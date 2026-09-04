import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { isClaudeSessionId, type DiscoveredSession } from '../sessions/discovery.js';
import { parseCodebuddyHeadMeta } from './transcript.js';

// CodeBuddy stores transcripts at ~/.codebuddy/projects/<encoded-cwd>/<id>.jsonl
// (Claude's directory layout, its own line schema — see transcript.ts).

const MAX_FILES = 400;
const HEAD_BYTES = 64 * 1024;

/** Walk the projects dir for session transcripts (bounded, newest first). */
function listTranscriptFiles(): { file: string; id: string; mtime: number }[] {
  const root = config.codebuddyProjectsDir;
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out: { file: string; id: string; mtime: number }[] = [];
  for (const dir of projectDirs) {
    if (out.length > MAX_FILES) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length > MAX_FILES) break;
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const id = e.name.slice(0, -'.jsonl'.length);
      if (!isClaudeSessionId(id)) continue; // skip non-session files
      const file = path.join(root, dir.name, e.name);
      try {
        out.push({ file, id, mtime: fs.statSync(file).mtimeMs });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Read the head of a transcript file (bounded byte window). */
function readHeadLines(file: string): string[] {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').split('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function toDiscovered(ref: { file: string; id: string; mtime: number }): DiscoveredSession | null {
  const meta = parseCodebuddyHeadMeta(readHeadLines(ref.file));
  if (!meta) return null;
  return {
    claudeSessionId: ref.id,
    cwd: meta.cwd,
    title: meta.title,
    model: meta.model || config.defaultCodebuddyModel,
    createdAt: meta.createdAt || ref.mtime,
    updatedAt: ref.mtime || meta.createdAt,
    messageCount: meta.messageCount,
  };
}

/** Discover local CodeBuddy sessions (most-recent first). */
export function listCodebuddySessions(): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  for (const ref of listTranscriptFiles().slice(0, 100)) {
    const d = toDiscovered(ref);
    if (d) out.push(d);
  }
  log.debug(`codebuddy discovery: ${out.length} session(s)`);
  return out;
}

/** Resolve one local CodeBuddy session by id (for continuing a discovered session). */
export function resolveCodebuddySessionSync(sessionId: string): DiscoveredSession | null {
  if (!isClaudeSessionId(sessionId)) return null;
  const ref = listTranscriptFiles().find((r) => r.id === sessionId);
  if (!ref) return null;
  return toDiscovered(ref);
}
