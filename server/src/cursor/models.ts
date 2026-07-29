import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';

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
const caches = new Map<string, { at: number; models: CursorModel[] }>();

function cachedOrFallback(key: string): CursorModel[] {
  return caches.get(key)?.models ?? FALLBACK;
}

function storeCache(key: string, models: CursorModel[]): CursorModel[] {
  caches.set(key, { at: Date.now(), models });
  return models;
}

/** Drop a host's (or local '') cached model list — e.g. after its proxy changes. */
export function invalidateCursorModelsCache(hostName?: string): void {
  caches.delete(hostName ?? '');
}

/** List the Cursor models the installed CLI exposes (cached ~5 min). */
export async function listCursorModels(): Promise<CursorModel[]> {
  const key = '';
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  const bin = config.cursorExecutable;
  if (!bin) return FALLBACK;
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(bin, ['models'], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const models = parseModels(out);
    if (!models.length) return cachedOrFallback(key);
    return storeCache(key, models);
  } catch (err) {
    log.debug('cursor models list failed', err);
    return cachedOrFallback(key);
  }
}

/**
 * List Cursor models as seen from a remote host (over SSH), with that host's
 * per-host proxy injected — the same env the agent turn uses. Region-gated
 * models (e.g. grok behind some egress IPs) then disappear from the picker
 * instead of failing only at send time. Cached ~5 min per host name.
 */
export async function listRemoteCursorModels(hostName: string): Promise<CursorModel[]> {
  const host = hostRegistry.get(hostName);
  if (!host) return listCursorModels();

  const key = host.name;
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;

  const remoteCmd = proxyEnvPrefix(proxyForAgent(host, 'cursor')) + loginShellCommand(`cursor-agent ${shQuote('models')}`);
  try {
    const res = await sshExec(host.ssh, remoteCmd, { timeoutMs: 20_000 });
    // `cursor-agent models` prints the list on stdout even when some variants
    // are filtered; a non-zero exit with empty stdout is a hard failure.
    const models = parseModels(res.stdout);
    if (!models.length) {
      log.debug('remote cursor models empty', host.name, res.stderr.slice(0, 200));
      return cachedOrFallback(key);
    }
    return storeCache(key, models);
  } catch (err) {
    log.debug('remote cursor models list failed', host.name, err);
    return cachedOrFallback(key);
  }
}
