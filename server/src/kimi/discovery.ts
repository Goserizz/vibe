import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { DiscoveredSession } from '../sessions/discovery.js';

const KIMI_SESSION_RE = /^(?:session_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024;

interface IndexRecord {
  sessionId?: unknown;
  sessionDir?: unknown;
  workDir?: unknown;
}

interface SessionState {
  createdAt?: unknown;
  updatedAt?: unknown;
  title?: unknown;
  workDir?: unknown;
}

export interface KimiSessionRef {
  id: string;
  dir: string;
  workDir: string;
}

export function isKimiSessionId(value: string): boolean {
  return KIMI_SESSION_RE.test(value);
}

/**
 * Parse Kimi Code's append-only session index. Pure: `home` bounds which
 * directories are accepted (a malformed/user-edited index must not turn
 * discovery into an arbitrary filesystem reader) and `exists` lets the local
 * caller require a real `state.json` while the remote caller skips that check.
 */
export function parseKimiIndex(
  raw: string,
  home: string,
  exists: (dir: string) => boolean = () => true,
): KimiSessionRef[] {
  const byId = new Map<string, KimiSessionRef>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: IndexRecord;
    try {
      record = JSON.parse(line) as IndexRecord;
    } catch {
      continue;
    }
    const id = typeof record.sessionId === 'string' ? record.sessionId : '';
    const rawDir = typeof record.sessionDir === 'string' ? record.sessionDir : '';
    if (!isKimiSessionId(id) || !rawDir) continue;
    // POSIX-normalize without touching the local filesystem semantics, so the
    // same check works for remote paths.
    const dir = path.posix.normalize(rawDir).replace(/\/+$/, '');
    const root = path.posix.normalize(home).replace(/\/+$/, '');
    if (dir !== root && !dir.startsWith(`${root}/`)) continue;
    if (!exists(dir)) continue;
    byId.set(id, {
      id,
      dir,
      workDir: typeof record.workDir === 'string' ? record.workDir : '',
    });
  }
  return [...byId.values()];
}

/** Read and validate Kimi Code's append-only session index. */
export function kimiSessionRefs(): KimiSessionRef[] {
  let raw = '';
  try {
    raw = fs.readFileSync(config.kimiSessionIndexFile, 'utf8');
  } catch {
    return [];
  }
  return parseKimiIndex(raw, path.resolve(config.kimiHome), (dir) =>
    fs.existsSync(path.join(dir, 'state.json')),
  );
}

export function findKimiSessionDir(sessionId: string): string | undefined {
  if (!isKimiSessionId(sessionId)) return undefined;
  return kimiSessionRefs().find((ref) => ref.id === sessionId)?.dir;
}

function parseTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function modelFromWire(raw: string): string {
  let model = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'config.update' && typeof event.modelAlias === 'string') model = event.modelAlias;
    } catch {
      /* skip corrupt/truncated lines */
    }
  }
  return model;
}

/**
 * Build a discovered session from the raw pieces Kimi keeps per session:
 * `state.json` and the head of `agents/main/wire.jsonl`. Pure, so local and
 * remote (SSH) discovery share the same interpretation.
 */
export function kimiSessionFromParts(
  ref: KimiSessionRef,
  stateJson: string,
  wireHead: string,
  times: { createdFallback: number; updatedAt: number },
): DiscoveredSession | null {
  let state: SessionState;
  try {
    state = JSON.parse(stateJson) as SessionState;
  } catch {
    return null;
  }
  const cwd = typeof state.workDir === 'string' ? state.workDir : ref.workDir;
  if (!cwd) return null;
  return {
    claudeSessionId: ref.id,
    cwd,
    title: typeof state.title === 'string' && state.title.trim() ? state.title.trim().slice(0, 200) : 'Kimi session',
    model: modelFromWire(wireHead) || config.defaultKimiModel,
    createdAt: parseTime(state.createdAt) || times.createdFallback,
    updatedAt: parseTime(state.updatedAt) || times.updatedAt,
    messageCount: (wireHead.match(/"type":"turn\.prompt"/g) ?? []).length,
  };
}

function toDiscovered(ref: KimiSessionRef): DiscoveredSession | null {
  let stateJson: string;
  try {
    stateJson = fs.readFileSync(path.join(ref.dir, 'state.json'), 'utf8');
  } catch {
    return null;
  }
  const wireFile = path.join(ref.dir, 'agents', 'main', 'wire.jsonl');
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(wireFile);
  } catch {
    try { stat = fs.statSync(path.join(ref.dir, 'state.json')); } catch { /* ignore */ }
  }
  const now = Date.now();
  return kimiSessionFromParts(ref, stateJson, readHead(wireFile), {
    createdFallback: stat?.birthtimeMs || stat?.mtimeMs || now,
    updatedAt: stat?.mtimeMs || now,
  });
}

/** Discover native Kimi Code sessions on this machine, newest first. */
export function listKimiSessions(limit = 100): DiscoveredSession[] {
  const sessions = kimiSessionRefs()
    .map(toDiscovered)
    .filter((session): session is DiscoveredSession => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  log.debug(`kimi discovery: ${sessions.length} session(s)`);
  return sessions;
}

/** Resolve one native Kimi Code session for adoption/continuation. */
export function resolveKimiSessionSync(sessionId: string): DiscoveredSession | null {
  const ref = kimiSessionRefs().find((candidate) => candidate.id === sessionId);
  return ref ? toDiscovered(ref) : null;
}
