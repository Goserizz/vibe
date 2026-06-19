import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';
import { log } from '../log.js';

export interface DiscoveredSession {
  claudeSessionId: string;
  cwd: string;
  title: string;
  /** The model this conversation used, so continuing resumes with the same one. */
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES_SCANNED = 500;

/** True for a valid Claude session id (UUID) — also guards shell interpolation. */
export function isClaudeSessionId(s: string): boolean {
  return UUID_RE.test(s);
}
const INTERNAL_PREFIXES = ['<command-name>', '<local-command-stdout>', '<command-message>', 'Caveat:'];

function isInternal(text: string): boolean {
  const t = text.trimStart();
  return !t || INTERNAL_PREFIXES.some((p) => t.startsWith(p));
}

function firstUserText(content: unknown): string | null {
  if (typeof content === 'string') return isInternal(content) ? null : content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string' && !isInternal(part.text)) return part.text;
    }
  }
  return null;
}

/**
 * Derive a session's display metadata from transcript lines (the head is
 * enough). Shared by local file scanning and remote head bundles.
 */
export function parseSessionMeta(
  lines: Iterable<string>,
  claudeSessionId: string,
  times: { createdFallback: number; updatedAt: number },
): DiscoveredSession | null {
  let cwd = '';
  let title = '';
  let summary = '';
  let model = '';
  let createdAt = 0;
  let messageCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (!summary && e.type === 'summary' && typeof e.summary === 'string') summary = e.summary;
    if (!model && typeof e.model === 'string' && e.model !== '<synthetic>') model = e.model;
    if (!model && typeof e.message?.model === 'string' && e.message.model !== '<synthetic>') model = e.message.model;
    if (!createdAt && typeof e.timestamp === 'string') createdAt = Date.parse(e.timestamp) || 0;

    const role = e.message?.role;
    if ((role === 'user' || role === 'assistant') && e.isMeta !== true && e.isSidechain !== true) {
      messageCount += 1;
      if (!title && role === 'user') {
        const t = firstUserText(e.message?.content);
        if (t) title = t.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
    }
  }

  if (messageCount === 0) return null; // no real conversation
  return {
    claudeSessionId,
    cwd: cwd || '',
    title: title || summary.slice(0, 80) || 'Untitled session',
    model: model || config.defaultModel,
    createdAt: createdAt || times.createdFallback,
    updatedAt: times.updatedAt,
    messageCount,
  };
}

/** Read the head of a local transcript to derive its display metadata. */
async function scanFile(file: string, claudeSessionId: string): Promise<DiscoveredSession | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const lines: string[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines.push(line);
      if (lines.length >= MAX_LINES_SCANNED) break;
    }
  } catch (err) {
    log.debug('scanFile error', err);
  } finally {
    rl.close();
  }

  return parseSessionMeta(lines, claudeSessionId, {
    createdFallback: stat.birthtimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  });
}

export interface FileRef {
  file: string;
  id: string;
  mtime: number;
}

/** Collect candidate transcript files (top-level UUID-named jsonl per project). */
export function candidateFiles(): FileRef[] {
  const root = config.claudeProjectsDir;
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }

  const refs: FileRef[] = [];
  for (const dir of projectDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const id = ent.name.slice(0, -'.jsonl'.length);
      if (!UUID_RE.test(id)) continue; // skip agent-*/subagent and other non-session files
      const file = path.join(dir, ent.name);
      try {
        refs.push({ file, id, mtime: fs.statSync(file).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  return refs;
}

/**
 * Discover Claude Code sessions created outside of Vibe (e.g. from the CLI),
 * most-recent first. Bounded so a huge history stays responsive.
 */
export async function listClaudeSessions(limit = 100): Promise<DiscoveredSession[]> {
  const refs = candidateFiles()
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const results = await Promise.all(refs.map((r) => scanFile(r.file, r.id)));
  return results.filter((s): s is DiscoveredSession => s !== null);
}

/** Resolve a single discovered session by its Claude session id. */
export async function getClaudeSessionInfo(claudeSessionId: string): Promise<DiscoveredSession | null> {
  if (!UUID_RE.test(claudeSessionId)) return null;
  for (const ref of candidateFiles()) {
    if (ref.id === claudeSessionId) return scanFile(ref.file, ref.id);
  }
  return null;
}

/**
 * Synchronously resolve the cwd + title for a discovered session. Used by the
 * WebSocket hub (which is synchronous) when adopting a CLI session to continue.
 */
export function resolveClaudeSessionSync(claudeSessionId: string): { cwd: string; title: string; model: string } | null {
  if (!UUID_RE.test(claudeSessionId)) return null;
  const ref = candidateFiles().find((r) => r.id === claudeSessionId);
  if (!ref) return null;
  try {
    const fd = fs.openSync(ref.file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let cwd = '';
    let title = '';
    let model = '';
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (!model && typeof e.model === 'string' && e.model !== '<synthetic>') model = e.model;
      if (!model && typeof e.message?.model === 'string' && e.message.model !== '<synthetic>') model = e.message.model;
      if (!title && e.message?.role === 'user') {
        const t = firstUserText(e.message?.content);
        if (t) title = t.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      if (cwd && title && model) break;
    }
    return { cwd, title: title || 'Untitled session', model: model || config.defaultModel };
  } catch {
    return null;
  }
}
