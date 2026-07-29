import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, sshExec } from '../remote/ssh.js';

export interface CodexModel {
  value: string;
  label: string;
  /** Supported `model_reasoning_effort` values (cache's supported_reasoning_levels).
   *  Per-model — e.g. gpt-5.6-* add `max`/`ultra` beyond the low..xhigh ladder. */
  efforts?: string[];
  /** Cache's default_reasoning_level for this model (e.g. 'medium', 'low'). */
  defaultEffort?: string;
}

/** Small valid fallback used when the cache can't be read (fresh install). `auto`
 *  lets Codex pick per its config.toml. */
const FALLBACK: CodexModel[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
];

/**
 * Codex has no `codex models` subcommand, but it caches the provider's model list
 * at ~/.codex/models_cache.json (`{models: [{slug, display_name, visibility, …}]}`).
 * We read that (a cheap local file read, or a `cat` over SSH on a remote host — no
 * subprocess that can hang) and surface the `visibility: "list"` models, prepending
 * `auto` (let Codex pick). Falls back to a small static list if the cache is
 * missing/unreadable. Returns at least the `auto` entry; callers treat length <= 1
 * (i.e. only `auto`) as a miss.
 */
function parseCache(raw: string): CodexModel[] {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  const models: any[] = Array.isArray(obj?.models) ? obj.models : [];
  const out: CodexModel[] = [{ value: 'auto', label: 'Auto' }];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    if (m.visibility && m.visibility !== 'list') continue; // skip hidden/internal
    const value = typeof m.slug === 'string' ? m.slug : '';
    if (!value) continue;
    const label = typeof m.display_name === 'string' ? m.display_name : value;
    // Reasoning levels are per-model — surfaced so the effort picker matches the
    // CLI (5.6 models advertise max/ultra that the older ladder omits).
    const efforts: string[] = [];
    for (const l of Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []) {
      if (l && typeof l === 'object' && typeof l.effort === 'string' && l.effort && !efforts.includes(l.effort)) {
        efforts.push(l.effort);
      }
    }
    const defaultEffort = typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined;
    if (!out.some((x) => x.value === value)) {
      out.push({ value, label, efforts: efforts.length ? efforts : undefined, defaultEffort });
    }
  }
  return out;
}

const TTL_MS = 5 * 60_000;
/** Cache key '' = local; otherwise the remote host name. */
const caches = new Map<string, { at: number; models: CodexModel[] }>();

function cachedOrFallback(key: string): CodexModel[] {
  return caches.get(key)?.models ?? FALLBACK;
}

function storeCache(key: string, models: CodexModel[]): CodexModel[] {
  caches.set(key, { at: Date.now(), models });
  return models;
}

/** Drop a host's (or local '') cached model list — e.g. after its proxy changes. */
export function invalidateCodexModelsCache(hostName?: string): void {
  caches.delete(hostName ?? '');
}

/** List the Codex models the installed CLI advertises (cached ~5 min). Reads the
 *  local ~/.codex/models_cache.json — no `codex models` subcommand exists. */
export function listCodexModels(): CodexModel[] {
  const key = '';
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  try {
    const raw = fs.readFileSync(config.codexModelsCacheFile, 'utf8');
    const models = parseCache(raw);
    if (models.length > 1) return storeCache(key, models);
  } catch (err) {
    log.debug('codex models cache read failed', err);
  }
  return cachedOrFallback(key);
}

/**
 * List Codex models as seen from a remote host (over SSH), reading that host's
 * ~/.codex/models_cache.json with its per-host proxy injected — the same egress
 * the agent turn uses. Codex only writes this cache after it has fetched from its
 * provider, so on a fresh remote install the picker falls back until `codex` has
 * been run there once. Cached ~5 min per host name.
 */
export async function listRemoteCodexModels(hostName: string): Promise<CodexModel[]> {
  const host = hostRegistry.get(hostName);
  if (!host) return listCodexModels();

  const key = host.name;
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;

  // `cat` over a login shell so $HOME resolves; the proxy prefix matches the
  // agent turn's egress. Silence `cat`'s own "no such file" — an empty result is
  // handled below as a cache miss (fresh install that hasn't run codex yet).
  const inner = 'cat "$HOME/.codex/models_cache.json" 2>/dev/null';
  const remoteCmd = proxyEnvPrefix(proxyForAgent(host, 'codex')) + loginShellCommand(inner);
  try {
    const res = await sshExec(host.ssh, remoteCmd, { timeoutMs: 20_000 });
    const models = parseCache(res.stdout);
    if (models.length <= 1) {
      log.debug('remote codex models empty', host.name, cleanRemoteStderr(res.stderr).slice(0, 200));
      return cachedOrFallback(key);
    }
    return storeCache(key, models);
  } catch (err) {
    log.debug('remote codex models read failed', host.name, err);
    return cachedOrFallback(key);
  }
}
