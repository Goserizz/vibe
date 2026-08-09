import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { DiscoveredSession } from '../sessions/discovery.js';

const KIRO_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionMetaFile {
  session_id?: unknown;
  cwd?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  title?: unknown;
  session_state?: {
    rts_model_state?: { model_info?: { model_id?: unknown } };
    agent_name?: unknown;
  };
}

export function isKiroSessionId(value: string): boolean {
  return KIRO_SESSION_RE.test(value);
}

function parseTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countPrompts(jsonlPath: string): number {
  let raw = '';
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.kind === 'Prompt') count += 1;
    } catch {
      /* skip */
    }
  }
  return count;
}

/** Pull one top-level string field out of a (possibly truncated) meta JSON. */
function looseString(raw: string, key: string): string {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return '';
  }
}

/**
 * Derive a Kiro session's metadata from its `<id>.json`. Accepts a truncated
 * head (remote discovery ships only the first few KB, since `session_state`
 * can be megabytes) by falling back to per-field extraction.
 */
export function parseKiroMeta(
  raw: string,
  fallbackId: string,
  times: { createdFallback: number; updatedAt: number },
  opts: { messageCount?: number } = {},
): DiscoveredSession | null {
  let meta: SessionMetaFile | undefined;
  try {
    meta = JSON.parse(raw) as SessionMetaFile;
  } catch {
    meta = undefined; // truncated head — use the loose extractor below
  }
  const id = (typeof meta?.session_id === 'string' ? meta.session_id : looseString(raw, 'session_id')) || fallbackId;
  if (!isKiroSessionId(id)) return null;
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : looseString(raw, 'cwd');
  if (!cwd) return null;
  const model =
    typeof meta?.session_state?.rts_model_state?.model_info?.model_id === 'string'
      ? meta.session_state.rts_model_state.model_info.model_id
      : looseString(raw, 'model_id') || config.defaultKiroModel;
  const rawTitle = typeof meta?.title === 'string' ? meta.title : looseString(raw, 'title');
  const created = parseTime(typeof meta?.created_at === 'string' ? meta.created_at : looseString(raw, 'created_at'));
  const updated = parseTime(typeof meta?.updated_at === 'string' ? meta.updated_at : looseString(raw, 'updated_at'));
  return {
    claudeSessionId: id,
    cwd,
    title: rawTitle.trim() ? rawTitle.trim().slice(0, 200) : 'Kiro session',
    model,
    createdAt: created || times.createdFallback,
    updatedAt: updated || times.updatedAt,
    messageCount: opts.messageCount ?? 0,
  };
}

function toDiscovered(file: string): DiscoveredSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch {
    /* ignore */
  }
  const now = Date.now();
  return parseKiroMeta(
    raw,
    path.basename(file, '.json'),
    {
      createdFallback: stat?.birthtimeMs || stat?.mtimeMs || now,
      updatedAt: stat?.mtimeMs || now,
    },
    { messageCount: countPrompts(file.replace(/\.json$/i, '.jsonl')) },
  );
}

/** Discover native Kiro CLI sessions on this machine (`~/.kiro/sessions/cli`). */
export function listKiroSessions(limit = 100): DiscoveredSession[] {
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(config.kiroSessionsDir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.jsonl'))
      .map((name) => path.join(config.kiroSessionsDir, name));
  } catch {
    return [];
  }

  const sessions = entries
    .map(toDiscovered)
    .filter((session): session is DiscoveredSession => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  log.debug(`kiro discovery: ${sessions.length} session(s)`);
  return sessions;
}

/** Resolve one native Kiro CLI session for adoption/continuation. */
export function resolveKiroSessionSync(sessionId: string): DiscoveredSession | null {
  if (!isKiroSessionId(sessionId)) return null;
  const file = path.join(config.kiroSessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  return toDiscovered(file);
}
