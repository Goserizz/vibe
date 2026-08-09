import { log } from '../log.js';
import { markerCmd, mtimeExpr, parseBundle, bundleMtimeMs } from '../remote/bundle.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { isKimiSessionId, kimiSessionFromParts, parseKimiIndex, type KimiSessionRef } from './discovery.js';
import { kimiWireBlocks } from './transcript.js';

// Kimi Code has no predictable per-session path: sessions are listed in an
// append-only index (`$KIMI_CODE_HOME/session_index.jsonl`) that maps a session id
// to its directory. Discovery therefore needs two round-trips — read the index,
// then fetch `state.json` + the head of `agents/main/wire.jsonl` for the newest
// entries. SSH ControlMaster keeps the second hop cheap.

const MAX_INDEX_LINES = 300;
const MAX_SESSIONS = 60;
const WIRE_HEAD_BYTES = 64 * 1024;
/** Bound a transcript fetch: wire logs embed full tool output. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** Round-trip 1: the remote Kimi home + the tail of its session index. */
const INDEX_CMD = [
  'KH="${KIMI_CODE_HOME:-$HOME/.kimi-code}"',
  `${markerCmd(['"$KH"'])}`,
  '[ -f "$KH/session_index.jsonl" ] || exit 0',
  `tail -n ${MAX_INDEX_LINES} "$KH/session_index.jsonl"`,
].join('\n');

async function remoteRefs(host: RemoteHost): Promise<KimiSessionRef[]> {
  const res = await sshExec(host.ssh, loginShellCommand(INDEX_CMD), { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote kimi index failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }
  const [record] = parseBundle(res.stdout);
  const home = record?.fields[0]?.trim();
  if (!home || !record) return [];
  // The index is append-only, so its tail holds the most recent sessions.
  return parseKimiIndex(record.body, home).slice(-MAX_SESSIONS);
}

/** Resolve a native Kimi session directory on an SSH host. Background-task
 *  monitoring only has the SSH target (not the host registry row), so expose a
 *  narrow lookup that reuses the same validated index parser as discovery. */
export async function findRemoteKimiSessionDir(
  sshTarget: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!isKimiSessionId(sessionId)) return undefined;
  const refs = await remoteRefs({ name: sshTarget, ssh: sshTarget });
  return refs.find((ref) => ref.id === sessionId)?.dir;
}

/** Round-trip 2: per session dir, `state.json` plus the wire log's head. */
function partsCmd(refs: KimiSessionRef[]): string {
  return [
    `for d in ${refs.map((ref) => shQuote(ref.dir)).join(' ')}; do`,
    '  [ -f "$d/state.json" ] || continue',
    '  w="$d/agents/main/wire.jsonl"',
    `  m=${mtimeExpr('"$w"')}`,
    `  [ -n "$m" ] || m=${mtimeExpr('"$d/state.json"')}`,
    `  ${markerCmd(['state', '"$d"', '"$m"'])}`,
    '  cat "$d/state.json"',
    `  ${markerCmd(['wire', '"$d"', '"$m"'])}`,
    `  head -c ${WIRE_HEAD_BYTES} "$w" 2>/dev/null`,
    "  printf '\\n'",
    'done',
  ].join('\n');
}

/** Discover native Kimi Code sessions on a remote host (most-recent first). */
export async function listRemoteKimiSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const refs = await remoteRefs(host);
  if (!refs.length) return [];

  const res = await sshExec(host.ssh, loginShellCommand(partsCmd(refs)), { timeoutMs: 25_000 });
  if (res.code !== 0) {
    log.debug(`remote kimi discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }

  const byDir = new Map<string, { state: string; wire: string; mtime: number }>();
  for (const { fields, body } of parseBundle(res.stdout)) {
    const [kind, dir, mtime] = fields;
    if (!dir) continue;
    const entry = byDir.get(dir) ?? { state: '', wire: '', mtime: bundleMtimeMs(mtime) };
    if (kind === 'state') entry.state = body;
    else if (kind === 'wire') entry.wire = body;
    byDir.set(dir, entry);
  }

  const sessions: DiscoveredSession[] = [];
  for (const ref of refs) {
    const parts = byDir.get(ref.dir);
    if (!parts?.state.trim()) continue;
    const session = kimiSessionFromParts(ref, parts.state, parts.wire, {
      createdFallback: parts.mtime,
      updatedAt: parts.mtime,
    });
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote native Kimi session's wire log into normalized blocks. */
export async function readRemoteKimiTranscript(host: RemoteHost, sessionId: string): Promise<ChatBlock[]> {
  if (!isKimiSessionId(sessionId)) return [];
  const ref = (await remoteRefs(host)).find((candidate) => candidate.id === sessionId);
  if (!ref) return [];
  const wire = `${shQuote(ref.dir)}/agents/main/wire.jsonl`;
  const res = await sshExec(
    host.ssh,
    loginShellCommand(`[ -f ${wire} ] && head -c ${MAX_TRANSCRIPT_BYTES} ${wire}`),
    { timeoutMs: 25_000 },
  );
  if (res.code !== 0 || !res.stdout.trim()) return [];
  return kimiWireBlocks(res.stdout);
}
