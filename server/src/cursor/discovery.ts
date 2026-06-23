import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { getRecentProjects } from '../projects.js';
import { sessionStore } from '../sessions/store.js';
import { isClaudeSessionId, type DiscoveredSession } from '../sessions/discovery.js';

// Cursor stores each chat under ~/.cursor/chats/<md5(cwd)>/<chatId>/. There's no
// cwd recorded in the chat metadata, so we recover it by hashing every cwd Vibe
// already knows about and matching the directory name. Chats whose cwd we can't
// recover are skipped (we couldn't continue them anyway).

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** Every local cwd Vibe knows about (recent projects + stored local sessions). */
function candidateCwds(): string[] {
  const set = new Set<string>();
  for (const p of getRecentProjects()) set.add(p.path);
  for (const s of sessionStore.list()) if (!s.host) set.add(s.cwd);
  return [...set];
}

/** Map md5(cwd) -> a continuable cwd, covering both the literal path and its
 *  realpath (Cursor hashes the resolved path, e.g. /tmp -> /private/tmp). */
function hashToCwd(): Map<string, string> {
  const m = new Map<string, string>();
  for (const cwd of candidateCwds()) {
    m.set(md5(cwd), cwd);
    try {
      const rp = fs.realpathSync(cwd);
      if (rp !== cwd) m.set(md5(rp), cwd);
    } catch {
      /* path gone — ignore */
    }
  }
  return m;
}

/** Read one chat's metadata from its meta.json (+ filesystem times). */
function readChatMeta(hashDir: string, chatId: string, cwd: string): DiscoveredSession | null {
  if (!isClaudeSessionId(chatId)) return null;
  const chatDir = path.join(hashDir, chatId);
  let meta: any;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
  // Skip chats that never held a conversation.
  if (meta.hasConversation === false) return null;

  let mtime = Date.now();
  try {
    mtime = fs.statSync(path.join(chatDir, 'store.db')).mtimeMs || mtime;
  } catch {
    /* no store yet */
  }
  const createdAt = Number(meta.createdAtMs) || mtime;
  const updatedAt = Number(meta.updatedAtMs) || mtime;
  const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : 'Cursor session';
  return {
    claudeSessionId: chatId,
    cwd,
    title,
    model: config.defaultCursorModel,
    createdAt,
    updatedAt,
    messageCount: Number(meta.messageCount) || 0,
  };
}

/** Discover local Cursor CLI chats whose cwd we can recover (most-recent first). */
export function listCursorSessions(): DiscoveredSession[] {
  const root = config.cursorChatsDir;
  let hashes: string[];
  try {
    hashes = fs.readdirSync(root);
  } catch {
    return [];
  }
  const map = hashToCwd();
  const out: DiscoveredSession[] = [];
  for (const hash of hashes) {
    const cwd = map.get(hash);
    if (!cwd) continue;
    const hashDir = path.join(root, hash);
    let chatIds: string[];
    try {
      chatIds = fs.readdirSync(hashDir);
    } catch {
      continue;
    }
    for (const chatId of chatIds) {
      const meta = readChatMeta(hashDir, chatId, cwd);
      if (meta) out.push(meta);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  log.debug(`cursor discovery: ${out.length} session(s)`);
  return out;
}

/** Resolve one local Cursor chat by id (for continuing a discovered session). */
export function resolveCursorSessionSync(chatId: string): DiscoveredSession | null {
  if (!isClaudeSessionId(chatId)) return null;
  for (const [hash, cwd] of hashToCwd()) {
    const hashDir = path.join(config.cursorChatsDir, hash);
    if (fs.existsSync(path.join(hashDir, chatId, 'meta.json'))) {
      return readChatMeta(hashDir, chatId, cwd);
    }
  }
  return null;
}
