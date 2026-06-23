import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';

export interface CodexModel {
  value: string;
  label: string;
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
 * We read that (a cheap local file read — no subprocess, can't hang) and surface
 * the `visibility: "list"` models, prepending `auto` (let Codex pick). Falls back
 * to a small static list if the cache is missing/unreadable.
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
    if (!out.some((x) => x.value === value)) out.push({ value, label });
  }
  return out;
}

let cache: { at: number; models: CodexModel[] } | null = null;
const TTL_MS = 5 * 60_000;

/** List the Codex models the installed CLI advertises (cached ~5 min). */
export function listCodexModels(): CodexModel[] {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  try {
    const raw = fs.readFileSync(config.codexModelsCacheFile, 'utf8');
    const models = parseCache(raw);
    if (models.length > 1) {
      cache = { at: Date.now(), models };
      return models;
    }
  } catch (err) {
    log.debug('codex models cache read failed', err);
  }
  return cache?.models ?? FALLBACK;
}
