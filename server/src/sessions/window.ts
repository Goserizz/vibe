import fs from 'node:fs';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

/**
 * Windowed reads over append-only JSONL transcripts, so opening a conversation
 * costs the last page instead of the whole file — the 61MB-session problem.
 *
 * Lines are only ever appended, so a byte offset is a stable cursor: a page
 * read ends at a fixed byte and older pages walk backwards from there. One
 * caveat: a single line can be megabytes (a huge tool result), so the reader
 * grows its window until it has a full first line or gives up past
 * MAX_WINDOW_BYTES.
 */

/** Tool results longer than this travel as a preview + `resultTruncated`. */
export const RESULT_PREVIEW_LIMIT = 200 * 1024;
/** Default line/block count per snapshot page. */
export const PAGE_DEFAULT_BLOCKS = 200;
/** Hard cap on lines/blocks per page. */
export const PAGE_MAX_BLOCKS = 500;
/** Raw transcript bytes a page is allowed to span before it stops early. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Largest window the tail reader will grow to chasing a giant single line. */
const MAX_WINDOW_BYTES = 36 * 1024 * 1024;
/** Full-text reads served by the on-demand endpoint stop here. */
export const FULL_RESULT_MAX_BYTES = 25 * 1024 * 1024;

export interface LinesWindow {
  lines: string[];
  /** Parallel to `lines`: byte offset of each line's start. */
  offsets: number[];
  /** Byte offset of the first returned line (0 = file start). */
  startByte: number;
  /** Byte offset just past the last returned line's newline. */
  endByte: number;
  /** True when the file has content above `startByte`. */
  hasMore: boolean;
}

export interface WindowOpts {
  /** Return at most this many lines/blocks. */
  limit?: number;
  /** Read the page ending at this byte offset (default: end of file). */
  endByte?: number;
}

/**
 * Read up to `limit` complete lines ending at `endByte` (default EOF), oldest
 * line first. Returns null when the file is missing/empty. A page stops early
 * once it spans PAGE_MAX_BYTES of raw file, so `lines` may be shorter than
 * `limit`. When `endByte` doesn't land exactly on a line start the trailing
 * partial line is dropped.
 */
export function readLinesWindow(file: string, opts: WindowOpts = {}): LinesWindow | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? PAGE_DEFAULT_BLOCKS, PAGE_MAX_BLOCKS));
  const end = Math.min(Math.max(0, opts.endByte ?? size), size);

  let windowStart = Math.max(0, end - PAGE_MAX_BYTES);
  for (;;) {
    const raw = readRange(file, windowStart, end);
    if (raw == null) return null;
    const text = raw.toString('utf8');
    const all = text.split('\n');
    // Trailing '' from the final newline, or a partial line when the window
    // ends mid-line, is dropped from the newest side.
    while (all.length > 0 && all[all.length - 1] === '') all.pop();
    if (all.length > 0 && end < size && !text.endsWith('\n')) all.pop();
    // A window not starting at byte 0 begins inside a line — drop that partial
    // line; its full copy arrives with the previous (older) page.
    const firstIdx = windowStart === 0 ? 0 : 1;
    // Prefix sum of line byte lengths (each + its newline) so each line's file
    // offset is a lookup, not a rescan.
    const prefix = new Array<number>(all.length);
    let acc = windowStart;
    for (let i = 0; i < all.length; i++) {
      prefix[i] = acc;
      acc += Buffer.byteLength(all[i]!, 'utf8') + 1;
    }
    const lines: string[] = [];
    const offsets: number[] = [];
    let bytes = 0;
    // Walk newest-to-oldest so the PAGE_MAX_BYTES cap clips the oldest side.
    for (let i = all.length - 1; i >= firstIdx; i--) {
      const line = all[i]!;
      if (!line.trim()) continue;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (lines.length > 0 && bytes + lineBytes > PAGE_MAX_BYTES) break;
      bytes += lineBytes + 1; // + trailing newline
      lines.push(line);
      offsets.push(prefix[i]!);
      if (lines.length >= limit) break;
    }
    if (lines.length > 0 || windowStart === 0) {
      lines.reverse();
      offsets.reverse();
      const startByte = offsets[0] ?? end;
      return { lines, offsets, startByte, endByte: end, hasMore: startByte > 0 };
    }
    // Zero complete lines in the window: the first line is bigger than the
    // window (multi-MB tool result). Grow and retry, but not forever.
    if (end - windowStart >= MAX_WINDOW_BYTES) {
      return { lines: [], offsets: [], startByte: end, endByte: end, hasMore: true };
    }
    windowStart = Math.max(0, windowStart - Math.max(PAGE_MAX_BYTES, end - windowStart));
  }
}

export interface BlocksWindow extends LinesWindow {
  blocks: ChatBlock[];
}

/** readLinesWindow + JSON.parse per line (skips corrupt lines). Blocks come
 *  back in conversation order: lines are normally in time order (a no-op),
 *  but a tool whose completion landed after its turn's result footer was
 *  persisted behind that footer — serving file order would render it as an
 *  "extra tool call after the conversation ended". Only pairs that both
 *  carry finite, differing timestamps are reordered; everything else
 *  (including blocks without a timestamp) keeps file order, and `offsets`
 *  stays parallel to `blocks` for the result line refs. */
export function readBlocksWindow(file: string, opts: WindowOpts = {}): BlocksWindow | null {
  const win = readLinesWindow(file, opts);
  if (!win) return null;
  const rows: { block: ChatBlock; offset: number; i: number }[] = [];
  win.lines.forEach((line, i) => {
    try {
      rows.push({ block: JSON.parse(line) as ChatBlock, offset: win.offsets[i]!, i });
    } catch {
      /* skip a corrupt line — same as the full-file readers */
    }
  });
  rows.sort((a, b) => {
    const ta = Number(a.block.ts);
    const tb = Number(b.block.ts);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.i - b.i;
  });
  return {
    ...win,
    blocks: rows.map((r) => r.block),
    offsets: rows.map((r) => r.offset),
  };
}

/** Read the single line starting at `offset` through its newline (bounded by
 *  FULL_RESULT_MAX_BYTES), for the on-demand full-result endpoint. */
export function readLineAt(file: string, offset: number): { line: string; start: number; end: number } | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (offset < 0 || offset >= size) return null;
  const raw = readRange(file, offset, Math.min(size, offset + FULL_RESULT_MAX_BYTES));
  if (raw == null) return null;
  const text = raw.toString('utf8');
  const nl = text.indexOf('\n');
  const line = nl < 0 ? text : text.slice(0, nl);
  return { line, start: offset, end: offset + Buffer.byteLength(line, 'utf8') };
}

function readRange(file: string, start: number, end: number): Buffer | null {
  if (end <= start) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return read === buf.length ? buf : buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Cut a string on a UTF-16 boundary that is safe to break (never splits a
 *  surrogate pair) — a preview that would otherwise end mid-emoji. */
function safeSlice(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = limit;
  const hi = text.charCodeAt(cut - 1);
  if (hi >= 0xd800 && hi <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * Shrink tool results past RESULT_PREVIEW_LIMIT for transfer, attaching
 * `resultTruncated` / `resultSize` and — when the block's line offset is
 * known — a `line:` resultRef the on-demand endpoint can seek. Blocks that
 * already carry a `blob:` ref (persisted externalized results) keep it.
 */
export function truncateForTransfer(blocks: ChatBlock[], offsets?: number[]): ChatBlock[] {
  let changed = false;
  const out = blocks.map((block, i) => {
    if (block.kind !== 'tool' || typeof block.result !== 'string') return block;
    const result = block.result;
    if (result.length <= RESULT_PREVIEW_LIMIT) return block;
    const preview = safeSlice(result, RESULT_PREVIEW_LIMIT);
    const tool: ToolBlock = {
      ...block,
      result: preview,
      resultTruncated: true,
      resultSize: result.length,
    };
    if (!tool.resultRef && offsets && offsets[i] !== undefined) {
      tool.resultRef = `line:${offsets[i]}`;
    }
    changed = true;
    return tool;
  });
  return changed ? out : blocks;
}
