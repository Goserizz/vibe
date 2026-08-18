import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { DiscoveredSession } from '../sessions/discovery.js';

const GROK_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionSummary {
  info?: { id?: unknown; cwd?: unknown };
  session_summary?: unknown;
  generated_title?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_active_at?: unknown;
  num_messages?: unknown;
  num_chat_messages?: unknown;
  current_model_id?: unknown;
  hidden?: unknown;
  session_kind?: unknown;
}

export function isGrokSessionId(value: string): boolean {
  return GROK_SESSION_RE.test(value);
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '0' in (value as object) && typeof (value as any)[0] === 'string') {
    return (value as any)[0];
  }
  return '';
}

function modelId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const nested = rec[0] ?? rec.id ?? rec.model;
    if (typeof nested === 'string') return nested;
  }
  return '';
}

function isHidden(summary: SessionSummary): boolean {
  if (summary.hidden === true) return true;
  const kind = asString(summary.session_kind).toLowerCase();
  return kind.includes('subagent');
}

/**
 * Derive a Grok session's metadata from its `summary.json`. Accepts a truncated
 * head (remote discovery ships only the first few KB).
 */
export function parseGrokSummary(
  raw: string,
  fallbackId: string,
  times: { createdFallback: number; updatedAt: number },
  opts: { messageCount?: number; cwdFallback?: string } = {},
): DiscoveredSession | null {
  let summary: SessionSummary | undefined;
  try {
    summary = JSON.parse(raw) as SessionSummary;
  } catch {
    return null;
  }
  if (!summary || isHidden(summary)) return null;
  const id = asString(summary.info?.id) || fallbackId;
  if (!isGrokSessionId(id)) return null;
  const cwd = asString(summary.info?.cwd) || opts.cwdFallback || '';
  if (!cwd) return null;
  const title =
    asString(summary.generated_title).trim()
    || asString(summary.session_summary).trim().slice(0, 200)
    || 'Grok session';
  const created = parseTime(summary.created_at);
  const updated = parseTime(summary.last_active_at) || parseTime(summary.updated_at);
  const messages = Number(summary.num_chat_messages ?? summary.num_messages) || 0;
  return {
    claudeSessionId: id,
    cwd,
    title: title.slice(0, 200),
    model: modelId(summary.current_model_id) || config.defaultGrokModel,
    createdAt: created || times.createdFallback,
    updatedAt: updated || times.updatedAt,
    messageCount: opts.messageCount ?? messages,
  };
}

function decodeCwdDir(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return '';
  }
}

function toDiscovered(summaryPath: string): DiscoveredSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(summaryPath, 'utf8');
  } catch {
    return null;
  }
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(summaryPath);
  } catch {
    /* ignore */
  }
  const now = Date.now();
  const sessionDir = path.dirname(summaryPath);
  const cwdDir = path.basename(path.dirname(sessionDir));
  const cwdFile = path.join(path.dirname(sessionDir), '.cwd');
  let cwdFallback = decodeCwdDir(cwdDir);
  try {
    const fromFile = fs.readFileSync(cwdFile, 'utf8').trim();
    if (fromFile) cwdFallback = fromFile;
  } catch {
    /* no .cwd sidecar */
  }
  return parseGrokSummary(
    raw,
    path.basename(sessionDir),
    {
      createdFallback: stat?.birthtimeMs || stat?.mtimeMs || now,
      updatedAt: stat?.mtimeMs || now,
    },
    { cwdFallback },
  );
}

/** Discover native Grok CLI sessions on this machine (`~/.grok/sessions`). */
export function listGrokSessions(limit = 100): DiscoveredSession[] {
  let cwdDirs: string[] = [];
  try {
    cwdDirs = fs.readdirSync(config.grokSessionsDir).map((name) => path.join(config.grokSessionsDir, name));
  } catch {
    return [];
  }

  const sessions: DiscoveredSession[] = [];
  for (const cwdDir of cwdDirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(cwdDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const summary = path.join(cwdDir, name, 'summary.json');
      const session = toDiscovered(summary);
      if (session) sessions.push(session);
    }
  }

  const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  log.debug(`grok discovery: ${sorted.length} session(s)`);
  return sorted;
}

/** Resolve one native Grok CLI session for adoption/continuation. */
export function resolveGrokSessionSync(sessionId: string): DiscoveredSession | null {
  if (!isGrokSessionId(sessionId)) return null;
  let cwdDirs: string[] = [];
  try {
    cwdDirs = fs.readdirSync(config.grokSessionsDir).map((name) => path.join(config.grokSessionsDir, name));
  } catch {
    return null;
  }
  for (const cwdDir of cwdDirs) {
    const summary = path.join(cwdDir, sessionId, 'summary.json');
    if (!fs.existsSync(summary)) continue;
    return toDiscovered(summary);
  }
  return null;
}

/** Absolute path to a native Grok session directory, if it exists locally. */
export function findGrokSessionDir(sessionId: string): string | null {
  if (!isGrokSessionId(sessionId)) return null;
  let cwdDirs: string[] = [];
  try {
    cwdDirs = fs.readdirSync(config.grokSessionsDir);
  } catch {
    return null;
  }
  for (const name of cwdDirs) {
    const dir = path.join(config.grokSessionsDir, name, sessionId);
    if (fs.existsSync(path.join(dir, 'summary.json'))) return dir;
  }
  return null;
}
