import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { encodeRemoteId } from '../remote/sessionId.js';
import type { EffortLevel, PermissionMode, SessionMeta } from '../../../shared/protocol.js';

/** Persisted shape (a superset of SessionMeta minus the live `running` flag). */
export interface StoredSession {
  id: string;
  claudeSessionId?: string;
  title: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  archived?: boolean;
  /** Remote host name (from the host registry); undefined = local machine. */
  host?: string;
}

interface PersistShape {
  sessions: StoredSession[];
  /** Claude session ids the user has dismissed from the Vibe list. */
  hidden: string[];
}

class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private hiddenIds = new Set<string>();
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(config.sessionsFile, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape | StoredSession[];
      // Migrate the original array-only format.
      const sessions = Array.isArray(parsed) ? parsed : parsed.sessions ?? [];
      const hidden = Array.isArray(parsed) ? [] : parsed.hidden ?? [];
      for (const s of sessions) this.sessions.set(s.id, s);
      for (const h of hidden) this.hiddenIds.add(h);
      log.debug(`loaded ${this.sessions.size} sessions, ${this.hiddenIds.size} hidden`);
    } catch {
      // first run — nothing persisted yet
    }
  }

  /** Debounced atomic write so rapid updates don't thrash the disk. */
  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const payload: PersistShape = { sessions: [...this.sessions.values()], hidden: [...this.hiddenIds] };
      const tmp = `${config.sessionsFile}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, config.sessionsFile);
      } catch (err) {
        log.error('failed to persist sessions', err);
      }
    }, 250);
  }

  list(): StoredSession[] {
    return [...this.sessions.values()]
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  create(input: { cwd: string; model: string; permissionMode: PermissionMode; effort?: EffortLevel; title?: string; host?: string }): StoredSession {
    const now = Date.now();
    const uuid = crypto.randomUUID();
    const session: StoredSession = {
      // Remote sessions get a host-namespaced id so the hub routes them over SSH.
      id: input.host ? encodeRemoteId(input.host, uuid) : uuid,
      title: input.title?.trim() || 'New session',
      cwd: input.cwd,
      model: input.model,
      permissionMode: input.permissionMode,
      effort: input.effort,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      host: input.host,
    };
    this.sessions.set(session.id, session);
    this.scheduleWrite();
    return session;
  }

  /** Bring a CLI-discovered session under Vibe management with an explicit id. */
  adopt(input: {
    id: string;
    claudeSessionId: string;
    cwd: string;
    title: string;
    model: string;
    permissionMode: PermissionMode;
    effort?: EffortLevel;
    createdAt?: number;
    messageCount?: number;
    host?: string;
  }): StoredSession {
    const existing = this.sessions.get(input.id);
    if (existing) return existing;
    const now = Date.now();
    const session: StoredSession = {
      id: input.id,
      claudeSessionId: input.claudeSessionId,
      title: input.title?.trim() || 'Session',
      cwd: input.cwd,
      model: input.model,
      permissionMode: input.permissionMode,
      effort: input.effort,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      messageCount: input.messageCount ?? 0,
      host: input.host,
    };
    this.sessions.set(session.id, session);
    this.scheduleWrite();
    return session;
  }

  update(id: string, patch: Partial<StoredSession>): StoredSession | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    const merged: StoredSession = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.sessions.set(id, merged);
    this.scheduleWrite();
    return merged;
  }

  remove(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (existed) this.scheduleWrite();
    return existed;
  }

  hide(claudeSessionId: string): void {
    this.hiddenIds.add(claudeSessionId);
    this.scheduleWrite();
  }

  isHidden(claudeSessionId: string): boolean {
    return this.hiddenIds.has(claudeSessionId);
  }
}

export function toMeta(s: StoredSession, running: boolean, source: 'vibe' | 'claude' = 'vibe'): SessionMeta {
  return {
    id: s.id,
    claudeSessionId: s.claudeSessionId,
    title: s.title,
    cwd: s.cwd,
    model: s.model,
    permissionMode: s.permissionMode,
    effort: s.effort ?? (config.defaultEffort as EffortLevel),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    running,
    source,
    host: s.host ?? config.localName,
  };
}

export const sessionStore = new SessionStore();
