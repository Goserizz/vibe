import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { config } from '../config.js';
import { sshExec } from '../remote/ssh.js';
import { oauthStore } from './oauth.js';
import type { McpServerDef } from '../../../shared/protocol.js';

/**
 * Bridge between Vibe's MCP server definitions and each engine's native config.
 *
 *  - Claude: servers are passed through the Agent SDK `mcpServers` option (no
 *    file written) — see `toSdkMcpServers`, used by claude/runner.ts.
 *  - Kimi: servers are passed per-session in the ACP `session/new` (and
 *    resume/load) `mcpServers` param — see `toAcpMcpServers`, used by kimi/acp.ts.
 *  - Cursor / Codex: their headless CLIs read MCP from a file on the host the
 *    session runs on, so we manage that file (`~/.cursor/mcp.json`,
 *    `~/.codex/config.toml`) before each turn — locally via fs, remotely via SSH.
 *  - ZCode: servers are merged into `~/.zcode/cli/config.json`; managed names
 *    live in a Vibe sidecar so strict vendor config parsing sees no marker.
 *
 * Cursor and Codex files are merged, not overwritten: entries Vibe owns are
 * tracked (a marker) and replaced each turn; anything the user added by hand is
 * preserved. Writes are gated by an in-memory signature cache so an unchanged
 * enabled set costs nothing on steady-state turns.
 */

export interface RemoteTarget {
  sshTarget: string;
}

/**
 * Resolve request headers for a server. OAuth-managed servers get a live
 * `Authorization: Bearer <accessToken>` from the oauth store (refreshed on a
 * background timer); everything else uses the user's static headers.
 */
function headersFor(d: McpServerDef): Record<string, string> | undefined {
  if (d.auth === 'oauth') {
    const token = oauthStore.bearerFor(d.name);
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }
  return d.headers && Object.keys(d.headers).length ? d.headers : undefined;
}

/** Best-effort: refresh any OAuth tokens that are near expiry before we read them. */
async function refreshOauthTokens(defs: McpServerDef[]): Promise<void> {
  await Promise.all(defs.filter((d) => d.auth === 'oauth').map((d) => oauthStore.ensureFresh(d.name)));
}

// ---- Claude (Agent SDK) -----------------------------------------------------

/** Map defs to the Claude Agent SDK `mcpServers` option shape (additive — the
 *  CLI still loads the user's own ~/.claude.json servers on top). */
export function toSdkMcpServers(defs: McpServerDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const headers = headersFor(d);
    if (d.transport === 'stdio') {
      const entry: Record<string, unknown> = { type: 'stdio', command: d.command };
      if (d.args?.length) entry.args = d.args;
      if (d.env && Object.keys(d.env).length) entry.env = d.env;
      out[d.name] = entry;
    } else if (d.transport === 'sse') {
      const entry: Record<string, unknown> = { type: 'sse', url: d.url };
      if (headers) entry.headers = headers;
      out[d.name] = entry;
    } else {
      const entry: Record<string, unknown> = { type: 'http', url: d.url };
      if (headers) entry.headers = headers;
      out[d.name] = entry;
    }
  }
  return out;
}

// ---- CodeBuddy (`--mcp-config` file, Claude CLI shape) -----------------------

/**
 * Build the JSON config file the CodeBuddy CLI takes via `--mcp-config`
 * (a Claude Code fork — same `{"mcpServers": {name: {type, command, args, env}
 * | {type, url, headers}}}` schema as the Claude CLI's own config). OAuth
 * bearers are refreshed first, like every other engine bridge. Returned as a
 * string so the caller decides where it lives (local file vs SSH upload) —
 * never inline it in a command line, where `ps` would leak the env/headers.
 */
export async function toCliMcpConfig(defs: McpServerDef[]): Promise<string> {
  await refreshOauthTokens(defs);
  return `${JSON.stringify({ mcpServers: toSdkMcpServers(defs) }, null, 2)}\n`;
}

// ---- Kimi (ACP session/new mcpServers) --------------------------------------

/** Map defs to the ACP `session/new` `mcpServers` shape (stdio entries carry no
 *  `type`; env/headers are name/value arrays). Additive like Claude's — Kimi
 *  still loads servers from its own CLI config on top. */
export async function toAcpMcpServers(defs: McpServerDef[]): Promise<unknown[]> {
  await refreshOauthTokens(defs);
  const out: unknown[] = [];
  for (const d of defs) {
    if (d.transport === 'stdio') {
      if (!d.command) continue;
      const entry: Record<string, unknown> = { name: d.name, command: d.command };
      if (d.args?.length) entry.args = d.args;
      const env = Object.entries(d.env ?? {}).map(([name, value]) => ({ name, value }));
      if (env.length) entry.env = env;
      out.push(entry);
    } else {
      if (!d.url) continue;
      const entry: Record<string, unknown> = { type: d.transport, name: d.name, url: d.url };
      const headers = Object.entries(headersFor(d) ?? {}).map(([name, value]) => ({ name, value }));
      if (headers.length) entry.headers = headers;
      out.push(entry);
    }
  }
  return out;
}

// ---- signature cache --------------------------------------------------------

const sigCache = new Map<string, string>();

// ---- Cursor ~/.cursor/mcp.json (JSON managed merge) -------------------------

const CURSOR_MARKER = '_vibe_managed';

function cursorEntry(def: McpServerDef): Record<string, unknown> | undefined {
  if (def.transport === 'stdio') {
    if (!def.command) return undefined;
    const entry: Record<string, unknown> = { command: def.command };
    if (def.args?.length) entry.args = def.args;
    if (def.env && Object.keys(def.env).length) entry.env = def.env;
    return entry;
  }
  // Cursor expresses non-stdio servers with an explicit `type`.
  const entry: Record<string, unknown> = { type: def.transport, url: def.url };
  const headers = headersFor(def);
  if (headers) entry.headers = headers;
  return entry;
}

/** Reconcile `~/.cursor/mcp.json` so Vibe's enabled servers are present (and any
 *  Vibe-managed name no longer enabled is removed). No-op when unchanged. */
export async function applyCursorMcp(defs: McpServerDef[], remote?: RemoteTarget): Promise<void> {
  await refreshOauthTokens(defs);
  const managed = defs.map((d) => d.name);
  const desired: Record<string, unknown> = {};
  for (const d of defs) {
    const entry = cursorEntry(d);
    if (entry) desired[d.name] = entry;
  }
  const sig = JSON.stringify({ managed, desired });
  if (sigCache.get(cursorKey(remote)) === sig) return;

  try {
    const raw = await readManagedFile('~/.cursor/mcp.json', remote);
    const obj: Record<string, unknown> = raw.trim() ? safeJsonParse(raw) : {};
    const servers: Record<string, unknown> =
      obj.mcpServers && typeof obj.mcpServers === 'object' ? { ...(obj.mcpServers as Record<string, unknown>) } : {};
    // Drop the names we managed last time, then merge the current set.
    const prevManaged = Array.isArray(obj[CURSOR_MARKER]) ? (obj[CURSOR_MARKER] as string[]) : [];
    for (const n of prevManaged) delete servers[n];
    for (const [n, e] of Object.entries(desired)) servers[n] = e;
    obj.mcpServers = servers;
    if (managed.length) obj[CURSOR_MARKER] = managed;
    else delete obj[CURSOR_MARKER];

    const out = JSON.stringify(obj, null, 2) + '\n';
    await writeManagedFile('~/.cursor/mcp.json', out, remote);
    sigCache.set(cursorKey(remote), sig);
  } catch (err) {
    log.warn('cursor mcp apply failed', err);
  }
}

function cursorKey(remote?: RemoteTarget): string {
  return `cursor:${remote?.sshTarget ?? 'local'}`;
}

// ---- Codex ~/.codex/config.toml (managed block) -----------------------------

const CODEX_BEGIN = '# >>> vibe mcp >>>';
const CODEX_END = '# <<< vibe mcp <<<';
const CODEX_BLOCK = new RegExp('\\n?' + escapeReg(CODEX_BEGIN) + '.*?' + escapeReg(CODEX_END) + '\\n?', 's');

/** Escape a TOML basic string value (RFC, double-quoted). */
function tomlStr(s: string): string {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function codexBlock(defs: McpServerDef[]): string {
  const lines: string[] = [CODEX_BEGIN];
  for (const d of defs) {
    lines.push(`[mcp_servers.${tomlStr(d.name)}]`);
    if (d.transport === 'stdio') {
      if (d.command) lines.push(`command = ${tomlStr(d.command)}`);
      if (d.args?.length) lines.push(`args = [${d.args.map(tomlStr).join(', ')}]`);
      if (d.env && Object.keys(d.env).length)
        lines.push(`env = { ${Object.entries(d.env).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')} }`);
    } else {
      if (d.url) lines.push(`url = ${tomlStr(d.url)}`);
      // Codex reads per-server headers from a nested table (best-effort; some
      // codex builds attach them to remote MCP requests, enabling OAuth bearer).
      const headers = headersFor(d);
      if (headers && Object.keys(headers).length) {
        lines.push('');
        for (const [k, v] of Object.entries(headers)) lines.push(`headers.${tomlStr(k)} = ${tomlStr(v)}`);
      }
    }
    lines.push('');
  }
  lines.push(CODEX_END);
  return lines.join('\n');
}

/** Reconcile the Vibe-managed `[mcp_servers.*]` block in `~/.codex/config.toml`. */
export async function applyCodexMcp(defs: McpServerDef[], remote?: RemoteTarget): Promise<void> {
  await refreshOauthTokens(defs);
  const block = defs.length ? codexBlock(defs) : '';
  const sig = block;
  if (sigCache.get(codexKey(remote)) === sig) return;

  try {
    const raw = await readManagedFile('~/.codex/config.toml', remote);
    // Strip any previous managed block (markers + everything between).
    const stripped = raw.replace(CODEX_BLOCK, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    const out = stripped ? `${stripped}\n\n${block}\n` : block ? `${block}\n` : '';
    // Nothing to write and no file touched before? Avoid creating an empty file.
    if (!block && !raw.trim()) {
      sigCache.set(codexKey(remote), sig);
      return;
    }
    await writeManagedFile('~/.codex/config.toml', out, remote);
    sigCache.set(codexKey(remote), sig);
  } catch (err) {
    log.warn('codex mcp apply failed', err);
  }
}

function codexKey(remote?: RemoteTarget): string {
  return `codex:${remote?.sshTarget ?? 'local'}`;
}

// ---- ZCode ~/.zcode/cli/config.json ----------------------------------------

function zcodeEntry(def: McpServerDef): Record<string, unknown> | undefined {
  const headers = headersFor(def);
  if (def.transport === 'stdio') {
    if (!def.command) return undefined;
    const entry: Record<string, unknown> = { type: 'stdio', command: def.command };
    if (def.args?.length) entry.args = def.args;
    if (def.env && Object.keys(def.env).length) entry.env = def.env;
    return entry;
  }
  if (!def.url) return undefined;
  const entry: Record<string, unknown> = { type: def.transport, url: def.url };
  if (headers) entry.headers = headers;
  return entry;
}

/** ZCode has no per-session MCP parameter: merge Vibe-managed entries into its
 * JSON config before starting app-server. The managed-name list lives in a
 * Vibe sidecar rather than an unknown config key that a strict ZCode build
 * could reject. User-authored MCP entries are preserved. */
export async function applyZcodeMcp(defs: McpServerDef[], remote?: RemoteTarget): Promise<void> {
  await refreshOauthTokens(defs);
  const desired: Record<string, unknown> = {};
  for (const def of defs) {
    const entry = zcodeEntry(def);
    if (entry) desired[def.name] = entry;
  }
  const sig = JSON.stringify(desired);
  const key = `zcode:${remote?.sshTarget ?? 'local'}`;
  if (sigCache.get(key) === sig) return;

  try {
    let configRaw = '';
    let managedRaw = '';
    if (remote) {
      const [cfg, managed] = await Promise.all([
        sshExec(remote.sshTarget, 'cat ~/.zcode/cli/config.json 2>/dev/null', { timeoutMs: 15_000 }),
        sshExec(remote.sshTarget, 'cat ~/.vibe/zcode-managed-mcp.json 2>/dev/null', { timeoutMs: 15_000 }),
      ]);
      configRaw = cfg.code === 0 ? cfg.stdout : '';
      managedRaw = managed.code === 0 ? managed.stdout : '';
    } else {
      try { configRaw = fs.readFileSync(config.zcodeConfigFile, 'utf8'); } catch { /* first config */ }
      try { managedRaw = fs.readFileSync(path.join(config.home, 'zcode-managed-mcp.json'), 'utf8'); } catch { /* first run */ }
    }

    let root: Record<string, unknown>;
    if (!configRaw.trim()) {
      root = {};
    } else {
      const parsed = JSON.parse(configRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ZCode config root is not a JSON object');
      }
      root = parsed as Record<string, unknown>;
    }
    const mcp = root.mcp && typeof root.mcp === 'object'
      ? { ...(root.mcp as Record<string, unknown>) }
      : {};
    const servers = mcp.servers && typeof mcp.servers === 'object'
      ? { ...(mcp.servers as Record<string, unknown>) }
      : {};
    let previous: string[] = [];
    try {
      const parsed = JSON.parse(managedRaw) as unknown;
      if (Array.isArray(parsed)) previous = parsed.map(String);
    } catch { /* absent/corrupt sidecar: merge without deleting user entries */ }
    for (const name of previous) delete servers[name];
    Object.assign(servers, desired);
    mcp.servers = servers;
    root.mcp = mcp;
    const configOut = `${JSON.stringify(root, null, 2)}\n`;
    const managedOut = `${JSON.stringify(Object.keys(desired), null, 2)}\n`;

    if (remote) {
      const cfgWrite = await sshExec(
        remote.sshTarget,
        'mkdir -p ~/.zcode/cli ~/.vibe && cfg=~/.zcode/cli/config.json.vibe-tmp && cat > "$cfg" && mv "$cfg" ~/.zcode/cli/config.json',
        { input: configOut, timeoutMs: 15_000 },
      );
      if (cfgWrite.code !== 0) throw new Error(cfgWrite.stderr.trim() || 'remote ZCode config write failed');
      const sideWrite = await sshExec(
        remote.sshTarget,
        'side=~/.vibe/zcode-managed-mcp.json.vibe-tmp && cat > "$side" && mv "$side" ~/.vibe/zcode-managed-mcp.json',
        { input: managedOut, timeoutMs: 15_000 },
      );
      if (sideWrite.code !== 0) throw new Error(sideWrite.stderr.trim() || 'remote ZCode MCP sidecar write failed');
    } else {
      fs.mkdirSync(path.dirname(config.zcodeConfigFile), { recursive: true });
      const cfgTmp = `${config.zcodeConfigFile}.vibe-tmp`;
      fs.writeFileSync(cfgTmp, configOut);
      fs.renameSync(cfgTmp, config.zcodeConfigFile);
      const side = path.join(config.home, 'zcode-managed-mcp.json');
      const sideTmp = `${side}.vibe-tmp`;
      fs.writeFileSync(sideTmp, managedOut);
      fs.renameSync(sideTmp, side);
    }
    sigCache.set(key, sig);
  } catch (error) {
    log.warn('zcode mcp apply failed', error);
  }
}

// ---- shared local/remote file helpers ---------------------------------------

async function readManagedFile(remotePath: string, remote?: RemoteTarget): Promise<string> {
  if (!remote) {
    const local = resolveHomePath(remotePath);
    try {
      return fs.readFileSync(local, 'utf8');
    } catch {
      return ''; // missing file is fine
    }
  }
  const res = await sshExec(remote.sshTarget, `cat ${remotePath} 2>/dev/null`, { timeoutMs: 15_000 });
  return res.code === 0 ? res.stdout : '';
}

async function writeManagedFile(remotePath: string, content: string, remote?: RemoteTarget): Promise<void> {
  if (!remote) {
    const local = resolveHomePath(remotePath);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, content);
    return;
  }
  // `cat > file` reads the new content from stdin — no shell escaping needed.
  const res = await sshExec(remote.sshTarget, `cat > ${remotePath}`, { input: content, timeoutMs: 15_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || `remote write failed (code ${res.code})`);
}

function resolveHomePath(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// ---- tiny utils -------------------------------------------------------------

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
