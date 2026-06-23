import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import type { ChatBlock, LiveEvent, ToolBlock } from '../../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Vibe-owned transcript — authoritative for Cursor sessions Vibe drives.
//
// Cursor stores conversations in a content-addressed SQLite/protobuf store
// that is fiddly to read. For sessions we drive ourselves we instead persist
// the normalized blocks to a simple JSONL under ~/.vibe, so snapshot/reconnect
// are reliable and engine-agnostic. The store.db parser below is only a
// best-effort fallback for sessions created outside Vibe.
// ---------------------------------------------------------------------------

function transcriptFile(sessionId: string): string {
  return path.join(config.cursorTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read a Vibe-persisted Cursor transcript (empty if none yet). */
export function readCursorTranscript(sessionId: string): ChatBlock[] {
  let raw: string;
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
      /* skip a corrupt line */
    }
  }
  return blocks;
}

/** Append a finished turn's blocks to the Vibe-persisted transcript. */
export function appendCursorBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.cursorTranscriptsDir, { recursive: true });
    fs.appendFileSync(transcriptFile(sessionId), blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
  } catch (err) {
    log.warn('failed to persist cursor transcript', err);
  }
}

/** Remove a Vibe-persisted transcript (on session delete). */
export function deleteCursorTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Accumulates `LiveEvent`s into final blocks (a server-side mirror of the web
 * client's reduceView) so a completed turn's blocks can be appended to the
 * Vibe transcript.
 */
export class CursorTranscriptBuilder {
  readonly blocks: ChatBlock[] = [];
  private readonly index = new Map<string, number>();

  private upsert(b: ChatBlock): void {
    const at = this.index.get(b.id);
    if (at === undefined) {
      this.index.set(b.id, this.blocks.length);
      this.blocks.push(b);
    } else {
      this.blocks[at] = b;
    }
  }

  apply(ev: LiveEvent): void {
    switch (ev.k) {
      case 'block':
        this.upsert(ev.block);
        break;
      case 'delta': {
        const at = this.index.get(ev.id);
        if (at !== undefined) {
          const b = this.blocks[at];
          if (b.kind === 'assistant' || b.kind === 'thinking') this.blocks[at] = { ...b, text: b.text + ev.chunk };
        }
        break;
      }
      case 'block_end': {
        const at = this.index.get(ev.id);
        if (at !== undefined) {
          const b = this.blocks[at];
          if (b.kind === 'assistant' || b.kind === 'thinking') {
            this.blocks[at] = { ...b, streaming: false, ...(ev.text != null ? { text: ev.text } : {}) };
          }
        }
        break;
      }
      case 'tool_result': {
        const at = this.index.get(ev.toolUseId);
        if (at !== undefined) {
          const b = this.blocks[at];
          if (b.kind === 'tool') this.blocks[at] = { ...b, result: ev.content, status: ev.isError ? 'error' : 'done', isError: ev.isError };
        }
        break;
      }
      case 'error':
        this.upsert({ id: `err_${this.blocks.length}_${Date.now()}`, kind: 'error', text: ev.text, ts: Date.now() });
        break;
      default:
        // run_state / token_usage are not persisted as blocks
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Best-effort parse of Cursor's on-disk store for sessions created outside Vibe.
//
// Layout: ~/.cursor/chats/<md5(realpath(cwd))>/<chatId>/store.db (SQLite). The
// `meta` table holds a hex-encoded JSON blob (so hex(value) is doubly encoded)
// with `latestRootBlobId` + `name`. `blobs(id, data)` is a content-addressed
// DAG: message blobs are raw JSON (`{role,content,...}`); index nodes are
// protobuf whose field 1 holds 32-byte child hashes in conversation order. We
// read via the system `sqlite3` (hex-encoded) to avoid a native dependency.
// ---------------------------------------------------------------------------

/** Read a LEB128 varint; returns [value, nextIndex] or null if truncated. */
function readVarint(buf: Buffer, i: number): [number, number] | null {
  let result = 0;
  let shift = 0;
  let pos = i;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 56) return null;
  }
  return null;
}

/** Extract a protobuf index node's child references (field 1, 32-byte hashes). */
function scanRefs(data: Buffer): string[] {
  const refs: string[] = [];
  let i = 0;
  while (i < data.length) {
    const tag = readVarint(data, i);
    if (!tag) break;
    i = tag[1];
    const field = tag[0] >>> 3;
    const wire = tag[0] & 7;
    if (wire === 2) {
      const lv = readVarint(data, i);
      if (!lv) break;
      i = lv[1];
      const start = i;
      const end = i + lv[0];
      if (end > data.length) break;
      i = end;
      if (field === 1 && lv[0] === 32) refs.push(data.subarray(start, end).toString('hex'));
    } else if (wire === 0) {
      const v = readVarint(data, i);
      if (!v) break;
      i = v[1];
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return refs;
}

/** Load all blobs (id -> bytes) and the latest root id from a store.db. */
function loadStore(dbPath: string): { blobs: Map<string, Buffer>; rootId?: string } {
  const blobs = new Map<string, Buffer>();
  let rootId: string | undefined;
  try {
    const metaOut = execFileSync('sqlite3', ['-batch', '-noheader', '-list', dbPath, 'SELECT hex(value) FROM meta'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of metaOut.split('\n')) {
      const h = line.trim();
      if (!h) continue;
      try {
        // hex(value) → inner hex text → JSON (value is a hex-encoded JSON BLOB).
        const inner = Buffer.from(h, 'hex').toString('utf8');
        const obj = JSON.parse(Buffer.from(inner, 'hex').toString('utf8'));
        if (obj && typeof obj.latestRootBlobId === 'string') {
          rootId = obj.latestRootBlobId;
          break;
        }
      } catch {
        /* not the json row */
      }
    }
  } catch (err) {
    log.debug('cursor store meta read failed', err);
    return { blobs };
  }
  try {
    const out = execFileSync('sqlite3', ['-batch', '-noheader', '-list', '-separator', '\t', dbPath, 'SELECT id, hex(data) FROM blobs'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      const hex = line.slice(tab + 1);
      if (id && hex) blobs.set(id, Buffer.from(hex, 'hex'));
    }
  } catch (err) {
    log.debug('cursor store blobs read failed', err);
  }
  return { blobs, rootId };
}

/** Walk the DAG from the root in conversation order, collecting message blobs.
 *  Message blobs are raw JSON (`{role,content,…}`); protobuf index nodes are
 *  expanded depth-first in field-1 order (which is chronological). */
function collectMessages(blobs: Map<string, Buffer>, rootId: string): any[] {
  const visited = new Set<string>();
  const msgs: any[] = [];
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const data = blobs.get(id);
    if (!data || data.length === 0) return;
    if (data[0] === 0x7b) {
      // '{' → a raw JSON message blob (leaf).
      try {
        const m = JSON.parse(data.toString('utf8'));
        if (m && typeof m === 'object' && m.role) msgs.push(m);
      } catch {
        /* not a message */
      }
      return;
    }
    for (const r of scanRefs(data)) walk(r);
  };
  walk(rootId);
  return msgs;
}

function resultToText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

/** Cursor wraps the real user input in <user_query>; everything else at the top
 *  of a user turn (<user_info>, attachments, …) is injected context we skip. */
function userText(raw: string): string | null {
  const m = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (m) return m[1].trim() || null;
  if (/^\s*<(user_info|additional_data|attached_files|environment_details)\b/i.test(raw)) return null;
  return raw.trim() || null;
}

/** Map Cursor's AI-SDK-style messages (role + content parts) into blocks. */
function messagesToBlocks(msgs: any[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const toolById = new Map<string, ToolBlock>();
  msgs.forEach((m, mi) => {
    const role = m.role;
    if (role === 'system') return; // internal system prompt — not shown
    const ts = Number(m.createdAt) || Date.now();
    const content = m.content;

    if (typeof content === 'string') {
      if (role === 'user') {
        const t = userText(content);
        if (t) blocks.push({ id: `cs_${mi}`, kind: 'user', text: t, ts });
      } else if (role === 'assistant' && content.trim()) {
        blocks.push({ id: `cs_${mi}`, kind: 'assistant', text: content, streaming: false, ts });
      }
      return;
    }
    if (!Array.isArray(content)) return;

    content.forEach((part: any, pi: number) => {
      if (!part || typeof part !== 'object') return;
      const id = `cs_${mi}_${pi}`;
      if (part.type === 'text') {
        const raw = String(part.text ?? '');
        if (role === 'user') {
          const t = userText(raw);
          if (t) blocks.push({ id, kind: 'user', text: t, ts });
        } else if (role === 'assistant' && raw.trim()) {
          blocks.push({ id, kind: 'assistant', text: raw, streaming: false, ts });
        }
      } else if (part.type === 'reasoning') {
        const t = String(part.text ?? '');
        if (t) blocks.push({ id, kind: 'thinking', text: t, streaming: false, ts });
      } else if (part.type === 'tool-call') {
        const tid = String(part.toolCallId ?? id);
        const tb: ToolBlock = { id: tid, kind: 'tool', toolUseId: tid, name: String(part.toolName ?? 'tool'), input: part.args, status: 'done', ts };
        toolById.set(tid, tb);
        blocks.push(tb);
      } else if (part.type === 'tool-result') {
        const tid = String(part.toolCallId ?? '');
        const tb = toolById.get(tid);
        if (tb) {
          tb.result = typeof part.result === 'string' ? part.result : resultToText(part.result);
          tb.status = 'done';
        }
      }
      // redacted-reasoning: encrypted, no readable text — skipped
    });
  });
  return blocks;
}

/** Best-effort read of an external Cursor chat transcript by cwd + chat id. */
export function readCursorStoreTranscript(cwd: string, chatId: string): ChatBlock[] {
  // Cursor hashes the resolved path; try both the literal cwd and its realpath.
  const hashes = new Set<string>();
  hashes.add(crypto.createHash('md5').update(cwd).digest('hex'));
  try {
    hashes.add(crypto.createHash('md5').update(fs.realpathSync(cwd)).digest('hex'));
  } catch {
    /* path gone */
  }
  for (const hash of hashes) {
    const dbPath = path.join(config.cursorChatsDir, hash, chatId, 'store.db');
    if (!fs.existsSync(dbPath)) continue;
    try {
      const { blobs, rootId } = loadStore(dbPath);
      if (!rootId) return [];
      return messagesToBlocks(collectMessages(blobs, rootId));
    } catch (err) {
      log.debug('cursor store transcript failed', err);
      return [];
    }
  }
  return [];
}
