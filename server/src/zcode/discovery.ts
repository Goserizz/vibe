import fs from 'node:fs';
import os from 'node:os';
import { config } from '../config.js';
import { log } from '../log.js';
import type { DiscoveredSession } from '../sessions/discovery.js';
import { withZcodeAppServer } from './appServer.js';

/**
 * ZCode keeps sessions in ~/.zcode/cli/db/db.sqlite — unreadable from Vibe's
 * Node 20 runtime (no node:sqlite). Discovery therefore spawns a short-lived
 * `zcode app-server` and calls `session/list`, cached stale-while-revalidate so
 * the HTTP session list never blocks on the spawn. Each successful pass also
 * rewrites a sidecar index (~/.vibe/zcode-index.json) that the synchronous
 * hub adoption path can peek at.
 */

const SESSION_RE = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isZcodeSessionId(value: string): boolean {
  return SESSION_RE.test(value);
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface IndexEntry {
  cwd: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

/** `session/list` rows → DiscoveredSession (pure, tolerant of shape drift). */
export function zcodeRowsToSessions(rows: unknown, fallbackModel: string): DiscoveredSession[] {
  if (!Array.isArray(rows)) return [];
  const sessions: DiscoveredSession[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.sessionId === 'string' ? rec.sessionId : '';
    const kind = typeof rec.sessionKind === 'string' ? rec.sessionKind : 'interactive';
    if (!isZcodeSessionId(id)) continue;
    // Skip subagent / workflow side sessions; keep interactive and forks.
    if (kind !== 'interactive' && kind !== 'fork') continue;
    const workspace = rec.workspace as Record<string, unknown> | undefined;
    const cwd = typeof workspace?.workspacePath === 'string' ? workspace.workspacePath : '';
    if (!cwd) continue;
    const title = (typeof rec.title === 'string' ? rec.title : '').trim() || 'ZCode session';
    sessions.push({
      claudeSessionId: id,
      cwd,
      title: title.slice(0, 200),
      model: fallbackModel,
      createdAt: parseTime(rec.createdAt),
      updatedAt: parseTime(rec.updatedAt),
      messageCount: 0,
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeIndex(sessions: DiscoveredSession[]): void {
  const index: Record<string, IndexEntry> = {};
  for (const session of sessions) {
    index[session.claudeSessionId] = {
      cwd: session.cwd,
      title: session.title,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
  try {
    fs.writeFileSync(config.zcodeIndexFile, JSON.stringify(index), { mode: 0o600 });
  } catch (error) {
    log.warn('failed to persist zcode session index', error);
  }
}

function readIndex(): Record<string, IndexEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.zcodeIndexFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, IndexEntry>) : {};
  } catch {
    return {};
  }
}

const TTL_MS = 30_000;
let cached: { at: number; value: DiscoveredSession[] } | null = null;
let inflight: Promise<DiscoveredSession[]> | null = null;

async function fetchSessions(): Promise<DiscoveredSession[]> {
  if (!config.zcodeExecutable) return [];
  const rows = await withZcodeAppServer(
    { cwd: os.homedir(), timeoutMs: 25_000 },
    (request) => request('session/list', {}),
  );
  const result = (rows as { sessions?: unknown })?.sessions ?? rows;
  const sessions = zcodeRowsToSessions(result, config.defaultZcodeModel).slice(0, 100);
  writeIndex(sessions);
  return sessions;
}

function refresh(): Promise<DiscoveredSession[]> {
  inflight ??= fetchSessions()
    .then((sessions) => {
      cached = { at: Date.now(), value: sessions };
      return sessions;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Discover native ZCode sessions on this machine (via `zcode app-server`).
 * Stale-while-revalidate, EXCEPT the first call waits for the spawn — the
 * session-list refresh pass is itself a background job, so a blocking first
 * load (~2s CLI spawn) is fine and keeps new sessions from appearing a full
 * refresh cycle late.
 */
export async function listZcodeSessions(limit = 100): Promise<DiscoveredSession[]> {
  if (!config.zcodeExecutable) return [];
  const fresh = cached !== null && Date.now() - cached.at < TTL_MS;
  if (!fresh) {
    const pending = refresh();
    pending.catch(() => undefined); // background revalidate — errors logged below
    if (!cached) {
      // First load: block so the caller sees real data (or [] on failure).
      return pending.catch((err) => {
        log.debug('zcode sessions refresh failed', err);
        return [];
      }).then((sessions) => sessions.slice(0, limit));
    }
  }
  return cached ? cached.value.slice(0, limit) : [];
}

/** Resolve one native ZCode session for adoption/continuation (synchronous:
 *  peeks the discovery cache, then the sidecar index). */
export function resolveZcodeSessionSync(sessionId: string): DiscoveredSession | null {
  if (!isZcodeSessionId(sessionId)) return null;
  const hit = cached?.value.find((session) => session.claudeSessionId === sessionId);
  if (hit) return hit;
  const entry = readIndex()[sessionId];
  if (!entry?.cwd) return null;
  return {
    claudeSessionId: sessionId,
    cwd: entry.cwd,
    title: entry.title || 'ZCode session',
    model: entry.model || config.defaultZcodeModel,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    messageCount: 0,
  };
}

export function invalidateZcodeSessionsCache(): void {
  if (cached) cached.at = 0;
}
