import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentInstallInfo,
  AgentKind,
  AgentLatestVersions,
  AgentUpdateResult,
  HostAgentsStatus,
} from '../../../shared/protocol.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { buildZcodeBundle, localZcodeVersion } from '../zcode/bundle.js';
import { cleanRemoteStderr, loginShellCommand, shQuote, sshExec, type SshResult } from './ssh.js';

const AGENTS: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy', 'opencode', 'devin'];

const emptyAgents = (): HostAgentsStatus => ({
  claude: { installed: false },
  cursor: { installed: false },
  codex: { installed: false },
  kimi: { installed: false },
  kiro: { installed: false },
  grok: { installed: false },
  zcode: { installed: false },
  codebuddy: { installed: false },
  opencode: { installed: false },
  devin: { installed: false },
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
  'grok_fallback="$HOME/.local/bin/grok"; '
    + 'if command -v grok >/dev/null 2>&1; then echo "GROK_VER:$(grok --version 2>/dev/null | head -1)"; '
    + 'elif [ -x "$grok_fallback" ]; then echo "GROK_VER:$("$grok_fallback" --version 2>/dev/null | head -1)"; '
    + 'else echo GROK_MISS; fi',
  'zcode_fallback="/usr/local/bin/zcode"; '
    + 'if command -v zcode >/dev/null 2>&1; then echo "ZCODE_VER:$(zcode --version 2>/dev/null | head -1)"; '
    + 'elif [ -x "$zcode_fallback" ]; then echo "ZCODE_VER:$("$zcode_fallback" --version 2>/dev/null | head -1)"; '
    + 'else echo ZCODE_MISS; fi',
  'if command -v codebuddy >/dev/null 2>&1; then echo "CB_VER:$(codebuddy --version 2>/dev/null | head -1)"; else echo CB_MISS; fi',
  // opencode's installer drops the binary under ~/.opencode/bin, which a login
  // shell usually has — fall back the same way the other XDG-ish CLIs do.
  'opencode_fallback="$HOME/.opencode/bin/opencode"; '
    + 'if command -v opencode >/dev/null 2>&1; then echo "OPENCODE_VER:$(opencode --version 2>/dev/null | head -1)"; '
    + 'elif [ -x "$opencode_fallback" ]; then echo "OPENCODE_VER:$("$opencode_fallback" --version 2>/dev/null | head -1)"; '
    + 'else echo OPENCODE_MISS; fi',
  // Devin installs to ~/.local/bin, which a login shell usually has — but the
  // symlink target lives under ~/.local/share, so fall back the same way the
  // other XDG-installed CLIs do.
  'devin_fallback="$HOME/.local/bin/devin"; '
    + 'if command -v devin >/dev/null 2>&1; then echo "DEVIN_VER:$(devin --version 2>/dev/null | head -1)"; '
    + 'elif [ -x "$devin_fallback" ]; then echo "DEVIN_VER:$("$devin_fallback" --version 2>/dev/null | head -1)"; '
    + 'else echo DEVIN_MISS; fi',
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
  parseLine('GROK', 'grok');
  parseLine('ZCODE', 'zcode');
  parseLine('CB', 'codebuddy');
  parseLine('OPENCODE', 'opencode');
  parseLine('DEVIN', 'devin');
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
 * (or `agent`), codex, kimi, kiro-cli, and grok. Runs inside a login shell so nvm/fnm PATH works.
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

/** Grok Build publishes the current installer script with an embedded version. */
async function fetchGrokLatest(): Promise<string | undefined> {
  try {
    const npm = await npmViewVersion('@xai-official/grok');
    if (npm) return npm;
  } catch {
    /* fall through to the install script */
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch('https://x.ai/cli/install.sh', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const text = await res.text();
    const m = text.match(/\b(?:VERSION|version)=['"]?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
    return m?.[1];
  } catch (err) {
    log.debug('grok latest version fetch failed', err);
    return undefined;
  }
}

/** ZCode "latest" is always the local CLI; never freeze it inside the npm TTL. */
function overlayLocalZcode(versions: AgentLatestVersions): AgentLatestVersions {
  const zcode = localZcodeVersion();
  if (zcode) versions.zcode = zcode;
  else delete versions.zcode;
  return versions;
}

/** Fetch (and cache ~15 min) the latest published version for each agent CLI. */
export async function getLatestAgentVersions(force = false): Promise<AgentLatestVersions> {
  if (!force && latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) {
    return overlayLocalZcode(latestCache.versions);
  }
  const [claude, cursor, codex, kimi, kiro, grok, codebuddy] = await Promise.all([
    npmViewVersion('@anthropic-ai/claude-code'),
    fetchCursorLatest(),
    npmViewVersion('@openai/codex'),
    fetchKimiLatest(),
    fetchKiroLatest(),
    fetchGrokLatest(),
    npmViewVersion('@tencent-ai/codebuddy-code'),
  ]);
  const versions: AgentLatestVersions = {};
  if (claude) versions.claude = claude;
  if (cursor) versions.cursor = cursor;
  if (codex) versions.codex = codex;
  if (kimi) versions.kimi = kimi;
  if (kiro) versions.kiro = kiro;
  if (grok) versions.grok = grok;
  if (codebuddy) versions.codebuddy = codebuddy;
  // ZCode publishes no registry — the local CLI the push installer ships IS
  // the latest, so hosts lagging it show an Update button.
  latestCache = { at: Date.now(), versions };
  return overlayLocalZcode(versions);
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
    case 'codebuddy':
      // npm @latest; idempotent, so Install and Update share this command. The
      // credential push + login probe run in codebuddyPushInstall afterwards.
      return [
        'npm install -g @tencent-ai/codebuddy-code@latest',
        'echo VIBE_UPDATE_DONE',
        'if command -v codebuddy >/dev/null 2>&1; then echo "CB_VER:$(codebuddy --version 2>/dev/null | head -1)"; fi',
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
    case 'grok':
      return [
        'if command -v grok >/dev/null 2>&1; then',
        '  grok update',
        'else',
        '  curl -fsSL https://x.ai/cli/install.sh | bash',
        'fi',
        'echo VIBE_UPDATE_DONE',
        'grok_fallback="$HOME/.local/bin/grok"',
        'if command -v grok >/dev/null 2>&1; then echo "GROK_VER:$(grok --version 2>/dev/null | head -1)"; '
          + 'elif [ -x "$grok_fallback" ]; then echo "GROK_VER:$("$grok_fallback" --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
    case 'zcode':
      // ZCode ships no CLI installer — the CLI is the zcode.cjs bundled in the
      // desktop AppImage (linux-x64 only; it needs node >= 22.5 for node:sqlite,
      // so a private Node 24 lands under /opt when the host node is older).
      // Follows the documented extraction procedure; re-running is a no-op.
      return [
        'ZCODE_RELEASE=3.9.2',
        'case "$(uname -s):$(uname -m)" in',
        '  Linux:x86_64) ;;',
        '  *) echo "ZCode install supports linux-x64 only (this host: $(uname -s) $(uname -m))" >&2; exit 1 ;;',
        'esac',
        // Non-root SSH logins work when passwordless sudo is available.
        'SUDO=""',
        'if [ "$(id -u)" != "0" ]; then',
        '  if sudo -n true 2>/dev/null; then SUDO="sudo"',
        '  else echo "ZCode install needs root or passwordless sudo on the target host (writes /opt and /usr/local/bin)" >&2; exit 1; fi',
        'fi',
        'if command -v zcode >/dev/null 2>&1; then',
        '  echo "zcode already installed: $(zcode --version 2>/dev/null | head -1)"',
        '  echo VIBE_UPDATE_DONE',
        '  echo "ZCODE_VER:$(zcode --version 2>/dev/null | head -1)"',
        '  exit 0',
        'fi',
        'node_bin=""',
        'for cand in "$(command -v node 2>/dev/null)" /opt/node/bin/node; do',
        '  [ -x "$cand" ] || continue',
        '  v="$("$cand" --version 2>/dev/null | tr -d v)"',
        '  maj="${v%%.*}"',
        '  min="$(echo "$v" | cut -d. -f2)"',
        '  if [ "${maj:-0}" -gt 22 ] || { [ "${maj:-0}" -eq 22 ] && [ "${min:-0}" -ge 5 ]; }; then node_bin="$cand"; break; fi',
        'done',
        'if [ -z "$node_bin" ]; then',
        '  echo "Installing Node 24 under /opt (zcode needs node >= 22.5 for node:sqlite)..."',
        '  node_file="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -oE \'node-v24\\.[0-9]+\\.[0-9]+-linux-x64\\.tar\\.xz\' | head -1)"',
        '  if [ -z "$node_file" ]; then echo "could not resolve the latest Node 24 tarball" >&2; exit 1; fi',
        '  curl -fsSL -o /tmp/zcode-node24.tar.xz "https://nodejs.org/dist/latest-v24.x/$node_file" || { echo "Node 24 download failed" >&2; exit 1; }',
        '  $SUDO rm -rf "/opt/${node_file%.tar.xz}"',
        '  $SUDO tar -xJf /tmp/zcode-node24.tar.xz -C /opt/ || { echo "Node 24 tar extraction failed" >&2; exit 1; }',
        '  $SUDO ln -sfn "/opt/${node_file%.tar.xz}" /opt/node',
        '  rm -f /tmp/zcode-node24.tar.xz',
        '  node_bin=/opt/node/bin/node',
        'fi',
        'echo "Downloading ZCode $ZCODE_RELEASE (linux-x64 AppImage, ~200MB)..."',
        'cd /tmp || exit 1',
        'curl -fsSL -o ZCode.AppImage "https://cdn-zcode.z.ai/zcode/electron/releases/$ZCODE_RELEASE/linux-x64/ZCode-$ZCODE_RELEASE-linux-x64.AppImage" || { echo "ZCode AppImage download failed" >&2; exit 1; }',
        'chmod +x ZCode.AppImage',
        './ZCode.AppImage --appimage-extract >/dev/null 2>&1 || { echo "ZCode AppImage extraction failed" >&2; rm -f ZCode.AppImage; exit 1; }',
        'rm -f ZCode.AppImage',
        '$SUDO rm -rf /opt/zcode-app',
        '$SUDO mv squashfs-root /opt/zcode-app',
        'printf \'#!/bin/sh\\nexec %s /opt/zcode-app/resources/glm/zcode.cjs "$@"\\n\' "$node_bin" | $SUDO tee /usr/local/bin/zcode >/dev/null',
        '$SUDO chmod +x /usr/local/bin/zcode',
        'echo VIBE_UPDATE_DONE',
        'echo "ZCODE_VER:$(/usr/local/bin/zcode --version 2>/dev/null | head -1)"',
      ].join('\n');
    case 'opencode':
      // Official installer, non-interactive: installs to ~/.opencode/bin,
      // upgrades in place, exit 0. Same install-and-update pattern as Kimi.
      return [
        'curl -fsSL https://opencode.ai/install | bash',
        'echo VIBE_UPDATE_DONE',
        'opencode_fallback="$HOME/.opencode/bin/opencode"',
        'if command -v opencode >/dev/null 2>&1; then echo "OPENCODE_VER:$(opencode --version 2>/dev/null | head -1)"; '
          + 'elif [ -x "$opencode_fallback" ]; then echo "OPENCODE_VER:$("$opencode_fallback" --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
    case 'devin':
      // Official installer (referenced by the CLI's own strings), verified
      // non-interactive with no TTY: installs latest to ~/.local/bin/devin,
      // upgrades in place, exit 0. The trailing "Login canceled" it prints
      // when nobody is signed in yet is the post-install first-run probe
      // failing harmlessly. Same install-and-update pattern as Kimi.
      return [
        'curl -fsSL https://cli.devin.ai/install.sh | bash',
        'echo VIBE_UPDATE_DONE',
        'devin_fallback="$HOME/.local/bin/devin"',
        'if command -v devin >/dev/null 2>&1; then echo "DEVIN_VER:$(devin --version 2>/dev/null | head -1)"; '
          + 'elif [ -x "$devin_fallback" ]; then echo "DEVIN_VER:$("$devin_fallback" --version 2>/dev/null | head -1)"; fi',
      ].join('\n');
  }
}

function versionPrefix(agent: AgentKind): string {
  if (agent === 'claude') return 'CLAUDE_VER:';
  if (agent === 'cursor') return 'CURSOR_VER:';
  if (agent === 'codex') return 'CODEX_VER:';
  if (agent === 'kimi') return 'KIMI_VER:';
  if (agent === 'kiro') return 'KIRO_VER:';
  if (agent === 'zcode') return 'ZCODE_VER:';
  if (agent === 'codebuddy') return 'CB_VER:';
  if (agent === 'opencode') return 'OPENCODE_VER:';
  if (agent === 'devin') return 'DEVIN_VER:';
  return 'GROK_VER:';
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
  // `claude update` often exits 0 after printing this; don't treat it as success.
  const failedInstall = /Failed to install update/i.test(out);
  if (!done || failedInstall || (res.code !== 0 && !version)) {
    const errLine =
      (failedInstall ? 'Failed to install update' : undefined) ||
      cleanRemoteStderr(res.stderr).split('\n').pop() ||
      'update failed';
    return { ok: false, agent, error: errLine, log: logTail, version };
  }
  return { ok: true, agent, version, log: logTail };
}

/** Install or upgrade an agent CLI on a remote host over SSH. */
export async function sshUpdateAgent(target: string, agent: AgentKind): Promise<AgentUpdateResult> {
  if (!AGENTS.includes(agent)) {
    return { ok: false, agent, error: 'unknown agent' };
  }
  // ZCode: prefer pushing the local CLI bundle over SSH (~9MB tar.gz) instead
  // of downloading the ~200MB AppImage on the remote host.
  if (agent === 'zcode') return zcodePushInstall(target);
  // CodeBuddy: after the npm install, deploy this machine's credentials (never
  // overwriting the remote's) and verify with a remote login probe.
  if (agent === 'codebuddy') return codebuddyPushInstall(target);
  const res = await sshExec(target, loginShellCommand(updateCommand(agent)), { timeoutMs: 180_000 });
  return updateResultFromExec(agent, res);
}

// ---------------------------------------------------------------------------
// CodeBuddy push install: npm install + credential deploy + login probe.
// ---------------------------------------------------------------------------

/** Deploy ~/.codebuddy/vibe-auth.env from this machine to the remote host —
 *  only when the remote has none of its own (never clobber host credentials).
 *  Returns a human-readable note for the update log. */
async function deployCodebuddyCredentials(target: string): Promise<string> {
  let localCreds = '';
  try {
    localCreds = fs.readFileSync(config.codebuddyAuthEnvFile, 'utf8');
  } catch {
    return 'no local credentials to deploy — sign in on the host if needed';
  }
  if (!localCreds.trim()) return 'no local credentials to deploy — sign in on the host if needed';
  const have = await sshExec(
    target,
    loginShellCommand('[ -f ~/.codebuddy/vibe-auth.env ] && echo HAVE || echo MISS'),
    { timeoutMs: 15_000 },
  );
  if (have.stdout.includes('HAVE')) return 'remote already has ~/.codebuddy/vibe-auth.env (kept)';
  const wrote = await sshExec(
    target,
    loginShellCommand(
      'mkdir -p ~/.codebuddy && chmod 700 ~/.codebuddy && cat > ~/.codebuddy/vibe-auth.env && chmod 600 ~/.codebuddy/vibe-auth.env && echo CREDS_OK',
    ),
    { input: localCreds, timeoutMs: 15_000 },
  );
  return wrote.code === 0 && wrote.stdout.includes('CREDS_OK')
    ? 'deployed local credentials to ~/.codebuddy/vibe-auth.env'
    : 'credential deployment failed — sign in on the host from Vibe Hosts';
}

async function codebuddyPushInstall(target: string): Promise<AgentUpdateResult> {
  const res = await sshExec(target, loginShellCommand(updateCommand('codebuddy')), { timeoutMs: 300_000 });
  const result = updateResultFromExec('codebuddy', res);
  if (!result.ok) return result;

  const notes: string[] = [];
  try {
    notes.push(await deployCodebuddyCredentials(target));
  } catch (err) {
    log.debug('codebuddy credential deploy failed', err);
    notes.push('credential deployment skipped (SSH error)');
  }
  try {
    notes.push(await syncCodebuddySkills(target));
  } catch (err) {
    log.debug('codebuddy skill sync failed', err);
    notes.push('skill sync skipped (SSH error)');
  }
  // Verify the remote can actually authenticate (also warms nothing — one turn).
  try {
    const { probeCodebuddyTarget } = await import('../agents/codebuddyProbe.js');
    const probe = await probeCodebuddyTarget(target);
    notes.push(
      probe.ok
        ? 'login probe: signed in ✓'
        : `login probe: not signed in (${probe.error ?? 'no credentials'}) — sign in from Vibe Hosts`,
    );
  } catch (err) {
    log.debug('codebuddy login probe failed', err);
    notes.push('login probe skipped');
  }
  result.log = `${notes.join('\n')}\n${result.log ?? ''}`.trim();
  return result;
}

/** Local ~/.codebuddy/skills entries (dirs holding a SKILL.md), newest first. */
function localCodebuddySkills(): string[] {
  const dir = path.join(config.codebuddyHome, 'skills');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** tar.gz a local skill dir as a Buffer (preserves extra reference files). */
function tarSkill(name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-czf', '-', '-C', path.join(config.codebuddyHome, 'skills'), name],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer)),
    );
  });
}

/**
 * Sync this machine's ~/.codebuddy/skills to the remote host: skill dirs the
 * remote already has are never touched; missing ones arrive as a base64'd
 * tar.gz over the SSH channel (the same transport the file panel uses).
 */
async function syncCodebuddySkills(target: string): Promise<string> {
  const names = localCodebuddySkills();
  if (!names.length) return 'no local codebuddy skills to sync';

  const listing = names.map((n) => shQuote(n)).join(' ');
  const probe = await sshExec(
    target,
    loginShellCommand(
      `mkdir -p ~/.codebuddy/skills; for n in ${listing}; do if [ -d ~/.codebuddy/skills/"$n" ]; then echo "HAVE:$n"; else echo "MISS:$n"; fi; done`,
    ),
    { timeoutMs: 15_000 },
  );
  const missing = probe.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('MISS:'))
    .map((l) => l.slice(5));
  const present = names.length - missing.length;

  let okCount = 0;
  for (const name of missing) {
    try {
      const tarball = await tarSkill(name);
      const uploaded = await sshExec(
        target,
        loginShellCommand(`base64 -d | tar -xzf - -C ~/.codebuddy/skills && echo SKILL_OK`),
        { input: tarball.toString('base64'), timeoutMs: 60_000 },
      );
      if (uploaded.code === 0 && uploaded.stdout.includes('SKILL_OK')) okCount++;
      else log.debug(`codebuddy skill upload failed: ${name}`, cleanRemoteStderr(uploaded.stderr));
    } catch (err) {
      log.debug(`codebuddy skill upload failed: ${name}`, err);
    }
  }
  const kept = present > 0 ? `, ${present} already present (untouched)` : '';
  return missing.length
    ? `skills: synced ${okCount}/${missing.length}${kept}`
    : `skills: all ${present} already on the host (untouched)`;
}

// ---------------------------------------------------------------------------
// ZCode push install: upload the local CLI bundle, extract it remotely.
// ---------------------------------------------------------------------------

/** Machine-readable preflight (runs read-only on the target). */
const ZCODE_PREFLIGHT = [
  'echo "ARCH:$(uname -s)-$(uname -m)"',
  'if command -v zcode >/dev/null 2>&1; then echo "ZCODE:$(zcode --version 2>/dev/null | head -1)"; else echo ZCODE:missing; fi',
  'if [ "$(id -u)" = "0" ]; then echo SUDO:root',
  'elif sudo -n true 2>/dev/null; then echo SUDO:sudo',
  'else echo SUDO:none; fi',
  'node_bin=""',
  'for cand in "$(command -v node 2>/dev/null)" /opt/node/bin/node; do',
  '  [ -x "$cand" ] || continue',
  '  v="$("$cand" --version 2>/dev/null | tr -d v)"',
  '  maj="${v%%.*}"',
  '  min="$(echo "$v" | cut -d. -f2)"',
  '  if [ "${maj:-0}" -gt 22 ] || { [ "${maj:-0}" -eq 22 ] && [ "${min:-0}" -ge 5 ]; }; then node_bin="$cand"; break; fi',
  'done',
  'if [ -n "$node_bin" ]; then echo "NODE:$node_bin"; else echo NODE:missing; fi',
  'if [ -f "$HOME/.zcode/cli/config.json" ]; then echo CONFIG:present; else echo CONFIG:missing; fi',
].join('\n');

interface ZcodePreflight {
  arch: string;
  zcodeVersion?: string;
  sudo: 'root' | 'sudo' | 'none';
  nodeBin?: string;
  configPresent: boolean;
}

function parseZcodePreflight(stdout: string): ZcodePreflight {
  const pick = (key: string): string =>
    stdout.split('\n').find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? '';
  const sudo = pick('SUDO');
  return {
    arch: pick('ARCH'),
    zcodeVersion: pick('ZCODE') === 'missing' || !pick('ZCODE') ? undefined : pick('ZCODE'),
    sudo: sudo === 'root' || sudo === 'sudo' ? sudo : 'none',
    nodeBin: pick('NODE') === 'missing' || !pick('NODE') ? undefined : pick('NODE'),
    configPresent: pick('CONFIG') === 'present',
  };
}

/** Remote install/update steps once the bundle tarball sits at /tmp/vibe-zcode-bundle.tar.gz. */
export function zcodeExtractCommand(sudo: 'root' | 'sudo'): string {
  const s = sudo === 'sudo' ? 'sudo ' : '';
  return [
    // A pre-existing /opt/zcode-app may hold a full desktop install — its
    // resources stay valid, so only the CLI resource dirs are swapped.
    `${s}mkdir -p /opt/zcode-app/resources/.vibe-incoming`,
    `${s}rm -rf /opt/zcode-app/resources/.vibe-incoming/*`,
    `${s}tar -xzf /tmp/vibe-zcode-bundle.tar.gz -C /opt/zcode-app/resources/.vibe-incoming || { echo "bundle extraction failed" >&2; exit 1; }`,
    // Swap each bundled dir in place — stale files from an older version never
    // linger (a plain overlay extract would keep them).
    'for d in /opt/zcode-app/resources/.vibe-incoming/*; do',
    '  [ -e "$d" ] || continue',
    '  n="/opt/zcode-app/resources/$(basename "$d")"',
    `  ${s}rm -rf "$n"`,
    `  ${s}mv "$d" "$n" || { echo "swap failed for $n" >&2; exit 1; }`,
    'done',
    `${s}rm -rf /opt/zcode-app/resources/.vibe-incoming`,
    // The archive preserves the source's root-only dir modes (700); non-root
    // users on the remote host must be able to read/traverse the CLI.
    `${s}chmod -R a+rX /opt/zcode-app/resources/glm /opt/zcode-app/resources/tools /opt/zcode-app/resources/model-providers /opt/zcode-app/resources/config 2>/dev/null || true`,
    'node_bin=""',
    'for cand in "$(command -v node 2>/dev/null)" /opt/node/bin/node; do',
    '  [ -x "$cand" ] || continue',
    '  v="$("$cand" --version 2>/dev/null | tr -d v)"',
    '  maj="${v%%.*}"',
    '  min="$(echo "$v" | cut -d. -f2)"',
    '  if [ "${maj:-0}" -gt 22 ] || { [ "${maj:-0}" -eq 22 ] && [ "${min:-0}" -ge 5 ]; }; then node_bin="$cand"; break; fi',
    'done',
    'if [ -z "$node_bin" ]; then',
    '  echo "Installing Node 24 under /opt (zcode needs node >= 22.5 for node:sqlite)..."',
    '  node_file="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -oE \'node-v24\\.[0-9]+\\.[0-9]+-linux-x64\\.tar\\.xz\' | head -1)"',
    '  if [ -z "$node_file" ]; then echo "no node >= 22.5 on the host and could not resolve a Node 24 tarball" >&2; exit 1; fi',
    '  curl -fsSL -o /tmp/zcode-node24.tar.xz "https://nodejs.org/dist/latest-v24.x/$node_file" || { echo "Node 24 download failed" >&2; exit 1; }',
    `  ${s}rm -rf "/opt/\${node_file%.tar.xz}"`,
    `  ${s}tar -xJf /tmp/zcode-node24.tar.xz -C /opt/ || { echo "Node 24 tar extraction failed" >&2; exit 1; }`,
    `  ${s}ln -sfn "/opt/\${node_file%.tar.xz}" /opt/node`,
    '  rm -f /tmp/zcode-node24.tar.xz',
    '  node_bin=/opt/node/bin/node',
    'fi',
    `printf '#!/bin/sh\\nexec %s /opt/zcode-app/resources/glm/zcode.cjs "$@"\\n' "$node_bin" | ${s}tee /usr/local/bin/zcode >/dev/null`,
    `${s}chmod +x /usr/local/bin/zcode`,
    'rm -f /tmp/vibe-zcode-bundle.tar.gz',
    zcodeConfigFinalize(),
    'echo VIBE_UPDATE_DONE',
    'echo "ZCODE_VER:$(/usr/local/bin/zcode --version 2>/dev/null | head -1)"',
  ].join('\n');
}

/** Move a staged ~/.zcode/cli/.vibe-config.json into place — only when the
 *  remote has no config of its own (never clobber a host-specific one). */
function zcodeConfigFinalize(): string {
  return [
    'if [ -f "$HOME/.zcode/cli/.vibe-config.json" ] && [ ! -f "$HOME/.zcode/cli/config.json" ]; then',
    '  mv "$HOME/.zcode/cli/.vibe-config.json" "$HOME/.zcode/cli/config.json"',
    '  chmod 600 "$HOME/.zcode/cli/config.json"',
    'fi',
    'rm -f "$HOME/.zcode/cli/.vibe-config.json"',
  ].join('\n');
}

/**
 * Install ZCode on a remote host by streaming the local CLI bundle over the
 * existing SSH channel. Falls back to the CDN AppImage script when no local
 * installation exists to push.
 */
async function zcodePushInstall(target: string): Promise<AgentUpdateResult> {
  const fail = (error: string, logTail = ''): AgentUpdateResult => ({ ok: false, agent: 'zcode', error, log: logTail });

  const bundle = buildZcodeBundle();
  if (!bundle) {
    // Nothing local to push — remote downloads the AppImage itself.
    const res = await sshExec(target, loginShellCommand(updateCommand('zcode')), { timeoutMs: 480_000 });
    return updateResultFromExec('zcode', res);
  }

  const pre = await sshExec(target, loginShellCommand(ZCODE_PREFLIGHT), { timeoutMs: 25_000 });
  if (pre.code !== 0) return fail(cleanRemoteStderr(pre.stderr).split('\n').pop() || 'preflight failed', pre.stdout);
  const info = parseZcodePreflight(pre.stdout);
  const localVersion = parseVersionOutput(bundle.version ?? '') ?? bundle.version;

  // Deploy the local model config when the remote has none ("Model config is
  // missing"). Never overwrites — a host-specific config always wins.
  let configDeployed = false;
  const needConfig = !info.configPresent;
  if (needConfig) {
    let localConfig = '';
    try {
      localConfig = fs.readFileSync(config.zcodeConfigFile, 'utf8');
    } catch {
      localConfig = '';
    }
    if (localConfig.trim()) {
      const staged = await sshExec(
        target,
        'mkdir -p ~/.zcode/cli && chmod 700 ~/.zcode/cli && cat > ~/.zcode/cli/.vibe-config.json && echo CONFIG_OK',
        { input: localConfig, timeoutMs: 30_000 },
      );
      if (staged.code === 0 && staged.stdout.includes('CONFIG_OK')) {
        const finalized = await sshExec(target, loginShellCommand(zcodeConfigFinalize()), { timeoutMs: 30_000 });
        configDeployed = finalized.code === 0;
        if (!configDeployed) {
          return fail(cleanRemoteStderr(finalized.stderr).split('\n').pop() || 'model config deployment failed', pre.stdout);
        }
      }
    }
  }

  if (info.zcodeVersion && localVersion) {
    // The local CLI is the source of truth: same version → nothing to do,
    // different → this click is an update push.
    const remoteVersion = parseVersionOutput(info.zcodeVersion) ?? info.zcodeVersion;
    if (remoteVersion === localVersion) {
      if (configDeployed) {
        return {
          ok: true,
          agent: 'zcode',
          version: remoteVersion,
          log: `zcode ${remoteVersion} already installed (matches local ${localVersion}); deployed local model config to ~/.zcode/cli/config.json`,
        };
      }
      if (needConfig) {
        return fail('remote has no ~/.zcode/cli/config.json and the local one is unavailable — create it (or log in with `zcode login`) on the host', pre.stdout);
      }
      return {
        ok: true,
        agent: 'zcode',
        version: remoteVersion,
        log: `zcode ${remoteVersion} already installed (matches local ${localVersion})`,
      };
    }
    log.info(`zcode update push: ${target} ${remoteVersion} -> ${localVersion}`);
  }
  if (!/^Linux-x86_64$/.test(info.arch)) {
    return fail(`ZCode install supports linux-x64 only (this host: ${info.arch})`, pre.stdout);
  }
  if (info.sudo === 'none') {
    return fail('ZCode install needs root or passwordless sudo on the target host (writes /opt and /usr/local/bin)', pre.stdout);
  }

  const payload = fs.readFileSync(bundle.file);
  const uploaded = await sshExec(target, 'cat > /tmp/vibe-zcode-bundle.tar.gz && echo UPLOAD_OK', {
    input: payload,
    timeoutMs: 480_000,
  });
  if (uploaded.code !== 0 || !uploaded.stdout.includes('UPLOAD_OK')) {
    return fail(cleanRemoteStderr(uploaded.stderr).split('\n').pop() || `bundle upload failed (${payload.length} bytes)`, uploaded.stdout);
  }

  const install = await sshExec(target, loginShellCommand(zcodeExtractCommand(info.sudo)), { timeoutMs: 300_000 });
  const result = updateResultFromExec('zcode', install);
  if (result.ok) {
    const action = info.zcodeVersion ? 'updated to' : 'installed';
    result.log = `${action} local zcode ${localVersion ?? ''} (${payload.length} bytes)\n${result.log ?? ''}`.trim();
  }
  return result;
}

/** Install or upgrade an agent CLI on the machine running Vibe. */
export async function localUpdateAgent(agent: AgentKind): Promise<AgentUpdateResult> {
  if (!AGENTS.includes(agent)) {
    return { ok: false, agent, error: 'unknown agent' };
  }
  const res = await localExec(updateCommand(agent), { timeoutMs: agent === 'zcode' ? 480_000 : 180_000 });
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
