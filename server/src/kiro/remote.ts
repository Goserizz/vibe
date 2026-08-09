import { log } from '../log.js';
import { bundleMtimeMs, markerCmd, mtimeExpr, parseBundle } from '../remote/bundle.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { isKiroSessionId, parseKiroMeta } from './discovery.js';
import { kiroNativeBlocks } from './transcript.js';

// Kiro CLI keeps one `<uuid>.json` (metadata + resumable state) plus a matching
// `<uuid>.jsonl` event log under ~/.kiro/sessions/cli. The `.json` can reach
// megabytes because it embeds the conversation state, so discovery ships only the
// head — the fields we need (session_id/cwd/created_at/updated_at/title) are at
// the top, and `parseKiroMeta` tolerates the truncation.

const MAX_FILES = 60;
const META_HEAD_BYTES = 8192;
/** Bound a transcript fetch: event logs can carry very large tool outputs. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

const BUNDLE_CMD = [
  'cd ~/.kiro/sessions/cli 2>/dev/null || exit 0',
  // `./*.json` never matches `*.jsonl`, so this lists metadata files only.
  `ls -1t ./*.json 2>/dev/null | head -${MAX_FILES} | while IFS= read -r f; do`,
  '  l="${f%.json}.jsonl"',
  `  m=${mtimeExpr('"$f"')}`,
  '  sz=$(stat -c %s "$l" 2>/dev/null || stat -f %z "$l" 2>/dev/null || echo 0)',
  `  ${markerCmd(['"$f"', '"$m"', '"$sz"'])}`,
  `  head -c ${META_HEAD_BYTES} "$f"`,
  "  printf '\\n'",
  'done',
].join('\n');

/** Discover native Kiro CLI sessions on a remote host (most-recent first). */
export async function listRemoteKiroSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const res = await sshExec(host.ssh, loginShellCommand(BUNDLE_CMD), { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote kiro discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }

  const sessions: DiscoveredSession[] = [];
  for (const { fields, body } of parseBundle(res.stdout)) {
    // An empty event log means nothing was ever said (subagent/aborted stub).
    if (Number(fields[2]) === 0) continue;
    const fallbackId = (fields[0] ?? '').replace(/^.*\//, '').replace(/\.json$/i, '');
    const mtime = bundleMtimeMs(fields[1]);
    // messageCount stays 0: counting prompts would mean reading every remote
    // event log (tens of MB) on each refresh.
    const session = parseKiroMeta(body, fallbackId, { createdFallback: mtime, updatedAt: mtime });
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote native Kiro session's event log into normalized blocks. */
export async function readRemoteKiroTranscript(host: RemoteHost, sessionId: string): Promise<ChatBlock[]> {
  if (!isKiroSessionId(sessionId)) return [];
  const file = `~/.kiro/sessions/cli/${shQuote(`${sessionId}.jsonl`)}`;
  const res = await sshExec(
    host.ssh,
    loginShellCommand(`[ -f ${file} ] && head -c ${MAX_TRANSCRIPT_BYTES} ${file}`),
    { timeoutMs: 25_000 },
  );
  if (res.code !== 0 || !res.stdout.trim()) return [];
  return kiroNativeBlocks(res.stdout);
}
