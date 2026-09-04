import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { getRecentProjects } from '../projects.js';
import { sessionStore } from '../sessions/store.js';
import { isClaudeSessionId, type DiscoveredSession } from '../sessions/discovery.js';
import { readCursorStoreTranscript } from './transcript.js';
import { parseTurnUserText } from '../switch/canonical.js';

// Cursor stores each chat under ~/.cursor/chats/<md5(cwd)>/<chatId>/. There's no
// cwd recorded in the chat metadata, so we recover it by hashing every cwd Vibe
// already knows about and matching the directory name. Chats whose cwd we can't
// recover are skipped (we couldn't continue them anyway).

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

interface CursorRecoveryInput {
  vibeSessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  /** Current Vibe transcript's user turns. Used only to identify a legacy
   *  switched chat whose old sidecar predates `vibeSessionId`. */
  userTexts?: readonly string[];
}

interface CursorRecoveryCandidate {
  id: string;
  stamp: number;
  exact: boolean;
}

/**
 * Recover a Vibe→Cursor native-id mapping after a stale source runtime wrote
 * its own id back. Exact `vibeSessionId` provenance wins. Older sidecars do
 * not have it, so the compatibility fallback is deliberately strict: same
 * cwd + title and exactly one chat inside a ten-minute window.
 */
export function recoverCursorChatId(
  input: CursorRecoveryInput,
  chatsDir: string = config.cursorChatsDir,
): string | null {
  const hashes = new Set([md5(input.cwd)]);
  try {
    hashes.add(md5(fs.realpathSync(input.cwd)));
  } catch {
    /* cwd may have disappeared; the literal hash is still useful */
  }

  const candidates: CursorRecoveryCandidate[] = [];
  for (const hash of hashes) {
    const hashDir = path.join(chatsDir, hash);
    let chatIds: string[];
    try {
      chatIds = fs.readdirSync(hashDir);
    } catch {
      continue;
    }
    for (const id of chatIds) {
      if (!isClaudeSessionId(id)) continue;
      let meta: any;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(hashDir, id, 'meta.json'), 'utf8'));
      } catch {
        continue;
      }
      if (meta?.hasConversation === false) continue;
      const exact = meta?.vibeSessionId === input.vibeSessionId;
      if (!exact && String(meta?.title ?? '').trim() !== input.title.trim()) continue;
      let stamp = Number(meta?.updatedAtMs) || Number(meta?.createdAtMs) || 0;
      if (!stamp) {
        try {
          stamp = fs.statSync(path.join(hashDir, id, 'store.db')).mtimeMs;
        } catch {
          continue;
        }
      }
      candidates.push({ id, stamp, exact });
    }
  }

  const exact = candidates.filter((candidate) => candidate.exact);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) {
    exact.sort((a, b) => Math.abs(a.stamp - input.updatedAt) - Math.abs(b.stamp - input.updatedAt));
    return exact[0]!.id;
  }

  const windowMs = 10 * 60_000;
  const nearby = candidates.filter((candidate) => Math.abs(candidate.stamp - input.updatedAt) <= windowMs);
  if (nearby.length === 1) return nearby[0]!.id;

  // A failed ACP resume can replace the stored mapping with a fresh, valid
  // UUID, long after the original ten-minute switch window. For legacy
  // sidecars we recover only when native content proves identity: every user
  // turn in exactly one candidate must equal the prefix of Vibe's transcript.
  // This is deliberately stronger than title/cwd matching and cannot be
  // fooled by another same-named chat or an empty decoy database.
  const expectedUsers = (input.userTexts ?? []).map((text) => text.trim()).filter(Boolean);
  if (!expectedUsers.length) return null;
  const contentMatches = candidates.filter((candidate) => {
    const candidateUsers = readCursorStoreTranscript(input.cwd, candidate.id, chatsDir)
      .filter((block) => block.kind === 'user')
      .map((block) => parseTurnUserText(block.text).text.trim())
      .filter(Boolean);
    return candidateUsers.length > 0
      && candidateUsers.length <= expectedUsers.length
      && candidateUsers.every((text, index) => text === expectedUsers[index]);
  });
  return contentMatches.length === 1 ? contentMatches[0]!.id : null;
}

/**
 * Mirror a chat-store database into the root used by `cursor-agent acp`.
 * Cursor uses the same SQLite/blob format in both places but does not search
 * `~/.cursor/chats` when handling `session/resume`.
 */
export function ensureCursorAcpSessionFromChat(
  chatId: string,
  cwd: string,
  chatsDir: string = config.cursorChatsDir,
  acpSessionsDir: string = config.cursorAcpSessionsDir,
): boolean {
  if (!isClaudeSessionId(chatId)) return false;
  const target = path.join(acpSessionsDir, chatId, 'store.db');
  if (fs.existsSync(target)) return true;

  const hashes = new Set([md5(cwd)]);
  try {
    hashes.add(md5(fs.realpathSync(cwd)));
  } catch {
    /* literal cwd may still locate the chat */
  }

  let source: string | undefined;
  for (const hash of hashes) {
    const candidate = path.join(chatsDir, hash, chatId, 'store.db');
    if (fs.existsSync(candidate)) {
      source = candidate;
      break;
    }
  }
  if (!source) return false;

  const dir = path.dirname(target);
  const tmp = `${target}.vibe-import-${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, tmp);
    // Never overwrite a session that ACP may have created concurrently.
    if (fs.existsSync(target)) {
      fs.rmSync(tmp, { force: true });
      return true;
    }
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    log.warn(`failed to mirror Cursor chat ${chatId} into ACP sessions`, err);
    return false;
  }
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

/**
 * Interpret a chat's `meta.json` content. Pure, so local discovery and remote
 * (SSH) discovery agree on titles, times and which chats are worth showing.
 */
export function parseCursorChatMeta(
  rawMeta: string,
  chatId: string,
  cwd: string,
  mtime: number,
): DiscoveredSession | null {
  if (!isClaudeSessionId(chatId)) return null;
  let meta: any;
  try {
    meta = JSON.parse(rawMeta);
  } catch {
    return null;
  }
  // Skip chats that never held a conversation.
  if (meta.hasConversation === false) return null;
  const stamp = mtime || Date.now();
  return {
    claudeSessionId: chatId,
    cwd,
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : 'Cursor session',
    model: config.defaultCursorModel,
    createdAt: Number(meta.createdAtMs) || stamp,
    updatedAt: Number(meta.updatedAtMs) || stamp,
    messageCount: Number(meta.messageCount) || 0,
  };
}

/** Read one chat's metadata from its meta.json (+ filesystem times). */
function readChatMeta(hashDir: string, chatId: string, cwd: string): DiscoveredSession | null {
  if (!isClaudeSessionId(chatId)) return null;
  const chatDir = path.join(hashDir, chatId);
  let rawMeta: string;
  try {
    rawMeta = fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8');
  } catch {
    return null;
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(path.join(chatDir, 'store.db')).mtimeMs || 0;
  } catch {
    /* no store yet */
  }
  return parseCursorChatMeta(rawMeta, chatId, cwd, mtime);
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
