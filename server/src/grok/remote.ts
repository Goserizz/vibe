import { log } from '../log.js';
import { bundleMtimeMs, markerCmd, mtimeExpr, parseBundle } from '../remote/bundle.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { isGrokSessionId, parseGrokSummary } from './discovery.js';
import { grokNativeBlocks } from './transcript.js';

// Grok Build stores sessions under ~/.grok/sessions/<encoded-cwd>/<uuid>/
// with summary.json (metadata) and updates.jsonl (ACP conversation log).

const MAX_FILES = 60;
const META_HEAD_BYTES = 8192;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

const BUNDLE_CMD = [
  'grok_home="${GROK_HOME:-$HOME/.grok}"',
  'cd "$grok_home/sessions" 2>/dev/null || exit 0',
  `ls -1td ./*/*/summary.json 2>/dev/null | head -${MAX_FILES} | while IFS= read -r f; do`,
  '  d="${f%/summary.json}"',
  '  l="$d/updates.jsonl"',
  `  m=${mtimeExpr('"$f"')}`,
  '  sz=$(stat -c %s "$l" 2>/dev/null || stat -f %z "$l" 2>/dev/null || echo 0)',
  `  ${markerCmd(['"$d"', '"$m"', '"$sz"'])}`,
  `  head -c ${META_HEAD_BYTES} "$f"`,
  "  printf '\\n'",
  'done',
].join('\n');

/** Discover native Grok CLI sessions on a remote host (most-recent first). */
export async function listRemoteGrokSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const res = await sshExec(host.ssh, loginShellCommand(BUNDLE_CMD), { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote grok discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }

  const sessions: DiscoveredSession[] = [];
  for (const { fields, body } of parseBundle(res.stdout)) {
    if (Number(fields[2]) === 0) continue;
    const dir = fields[0] ?? '';
    const fallbackId = dir.replace(/^.*\//, '');
    const mtime = bundleMtimeMs(fields[1]);
    const session = parseGrokSummary(body, fallbackId, { createdFallback: mtime, updatedAt: mtime });
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote native Grok session's ACP update log into normalized blocks. */
export async function readRemoteGrokTranscript(host: RemoteHost, sessionId: string): Promise<ChatBlock[]> {
  if (!isGrokSessionId(sessionId)) return [];
  const inner = [
    'grok_home="${GROK_HOME:-$HOME/.grok}"',
    `id=${shQuote(sessionId)}`,
    'f=$(ls -1d "$grok_home"/sessions/*/"$id"/updates.jsonl 2>/dev/null | head -1)',
    `[ -n "$f" ] && head -c ${MAX_TRANSCRIPT_BYTES} "$f"`,
  ].join('\n');
  const res = await sshExec(host.ssh, loginShellCommand(inner), { timeoutMs: 25_000 });
  if (res.code !== 0 || !res.stdout.trim()) return [];
  return grokNativeBlocks(res.stdout);
}
