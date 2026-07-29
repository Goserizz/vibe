import { execFile, spawn } from 'node:child_process';
import type {
  AgentInstallInfo,
  AgentKind,
  AgentLatestVersions,
  AgentUpdateResult,
  HostAgentsStatus,
} from '../../../shared/protocol.js';
import { log } from '../log.js';
import { cleanRemoteStderr, loginShellCommand, sshExec, type SshResult } from './ssh.js';

const AGENTS: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro'];

const emptyAgents = (): HostAgentsStatus => ({
  claude: { installed: false },
  cursor: { installed: false },
  codex: { installed: false },
  kimi: { installed: false },
  kiro: { installed: false },
});

/** Probe script shared by local + remote (login-shell PATH for nvm/fnm/…). */
const PROBE_SCRIPT = [
  'echo VIBE_OK',
  'if command -v claude >/dev/null 2>&1; then echo "CLAUDE_VER:$(claude --version 2>/dev/null | head -1)"; else echo CLAUDE_MISS; fi',
  'if command -v cursor-agent >/dev/null 2>&1; then echo "CURSOR_VER:$(cursor-agent --version 2>/dev/null | head -1)"; '
    + 'elif command -v agent >/dev/null 2>&1; then echo "CURSOR_VER:$(agent --version 2>/dev/null | head -1)"; '
    + 'else echo CURSOR_MISS; fi',
  'if command -v codex >/dev/null 2>&1; then echo "CODEX_VER:$(codex --version 2>/dev/null | head -1)"; else echo CODEX_MISS; fi',
  'kimi_fallback="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin/kimi"; '
    + 'if command -v kimi >/dev/null 2>&1; then echo "KIMI_VER:$(kimi --version 2>/dev/null | head -1)"; '
    + 'elif [ -x "$kimi_fallback" ]; then echo "KIMI_VER:$("$kimi_fallback" --version 2>/dev/null | head -1)"; '
    + 'else echo KIMI_MISS; fi',
  'kiro_fallback="$HOME/.local/bin/kiro-cli"; '
    + 'if command -v kiro-cli >/dev/null 2>&1; then echo "KIRO_VER:$(kiro-cli --version 2>/dev/null | head -1)"; '
    + 'elif [ -x "$kiro_fallback" ]; then echo "KIRO_VER:$("$kiro_fallback" --version 2>/dev/null | head -1)"; '
    + 'else echo KIRO_MISS; fi',
].join('; ');

/** Pull a semver-ish or Cursor-style version token out of CLI `--version` output. */
export function parseVersionOutput(raw: string): string | undefined {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^usage:/i.test(l));
  if (!line) return undefined;
  // Cursor: 2026.07.08-0c04a8a
  const cursor = line.match(/\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\b/i);
  if (cursor) return cursor[1];
  // Claude / Codex / generic: 2.1.191 or v0.143.0
  const semver = line.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  if (semver) return semver[1];
  // Fallback: first token that looks version-like
  const token = line.match(/\b([0-9][0-9A-Za-z._+-]*)\b/);
  return token?.[1];
}

function parseProbeStdout(stdout: string): HostAgentsStatus {
  const agents = emptyAgents();
  const parseLine = (prefix: string, kind: AgentKind) => {
    const line = stdout.split('\n').find((l) => l.includes(`${prefix}_VER:`) || l.trim() === `${prefix}_MISS`);
    if (!line || line.includes(`${prefix}_MISS`)) return;
    const raw = line.replace(new RegExp(`.*${prefix}_VER:`), '').trim();
    const version = parseVersionOutput(raw);
    agents[kind] = { installed: true, version };
  };
  parseLine('CLAUDE', 'claude');
  parseLine('CURSOR', 'cursor');
  parseLine('CODEX', 'codex');
  parseLine('KIMI', 'kimi');
  parseLine('KIRO', 'kiro');
  return agents;
}

/** Run a command through the local login shell (same PATH semantics as remote probes). */
function localExec(inner: string, opts: { timeoutMs?: number } = {}): Promise<SshResult> {
  const shell = process.env.SHELL || 'bash';
  return new Promise((resolve) => {
    const child = spawn(shell, ['-lic', inner], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 20_000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}${e instanceof Error ? e.message : String(e)}`,
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function probeFromResult(res: SshResult): {
  online: boolean;
  claude: boolean;
  agents: HostAgentsStatus;
  error?: string;
} {
  if (res.code !== 0 || !res.stdout.includes('VIBE_OK')) {
    const error = res.timedOut
      ? 'connection timed out'
      : cleanRemoteStderr(res.stderr).split('\n').pop() || 'unreachable';
    return { online: false, claude: false, agents: emptyAgents(), error };
  }
  const agents = parseProbeStdout(res.stdout);
  return { online: true, claude: agents.claude.installed, agents };
}

/**
 * One-shot remote probe: reachability + install/version for claude, cursor-agent
 * (or `agent`), codex, kimi, and kiro-cli. Runs inside a login shell so nvm/fnm PATH works.
 */
export async function sshProbeAgents(
  target: string,
): Promise<{ online: boolean; claude: boolean; agents: HostAgentsStatus; error?: string }> {
  const res = await sshExec(target, loginShellCommand(PROBE_SCRIPT), { timeoutMs: 25_000 });
  return probeFromResult(res);
}

/** Same probe as `sshProbeAgents`, but against the machine running Vibe. */
export async function localProbeAgents(): Promise<{
  online: boolean;
  claude: boolean;
  agents: HostAgentsStatus;
  error?: string;
}> {
  const res = await localExec(PROBE_SCRIPT, { timeoutMs: 25_000 });
  return probeFromResult(res);
}

// -- Latest published versions (cached) --------------------------------------

const LATEST_TTL_MS = 15 * 60_000;
let latestCache: { at: number; versions: AgentLatestVersions } | null = null;

function npmViewVersion(pkg: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('npm', ['view', pkg, 'version'], { timeout: 20_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const v = stdout.trim().split('\n').pop()?.trim();
      resolve(v || undefined);
    });
  });
}

/** Latest Cursor CLI version is baked into the public install script. */
async function fetchCursorLatest(): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch('https://cursor.com/install', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const text = await res.text();
    const m = text.match(/\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\b/i);
    return m?.[1];
  } catch (err) {
    log.debug('cursor latest version fetch failed', err);
    return undefined;
  }
}

/** Kimi Code publishes the current native-installer version as plain text. */
async function fetchKimiLatest(): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch('https://code.kimi.com/kimi-code/latest', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const version = (await res.text()).trim();
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
  } catch (err) {
    log.debug('kimi latest version fetch failed', err);
    return undefined;
  }
}

/** Kiro CLI publishes a channel manifest with the current version. */
async function fetchKiroLatest(): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch('https://prod.download.cli.kiro.dev/stable/latest/manifest.json', {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
  } catch (err) {
    log.debug('kiro latest version fetch failed', err);
    return undefined;
  }
}

/** Fetch (and cache ~15 min) the latest published version for each agent CLI. */
export async function getLatestAgentVersions(force = false): Promise<AgentLatestVersions> {
  if (!force && latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) {
    return latestCache.versions;
  }
  const [claude, cursor, codex, kimi, kiro] = await Promise.all([
    npmViewVersion('@anthropic-ai/claude-code'),
    fetchCursorLatest(),
    npmViewVersion('@openai/codex'),
    fetchKimiLatest(),
    fetchKiroLatest(),
  ]);
  const versions: AgentLatestVersions = {};
  if (claude) versions.claude = claude;
  if (cursor) versions.cursor = cursor;
  if (codex) versions.codex = codex;
  if (kimi) versions.kimi = kimi;
  if (kiro) versions.kiro = kiro;
  latestCache = { at: Date.now(), versions };
  return versions;
}

// -- Update / install on a remote host ---------------------------------------

function updateCommand(agent: AgentKind): string {
  switch (agent) {
    case 'claude':
      // Prefer the built-in updater when present; otherwise run the native installer.
      // Keep this a single shell script — no leading `;` after newlines (bash rejects that).
      return [
        'if command -v claude >/dev/null 2>&1; then',
        '  claude update',
        'else',
        '  curl -fsSL https://claude.ai/install.sh | bash',
        'fi',
        'echo VIBE_UPDATE_DONE',
        'if command -v claude >/dev/null 2>&1; then echo "CLAUDE_VER:$(claude --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
    case 'cursor':
      return [
        'if command -v cursor-agent >/dev/null 2>&1; then',
        '  cursor-agent update',
        'elif command -v agent >/dev/null 2>&1; then',
        '  agent update',
        'else',
        '  curl -fsS https://cursor.com/install | bash',
        'fi',
        'echo VIBE_UPDATE_DONE',
        'if command -v cursor-agent >/dev/null 2>&1; then echo "CURSOR_VER:$(cursor-agent --version 2>/dev/null | head -1)"; '
          + 'elif command -v agent >/dev/null 2>&1; then echo "CURSOR_VER:$(agent --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
    case 'codex':
      // npm @latest covers both fresh install and upgrade for the common path.
      return [
        'npm install -g @openai/codex@latest',
        'echo VIBE_UPDATE_DONE',
        'if command -v codex >/dev/null 2>&1; then echo "CODEX_VER:$(codex --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
    case 'kimi':
      // The official installer is non-interactive and handles both install and
      // upgrade for native Kimi Code installations.
      return [
        'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
        'echo VIBE_UPDATE_DONE',
        'kimi_fallback="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin/kimi"',
        'if command -v kimi >/dev/null 2>&1; then echo "KIMI_VER:$(kimi --version 2>/dev/null | head -1)"; '
          + 'elif [ -x "$kimi_fallback" ]; then echo "KIMI_VER:$("$kimi_fallback" --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
    case 'kiro':
      return [
        'if command -v kiro-cli >/dev/null 2>&1; then',
        '  kiro-cli update -y',
        'else',
        '  curl -fsSL https://cli.kiro.dev/install | bash',
        'fi',
        'echo VIBE_UPDATE_DONE',
        'kiro_fallback="$HOME/.local/bin/kiro-cli"',
        'if command -v kiro-cli >/dev/null 2>&1; then echo "KIRO_VER:$(kiro-cli --version 2>/dev/null | head -1)"; '
          + 'elif [ -x "$kiro_fallback" ]; then echo "KIRO_VER:$("$kiro_fallback" --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
  }
}

function versionPrefix(agent: AgentKind): string {
  if (agent === 'claude') return 'CLAUDE_VER:';
  if (agent === 'cursor') return 'CURSOR_VER:';
  if (agent === 'codex') return 'CODEX_VER:';
  if (agent === 'kimi') return 'KIMI_VER:';
  return 'KIRO_VER:';
}

function updateResultFromExec(agent: AgentKind, res: SshResult): AgentUpdateResult {
  const out = `${res.stdout}\n${res.stderr}`;
  const logTail = cleanRemoteStderr(out, 2000) || out.trim().slice(-2000);
  const done = res.stdout.includes('VIBE_UPDATE_DONE');
  const verLine = res.stdout.split('\n').find((l) => l.includes(versionPrefix(agent)));
  const version = verLine ? parseVersionOutput(verLine.replace(/^.*?:/, '').trim()) : undefined;

  if (res.timedOut) {
    return { ok: false, agent, error: 'update timed out', log: logTail };
  }
  if (!done || (res.code !== 0 && !version)) {
    const errLine = cleanRemoteStderr(res.stderr).split('\n').pop() || 'update failed';
    return { ok: false, agent, error: errLine, log: logTail, version };
  }
  return { ok: true, agent, version, log: logTail };
}

/** Install or upgrade an agent CLI on a remote host over SSH. */
export async function sshUpdateAgent(target: string, agent: AgentKind): Promise<AgentUpdateResult> {
  if (!AGENTS.includes(agent)) {
    return { ok: false, agent, error: 'unknown agent' };
  }
  const res = await sshExec(target, loginShellCommand(updateCommand(agent)), { timeoutMs: 180_000 });
  return updateResultFromExec(agent, res);
}

/** Install or upgrade an agent CLI on the machine running Vibe. */
export async function localUpdateAgent(agent: AgentKind): Promise<AgentUpdateResult> {
  if (!AGENTS.includes(agent)) {
    return { ok: false, agent, error: 'unknown agent' };
  }
  const res = await localExec(updateCommand(agent), { timeoutMs: 180_000 });
  return updateResultFromExec(agent, res);
}

export function isAgentKind(s: string): s is AgentKind {
  return (AGENTS as string[]).includes(s);
}

/** Compare installed vs latest; true when both exist and differ. */
export function isOutdated(info: AgentInstallInfo | undefined, latest?: string): boolean {
  if (!info?.installed || !info.version || !latest) return false;
  return info.version !== latest;
}
