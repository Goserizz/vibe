import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { oauthStore } from './oauth.js';
import type { McpConfigSnapshot, McpServerDef } from '../../../shared/protocol.js';

/** Scope name used for sessions running on this machine (no SSH host). */
export const LOCAL_SCOPE = 'local';

interface McpFile {
  servers: Record<string, McpServerDef>;
  /** Scope (host name or 'local') -> enabled server names. */
  enabled: Record<string, string[]>;
}

/** Normalize + validate a server definition. Returns undefined if invalid. */
function normalize(def: McpServerDef): McpServerDef | undefined {
  const name = def.name?.trim();
  if (!name) return undefined;
  const transport = def.transport === 'sse' || def.transport === 'http' ? def.transport : 'stdio';
  const out: McpServerDef = { name, transport };
  if (transport === 'stdio') {
    const command = def.command?.trim();
    if (!command) return undefined;
    out.command = command;
    if (Array.isArray(def.args)) out.args = def.args.map(String);
    if (def.env && typeof def.env === 'object') out.env = stringifyEnv(def.env);
  } else {
    const url = def.url?.trim();
    if (!url) return undefined;
    out.url = url;
    // OAuth only applies to remote (http/sse) servers.
    if (def.auth === 'oauth') out.auth = 'oauth';
    else if (def.headers && typeof def.headers === 'object') out.headers = stringifyEnv(def.headers);
  }
  return out;
}

function stringifyEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (k) out[k] = String(v ?? '');
  return out;
}

/**
 * Registry of MCP server definitions plus per-scope enable lists, persisted to
 * ~/.vibe/mcp.json. Definitions live here once and are referenced by name from
 * each scope (the local machine or a remote host), so the same server can be
 * enabled in several places without re-entering its config.
 */
class McpRegistry {
  private servers = new Map<string, McpServerDef>();
  private enabled = new Map<string, Set<string>>();

  constructor() {
    this.load();
  }

  private load(): void {
    let parsed: McpFile;
    try {
      parsed = JSON.parse(fs.readFileSync(config.mcpFile, 'utf8')) as McpFile;
    } catch {
      return; /* first run */
    }
    if (parsed && typeof parsed === 'object') {
      if (parsed.servers && typeof parsed.servers === 'object') {
        for (const [name, def] of Object.entries(parsed.servers)) {
          const clean = normalize({ ...(def as McpServerDef), name });
          if (clean) this.servers.set(clean.name, clean);
        }
      }
      if (parsed.enabled && typeof parsed.enabled === 'object') {
        for (const [scope, names] of Object.entries(parsed.enabled)) {
          if (!Array.isArray(names)) continue;
          const set = new Set<string>(names.map((n) => String(n)).filter((n) => this.servers.has(n)));
          if (set.size) this.enabled.set(scope, set);
        }
      }
    }
  }

  private save(): void {
    try {
      const tmp = `${config.mcpFile}.tmp`;
      const data: McpFile = {
        servers: Object.fromEntries(this.servers),
        enabled: Object.fromEntries([...this.enabled.entries()].map(([k, v]) => [k, [...v]])),
      };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, config.mcpFile);
    } catch (err) {
      log.error('failed to persist mcp registry', err);
    }
  }

  list(): McpServerDef[] {
    return [...this.servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): McpServerDef | undefined {
    return this.servers.get(name);
  }

  /** Insert or update a server definition. */
  upsert(def: McpServerDef): McpServerDef | undefined {
    const clean = normalize(def);
    if (!clean) return undefined;
    this.servers.set(clean.name, clean);
    this.save();
    return clean;
  }

  remove(name: string): boolean {
    const ok = this.servers.delete(name);
    if (!ok) return false;
    // Drop it from every scope's enable list.
    for (const [, set] of this.enabled) set.delete(name);
    // Best-effort: revoke + drop any OAuth tokens bound to it.
    void oauthStore.disconnect(name);
    this.save();
    return true;
  }

  /** Names enabled for a scope. */
  enabledFor(scope: string): string[] {
    return [...(this.enabled.get(scope) ?? [])];
  }

  /** Set the enabled server names for a scope (names not in the registry are ignored). */
  setEnabled(scope: string, names: string[]): void {
    const set = new Set<string>(names.filter((n) => this.servers.has(n)));
    if (set.size) this.enabled.set(scope, set);
    else this.enabled.delete(scope);
    this.save();
  }

  /** Resolve the enabled server definitions for a scope, in stored order. */
  resolveForScope(scope: string): McpServerDef[] {
    const names = this.enabled.get(scope);
    if (!names?.size) return [];
    const out: McpServerDef[] = [];
    for (const name of this.list()) if (names.has(name.name)) out.push(name);
    return out;
  }

  snapshot(): McpConfigSnapshot {
    const enabled: Record<string, string[]> = {};
    for (const [scope, set] of this.enabled) enabled[scope] = [...set];
    return { servers: this.list(), enabled, oauth: oauthStore.snapshotStatus() };
  }
}

export const mcpRegistry = new McpRegistry();
