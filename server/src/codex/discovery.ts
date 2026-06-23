import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { isClaudeSessionId, type DiscoveredSession } from '../sessions/discovery.js';

// Codex stores each session as a rollout JSONL under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl. The first line is a
// `session_meta` carrying the session id + cwd, so (unlike Cursor) we recover the
// cwd directly — no hashing. The first user `input_text` becomes the title.

const MAX_FILES = 2000;
const HEAD_BYTES = 64 * 1024;

/** Read up to HEAD_BYTES of a file, split into trimmed lines. */
function readHeadLines(file: string): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

interface RolloutMeta {
  id: string;
  cwd: string;
  createdAt: number;
  title: string;
  messageCount: number;
}

/** Parse a rollout's head for id/cwd/timestamp + the first user message (title). */
function readRolloutMeta(file: string): RolloutMeta | null {
  const lines = readHeadLines(file);
  let id = '';
  let cwd = '';
  let createdAt = 0;
  let title = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!title) {
      const payload = obj?.type === 'response_item' ? obj.payload : null;
      if (payload?.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
        for (const part of payload.content) {
          if (part?.type === 'input_text' && typeof part.text === 'string') {
            // Skip Codex's injected <environment_context> block; take the real prompt.
            const t = part.text.trim();
            if (t && !t.startsWith('<environment_context>')) { title = t.replace(/\s+/g, ' ').slice(0, 80); break; }
          }
        }
      }
    }
    if (!id && obj?.type === 'session_meta' && obj.payload) {
      id = String(obj.payload.id ?? '');
      cwd = String(obj.payload.cwd ?? '');
      createdAt = parseIso(obj.payload.timestamp);
    }
    if (id && title) break;
  }

  if (!id || !cwd) return null;
  return { id, cwd, createdAt, title: title || 'Codex session', messageCount: 0 };
}

function parseIso(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** Walk the sessions dir for rollout JSONL files (bounded). */
function listRolloutFiles(): string[] {
  const root = config.codexSessionsDir;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length > MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function toDiscovered(file: string): DiscoveredSession | null {
  const meta = readRolloutMeta(file);
  if (!meta) return null;
  if (!isClaudeSessionId(meta.id)) return null; // expect a UUID
  const mtime = mtimeMs(file);
  return {
    claudeSessionId: meta.id,
    cwd: meta.cwd,
    title: meta.title,
    model: config.defaultCodexModel,
    createdAt: meta.createdAt || mtime,
    updatedAt: mtime || meta.createdAt,
    messageCount: meta.messageCount,
  };
}

/** Discover local Codex sessions whose cwd we can read (most-recent first). */
export function listCodexSessions(): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  for (const file of listRolloutFiles()) {
    const d = toDiscovered(file);
    if (d) out.push(d);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  log.debug(`codex discovery: ${out.length} session(s)`);
  return out;
}

/** Resolve one local Codex session by id (for continuing a discovered session). */
export function resolveCodexSessionSync(sessionId: string): DiscoveredSession | null {
  if (!isClaudeSessionId(sessionId)) return null;
  const target = sessionId.toLowerCase();
  for (const file of listRolloutFiles()) {
    if (path.basename(file).toLowerCase().includes(target)) return toDiscovered(file);
  }
  return null;
}
