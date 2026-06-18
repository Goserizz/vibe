import { log } from '../log.js';
import { parseTranscriptBlocks } from '../sessions/transcript.js';
import { isClaudeSessionId, parseSessionMeta, type DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { sshExec } from './ssh.js';

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

interface CacheEntry {
  at: number;
  sessions: DiscoveredSession[];
}
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 8_000;

/** Discover Claude sessions on a remote host (most-recent first). */
export async function listRemoteSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const cached = cache.get(host.name);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.sessions;

  const res = await sshExec(host.ssh, BUNDLE_CMD, { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return cached?.sessions ?? [];
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

  cache.set(host.name, { at: Date.now(), sessions });
  return sessions;
}

/** Resolve a single remote session's metadata (for continuing it). */
export async function getRemoteSessionInfo(host: RemoteHost, claudeSessionId: string): Promise<DiscoveredSession | null> {
  if (!isClaudeSessionId(claudeSessionId)) return null;
  const cmd = `f=$(ls -1 ~/.claude/projects/*/${claudeSessionId}.jsonl 2>/dev/null | head -1); [ -n "$f" ] && head -n 80 "$f"`;
  const res = await sshExec(host.ssh, cmd, { timeoutMs: 15_000 });
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const now = Date.now();
  return parseSessionMeta(res.stdout.split('\n'), claudeSessionId, { createdFallback: now, updatedAt: now });
}

/** Read a remote session's full transcript into normalized blocks. */
export async function readRemoteTranscript(host: RemoteHost, claudeSessionId: string): Promise<ChatBlock[]> {
  if (!isClaudeSessionId(claudeSessionId)) return [];
  const cmd = `cat ~/.claude/projects/*/${claudeSessionId}.jsonl 2>/dev/null`;
  const res = await sshExec(host.ssh, cmd, { timeoutMs: 25_000 });
  if (res.code !== 0 || !res.stdout) return [];
  return parseTranscriptBlocks(res.stdout).blocks;
}
