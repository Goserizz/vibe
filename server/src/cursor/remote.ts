import { log } from '../log.js';
import { markerCmd, mtimeExpr, parseBundle, bundleMtimeMs } from '../remote/bundle.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import { isClaudeSessionId, type DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { parseCursorChatMeta } from './discovery.js';
import { cursorStoreBlocks, parseCursorStoreDump } from './transcript.js';

// Cursor stores chats under ~/.cursor/chats/<md5(realpath(cwd))>/<chatId>/ and
// records the cwd nowhere in the metadata, so — exactly like local discovery — a
// remote chat is only recoverable when we can guess its cwd. The candidate cwds
// come from what Vibe already knows about that host (stored sessions) plus the
// cwds the other agents' remote discovery just found there. The md5 is computed
// *on the host* so a remote realpath (e.g. macOS /tmp → /private/tmp) matches.

const MAX_CWDS = 60;
/** Skip absurdly large stores: the transcript is hex-dumped over the wire. */
const MAX_STORE_BYTES = 32 * 1024 * 1024;

/** `hash_of <path>` → md5 hex, using GNU `md5sum` or BSD `md5`. */
const HASH_FN = [
  'hash_of() {',
  "  printf %s \"$1\" | { md5sum 2>/dev/null || md5 2>/dev/null; } | tr -dc '0-9a-f' | head -c 32",
  '}',
].join('\n');

function bundleCmd(cwds: string[]): string {
  return [
    'cd ~/.cursor/chats 2>/dev/null || exit 0',
    HASH_FN,
    `for c in ${cwds.map((cwd) => shQuote(cwd)).join(' ')}; do`,
    '  for p in "$c" "$(readlink -f "$c" 2>/dev/null)"; do',
    '    [ -n "$p" ] || continue',
    '    h=$(hash_of "$p")',
    '    [ -n "$h" ] && [ -d "$h" ] || continue',
    '    for chat in "$h"/*/; do',
    '      [ -f "$chat/meta.json" ] || continue',
    '      id=$(basename "$chat")',
    `      m=${mtimeExpr('"$chat/store.db"')}`,
    `      ${markerCmd(['"$id"', '"$c"', '"$m"'])}`,
    '      cat "$chat/meta.json"',
    '    done',
    '  done',
    'done',
  ].join('\n');
}

/**
 * Discover Cursor chats on a remote host for the given candidate cwds
 * (most-recent first). Chats whose cwd isn't among the candidates stay hidden —
 * Vibe couldn't resume them anyway.
 */
export async function listRemoteCursorSessions(host: RemoteHost, cwds: string[]): Promise<DiscoveredSession[]> {
  const candidates = [...new Set(cwds.filter((cwd) => cwd.trim()))].slice(0, MAX_CWDS);
  if (!candidates.length) return [];

  const res = await sshExec(host.ssh, loginShellCommand(bundleCmd(candidates)), { timeoutMs: 25_000 });
  if (res.code !== 0) {
    log.debug(`remote cursor discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }

  const byId = new Map<string, DiscoveredSession>();
  for (const { fields, body } of parseBundle(res.stdout)) {
    const [rawId, cwd, mtime] = fields;
    const chatId = (rawId ?? '').replace(/\/+$/, '');
    if (!chatId || !cwd) continue;
    const session = parseCursorChatMeta(body, chatId, cwd, bundleMtimeMs(mtime));
    if (session) byId.set(chatId, session);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote Cursor chat's store by dumping it through the host's sqlite3.
 *  Requires `sqlite3` on the host (the local reader has the same requirement);
 *  without it the chat still appears, just with no history until the first turn
 *  Vibe drives writes its own transcript. */
export async function readRemoteCursorTranscript(
  host: RemoteHost,
  chatId: string,
  cwd: string,
): Promise<ChatBlock[]> {
  if (!isClaudeSessionId(chatId) || !cwd.trim()) return [];
  const cmd = [
    'cd ~/.cursor/chats 2>/dev/null || exit 0',
    'command -v sqlite3 >/dev/null 2>&1 || exit 0',
    HASH_FN,
    "TAB=$(printf '\\t')",
    `for p in ${shQuote(cwd)} "$(readlink -f ${shQuote(cwd)} 2>/dev/null)"; do`,
    '  [ -n "$p" ] || continue',
    `  db="$(hash_of "$p")/${shQuote(chatId)}/store.db"`,
    '  [ -f "$db" ] || continue',
    '  sz=$(stat -c %s "$db" 2>/dev/null || stat -f %z "$db" 2>/dev/null || echo 0)',
    `  [ "$sz" -gt ${MAX_STORE_BYTES} ] && exit 0`,
    `  ${markerCmd(['meta'])}`,
    `  sqlite3 -batch -noheader -list "$db" 'SELECT hex(value) FROM meta'`,
    `  ${markerCmd(['blobs'])}`,
    `  sqlite3 -batch -noheader -list -separator "$TAB" "$db" 'SELECT id, hex(data) FROM blobs'`,
    '  exit 0',
    'done',
  ].join('\n');

  const res = await sshExec(host.ssh, loginShellCommand(cmd), { timeoutMs: 40_000 });
  if (res.code !== 0 || !res.stdout.trim()) return [];
  let metaDump = '';
  let blobsDump = '';
  for (const { fields, body } of parseBundle(res.stdout)) {
    if (fields[0] === 'meta') metaDump = body;
    else if (fields[0] === 'blobs') blobsDump = body;
  }
  if (!metaDump.trim()) return [];
  try {
    return cursorStoreBlocks(parseCursorStoreDump(metaDump, blobsDump));
  } catch (err) {
    log.debug('remote cursor transcript parse failed', err);
    return [];
  }
}
