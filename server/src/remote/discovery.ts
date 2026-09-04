import zlib from 'node:zlib';
import { log } from '../log.js';
import { parseTranscriptBlocks } from '../sessions/transcript.js';
import { isClaudeSessionId, parseSessionMeta, type DiscoveredSession } from '../sessions/discovery.js';
import { sessionStore } from '../sessions/store.js';
import { listRemoteCodexSessions, readRemoteCodexTranscript } from '../codex/remote.js';
import { listRemoteKimiSessions, readRemoteKimiTranscript } from '../kimi/remote.js';
import { listRemoteKiroSessions, readRemoteKiroTranscript } from '../kiro/remote.js';
import { listRemoteGrokSessions, readRemoteGrokTranscript } from '../grok/remote.js';
import { listRemoteZcodeSessions, readRemoteZcodeTranscript } from '../zcode/remote.js';
import { listRemoteDevinSessions, readRemoteDevinTranscript } from '../devin/remote.js';
import { listRemoteOpencodeSessions, readRemoteOpencodeTranscript } from '../opencode/remote.js';
import { listRemoteCodebuddySessions, readRemoteCodebuddyTranscript } from '../codebuddy/remote.js';
import { listRemoteCursorSessions, readRemoteCursorTranscript } from '../cursor/remote.js';
import type { AgentKind, ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { loginShellCommand, sshExec } from './ssh.js';

// Record/field separators (control chars) keep the bundle unambiguous vs JSON.
const RS = '\x1e';
const FS = '\x1f';

// One round-trip: list the most-recent top-level transcripts and emit, per file,
// a marker line (relpath + mtime) followed by the file's head.
const BUNDLE_CMD = [
  'cd ~/.claude/projects 2>/dev/null || exit 0',
  // `./*/*.jsonl` (not `*/*.jsonl`) so project dirs whose names start with "-"
  // aren't mistaken for `ls` options.
  'ls -1t ./*/*.jsonl 2>/dev/null | head -80 | while IFS= read -r f; do',
  '  m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)',
  `  printf '${RS}%s${FS}%s${RS}\\n' "$f" "$m"`,
  '  head -n 60 "$f"',
  'done',
].join('\n');

const cache = new Map<string, DiscoveredSession[]>();
/** Per-host results across every agent (see {@link listRemoteAgentSessions}). */
const allCache = new Map<string, RemoteDiscovery[]>();

/** A session found on a remote host, tagged with the agent that owns it. */
export interface RemoteDiscovery {
  agent: AgentKind;
  session: DiscoveredSession;
}

/** Drop per-host SSH discovery results (e.g. when hosts change). */
export function clearRemoteDiscoveryCache(): void {
  cache.clear();
  allCache.clear();
}

/** Discover Claude sessions on a remote host (most-recent first). */
export async function listRemoteSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const hit = cache.get(host.name);
  if (hit) return hit;

  const res = await sshExec(host.ssh, loginShellCommand(BUNDLE_CMD), { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }

  // Each file emits: RS <relpath> FS <mtime> RS <head...>. Splitting on RS
  // yields ["", marker0, head0, marker1, head1, ...] — process in pairs.
  const sessions: DiscoveredSession[] = [];
  const parts = res.stdout.split(RS);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const [relPath, mtimeStr] = parts[i].split(FS);
    const head = parts[i + 1];
    if (!relPath) continue;
    const id = relPath.replace(/^.*\//, '').replace(/\.jsonl$/, '');
    if (!isClaudeSessionId(id)) continue;
    const mtime = (Number(mtimeStr) || 0) * 1000 || Date.now();
    const meta = parseSessionMeta(head.split('\n'), id, { createdFallback: mtime, updatedAt: mtime });
    if (meta) sessions.push(meta);
  }

  cache.set(host.name, sessions);
  return sessions;
}

/** cwds Vibe already knows on a host — the only way to locate Cursor chats. */
function knownCwds(hostName: string): string[] {
  return sessionStore
    .list()
    .filter((session) => session.host === hostName)
    .map((session) => session.cwd);
}

/**
 * Discover sessions started directly on a remote host's CLIs, for every agent.
 *
 * Claude/Codex/Kimi/Kiro/Grok are probed in parallel (SSH ControlMaster keeps the
 * extra round-trips cheap); Cursor runs last because it can only find chats
 * whose cwd we can name, and the other agents' results are the best source of
 * cwds actually used on that host.
 */
export async function listRemoteAgentSessions(host: RemoteHost): Promise<RemoteDiscovery[]> {
  const hit = allCache.get(host.name);
  if (hit) return hit;

  // One cheap round-trip first: an unreachable host would otherwise hang five
  // separate probes, and this also warms the SSH ControlMaster so the per-agent
  // commands below reuse a single authenticated connection.
  const probe = await sshExec(host.ssh, 'echo VIBE_OK', { timeoutMs: 12_000 });
  if (!probe.stdout.includes('VIBE_OK')) {
    log.debug(`remote discovery skipped for ${host.name}: ${probe.timedOut ? 'timed out' : probe.stderr.trim().slice(0, 120)}`);
    return [];
  }

  const tag = (agent: AgentKind) => (sessions: DiscoveredSession[]): RemoteDiscovery[] =>
    sessions.map((session) => ({ agent, session }));
  const safely = async (agent: AgentKind, run: () => Promise<DiscoveredSession[]>): Promise<RemoteDiscovery[]> => {
    try {
      return tag(agent)(await run());
    } catch (err) {
      log.debug(`remote ${agent} discovery failed for ${host.name}`, err);
      return [];
    }
  };

  const groups = await Promise.all([
    safely('claude', () => listRemoteSessions(host)),
    safely('codex', () => listRemoteCodexSessions(host)),
    safely('kimi', () => listRemoteKimiSessions(host)),
    safely('kiro', () => listRemoteKiroSessions(host)),
    safely('grok', () => listRemoteGrokSessions(host)),
    safely('zcode', () => listRemoteZcodeSessions(host)),
    safely('codebuddy', () => listRemoteCodebuddySessions(host)),
    safely('opencode', () => listRemoteOpencodeSessions(host)),
    safely('devin', () => listRemoteDevinSessions(host)),
  ]);
  const found = groups.flat();

  const cwds = [...knownCwds(host.name), ...found.map((entry) => entry.session.cwd)];
  found.push(...(await safely('cursor', () => listRemoteCursorSessions(host, cwds))));

  // An id can only belong to one agent; first writer wins (claude → … → cursor).
  const byId = new Map<string, RemoteDiscovery>();
  for (const entry of found) {
    if (!byId.has(entry.session.claudeSessionId)) byId.set(entry.session.claudeSessionId, entry);
  }
  const all = [...byId.values()].sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  log.debug(`remote discovery ${host.name}: ${all.length} session(s)`);
  allCache.set(host.name, all);
  return all;
}

/** Resolve a single remote Claude session's metadata (for continuing it). */
export async function getRemoteSessionInfo(host: RemoteHost, claudeSessionId: string): Promise<DiscoveredSession | null> {
  if (!isClaudeSessionId(claudeSessionId)) return null;
  const cmd = `f=$(ls -1 ~/.claude/projects/*/${claudeSessionId}.jsonl 2>/dev/null | head -1); [ -n "$f" ] && head -n 80 "$f"`;
  const res = await sshExec(host.ssh, loginShellCommand(cmd), { timeoutMs: 15_000 });
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const now = Date.now();
  return parseSessionMeta(res.stdout.split('\n'), claudeSessionId, { createdFallback: now, updatedAt: now });
}

/**
 * Resolve a remote session (any agent) so it can be opened/continued. Uses the
 * cached discovery pass when possible, then falls back to a direct per-id Claude
 * lookup (a Claude session can exist without being in the bounded newest-80 list).
 */
export async function resolveRemoteSession(host: RemoteHost, sessionId: string): Promise<RemoteDiscovery | null> {
  const cached = allCache.get(host.name)?.find((entry) => entry.session.claudeSessionId === sessionId);
  if (cached) return cached;

  const hit = (await listRemoteAgentSessions(host)).find((entry) => entry.session.claudeSessionId === sessionId);
  if (hit) return hit;

  const claude = await getRemoteSessionInfo(host, sessionId);
  return claude ? { agent: 'claude', session: claude } : null;
}

/** Read a remote session's full transcript into normalized blocks.
 *  The transcript is fetched gzip-compressed and base64-wrapped (base64 so the
 *  binary gzip stream survives the utf8 stdout channel). JSONL compresses
 *  ~6-10x, which keeps multi-MB remote sessions well under the SSH timeout that
 *  a raw `cat` would blow through. */
export async function readRemoteTranscript(host: RemoteHost, claudeSessionId: string): Promise<ChatBlock[]> {
  if (!isClaudeSessionId(claudeSessionId)) return [];
  const cmd = `gzip -c ~/.claude/projects/*/${claudeSessionId}.jsonl 2>/dev/null | base64`;
  const res = await sshExec(host.ssh, loginShellCommand(cmd), { timeoutMs: 90_000 });
  if (res.code !== 0 || !res.stdout) return [];
  try {
    const raw = zlib.gunzipSync(Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64')).toString('utf8');
    return parseTranscriptBlocks(raw).blocks;
  } catch (err) {
    log.debug(`gunzip transcript failed for ${host.name}`, err);
    return [];
  }
}

/** Read a remote session's native transcript for whichever agent owns it. */
export async function readRemoteAgentTranscript(
  host: RemoteHost,
  agent: AgentKind,
  sessionId: string,
  cwd: string,
): Promise<ChatBlock[]> {
  try {
    switch (agent) {
      case 'codex':
        return await readRemoteCodexTranscript(host, sessionId);
      case 'kimi':
        return await readRemoteKimiTranscript(host, sessionId);
      case 'kiro':
        return await readRemoteKiroTranscript(host, sessionId);
      case 'grok':
        return await readRemoteGrokTranscript(host, sessionId);
      case 'zcode':
        return await readRemoteZcodeTranscript(host, sessionId);
      case 'codebuddy':
        return await readRemoteCodebuddyTranscript(host, sessionId);
      case 'opencode':
        return await readRemoteOpencodeTranscript(host, sessionId);
      case 'devin':
        return await readRemoteDevinTranscript(host, sessionId);
      case 'cursor':
        return await readRemoteCursorTranscript(host, sessionId, cwd);
      default:
        return await readRemoteTranscript(host, sessionId);
    }
  } catch (err) {
    log.debug(`remote ${agent} transcript failed for ${host.name}`, err);
    return [];
  }
}
