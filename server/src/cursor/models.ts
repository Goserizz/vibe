import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';

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
function parseModels(out: string): CursorModel[] {
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

let cache: { at: number; models: CursorModel[] } | null = null;
const TTL_MS = 5 * 60_000;

/** List the Cursor models the installed CLI exposes (cached ~5 min). */
export async function listCursorModels(): Promise<CursorModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
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
    if (!models.length) return cache?.models ?? FALLBACK;
    cache = { at: Date.now(), models };
    return models;
  } catch (err) {
    log.debug('cursor models list failed', err);
    return cache?.models ?? FALLBACK;
  }
}
