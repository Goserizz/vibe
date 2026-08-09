import { log } from '../log.js';
import { bundleMtimeMs, markerCmd, mtimeExpr, parseBundle } from '../remote/bundle.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import { isClaudeSessionId } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { codexMetaToDiscovered, parseCodexRolloutHead } from './discovery.js';
import { codexRolloutBlocks } from './transcript.js';

// Codex keeps rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
// Both the day directories and the file names sort chronologically, so the newest
// sessions can be picked without a `stat` per file (a `find`-wide scan over years
// of history would dominate the round-trip).

const MAX_FILES = 60;
const MAX_DAY_DIRS = 20;
/** Bound a transcript fetch: a single rollout can carry huge tool outputs. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

const BUNDLE_CMD = [
  'cd ~/.codex/sessions 2>/dev/null || exit 0',
  // `./*/…` (not `*/…`) so a directory named like a flag can't become one.
  'recent_files() {',
  `  ls -1d ./*/*/* 2>/dev/null | sort -r | head -${MAX_DAY_DIRS} | while IFS= read -r d; do`,
  '    ls -1 "$d"/*.jsonl 2>/dev/null | sort -r',
  '  done',
  // Some installs keep rollouts flat under the sessions dir.
  '  ls -1 ./*.jsonl 2>/dev/null | sort -r',
  '}',
  `recent_files | head -${MAX_FILES} | while IFS= read -r f; do`,
  `  m=${mtimeExpr('"$f"')}`,
  `  ${markerCmd(['"$f"', '"$m"'])}`,
  '  head -n 40 "$f"',
  'done',
].join('\n');

/** Discover Codex sessions on a remote host (most-recent first). */
export async function listRemoteCodexSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const res = await sshExec(host.ssh, loginShellCommand(BUNDLE_CMD), { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote codex discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }

  const byId = new Map<string, DiscoveredSession>();
  for (const { fields, body } of parseBundle(res.stdout)) {
    const meta = parseCodexRolloutHead(body.split('\n'));
    if (!meta) continue;
    const session = codexMetaToDiscovered(meta, bundleMtimeMs(fields[1]));
    // A resumed session appends a new rollout; keep the most recent one.
    if (session && (byId.get(session.claudeSessionId)?.updatedAt ?? 0) < session.updatedAt) {
      byId.set(session.claudeSessionId, session);
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote Codex session's rollout into normalized blocks. */
export async function readRemoteCodexTranscript(host: RemoteHost, sessionId: string): Promise<ChatBlock[]> {
  if (!isClaudeSessionId(sessionId)) return [];
  const cmd = [
    // Newest rollout carrying this id (a resumed session has several).
    `f=$(ls -1t ~/.codex/sessions/*/*/*/*${shQuote(sessionId)}*.jsonl ~/.codex/sessions/*${shQuote(sessionId)}*.jsonl 2>/dev/null | head -1)`,
    `[ -n "$f" ] && head -c ${MAX_TRANSCRIPT_BYTES} "$f"`,
  ].join('\n');
  const res = await sshExec(host.ssh, loginShellCommand(cmd), { timeoutMs: 25_000 });
  if (res.code !== 0 || !res.stdout.trim()) return [];
  return codexRolloutBlocks(res.stdout);
}
