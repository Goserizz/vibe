import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { log } from '../log.js';

/**
 * Cursor ACP streams often omit `rawInput`; the real tool args live in
 * `~/.cursor/acp-sessions/<sessionId>/store.db`. Look them up by toolCallId so
 * Read/Grep/Shell show paths and patterns.
 *
 * Uses Python's sqlite3 (the `sqlite3` CLI is often absent on servers).
 */

function acpSessionDb(sessionId: string): string | null {
  const flat = path.join(os.homedir(), '.cursor', 'acp-sessions', sessionId, 'store.db');
  if (fs.existsSync(flat)) return flat;
  return null;
}

function idsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aTail = a.split('\n').pop() ?? a;
  const bTail = b.split('\n').pop() ?? b;
  return aTail === bTail || a.startsWith(b) || b.startsWith(a);
}

type ToolArgsEntry = { name?: string; args: Record<string, unknown> };

/** Build toolCallId → args from an ACP session store.db (best-effort). */
export function loadAcpToolArgsIndex(sessionId: string): Map<string, ToolArgsEntry> {
  const out = new Map<string, ToolArgsEntry>();
  const dbPath = acpSessionDb(sessionId);
  if (!dbPath) return out;

  const py = `
import json, sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
out = []
for _id, data in con.execute("select id, data from blobs"):
    if not data: continue
    try:
        s = data.decode("utf-8")
    except Exception:
        continue
    if "tool-call" not in s:
        continue
    try:
        obj = json.loads(s)
    except Exception:
        continue
    content = obj.get("content")
    if not isinstance(content, list):
        continue
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "tool-call":
            continue
        tid = part.get("toolCallId")
        args = part.get("args")
        if not tid or not isinstance(args, dict):
            continue
        name = part.get("toolName") if isinstance(part.get("toolName"), str) else None
        out.append({"id": str(tid), "name": name, "args": args})
con.close()
print(json.dumps(out, ensure_ascii=False))
`;

  try {
    const raw = execFileSync('python3', ['-c', py, dbPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows = JSON.parse(raw) as Array<{ id: string; name?: string | null; args: Record<string, unknown> }>;
    for (const row of rows) {
      const entry: ToolArgsEntry = {
        name: row.name ?? undefined,
        args: { ...row.args },
      };
      out.set(row.id, entry);
      for (const half of row.id.split('\n')) {
        if (half && half !== row.id) out.set(half, entry);
      }
    }
  } catch (err) {
    log.debug('acp store tool-args index failed', err);
  }
  return out;
}

export function lookupAcpToolArgs(
  index: Map<string, ToolArgsEntry>,
  toolCallId: string,
): ToolArgsEntry | null {
  if (!toolCallId) return null;
  const direct = index.get(toolCallId);
  if (direct) return direct;
  for (const [id, entry] of index) {
    if (idsMatch(id, toolCallId)) return entry;
  }
  return null;
}
