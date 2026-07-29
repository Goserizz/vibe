import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, sshExec } from '../remote/ssh.js';
import { createSwrCache } from '../util/swrCache.js';

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
const cache = createSwrCache<CodexModel[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  // Only `auto` ⇒ miss (fresh install / unreadable cache).
  isEmpty: (m) => m.length <= 1,
  onError: (key, err) => log.debug('codex models refresh failed', key || 'local', err),
});

function fetchLocal(): Promise<CodexModel[] | null> {
  try {
    const raw = fs.readFileSync(config.codexModelsCacheFile, 'utf8');
    return Promise.resolve(parseCache(raw));
  } catch (err) {
    log.debug('codex models cache read failed', err);
    return Promise.resolve(null);
  }
}

async function fetchRemote(hostName: string): Promise<CodexModel[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  // `cat` over a login shell so $HOME resolves; the proxy prefix matches the
  // agent turn's egress. Silence `cat`'s own "no such file" — an empty result is
  // handled below as a cache miss (fresh install that hasn't run codex yet).
  const inner = 'cat "$HOME/.codex/models_cache.json" 2>/dev/null';
  const remoteCmd = proxyEnvPrefix(proxyForAgent(host, 'codex')) + loginShellCommand(inner);
  const res = await sshExec(host.ssh, remoteCmd, { timeoutMs: 20_000 });
  const models = parseCache(res.stdout);
  if (models.length <= 1) {
    log.debug('remote codex models empty', host.name, cleanRemoteStderr(res.stderr).slice(0, 200));
    return null;
  }
  return models;
}

/** Drop a host's (or local '') freshness — keep last value, refresh on next serve. */
export function invalidateCodexModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}

/** List the Codex models the installed CLI advertises. Local file read is sync-fast;
 *  still goes through SWR so callers share one code path. Never blocks on SSH. */
export function listCodexModels(): CodexModel[] {
  return cache.serve('', fetchLocal);
}

/**
 * List Codex models as seen from a remote host (over SSH), reading that host's
 * ~/.codex/models_cache.json with its per-host proxy injected. Never blocks on SSH.
 */
export async function listRemoteCodexModels(hostName: string): Promise<CodexModel[]> {
  if (!hostRegistry.get(hostName)) return listCodexModels();
  return cache.serve(hostName, () => fetchRemote(hostName));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchCodexModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
}
