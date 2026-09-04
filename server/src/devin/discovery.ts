import { config } from '../config.js';
import { log } from '../log.js';
import { openSqliteReadonly, type SqliteDb } from '../switch/sqlite.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import { devinFamilyForModel } from './models.js';

/**
 * Discovery for Devin's own sessions.
 *
 * Devin has a `devin list` subcommand, but it only reports sessions for the
 * *current* directory, which makes it useless for Vibe's global session list.
 * We read its SQLite store directly instead — the same table the CLI itself
 * uses for `session/list`.
 */

/** Devin session ids are readable slugs (`resilient-package`), but Vibe also
 *  writes `vibe-<hex>` ids when switching a session in. Both must be safe to
 *  interpolate into shell commands, so restrict the alphabet. */
const DEVIN_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isDevinSessionId(value: string): boolean {
  return DEVIN_SESSION_RE.test(value);
}

interface SessionRow {
  id: string;
  working_directory: string | null;
  model: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  title: string | null;
  message_count: number | null;
}

/**
 * Count only real conversation turns.
 *
 * A session's node forest is dominated by regenerated system-prefix nodes
 * (several per chain, and multiple chains per session), so a plain row count
 * would badly overstate the message count. `json_extract` is available in
 * SQLite builds with JSON1 — if a build lacks it we fall back to the raw count
 * rather than failing discovery.
 */
function querySessions(db: SqliteDb, limit: number): SessionRow[] {
  const columns = 's.id, s.working_directory, s.model, s.created_at, s.last_activity_at, s.title';
  try {
    return db
      .prepare(
        `select ${columns}, (
           select count(*) from message_nodes m
           where m.session_id = s.id
             and json_extract(m.chat_message, '$.role') in ('user', 'assistant', 'tool')
         ) as message_count
         from sessions s
         where ifnull(s.hidden, 0) = 0
         order by s.last_activity_at desc
         limit ?`,
      )
      .all(limit) as SessionRow[];
  } catch {
    return db
      .prepare(
        `select ${columns}, (
           select count(*) from message_nodes m where m.session_id = s.id
         ) as message_count
         from sessions s
         where ifnull(s.hidden, 0) = 0
         order by s.last_activity_at desc
         limit ?`,
      )
      .all(limit) as SessionRow[];
  }
}

function toDiscovered(row: SessionRow): DiscoveredSession | null {
  const id = String(row.id ?? '');
  if (!isDevinSessionId(id)) return null;
  const cwd = String(row.working_directory ?? '');
  if (!cwd) return null;
  const createdAt = Number(row.created_at) || 0;
  const updatedAt = Number(row.last_activity_at) || createdAt || Date.now();
  const rawTitle = String(row.title ?? '').trim();
  return {
    claudeSessionId: id,
    cwd,
    title: rawTitle ? rawTitle.slice(0, 200) : 'Devin session',
    model: devinFamilyForModel(String(row.model ?? '')) || config.defaultDevinModel,
    createdAt: createdAt > 0 ? createdAt * 1000 : updatedAt,
    updatedAt: updatedAt * 1000,
    messageCount: Number(row.message_count) || 0,
  };
}

/** Discover native Devin sessions on this machine. Best-effort — returns `[]`
 *  when Devin was never run here or the SQLite addon is unavailable. */
export function listDevinSessions(limit = 100): DiscoveredSession[] {
  const db = openSqliteReadonly(config.devinSessionsDb);
  if (!db) return [];
  try {
    const sessions = querySessions(db, limit)
      .map(toDiscovered)
      .filter((session): session is DiscoveredSession => session !== null);
    log.debug(`devin discovery: ${sessions.length} session(s)`);
    return sessions;
  } catch (error) {
    log.debug('devin discovery failed', error);
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Resolve one native Devin session for adoption/continuation. */
export function resolveDevinSessionSync(sessionId: string): DiscoveredSession | null {
  if (!isDevinSessionId(sessionId)) return null;
  const db = openSqliteReadonly(config.devinSessionsDb);
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `select id, working_directory, model, created_at, last_activity_at, title,
                (select count(*) from message_nodes m where m.session_id = ?) as message_count
         from sessions where id = ?`,
      )
      .get(sessionId, sessionId) as SessionRow | undefined;
    return row ? toDiscovered(row) : null;
  } catch (error) {
    log.debug(`devin resolve failed for ${sessionId}`, error);
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
