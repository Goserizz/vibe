import { config } from '../config.js';
import { log } from '../log.js';
import { sessionStore, toMeta } from './store.js';
import { listClaudeSessions, type DiscoveredSession } from './discovery.js';
import { listCursorSessions } from '../cursor/discovery.js';
import { listCodexSessions } from '../codex/discovery.js';
import { listKimiSessions } from '../kimi/discovery.js';
import { listKiroSessions } from '../kiro/discovery.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { listRemoteSessions } from '../remote/discovery.js';
import { encodeRemoteId } from '../remote/sessionId.js';
import { hub } from '../ws/hub.js';
import { compareSessions, type AgentKind, type EffortLevel, type SessionMeta } from '../../../shared/protocol.js';
import {
  getSessionListInflight,
  peekSessionListCache,
  setSessionListCache,
  setSessionListInflight,
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

/** Unified session list: Vibe-managed + local CLI + remote hosts (cached).
 *  No TTL — serve the in-memory list; create/update/delete patch it in place.
 *  Full reload only on cold miss or host-registry change. */
export async function listAllSessions(): Promise<SessionMeta[]> {
  const cached = peekSessionListCache();
  if (cached) return withLiveRunning(cached);
  return withLiveRunning(await loadSessionListAwait());
}

async function loadSessionListAwait(): Promise<SessionMeta[]> {
  const existing = getSessionListInflight();
  if (existing) return existing;

  const pending = loadAllSessions()
    .then((sessions) => {
      setSessionListCache(sessions);
      return sessions;
    })
    .finally(() => {
      setSessionListInflight(null);
    });
  setSessionListInflight(pending);
  return pending;
}

/** Warm the cache at process start so the first /sessions is not a cold SSH wait. */
export function prefetchSessionList(): void {
  if (peekSessionListCache() || getSessionListInflight()) return;
  void loadSessionListAwait().catch((err) => {
    log.debug('session list prefetch failed', err);
  });
}
