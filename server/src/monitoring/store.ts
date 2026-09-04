import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { openSqlite, type SqliteDb } from '../switch/sqlite.js';
import type {
  Monitor,
  MonitorEvent,
  MonitorInput,
  MonitorProbe,
  MonitorProbeResult,
  MonitorStatus,
} from '../../../shared/protocol.js';

interface MonitorRow {
  id: string;
  owner: string;
  name: string;
  enabled: number;
  session_id: string | null;
  host: string | null;
  cwd: string | null;
  interval_ms: number;
  probe_json: string;
  action_mode: 'notify' | 'wake-agent';
  instructions: string;
  max_wake_attempts: number;
  remind_every_ms: number;
  notify_on_recovery: number;
  status: MonitorStatus;
  created_at: number;
  updated_at: number;
  next_check_at: number | null;
  last_check_at: number | null;
  last_healthy_at: number | null;
  last_summary: string | null;
  last_error: string | null;
  consecutive_failures: number;
  active_event_id: string | null;
  lease_owner: string | null;
  lease_until: number | null;
}

interface EventRow {
  id: string;
  monitor_id: string;
  kind: 'unhealthy' | 'probe-error';
  status: 'open' | 'handling' | 'resolved' | 'escalated';
  summary: string;
  detail: string | null;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  attempt_count: number;
  last_dispatch_at: number | null;
  next_dispatch_at: number | null;
  dispatch_lease_owner: string | null;
  dispatch_lease_until: number | null;
}

export interface StoredMonitor extends Monitor {
  owner: string;
}

export interface ProbeTransition {
  monitor: StoredMonitor;
  event?: MonitorEvent;
  opened?: boolean;
  resolved?: MonitorEvent;
}

export class MonitorStoreUnavailableError extends Error {
  constructor() {
    super('monitor storage is unavailable because SQLite could not be loaded');
  }
}

function parseProbe(raw: string): MonitorProbe {
  return JSON.parse(raw) as MonitorProbe;
}

function optionalNumber(value: number | null): number | undefined {
  return value == null ? undefined : value;
}

function optionalString(value: string | null): string | undefined {
  return value == null ? undefined : value;
}

function rowToMonitor(row: MonitorRow): StoredMonitor {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    enabled: row.enabled === 1,
    sessionId: optionalString(row.session_id),
    host: optionalString(row.host),
    cwd: optionalString(row.cwd),
    intervalMs: row.interval_ms,
    probe: parseProbe(row.probe_json),
    actionMode: row.action_mode,
    instructions: row.instructions,
    maxWakeAttempts: row.max_wake_attempts,
    remindEveryMs: row.remind_every_ms,
    notifyOnRecovery: row.notify_on_recovery === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextCheckAt: optionalNumber(row.next_check_at),
    lastCheckAt: optionalNumber(row.last_check_at),
    lastHealthyAt: optionalNumber(row.last_healthy_at),
    lastSummary: optionalString(row.last_summary),
    lastError: optionalString(row.last_error),
    consecutiveFailures: row.consecutive_failures,
    activeEventId: optionalString(row.active_event_id),
  };
}

function rowToEvent(row: EventRow): MonitorEvent {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    detail: optionalString(row.detail),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: optionalNumber(row.resolved_at),
    attemptCount: row.attempt_count,
    lastDispatchAt: optionalNumber(row.last_dispatch_at),
    nextDispatchAt: optionalNumber(row.next_dispatch_at),
  };
}

/** SQLite-backed desired state and incident log. Every state transition that
 * couples a monitor with its current incident is committed synchronously, so a
 * process crash cannot persist one half without the other. */
export class MonitorStore {
  private db: SqliteDb | null = null;

  constructor(file = config.monitorsDb) {
    let db: SqliteDb | null = null;
    try {
      db = openSqlite(file);
      if (!db) return;
      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(`
      CREATE TABLE IF NOT EXISTS monitor (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        host TEXT,
        cwd TEXT,
        interval_ms INTEGER NOT NULL,
        probe_json TEXT NOT NULL,
        action_mode TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        max_wake_attempts INTEGER NOT NULL DEFAULT 3,
        remind_every_ms INTEGER NOT NULL DEFAULT 300000,
        notify_on_recovery INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_check_at INTEGER,
        last_check_at INTEGER,
        last_healthy_at INTEGER,
        last_summary TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        active_event_id TEXT,
        lease_owner TEXT,
        lease_until INTEGER
      );

      CREATE TABLE IF NOT EXISTS monitor_event (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        summary TEXT NOT NULL,
        detail TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        resolved_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_dispatch_at INTEGER,
        next_dispatch_at INTEGER,
        dispatch_lease_owner TEXT,
        dispatch_lease_until INTEGER
      );

      CREATE INDEX IF NOT EXISTS monitor_due_idx
        ON monitor(enabled, next_check_at, lease_until);
      CREATE INDEX IF NOT EXISTS monitor_owner_idx
        ON monitor(owner, updated_at DESC);
      CREATE INDEX IF NOT EXISTS monitor_event_active_idx
        ON monitor_event(monitor_id, status, next_dispatch_at);
      `);
      for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        try { fs.chmodSync(candidate, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
      }
      this.db = db;
    } catch (error) {
      log.error(`monitor SQLite initialization failed (${file}); monitoring is disabled`, error);
      try { db?.close(); } catch { /* already unusable */ }
    }
  }

  available(): boolean {
    return this.db !== null;
  }

  private required(): SqliteDb {
    if (!this.db) throw new MonitorStoreUnavailableError();
    return this.db;
  }

  close(): void {
    this.db?.close();
  }

  list(owner: string): StoredMonitor[] {
    const rows = this.required()
      .prepare('SELECT * FROM monitor WHERE owner = ? ORDER BY updated_at DESC')
      .all(owner) as MonitorRow[];
    return rows.map(rowToMonitor);
  }

  get(id: string): StoredMonitor | undefined {
    const row = this.required().prepare('SELECT * FROM monitor WHERE id = ?').get(id) as MonitorRow | undefined;
    return row ? rowToMonitor(row) : undefined;
  }

  getOwned(id: string, owner: string): StoredMonitor | undefined {
    const row = this.required()
      .prepare('SELECT * FROM monitor WHERE id = ? AND owner = ?')
      .get(id, owner) as MonitorRow | undefined;
    return row ? rowToMonitor(row) : undefined;
  }

  create(owner: string, input: MonitorInput, now = Date.now()): StoredMonitor {
    const id = `mon_${crypto.randomUUID()}`;
    this.required().prepare(`
      INSERT INTO monitor (
        id, owner, name, enabled, session_id, host, cwd, interval_ms,
        probe_json, action_mode, instructions, max_wake_attempts,
        remind_every_ms, notify_on_recovery, status, created_at, updated_at,
        consecutive_failures
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0)
    `).run(
      id,
      owner,
      input.name,
      input.sessionId ?? null,
      input.host ?? null,
      input.cwd ?? null,
      input.intervalMs,
      JSON.stringify(input.probe),
      input.actionMode,
      input.instructions,
      input.maxWakeAttempts,
      input.remindEveryMs,
      input.notifyOnRecovery ? 1 : 0,
      now,
      now,
    );
    return this.get(id)!;
  }

  update(id: string, owner: string, patch: Partial<MonitorInput>, now = Date.now()): StoredMonitor | undefined {
    const current = this.getOwned(id, owner);
    if (!current) return undefined;
    const has = (key: keyof MonitorInput): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    const next: MonitorInput = {
      name: patch.name ?? current.name,
      sessionId: has('sessionId') ? patch.sessionId : current.sessionId,
      host: has('host') ? patch.host : current.host,
      cwd: has('cwd') ? patch.cwd : current.cwd,
      intervalMs: patch.intervalMs ?? current.intervalMs,
      probe: patch.probe ?? current.probe,
      actionMode: patch.actionMode ?? current.actionMode,
      instructions: patch.instructions ?? current.instructions,
      maxWakeAttempts: patch.maxWakeAttempts ?? current.maxWakeAttempts,
      remindEveryMs: patch.remindEveryMs ?? current.remindEveryMs,
      notifyOnRecovery: patch.notifyOnRecovery ?? current.notifyOnRecovery,
    };
    const rearmEvent = Boolean(current.enabled && current.activeEventId && (
      next.sessionId !== current.sessionId
      || next.host !== current.host
      || next.cwd !== current.cwd
      || JSON.stringify(next.probe) !== JSON.stringify(current.probe)
      || next.actionMode !== current.actionMode
      || next.instructions !== current.instructions
      || next.maxWakeAttempts !== current.maxWakeAttempts
      || next.remindEveryMs !== current.remindEveryMs
    ));
    const db = this.required();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE monitor SET
          name = ?, session_id = ?, host = ?, cwd = ?, interval_ms = ?,
          probe_json = ?, action_mode = ?, instructions = ?,
          max_wake_attempts = ?, remind_every_ms = ?, notify_on_recovery = ?,
          updated_at = ?, next_check_at = CASE WHEN enabled = 1 THEN ? ELSE next_check_at END,
          lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND owner = ?
      `).run(
        next.name,
        next.sessionId ?? null,
        next.host ?? null,
        next.cwd ?? null,
        next.intervalMs,
        JSON.stringify(next.probe),
        next.actionMode,
        next.instructions,
        next.maxWakeAttempts,
        next.remindEveryMs,
        next.notifyOnRecovery ? 1 : 0,
        now,
        now,
        id,
        owner,
      );
      if (rearmEvent && current.activeEventId) {
        db.prepare(`
          UPDATE monitor_event SET status = 'open', attempt_count = 0,
            last_dispatch_at = NULL, next_dispatch_at = ?,
            dispatch_lease_owner = NULL, dispatch_lease_until = NULL
          WHERE id = ? AND status <> 'resolved'
        `).run(now, current.activeEventId);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
    return this.getOwned(id, owner);
  }

  setEnabled(id: string, owner: string, enabled: boolean, now = Date.now()): StoredMonitor | undefined {
    const current = this.getOwned(id, owner);
    if (!current) return undefined;
    if (current.enabled === enabled) return current;
    const db = this.required();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE monitor SET
          enabled = ?, status = ?, updated_at = ?, next_check_at = ?,
          lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND owner = ?
      `).run(enabled ? 1 : 0, enabled ? 'checking' : 'paused', now, enabled ? now : null, id, owner);
      if (enabled && current.activeEventId) {
        // Pause → resume is an explicit user retry: replenish the wake budget
        // for an unresolved/escalated incident, then verify it immediately.
        db.prepare(`
          UPDATE monitor_event SET status = 'open', attempt_count = 0,
            last_dispatch_at = NULL, next_dispatch_at = ?,
            dispatch_lease_owner = NULL, dispatch_lease_until = NULL
          WHERE id = ? AND status <> 'resolved'
        `).run(now, current.activeEventId);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
    return this.getOwned(id, owner);
  }

  delete(id: string, owner: string): boolean {
    const result = this.required().prepare('DELETE FROM monitor WHERE id = ? AND owner = ?').run(id, owner) as {
      changes?: number;
    };
    return (result.changes ?? 0) > 0;
  }

  deleteOwnedBy(owner: string): number {
    const result = this.required().prepare('DELETE FROM monitor WHERE owner = ?').run(owner) as { changes?: number };
    return result.changes ?? 0;
  }

  /** A deleted conversation cannot handle future incidents. Pause attached
   * monitors rather than leaving recurring commands silently active. */
  pauseForSession(sessionId: string, owner: string, now = Date.now()): string[] {
    const rows = this.required()
      .prepare('SELECT id FROM monitor WHERE owner = ? AND session_id = ? AND enabled = 1')
      .all(owner, sessionId) as Array<{ id: string }>;
    if (!rows.length) return [];
    this.required().prepare(`
      UPDATE monitor SET enabled = 0, status = 'paused', next_check_at = NULL,
        updated_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE owner = ? AND session_id = ? AND enabled = 1
    `).run(now, owner, sessionId);
    return rows.map((row) => row.id);
  }

  pauseForHost(host: string, owner: string, now = Date.now()): string[] {
    const rows = this.required()
      .prepare('SELECT id FROM monitor WHERE owner = ? AND host = ? AND enabled = 1')
      .all(owner, host) as Array<{ id: string }>;
    if (!rows.length) return [];
    this.required().prepare(`
      UPDATE monitor SET enabled = 0, status = 'paused', next_check_at = NULL,
        updated_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE owner = ? AND host = ? AND enabled = 1
    `).run(now, owner, host);
    return rows.map((row) => row.id);
  }

  /** Atomically lease due monitors. The probe itself runs outside the SQLite
   * transaction; another worker may reclaim it after lease expiry. */
  claimDue(now: number, workerId: string, leaseMs: number, limit = 8): StoredMonitor[] {
    const db = this.required();
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(`
        SELECT * FROM monitor
        WHERE enabled = 1
          AND next_check_at IS NOT NULL
          AND next_check_at <= ?
          AND (lease_until IS NULL OR lease_until < ?)
        ORDER BY next_check_at ASC
        LIMIT ?
      `).all(now, now, limit) as MonitorRow[];
      const update = db.prepare(`
        UPDATE monitor SET lease_owner = ?, lease_until = ?, status = 'checking'
        WHERE id = ? AND enabled = 1 AND (lease_until IS NULL OR lease_until < ?)
      `);
      const claimed: MonitorRow[] = [];
      for (const row of rows) {
        const result = update.run(workerId, now + leaseMs, row.id, now) as { changes?: number };
        if ((result.changes ?? 0) > 0) claimed.push({ ...row, status: 'checking' });
      }
      db.exec('COMMIT');
      return claimed.map(rowToMonitor);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /** Commit one observation and open/update/resolve its continuous incident. */
  recordProbeResult(
    id: string,
    workerId: string | undefined,
    result: MonitorProbeResult,
    now = Date.now(),
  ): ProbeTransition | undefined {
    const db = this.required();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM monitor WHERE id = ?').get(id) as MonitorRow | undefined;
      if (!row) {
        db.exec('COMMIT');
        return undefined;
      }
      if (workerId && row.lease_owner !== workerId) {
        db.exec('COMMIT');
        return undefined;
      }

      // A manual test of a draft/paused monitor records no incident and does
      // not silently enable or change its lifecycle status.
      if (row.enabled !== 1) {
        db.prepare(`
          UPDATE monitor SET last_check_at = ?, last_summary = ?, last_error = ?,
            updated_at = ?, lease_owner = NULL, lease_until = NULL
          WHERE id = ?
        `).run(
          result.checkedAt,
          result.summary,
          result.kind === 'probe-error' ? result.summary : null,
          now,
          id,
        );
        db.exec('COMMIT');
        return { monitor: this.get(id)! };
      }

      const activeRow = db.prepare(`
        SELECT * FROM monitor_event
        WHERE monitor_id = ? AND status IN ('open', 'handling', 'escalated')
        ORDER BY first_seen_at DESC LIMIT 1
      `).get(id) as EventRow | undefined;
      let event: MonitorEvent | undefined;
      let resolved: MonitorEvent | undefined;
      let opened = false;

      if (result.healthy) {
        if (activeRow) {
          const recoveryDetail = [
            activeRow.detail,
            `Recovery check: ${result.summary}${result.detail ? `\n${result.detail}` : ''}`,
          ].filter(Boolean).join('\n\n');
          db.prepare(`
            UPDATE monitor_event SET status = 'resolved', resolved_at = ?,
              last_seen_at = ?, detail = ?,
              next_dispatch_at = NULL, dispatch_lease_owner = NULL,
              dispatch_lease_until = NULL
            WHERE id = ?
          `).run(now, now, recoveryDetail || null, activeRow.id);
          resolved = rowToEvent({
            ...activeRow,
            status: 'resolved',
            resolved_at: now,
            last_seen_at: now,
            detail: recoveryDetail || null,
            next_dispatch_at: null,
            dispatch_lease_owner: null,
            dispatch_lease_until: null,
          });
        }
        db.prepare(`
          UPDATE monitor SET status = 'healthy', last_check_at = ?,
            last_healthy_at = ?, last_summary = ?, last_error = NULL,
            consecutive_failures = 0, active_event_id = NULL,
            next_check_at = ?, updated_at = ?, lease_owner = NULL,
            lease_until = NULL
          WHERE id = ?
        `).run(result.checkedAt, now, result.summary, now + row.interval_ms, now, id);
      } else {
        if (activeRow) {
          db.prepare(`
            UPDATE monitor_event SET kind = ?, summary = ?, detail = ?,
              last_seen_at = ? WHERE id = ?
          `).run(
            result.kind === 'probe-error' ? 'probe-error' : 'unhealthy',
            result.summary,
            result.detail ?? null,
            now,
            activeRow.id,
          );
          event = rowToEvent({
            ...activeRow,
            kind: result.kind === 'probe-error' ? 'probe-error' : 'unhealthy',
            summary: result.summary,
            detail: result.detail ?? null,
            last_seen_at: now,
          });
        } else {
          const eventId = `mev_${crypto.randomUUID()}`;
          const kind = result.kind === 'probe-error' ? 'probe-error' : 'unhealthy';
          db.prepare(`
            INSERT INTO monitor_event (
              id, monitor_id, kind, status, summary, detail, first_seen_at,
              last_seen_at, attempt_count, next_dispatch_at
            ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 0, ?)
          `).run(eventId, id, kind, result.summary, result.detail ?? null, now, now, now);
          event = {
            id: eventId,
            monitorId: id,
            kind,
            status: 'open',
            summary: result.summary,
            detail: result.detail,
            firstSeenAt: now,
            lastSeenAt: now,
            attemptCount: 0,
            nextDispatchAt: now,
          };
          opened = true;
        }
        db.prepare(`
          UPDATE monitor SET status = ?, last_check_at = ?, last_summary = ?,
            last_error = ?, consecutive_failures = consecutive_failures + 1,
            active_event_id = ?, next_check_at = ?, updated_at = ?,
            lease_owner = NULL, lease_until = NULL
          WHERE id = ?
        `).run(
          result.kind === 'probe-error' ? 'error' : 'firing',
          result.checkedAt,
          result.summary,
          result.kind === 'probe-error' ? result.summary : null,
          event.id,
          now + row.interval_ms,
          now,
          id,
        );
      }
      db.exec('COMMIT');
      return { monitor: this.get(id)!, event, opened, resolved };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  listEvents(owner: string, monitorId?: string, limit = 100): MonitorEvent[] {
    const rows = monitorId
      ? this.required().prepare(`
          SELECT e.* FROM monitor_event e JOIN monitor m ON m.id = e.monitor_id
          WHERE m.owner = ? AND m.id = ? ORDER BY e.first_seen_at DESC LIMIT ?
        `).all(owner, monitorId, limit)
      : this.required().prepare(`
          SELECT e.* FROM monitor_event e JOIN monitor m ON m.id = e.monitor_id
          WHERE m.owner = ? ORDER BY e.first_seen_at DESC LIMIT ?
        `).all(owner, limit);
    return (rows as EventRow[]).map(rowToEvent);
  }

  getEvent(id: string): MonitorEvent | undefined {
    const row = this.required().prepare('SELECT * FROM monitor_event WHERE id = ?').get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  /** Lease incidents ready for their first notice/wake or a reminder. */
  claimDueEvents(now: number, workerId: string, leaseMs: number, limit = 8): MonitorEvent[] {
    const db = this.required();
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(`
        SELECT e.* FROM monitor_event e
        JOIN monitor m ON m.id = e.monitor_id
        WHERE m.enabled = 1
          AND e.status IN ('open', 'handling')
          AND e.next_dispatch_at IS NOT NULL
          AND e.next_dispatch_at <= ?
          AND e.attempt_count < m.max_wake_attempts
          AND (e.dispatch_lease_until IS NULL OR e.dispatch_lease_until < ?)
        ORDER BY e.next_dispatch_at ASC LIMIT ?
      `).all(now, now, limit) as EventRow[];
      const update = db.prepare(`
        UPDATE monitor_event SET dispatch_lease_owner = ?, dispatch_lease_until = ?
        WHERE id = ? AND (dispatch_lease_until IS NULL OR dispatch_lease_until < ?)
      `);
      const claimed: EventRow[] = [];
      for (const row of rows) {
        const result = update.run(workerId, now + leaseMs, row.id, now) as { changes?: number };
        if ((result.changes ?? 0) > 0) claimed.push(row);
      }
      db.exec('COMMIT');
      return claimed.map(rowToEvent);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  markEventDispatched(id: string, workerId: string, nextDispatchAt: number | undefined, now = Date.now()): MonitorEvent | undefined {
    this.required().prepare(`
      UPDATE monitor_event SET status = 'handling', attempt_count = attempt_count + 1,
        last_dispatch_at = ?, next_dispatch_at = ?, dispatch_lease_owner = NULL,
        dispatch_lease_until = NULL
      WHERE id = ? AND dispatch_lease_owner = ?
    `).run(now, nextDispatchAt ?? null, id, workerId);
    return this.getEvent(id);
  }

  postponeEvent(id: string, workerId: string, nextDispatchAt: number): void {
    this.required().prepare(`
      UPDATE monitor_event SET next_dispatch_at = ?, dispatch_lease_owner = NULL,
        dispatch_lease_until = NULL
      WHERE id = ? AND dispatch_lease_owner = ?
    `).run(nextDispatchAt, id, workerId);
  }

  failEventDispatch(id: string, workerId: string, summary: string, now = Date.now()): MonitorEvent | undefined {
    this.required().prepare(`
      UPDATE monitor_event SET status = 'escalated', summary = ?, last_seen_at = ?,
        next_dispatch_at = NULL, dispatch_lease_owner = NULL,
        dispatch_lease_until = NULL
      WHERE id = ? AND dispatch_lease_owner = ?
    `).run(summary, now, id, workerId);
    return this.getEvent(id);
  }

  /** Stop repeated agent wakes once the configured attempt budget is spent.
   * A subsequent healthy observation can still resolve an escalated event. */
  escalateExhausted(now = Date.now()): MonitorEvent[] {
    const db = this.required();
    const rows = db.prepare(`
      SELECT e.* FROM monitor_event e JOIN monitor m ON m.id = e.monitor_id
      WHERE m.enabled = 1 AND m.action_mode = 'wake-agent'
        AND e.status IN ('open', 'handling')
        AND e.next_dispatch_at IS NOT NULL AND e.next_dispatch_at <= ?
        AND e.attempt_count >= m.max_wake_attempts
    `).all(now) as EventRow[];
    const update = db.prepare(`
      UPDATE monitor_event SET status = 'escalated', next_dispatch_at = NULL,
        dispatch_lease_owner = NULL, dispatch_lease_until = NULL WHERE id = ?
    `);
    for (const row of rows) update.run(row.id);
    return rows.map((row) => rowToEvent({ ...row, status: 'escalated', next_dispatch_at: null }));
  }
}

export const monitorStore = new MonitorStore();
