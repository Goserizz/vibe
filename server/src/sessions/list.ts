import { config } from '../config.js';
import { log } from '../log.js';
import { sessionStore, toMeta } from './store.js';
import { listClaudeSessions, type DiscoveredSession } from './discovery.js';
import { listCursorSessions } from '../cursor/discovery.js';
import { listCodexSessions } from '../codex/discovery.js';
import { listKimiSessions } from '../kimi/discovery.js';
import { listKiroSessions } from '../kiro/discovery.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { listRemoteSessions, clearRemoteDiscoveryCache } from '../remote/discovery.js';
import { encodeRemoteId } from '../remote/sessionId.js';
import { hub } from '../ws/hub.js';
import { compareSessions, type AgentKind, type EffortLevel, type SessionMeta } from '../../../shared/protocol.js';
import {
  getSessionListInflight,
  peekSessionListCache,
  setSessionListCache,
  setSessionListInflight,
  setSessionListInvalidateHook,
} from './listCache.js';

export { invalidateSessionListCache } from './listCache.js';

/**
 * Present a CLI-discovered session as session metadata. For remote hosts the id
 * is namespaced (`host::sessionId`) and tagged with the host name.
 */
export function discoveredToMeta(
  d: DiscoveredSession,
  host: string,
  remote: boolean,
  agent: AgentKind = 'claude',
): SessionMeta {
  return {
    id: remote ? encodeRemoteId(host, d.claudeSessionId) : d.claudeSessionId,
    claudeSessionId: d.claudeSessionId,
    title: d.title,
    cwd: d.cwd,
    model: d.model,
    permissionMode: 'default',
    effort: config.defaultEffort as EffortLevel,
    agent,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    messageCount: d.messageCount,
    running: false,
    source:
      agent === 'cursor'
        ? 'cursor'
        : agent === 'codex'
          ? 'codex'
          : agent === 'kimi'
            ? 'kimi'
            : agent === 'kiro'
              ? 'kiro'
              : 'claude',
    host,
  };
}

/** Overlay live running flags without re-scanning disks/SSH. */
function withLiveRunning(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.map((s) => {
    const running = hub.isRunning(s.id);
    return s.running === running ? s : { ...s, running };
  });
}

/** Sync, local-only snapshot used to seed the cache so `/sessions` is never
 *  empty/blocked while SSH discovery is still in flight. */
function seedFromStore(): SessionMeta[] {
  return sessionStore
    .list()
    .map((s) => toMeta(s, hub.isRunning(s.id), 'vibe'))
    .map((s) => ({ ...s, pinned: sessionStore.isPinned(s.id) }))
    .sort(compareSessions);
}

function ensureSeeded(): void {
  if (!peekSessionListCache()) setSessionListCache(seedFromStore());
}

async function loadAllSessions(): Promise<SessionMeta[]> {
  const stored = sessionStore.list();
  const storeMetas = stored.map((s) => toMeta(s, hub.isRunning(s.id), 'vibe'));

  const known = new Set<string>();
  for (const s of stored) {
    known.add(s.id);
    if (s.claudeSessionId) known.add(s.claudeSessionId);
  }

  const discovered: SessionMeta[] = [];

  try {
    for (const d of await listClaudeSessions()) {
      if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
        discovered.push(discoveredToMeta(d, config.localName, false));
      }
    }
  } catch (err) {
    log.warn('local session discovery failed', err);
  }

  try {
    for (const d of listCursorSessions()) {
      if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
        discovered.push(discoveredToMeta(d, config.localName, false, 'cursor'));
      }
    }
  } catch (err) {
    log.warn('cursor session discovery failed', err);
  }

  try {
    for (const d of listCodexSessions()) {
      if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
        discovered.push(discoveredToMeta(d, config.localName, false, 'codex'));
      }
    }
  } catch (err) {
    log.warn('codex session discovery failed', err);
  }

  try {
    for (const d of listKimiSessions()) {
      if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
        discovered.push(discoveredToMeta(d, config.localName, false, 'kimi'));
      }
    }
  } catch (err) {
    log.warn('kimi session discovery failed', err);
  }

  try {
    for (const d of listKiroSessions()) {
      if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
        discovered.push(discoveredToMeta(d, config.localName, false, 'kiro'));
      }
    }
  } catch (err) {
    log.warn('kiro session discovery failed', err);
  }

  await Promise.all(
    hostRegistry.list().map(async (host) => {
      try {
        for (const d of await listRemoteSessions(host)) {
          const id = encodeRemoteId(host.name, d.claudeSessionId);
          hub.cacheRemoteSession(id, {
            host: host.name,
            sshTarget: host.ssh,
            cwd: d.cwd,
            model: d.model,
            title: d.title,
            proxy: proxyForAgent(host, 'claude'),
          });
          if (!known.has(d.claudeSessionId) && !known.has(id) && !sessionStore.isHidden(id)) {
            discovered.push(discoveredToMeta(d, host.name, true));
          }
        }
      } catch (err) {
        log.debug(`remote discovery failed for ${host.name}`, err);
      }
    }),
  );

  return [...storeMetas, ...discovered]
    .map((s) => ({ ...s, pinned: sessionStore.isPinned(s.id) }))
    .sort(compareSessions);
}

/** Fields the sidebar cares about — skip WS spam when a refresh is a no-op. */
function listRelevantEqual(a: SessionMeta, b: SessionMeta): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.cwd === b.cwd &&
    a.model === b.model &&
    a.permissionMode === b.permissionMode &&
    a.effort === b.effort &&
    a.agent === b.agent &&
    a.updatedAt === b.updatedAt &&
    a.messageCount === b.messageCount &&
    a.running === b.running &&
    a.pinned === b.pinned &&
    a.host === b.host &&
    a.source === b.source &&
    a.claudeSessionId === b.claudeSessionId
  );
}

/** Push add/update/remove to connected web clients after a background rebuild. */
function broadcastSessionListDiff(prev: SessionMeta[] | null, next: SessionMeta[]): void {
  const prevMap = new Map((prev ?? []).map((s) => [s.id, s]));
  const nextIds = new Set<string>();
  for (const s of next) {
    nextIds.add(s.id);
    const old = prevMap.get(s.id);
    if (!old || !listRelevantEqual(old, s)) hub.broadcastMetaObject(s);
  }
  if (!prev) return;
  for (const id of prevMap.keys()) {
    if (!nextIds.has(id)) hub.broadcastSessionGone(id);
  }
}

/** True after at least one full disk/SSH discovery pass finished. Until then
 *  the cache is only the sync store seed — still servable, just incomplete. */
let fullDiscoveryDone = false;

async function loadSessionListAwait(): Promise<SessionMeta[]> {
  const existing = getSessionListInflight();
  if (existing) return existing;

  // Snapshot ids/rows before the async pass so in-place upsert/patch during
  // the load doesn't mutate the baseline we diff against for WS updates.
  const prev = peekSessionListCache()?.slice() ?? null;
  const pending = loadAllSessions()
    .then((sessions) => {
      const live = withLiveRunning(sessions);
      setSessionListCache(live);
      fullDiscoveryDone = true;
      broadcastSessionListDiff(prev, live);
      return live;
    })
    .finally(() => {
      setSessionListInflight(null);
    });
  setSessionListInflight(pending);
  return pending;
}

/**
 * Unified session list for the web UI. Never waits on SSH: serves the warm
 * cache (or a sync store seed) and lets the background refresher fill remotes.
 * Connected clients learn about newly discovered rows via session_meta WS events.
 */
export async function listAllSessions(): Promise<SessionMeta[]> {
  ensureSeeded();
  // Only kick a load if we've never completed one and nothing is in flight.
  // Periodic refresh / host invalidate go through refreshSessionList instead.
  if (!fullDiscoveryDone && !getSessionListInflight()) {
    void loadSessionListAwait().catch((err) => log.debug('session list background load failed', err));
  }
  return withLiveRunning(peekSessionListCache() ?? seedFromStore());
}

/** Wait for a full discovery pass (Telegram /sessions, etc.). */
export async function awaitFullSessionList(): Promise<SessionMeta[]> {
  ensureSeeded();
  return withLiveRunning(await loadSessionListAwait());
}

/** Seed a warm cache immediately, then kick off full discovery in the background. */
export function prefetchSessionList(): void {
  ensureSeeded();
  if (getSessionListInflight()) return;
  void loadSessionListAwait().catch((err) => {
    log.debug('session list prefetch failed', err);
  });
}

/**
 * Background refresh cadence. The cache has no TTL on purpose (it's kept in
 * sync via upsert/patch/remove for Vibe-managed sessions), but per-host remote
 * discovery results are frozen after the first load — so sessions created
 * directly on a remote CLI never surface. Clearing the discovery cache and
 * reloading every cycle lets them appear within one interval, without making
 * any client wait: /sessions always reads the warm cache (~ms). SSH
 * ControlMaster (remote/ssh.ts) keeps each cycle cheap after the first dial.
 */
const REFRESH_INTERVAL_MS = 60_000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Force a reload: drop per-host discovery results, then repopulate the cache.
 *  Safe on an interval — loadSessionListAwait dedups concurrent callers. */
export async function refreshSessionList(): Promise<void> {
  clearRemoteDiscoveryCache();
  await loadSessionListAwait();
}

/** Start the periodic background refresh. `unref`'d so it never blocks exit. */
export function startSessionListRefresher(intervalMs = REFRESH_INTERVAL_MS): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshSessionList().catch((err) => log.debug('session list refresh failed', err));
  }, intervalMs);
  refreshTimer.unref?.();
}

export function stopSessionListRefresher(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// Host add/update/remove calls invalidateSessionListCache(); rebuild off-thread
// while the previous list stays servable.
setSessionListInvalidateHook(() => {
  void refreshSessionList().catch((err) => log.debug('session list invalidate refresh failed', err));
});
