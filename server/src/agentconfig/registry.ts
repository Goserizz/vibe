import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostRegistry } from '../remote/hosts.js';
import { sshExec, loginShellCommand, type SshResult } from '../remote/ssh.js';
import type { AgentKind, ConfigFileDetail, ConfigFileEntry } from '../../../shared/protocol.js';

/**
 * Agent config files (e.g. Claude's `~/.claude/settings.json`, Codex's
 * `~/.codex/config.toml`). Unlike skills, these aren't parsed — they're a mix
 * of JSON and TOML, so we read/write raw text and never reformat. This preserves
 * comments (TOML) and any keys/structure we don't manage.
 *
 * Security: the client only ever sends an opaque `id` from this fixed per-agent
 * allowlist. The server resolves `id → path`, so no client-supplied path is ever
 * interpolated — path traversal is impossible regardless of input. Raw
 * credential files (`.credentials.json`, `auth.json`) and Claude's giant root
 * `~/.claude.json` are intentionally excluded.
 */

/** Max bytes we'll read or write in one shot — guards against huge files. */
const SIZE_LIMIT = 1 * 1024 * 1024;

/** Allowed config-file id: lowercase letters, digits, dot, dash. */
export const CONFIG_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

interface ConfigFileDef {
  /** Opaque key the client uses to reference this file. */
  id: string;
  /** Display label. */
  label: string;
  /** Remote path, `~` left bare so the login shell expands it (constant — never
   *  user input, so it's safe to interpolate bare). */
  rel: string;
  /** Absolute local path. */
  local: () => string;
}

const home = () => os.homedir();

const AGENT_CONFIGS: Record<AgentKind, ConfigFileDef[]> = {
  claude: [
    { id: 'settings', label: 'settings.json', rel: '~/.claude/settings.json', local: () => path.join(home(), '.claude', 'settings.json') },
    { id: 'settings.local', label: 'settings.local.json', rel: '~/.claude/settings.local.json', local: () => path.join(home(), '.claude', 'settings.local.json') },
  ],
  codex: [
    { id: 'config', label: 'config.toml', rel: '~/.codex/config.toml', local: () => path.join(home(), '.codex', 'config.toml') },
  ],
  cursor: [
    { id: 'cli-config', label: 'cli-config.json', rel: '~/.cursor/cli-config.json', local: () => path.join(home(), '.cursor', 'cli-config.json') },
  ],
  kimi: [
    { id: 'config', label: 'config.toml', rel: '~/.kimi-code/config.toml', local: () => path.join(home(), '.kimi-code', 'config.toml') },
    { id: 'tui', label: 'tui.toml', rel: '~/.kimi-code/tui.toml', local: () => path.join(home(), '.kimi-code', 'tui.toml') },
  ],
  kiro: [
    { id: 'cli', label: 'settings/cli.json', rel: '~/.kiro/settings/cli.json', local: () => path.join(home(), '.kiro', 'settings', 'cli.json') },
  ],
};

/** Resolve an opaque `id` to its fixed def, or throw. This is the confinement check. */
function resolveDef(agent: AgentKind, id: string): ConfigFileDef {
  const def = AGENT_CONFIGS[agent].find((d) => d.id === id);
  if (!def) throw new Error('invalid config id');
  return def;
}

/** host name → SSH target (mirrors skills.ts's private resolveTarget). */
function resolveTarget(host?: string): { remote: boolean; target: string } {
  if (!host) return { remote: false, target: '' };
  const h = hostRegistry.get(host);
  return { remote: true, target: h?.ssh ?? host };
}

/** Run a command on a remote host inside a login shell; throw on timeout. */
async function run(target: string, inner: string, opts: { input?: string; timeoutMs?: number } = {}): Promise<SshResult> {
  const r = await sshExec(target, loginShellCommand(inner), opts);
  if (r.timedOut) throw new Error('remote operation timed out');
  return r;
}

/** Local stat → {exists, size}. */
function statLocal(file: string): { exists: boolean; size: number } {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

/** Parse one line of `EXISTS <bytes>` / `MISSING` from the remote stat probe. */
function parseStat(line: string): { exists: boolean; size: number } {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'EXISTS') return { exists: true, size: Number(parts[1]) || 0 };
  return { exists: false, size: 0 };
}

/**
 * List config files for an agent on this machine or a remote host, each
 * annotated with whether it currently exists and its size.
 */
export async function listConfigFiles(args: { agent: AgentKind; host?: string }): Promise<ConfigFileEntry[]> {
  const { agent, host } = args;
  const defs = AGENT_CONFIGS[agent];
  const { remote, target } = resolveTarget(host);

  if (!remote) {
    return defs.map((d) => {
      const st = statLocal(d.local());
      return { id: d.id, agent, label: d.label, relPath: d.rel, exists: st.exists, size: st.size };
    });
  }

  // Remote: one parallel stat probe per file. `~` expands in the login shell.
  const results = await Promise.all(
    defs.map((d) => run(target, `if [ -f ${d.rel} ]; then echo EXISTS $(wc -c < ${d.rel}); else echo MISSING; fi`, { timeoutMs: 15_000 })),
  );
  return defs.map((d, i) => {
    const st = parseStat(results[i].stdout);
    return { id: d.id, agent, label: d.label, relPath: d.rel, exists: st.exists, size: st.size };
  });
}

/** Read one config file's raw text. Missing file ⇒ empty content, exists:false. */
export async function readConfigFile(args: { agent: AgentKind; host?: string; id: string }): Promise<ConfigFileDetail> {
  const { agent, id } = args;
  const def = resolveDef(agent, id);
  const { remote, target } = resolveTarget(args.host);

  let content = '';
  let exists = false;
  if (!remote) {
    const st = statLocal(def.local());
    if (st.exists) {
      if (st.size > SIZE_LIMIT) throw new Error('config file too large to edit');
      content = fs.readFileSync(def.local(), 'utf8');
      exists = true;
    }
  } else {
    const r = await run(target, `cat ${def.rel} 2>/dev/null`, { timeoutMs: 15_000 });
    // code !== 0 ⇒ file missing (matches skills.ts's readSkill remote branch).
    if (r.code === 0) {
      if (Buffer.byteLength(r.stdout, 'utf8') > SIZE_LIMIT) throw new Error('config file too large to edit');
      content = r.stdout;
      exists = true;
    }
  }

  return { id, agent, label: def.label, relPath: def.rel, content, exists, readOnly: false };
}

/** Create or overwrite a config file (mkdir -p the parent first). */
export async function writeConfigFile(args: { agent: AgentKind; host?: string; id: string; content: string }): Promise<ConfigFileDetail> {
  const { agent, id, content } = args;
  if (Buffer.byteLength(content, 'utf8') > SIZE_LIMIT) throw new Error('config file too large');
  const def = resolveDef(agent, id);
  const { remote, target } = resolveTarget(args.host);

  if (!remote) {
    const file = def.local();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  } else {
    await run(target, `mkdir -p $(dirname ${def.rel})`, { timeoutMs: 15_000 });
    await run(target, `cat > ${def.rel}`, { input: content, timeoutMs: 30_000 });
  }

  return { id, agent, label: def.label, relPath: def.rel, content, exists: true, readOnly: false };
}
