import type { DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';

/**
 * Remote-host ZCode discovery — v1 stubs. ZCode keeps sessions in SQLite, so
 * the file-bundle trick the other agents use over SSH does not apply, and a
 * remote session listing would need an interactive app-server over stdin.
 * Remote hosts still show ZCode install status (remote/agents.ts probe); only
 * session listing/adoption is deferred.
 */

export async function listRemoteZcodeSessions(_host: RemoteHost): Promise<DiscoveredSession[]> {
  void _host;
  return [];
}

export async function readRemoteZcodeTranscript(
  _host: RemoteHost,
  _sessionId: string,
): Promise<ChatBlock[]> {
  void _host;
  void _sessionId;
  return [];
}
