import type { DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';

/**
 * Remote (SSH) discovery for Devin.
 *
 * Devin keeps its session list in a SQLite database, and Vibe has no way to
 * query one in place on a remote host — `readRemoteDevinTranscript` and this
 * lister would each have to pull the whole (multi-hundred-MB-scale) file over
 * the wire on every refresh. ZCode and Cursor have the same shape and make the
 * same trade-off, so remote Devin sessions are simply not listed; sessions
 * Vibe itself drives on a remote host still work and are tracked locally.
 */
export async function listRemoteDevinSessions(_host: RemoteHost): Promise<DiscoveredSession[]> {
  void _host;
  return [];
}

export async function readRemoteDevinTranscript(
  _host: RemoteHost,
  _sessionId: string,
): Promise<ChatBlock[]> {
  void _host;
  void _sessionId;
  return [];
}
