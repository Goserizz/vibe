import { compareSessions, type SessionMeta } from '../../../shared/protocol.js';
import { clearRemoteDiscoveryCache } from '../remote/discovery.js';

/**
 * In-memory cache for listAllSessions(). The expensive part is remote SSH
 * discovery (~seconds per host).
 *
 * No TTL: load once (or after host-registry change), then keep in sync via
 * upsert / patch / remove when sessions are created, updated, or deleted.
 */

let cached: SessionMeta[] | null = null;
let inflight: Promise<SessionMeta[]> | null = null;

export function invalidateSessionListCache(): void {
  cached = null;
  clearRemoteDiscoveryCache();
}

export function peekSessionListCache(): SessionMeta[] | null {
  return cached;
}

export function setSessionListCache(sessions: SessionMeta[]): void {
  cached = sessions;
}

/** Patch one row without dropping remote discovery results. */
export function patchSessionListCache(id: string, patch: Partial<SessionMeta>): boolean {
  if (!cached) return false;
  const i = cached.findIndex((s) => s.id === id);
  if (i < 0) return false;
  const prev = cached[i]!;
  cached[i] = { ...prev, ...patch, id: prev.id };
  cached.sort(compareSessions);
  return true;
}

/** Insert or replace a Vibe-managed session in the cache. */
export function upsertSessionListCache(meta: SessionMeta): void {
  if (!cached) return;
  const i = cached.findIndex((s) => s.id === meta.id);
  if (i >= 0) cached[i] = { ...cached[i]!, ...meta };
  else cached.push(meta);
  cached.sort(compareSessions);
}

/** Drop a session (and matching claudeSessionId) from the cache. */
export function removeSessionListCache(id: string): void {
  if (!cached) return;
  cached = cached.filter((s) => s.id !== id && s.claudeSessionId !== id);
}

/** Deduplicate concurrent listAllSessions() while a load is in flight. */
export function getSessionListInflight(): Promise<SessionMeta[]> | null {
  return inflight;
}

export function setSessionListInflight(p: Promise<SessionMeta[]> | null): void {
  inflight = p;
}
