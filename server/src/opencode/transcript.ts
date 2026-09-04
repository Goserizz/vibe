import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { externalizeResults } from '../sessions/blobs.js';
import { log } from '../log.js';
import { openSqliteReadonly, type SqliteDb } from '../switch/sqlite.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.opencodeTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for an opencode session Vibe drove. */
export function readOpencodeTranscript(sessionId: string): ChatBlock[] {
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      blocks.push(JSON.parse(line) as ChatBlock);
    } catch {
      /* skip corrupt line */
    }
  }
  return blocks;
}

export function appendOpencodeBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.opencodeTranscriptsDir, { recursive: true });
    const persisted = externalizeResults(sessionId, blocks);
    fs.appendFileSync(transcriptFile(sessionId), `${persisted.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist opencode transcript', error);
  }
}

export function deleteOpencodeTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Native transcript (opencode's own SQLite store)
// ---------------------------------------------------------------------------
//
// `~/.local/share/opencode/opencode.db` (WAL mode):
//   session(id ses_…, project_id, directory, title, agent, model JSON, times ms)
//   message(id msg_…, session_id, time_created, data JSON)
//   part(id prt_…, message_id, session_id, time_created, data JSON)
//
// message.data: user `{role:user, time:{created}}` / assistant
// `{parentID, role:assistant, mode, agent, path:{cwd}, tokens, time}`.
// part.data: `{type:text, text}` / `{type:reasoning, text}` /
// `{type:tool, tool, callID, state:{status,input,output}}` / step markers.
// Reasoning parts with empty text carry only encrypted provider payloads —
// skipped, like vendor signatures elsewhere (never forged or replayed).
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  data: string;
  time_created: number;
}

function parseData(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tsOf(part: Record<string, unknown>, fallback: number): number {
  const time = part.time as { start?: unknown } | undefined;
  const start = typeof time?.start === 'number' && Number.isFinite(time.start) ? time.start : 0;
  if (start > 0) return start;
  return fallback || Date.now();
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert one session's raw message/part rows into Vibe's normalized blocks.
 * Pure — shared by the local reader, the remote reader, and tests.
 */
export function opencodeNativeBlocksFromRows(msgRows: Row[], partRows: Row[]): ChatBlock[] {
  const partsByMessage = new Map<string, { id: string; data: Record<string, unknown>; ts: number }[]>();
  for (const row of partRows) {
    const data = parseData(row.data);
    if (!data) continue;
    const messageId = typeof data.message_id === 'string' ? data.message_id : '';
    if (!messageId) continue;
    const list = partsByMessage.get(messageId) ?? [];
    list.push({ id: row.id, data, ts: row.time_created });
    partsByMessage.set(messageId, list);
  }
  for (const list of partsByMessage.values()) list.sort((a, b) => a.ts - b.ts);
  const ordered = [...msgRows].sort((a, b) => a.time_created - b.time_created);

  const blocks: ChatBlock[] = [];
  for (const row of ordered) {
    const msg = parseData(row.data);
    if (!msg) continue;
    const role = typeof msg.role === 'string' ? msg.role : '';
    const parts = partsByMessage.get(row.id) ?? [];
    if (role === 'user') {
      const text = parts
        .filter((p) => p.data.type === 'text' && typeof p.data.text === 'string')
        .map((p) => p.data.text as string)
        .join('');
      if (text.trim()) blocks.push({ id: `opu_${row.id}`, kind: 'user', text, ts: row.time_created || Date.now() });
      continue;
    }
    if (role !== 'assistant') continue;
    for (const part of parts) {
      const type = part.data.type;
      if (type === 'text') {
        const text = typeof part.data.text === 'string' ? part.data.text : '';
        if (text) {
          blocks.push({ id: String(part.data.id ?? part.id), kind: 'assistant', text, streaming: false, ts: tsOf(part.data, row.time_created) });
        }
      } else if (type === 'reasoning') {
        const text = typeof part.data.text === 'string' ? part.data.text : '';
        if (text.trim()) {
          blocks.push({ id: String(part.data.id ?? part.id), kind: 'thinking', text, streaming: false, ts: tsOf(part.data, row.time_created) });
        }
      } else if (type === 'tool') {
        const callID = typeof part.data.callID === 'string' && part.data.callID ? part.data.callID : part.id;
        const name = typeof part.data.tool === 'string' && part.data.tool ? part.data.tool : 'tool';
        const state = (part.data.state ?? {}) as Record<string, unknown>;
        const done = state.status === 'completed';
        const block: ToolBlock = {
          id: callID,
          kind: 'tool',
          toolUseId: callID,
          name,
          input: (state.input ?? {}) as Record<string, unknown>,
          status: done ? 'done' : 'error',
          result: outputText(state.output),
          isError: !done,
          ts: tsOf(part.data, row.time_created),
        };
        blocks.push(block);
      }
      // step-start / step-finish are run markers, not conversation content.
    }
  }
  return blocks;
}

function queryRows(db: SqliteDb, sessionId: string): { msgs: Row[]; parts: Row[] } {
  const msgs = db
    .prepare('select id, data, time_created from message where session_id = ?')
    .all(sessionId) as Row[];
  const parts = db
    .prepare('select id, data, time_created from part where session_id = ?')
    .all(sessionId) as Row[];
  return { msgs, parts };
}

/**
 * Read a native opencode session out of a specific SQLite store.
 * Best-effort: returns `[]` when the session is gone or the `better-sqlite3`
 * addon is unavailable. The path is a parameter so tests can read a throwaway
 * copy instead of the real `~/.local/share/opencode` database.
 */
export function readOpencodeNativeTranscriptAt(dbPath: string, sessionId: string): ChatBlock[] {
  const db: SqliteDb | null = openSqliteReadonly(dbPath);
  if (!db) return [];
  try {
    const { msgs, parts } = queryRows(db, sessionId);
    if (!msgs.length) return [];
    return opencodeNativeBlocksFromRows(msgs, parts);
  } catch (error) {
    log.debug(`opencode native transcript failed for ${sessionId}`, error);
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Read a local native opencode session from this machine's store. */
export function readOpencodeNativeTranscript(sessionId: string): ChatBlock[] {
  return readOpencodeNativeTranscriptAt(config.opencodeDb, sessionId);
}
