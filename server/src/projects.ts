import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import type { ProjectDir } from '../../shared/protocol.js';

/** Read the `cwd` recorded inside a transcript without parsing the whole file. */
function readCwdFromTranscript(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString('utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } catch {
    // ignore unreadable files
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/**
 * Discover working directories the user has recently used with Claude Code, so
 * the "new session" picker can offer them. Best-effort and bounded.
 */
export function getRecentProjects(limit = 40): ProjectDir[] {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(config.claudeProjectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects: ProjectDir[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(config.claudeProjectsDir, dir.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    let newest = 0;
    let newestFile = '';
    for (const f of files) {
      try {
        const m = fs.statSync(path.join(dirPath, f)).mtimeMs;
        if (m > newest) {
          newest = m;
          newestFile = path.join(dirPath, f);
        }
      } catch {
        /* skip */
      }
    }
    const cwd = newestFile ? readCwdFromTranscript(newestFile) : undefined;
    if (!cwd || !fs.existsSync(cwd)) continue;
    projects.push({ path: cwd, name: path.basename(cwd), lastUsed: newest, sessionCount: files.length });
  }

  return projects
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    .slice(0, limit);
}

export interface PathCheck {
  ok: boolean;
  path: string;
  error?: string;
}

/** Validate a directory the user typed in for a new session. */
export function validateDir(input: string): PathCheck {
  let resolved = input.trim();
  if (!resolved) return { ok: false, path: input, error: 'empty path' };
  if (resolved.startsWith('~')) resolved = path.join(os.homedir(), resolved.slice(1));
  resolved = path.resolve(resolved);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, path: resolved, error: 'not a directory' };
    return { ok: true, path: resolved };
  } catch {
    return { ok: false, path: resolved, error: 'directory does not exist' };
  }
}
