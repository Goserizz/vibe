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

function toDiscovered(file: string): DiscoveredSession | null {
  let meta: SessionMetaFile;
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionMetaFile;
  } catch {
    return null;
  }
  const id = typeof meta.session_id === 'string' ? meta.session_id : path.basename(file, '.json');
  if (!isKiroSessionId(id)) return null;
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  if (!cwd) return null;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch {
    /* ignore */
  }
  const model =
    typeof meta.session_state?.rts_model_state?.model_info?.model_id === 'string'
      ? meta.session_state.rts_model_state.model_info.model_id
      : config.defaultKiroModel;
  const title =
    typeof meta.title === 'string' && meta.title.trim()
      ? meta.title.trim().slice(0, 200)
      : 'Kiro session';
  const jsonl = file.replace(/\.json$/i, '.jsonl');
  return {
    claudeSessionId: id,
    cwd,
    title,
    model,
    createdAt: parseTime(meta.created_at) || stat?.birthtimeMs || stat?.mtimeMs || Date.now(),
    updatedAt: parseTime(meta.updated_at) || stat?.mtimeMs || Date.now(),
    messageCount: countPrompts(jsonl),
  };
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
