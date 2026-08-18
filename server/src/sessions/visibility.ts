import { hostRegistry } from '../remote/hosts.js';
import { parseSessionId } from '../remote/sessionId.js';
import { sessionStore } from './store.js';
import { ADMIN_ACCOUNT, type SessionMeta } from '../../../shared/protocol.js';

/**
 * Multi-account visibility rules, shared by the HTTP API, the WS hub, and the
 * session list so every surface agrees on what an account may see:
 *
 *  - Accounts are peers: each one — admin included — only sees sessions on the
 *    hosts it added. Legacy rows/hosts without an owner belong to admin.
 *  - A session on a remote host follows the host's owner.
 *  - The local machine — its sessions, files, and CLI stores — is admin-only
 *    (admin still being the server's own account).
 */

export function sessionVisible(account: string, sessionId: string): boolean {
  const stored = sessionStore.get(sessionId);
  if (stored) {
    if (!stored.host) return account === ADMIN_ACCOUNT; // local machine
    return hostRegistry.visibleTo(account, stored.host);
  }
  const { host } = parseSessionId(sessionId);
  if (!host) return account === ADMIN_ACCOUNT; // discovered local CLI session
  return hostRegistry.visibleTo(account, host);
}

/** Visibility check for an already-built meta row (list filtering). */
export function metaVisible(account: string, meta: SessionMeta): boolean {
  if (!meta.host || hostRegistry.isLocalName(meta.host)) return account === ADMIN_ACCOUNT;
  return hostRegistry.visibleTo(account, meta.host);
}

/** Filter a session list down to what `account` may see. */
export function filterVisibleSessions(account: string, sessions: SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => metaVisible(account, s));
}
