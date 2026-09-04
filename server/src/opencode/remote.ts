import { log } from '../log.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';
import { isOpencodeSessionId, opencodeModelValue } from './discovery.js';
import { opencodeNativeBlocksFromRows } from './transcript.js';

// opencode keeps every session in one SQLite library:
// `${OPENCODE_HOME:-$HOME/.local/share/opencode}/opencode.db` (WAL mode).
// Remote discovery/transcript run read-only python3 queries over SSH — no
// database files are copied, so a live opencode on that host is never locked.

const DB_EXPR = '"${OPENCODE_HOME:-$HOME/.local/share/opencode}/opencode.db"';

const LIST_SCRIPT = String.raw`
import json, os, sqlite3, sys
db = os.path.expanduser(os.environ.get("OPENCODE_DB", ""))
if not db or not os.path.exists(db):
    print("[]")
    sys.exit(0)
con = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
try:
    rows = con.execute(
        "select s.id, s.directory, s.title, s.agent, s.model,"
        " s.time_created, s.time_updated,"
        " (select count(*) from message m where m.session_id = s.id) as message_count"
        " from session s order by s.time_updated desc limit 100"
    ).fetchall()
    print(json.dumps([dict(r) for r in rows], ensure_ascii=True))
except Exception as exc:
    print("VIBE_OPENCODE_ERROR:" + str(exc), file=sys.stderr)
    sys.exit(2)
finally:
    con.close()
`;

const READ_SCRIPT = String.raw`
import json, os, sqlite3, sys
db, sid = sys.argv[1], sys.argv[2]
con = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
try:
    msgs = [dict(r) for r in con.execute(
        "select id, data, time_created from message where session_id = ?", (sid,))]
    parts = [dict(r) for r in con.execute(
        "select id, data, time_created from part where session_id = ?", (sid,))]
    print(json.dumps({"msgs": msgs, "parts": parts}, ensure_ascii=True))
except Exception as exc:
    print("VIBE_OPENCODE_ERROR:" + str(exc), file=sys.stderr)
    sys.exit(2)
finally:
    con.close()
`;

interface RemoteSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  model: string | null;
  time_created: number | null;
  time_updated: number | null;
  message_count: number | null;
}

/** Discover native opencode sessions on a remote host (most-recent first). */
export async function listRemoteOpencodeSessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const inner = [`export OPENCODE_DB=${DB_EXPR}`, `python3 - <<'VIBE_OPENCODE_EOF'`, LIST_SCRIPT, 'VIBE_OPENCODE_EOF'].join('\n');
  const res = await sshExec(host.ssh, loginShellCommand(inner), { timeoutMs: 25_000 });
  if (res.code !== 0 || !res.stdout.trim()) {
    log.debug(`remote opencode discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }
  let rows: RemoteSessionRow[];
  try {
    rows = JSON.parse(res.stdout) as RemoteSessionRow[];
  } catch {
    return [];
  }
  const now = Date.now();
  const sessions: DiscoveredSession[] = [];
  for (const row of rows) {
    const id = String(row.id ?? '');
    const cwd = String(row.directory ?? '');
    if (!isOpencodeSessionId(id) || !cwd) continue;
    const created = Number(row.time_created) || 0;
    const updated = Number(row.time_updated) || created || now;
    const title = String(row.title ?? '').trim();
    sessions.push({
      claudeSessionId: id,
      cwd,
      title: title ? title.slice(0, 200) : 'opencode session',
      model: opencodeModelValue(row.model ?? null),
      createdAt: created || updated,
      updatedAt: updated,
      messageCount: Number(row.message_count) || 0,
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote native opencode session into normalized blocks. */
export async function readRemoteOpencodeTranscript(host: RemoteHost, sessionId: string): Promise<ChatBlock[]> {
  if (!isOpencodeSessionId(sessionId)) return [];
  const inner = [
    `export OPENCODE_DB=${DB_EXPR}`,
    `python3 - "$OPENCODE_DB" ${shQuote(sessionId)} <<'VIBE_OPENCODE_EOF'`,
    READ_SCRIPT,
    'VIBE_OPENCODE_EOF',
  ].join('\n');
  const res = await sshExec(host.ssh, loginShellCommand(inner), { timeoutMs: 25_000 });
  if (res.code !== 0 || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout) as {
      msgs?: { id: string; data: string; time_created: number }[];
      parts?: { id: string; data: string; time_created: number }[];
    };
    if (!parsed.msgs?.length) return [];
    return opencodeNativeBlocksFromRows(parsed.msgs, parsed.parts ?? []);
  } catch {
    return [];
  }
}
