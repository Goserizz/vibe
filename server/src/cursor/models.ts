import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import { createSwrCache } from '../util/swrCache.js';

export interface CursorModel {
  value: string;
  label: string;
}

/** A small, valid fallback used when `cursor-agent models` can't be run. */
const FALLBACK: CursorModel[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { value: 'composer-2.5', label: 'Composer 2.5' },
  { value: 'gpt-5.3-codex', label: 'Codex 5.3' },
  { value: 'gpt-5.5-medium', label: 'GPT-5.5' },
  { value: 'claude-4.6-sonnet-medium', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-8-thinking-high', label: 'Opus 4.8 Thinking' },
];

/**
 * Parse `cursor-agent models` output. Each model is a line `id - Label`; the
 * "(current)"/"(default)" annotations are stripped so the label is clean. The
 * header and the trailing "Tip:" line are ignored.
 */
export function parseModels(out: string): CursorModel[] {
  const models: CursorModel[] = [];
  const seen = new Set<string>();
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    const m = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!m) continue;
    const value = m[1];
    // ids are slugs (letters, digits, dots, hyphens) — guards against prose lines.
    if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(value) || seen.has(value)) continue;
    const label = m[2].replace(/\s*\((?:current|default)\)\s*$/i, '').trim();
    seen.add(value);
    models.push({ value, label: label || value });
  }
  return models;
}

const TTL_MS = 5 * 60_000;
/** Cache key '' = local; otherwise the remote host name. */
const cache = createSwrCache<CursorModel[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  isEmpty: (m) => m.length === 0,
  onError: (key, err) => log.debug('cursor models refresh failed', key || 'local', err),
});

async function fetchLocal(): Promise<CursorModel[] | null> {
  const bin = config.cursorExecutable;
  if (!bin) return null;
  const out = await new Promise<string>((resolve, reject) => {
    execFile(bin, ['models'], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
  return parseModels(out);
}

async function fetchRemote(hostName: string): Promise<CursorModel[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  const remoteCmd = proxyEnvPrefix(proxyForAgent(host, 'cursor')) + loginShellCommand(`cursor-agent ${shQuote('models')}`);
  const res = await sshExec(host.ssh, remoteCmd, { timeoutMs: 20_000 });
  const models = parseModels(res.stdout);
  if (!models.length) {
    log.debug('remote cursor models empty', host.name, res.stderr.slice(0, 200));
    return null;
  }
  return models;
}

/** Drop a host's (or local '') freshness — keep last value, refresh on next serve. */
export function invalidateCursorModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}

/** List the Cursor models the installed CLI exposes. Never blocks on the CLI. */
export async function listCursorModels(): Promise<CursorModel[]> {
  return cache.serve('', fetchLocal);
}

/**
 * List Cursor models as seen from a remote host (over SSH), with that host's
 * per-host proxy injected — the same env the agent turn uses. Region-gated
 * models (e.g. grok behind some egress IPs) then disappear from the picker
 * instead of failing only at send time. Never blocks on SSH.
 */
export async function listRemoteCursorModels(hostName: string): Promise<CursorModel[]> {
  if (!hostRegistry.get(hostName)) return listCursorModels();
  return cache.serve(hostName, () => fetchRemote(hostName));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchCursorModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
}
