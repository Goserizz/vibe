import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { encodeRemoteId } from '../remote/sessionId.js';
import { patchSessionListCache, removeSessionListCache, upsertSessionListCache } from './listCache.js';
import type { AgentKind, EffortLevel, PermissionMode, SessionMeta } from '../../../shared/protocol.js';

/** Persisted shape (a superset of SessionMeta minus its live run/task flags). */
export interface StoredSession {
  id: string;
  claudeSessionId?: string;
  title: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  /** CLI engine driving this session; absent on legacy data ⇒ 'claude'. */
  agent?: AgentKind;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  archived?: boolean;
  /** Remote host name (from the host registry); undefined = local machine. */
  host?: string;
  /** Account that created/adopted this session. Local sessions are private to
   *  their owner; remote sessions follow the host's owner. Missing on legacy
   *  data ⇒ 'admin'. */
  owner?: string;
  /** True when cwd is an auto-created throwaway folder (kept out of "common dirs"). */
  ephemeral?: boolean;
  /** 切换 agent 时的待注入历史（fidelity=partial 的降级方向才有）。
   *
   * 当目标 adapter 的运行时依赖不可用、无法安全构造原生会话时，把完整历史序列化
   * 成文本暂存在这里，等该会话**第一次发消息**时作为上下文前缀注入，注入后立即
   * 清空。
   * 新增字段，旧数据没有它 —— 向后兼容。 */
  switchPrimer?: string;
}

interface PersistShape {
  sessions: StoredSession[];
  /** Claude session ids the user has dismissed from the Vibe list. */
  hidden: string[];
  /** Session ids the user has favorited/pinned (stored + discovered alike). */
  pinned?: string[];
}

class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private hiddenIds = new Set<string>();
  private pinnedIds = new Set<string>();
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
      const pinned = Array.isArray(parsed) ? [] : parsed.pinned ?? [];
      for (const s of sessions) this.sessions.set(s.id, s);
      for (const h of hidden) this.hiddenIds.add(h);
      for (const p of pinned) this.pinnedIds.add(p);
      log.debug(`loaded ${this.sessions.size} sessions, ${this.hiddenIds.size} hidden, ${this.pinnedIds.size} pinned`);    } catch {
      // first run — nothing persisted yet
    }
  }

  /** Debounced atomic write so rapid updates don't thrash the disk. */
  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeNow();
    }, 250);
  }

  /** Atomic write: temp file + same-directory rename, so a reader never sees a
   *  half-written sessions.json. */
  private writeNow(): void {
    const payload: PersistShape = {
      sessions: [...this.sessions.values()],
      hidden: [...this.hiddenIds],
      pinned: [...this.pinnedIds],
    };
    const tmp = `${config.sessionsFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, config.sessionsFile);
    } catch (err) {
      log.error('failed to persist sessions', err);
    }
  }

  /**
   * 立刻落盘（跳过 debounce）。
   *
   * 用于「低频但关键」的状态变更 —— 比如切换 agent：新注册的原生会话 id 如果
   * 在下一次 debounce 窗口内进程就挂了，会话会仍然指向旧 agent 的原生 id，
   * 用户重开时会续到错误的引擎上。
   */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.writeNow();
  }

  list(): StoredSession[] {
    return [...this.sessions.values()]
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  create(input: { cwd: string; model: string; permissionMode: PermissionMode; effort?: EffortLevel; agent?: AgentKind; title?: string; host?: string; ephemeral?: boolean; owner?: string }): StoredSession {
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
      agent: input.agent,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      host: input.host,
      owner: input.owner,
      ephemeral: input.ephemeral,
    };
    this.sessions.set(session.id, session);
    this.scheduleWrite();
    // Prefer in-place upsert so /sessions keeps remote discovery warm.
    upsertSessionListCache(toMeta(session, false, 'vibe'));
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
    agent?: AgentKind;
    createdAt?: number;
    messageCount?: number;
    host?: string;
    owner?: string;
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
      agent: input.agent,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      messageCount: input.messageCount ?? 0,
      host: input.host,
      owner: input.owner,
    };
    this.sessions.set(session.id, session);
    this.scheduleWrite();
    upsertSessionListCache(toMeta(session, false, 'vibe'));
    return session;
  }

  update(id: string, patch: Partial<StoredSession>): StoredSession | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    const merged: StoredSession = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.sessions.set(id, merged);
    this.scheduleWrite();
    // Patch cache in place — full invalidate here made every turn wipe SSH discovery.
    if (!patchSessionListCache(id, {
      title: merged.title,
      cwd: merged.cwd,
      model: merged.model,
      permissionMode: merged.permissionMode,
      effort: merged.effort,
      agent: merged.agent,
      claudeSessionId: merged.claudeSessionId,
      updatedAt: merged.updatedAt,
      messageCount: merged.messageCount,
      host: merged.host,
      source: 'vibe',
    })) {
      // Not in cache (e.g. cold) — leave cache alone; soft TTL will refresh.
    }
    return merged;
  }

  remove(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (existed) {
      this.scheduleWrite();
      removeSessionListCache(id);
    }
    return existed;
  }

  hide(claudeSessionId: string): void {
    this.hiddenIds.add(claudeSessionId);
    this.scheduleWrite();
    removeSessionListCache(claudeSessionId);
  }

  isHidden(claudeSessionId: string): boolean {
    return this.hiddenIds.has(claudeSessionId);
  }

  /** Favorite/pin a session (stored or discovered). Persists the id and patches
   *  the list cache so the row's `pinned` flips without a full reload. */
  pin(id: string): void {
    if (this.pinnedIds.has(id)) return;
    this.pinnedIds.add(id);
    this.scheduleWrite();
    patchSessionListCache(id, { pinned: true });
  }

  unpin(id: string): void {
    if (!this.pinnedIds.delete(id)) return;
    this.scheduleWrite();
    patchSessionListCache(id, { pinned: false });
  }

  isPinned(id: string): boolean {
    return this.pinnedIds.has(id);
  }
}

export function toMeta(
  s: StoredSession,
  running: boolean,
  source: 'vibe' | 'claude' | 'cursor' | 'codex' | 'kimi' | 'kiro' | 'grok' | 'zcode' | 'codebuddy' | 'opencode' | 'devin' = 'vibe',
  backgroundTasksRunning = false,
): SessionMeta {
  return {
    id: s.id,
    claudeSessionId: s.claudeSessionId,
    title: s.title,
    cwd: s.cwd,
    model: s.model,
    permissionMode: s.permissionMode,
    effort: s.effort ?? (config.defaultEffort as EffortLevel),
    agent: s.agent ?? 'claude',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    backgroundTasksRunning,
    running,
    source,
    host: s.host ?? config.localName,
    owner: s.owner,
    ephemeral: s.ephemeral,
    pinned: sessionStore.isPinned(s.id),
  };
}

export const sessionStore = new SessionStore();
