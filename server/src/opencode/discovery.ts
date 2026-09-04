import { config } from '../config.js';
import { log } from '../log.js';
import { openSqliteReadonly, type SqliteDb } from '../switch/sqlite.js';
import type { DiscoveredSession } from '../sessions/discovery.js';

/** opencode session ids look like `ses_f99ba29a7ffeVQeyoCutfxCZ2V`. */
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]+$/;

export function isOpencodeSessionId(value: string): boolean {
  return OPENCODE_SESSION_RE.test(value);
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  agent: string | null;
  model: string | null;
  time_created: number | null;
  time_updated: number | null;
  message_count: number | null;
}

/** `session.model` is JSON (`{id, providerID, variant}`) — render `provider/id`. */
export function opencodeModelValue(raw: string | null): string {
  if (!raw) return config.defaultOpencodeModel;
  const trimmed = raw.trim();
  if (!trimmed) return config.defaultOpencodeModel;
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; providerID?: unknown };
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const provider = typeof parsed.providerID === 'string' ? parsed.providerID : '';
    if (id && provider) return `${provider}/${id}`;
    return id || trimmed;
  } catch {
    return trimmed;
  }
}

function toDiscovered(row: SessionRow): DiscoveredSession | null {
  const id = String(row.id ?? '');
  if (!isOpencodeSessionId(id)) return null;
  const cwd = String(row.directory ?? '');
  if (!cwd) return null;
  const now = Date.now();
  const created = Number(row.time_created) || 0;
  const updated = Number(row.time_updated) || created || now;
  const rawTitle = String(row.title ?? '').trim();
  return {
    claudeSessionId: id,
    cwd,
    title: rawTitle ? rawTitle.slice(0, 200) : 'opencode session',
    model: opencodeModelValue(row.model),
    createdAt: created || updated,
    updatedAt: updated,
    messageCount: Number(row.message_count) || 0,
  };
}

function querySessions(db: SqliteDb, limit: number): SessionRow[] {
  return db
    .prepare(
      `select s.id, s.directory, s.title, s.agent, s.model, s.time_created, s.time_updated, (
         select count(*) from message m where m.session_id = s.id
       ) as message_count
       from session s
       order by s.time_updated desc
       limit ?`,
    )
    .all(limit) as SessionRow[];
}

/** Discover native opencode sessions on this machine. Best-effort — returns
 *  `[]` when opencode never ran here or the SQLite addon is unavailable. */
export function listOpencodeSessions(limit = 100): DiscoveredSession[] {
  const db = openSqliteReadonly(config.opencodeDb);
  if (!db) return [];
  try {
    const sessions = querySessions(db, limit)
      .map(toDiscovered)
      .filter((session): session is DiscoveredSession => session !== null);
    log.debug(`opencode discovery: ${sessions.length} session(s)`);
    return sessions;
  } catch (error) {
    log.debug('opencode discovery failed', error);
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Resolve one native opencode session for adoption/continuation. */
export function resolveOpencodeSessionSync(sessionId: string): DiscoveredSession | null {
  if (!isOpencodeSessionId(sessionId)) return null;
  const db = openSqliteReadonly(config.opencodeDb);
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `select id, directory, title, agent, model, time_created, time_updated,
                (select count(*) from message m where m.session_id = ?) as message_count
         from session where id = ?`,
      )
      .get(sessionId, sessionId) as SessionRow | undefined;
    return row ? toDiscovered(row) : null;
  } catch (error) {
    log.debug(`opencode resolve failed for ${sessionId}`, error);
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
