import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { hub } from '../ws/hub.js';
import { hostRegistry } from '../remote/hosts.js';
import { encodeRemoteId } from '../remote/sessionId.js';
import { searchRemoteHost, type RemoteSearchHit } from '../remote/search.js';
import { candidateFiles, parseSessionMeta, type DiscoveredSession, type FileRef } from './discovery.js';
import { parseTranscriptBlocks } from './transcript.js';
import { sessionStore, type StoredSession } from './store.js';
import { sessionVisible } from './visibility.js';
import { ADMIN_ACCOUNT, type ChatBlock, type RemoteHost, type SearchHit, type SearchResult } from '../../../shared/protocol.js';

const SNIPPET_PAD = 60;
const MAX_HITS_PER_SESSION = 3;
const LOCAL_SCAN_CAP = 1000;

/** Strip separators/newlines the remote bundle depends on; reject empty queries. */
function sanitize(q: string): string {
  return q.replace(/[\x1e\x1f\r\n]+/g, ' ').trim();
}

/** Split a sanitized query into whitespace-separated terms (case-insensitively
 *  deduped). Terms are ANDed: a conversation matches only if every term appears
 *  somewhere in its message text. */
function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of sanitize(query).split(/\s+/)) {
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  return terms;
}

/** Build a ±SNIPPET_PAD window around the first match (newlines/tabs → space). */
function snippetAround(text: string, idx: number, matchLen: number): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ');
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(clean.length, idx + matchLen + SNIPPET_PAD);
  let s = clean.slice(start, end).trim();
  if (start > 0) s = `… ${s}`;
  if (end < clean.length) s = `${s} …`;
  return s;
}

/**
 * Case-insensitively match message-text blocks (user/assistant/thinking) against
 * every term (AND semantics: each term must appear somewhere in the session's
 * message text, possibly in different blocks) and return up to
 * MAX_HITS_PER_SESSION snippets, taken from the blocks covering the most
 * distinct terms. Shared by the local and remote paths so both behave
 * identically — and so tool-I/O-only matches (which parse to no message-text
 * block) never produce a hit.
 */
function findHits(blocks: ChatBlock[], terms: string[]): SearchHit[] {
  const qs = terms.map((t) => t.toLowerCase());
  // Blocks containing at least one term, with the number of distinct terms each
  // block covers.
  const candidates: { hit: SearchHit; count: number }[] = [];
  const covered = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== 'user' && b.kind !== 'assistant' && b.kind !== 'thinking') continue;
    if (!b.text) continue;
    const lower = b.text.toLowerCase();
    let idx = -1;
    let len = 0;
    let count = 0;
    for (const q of qs) {
      const at = lower.indexOf(q);
      if (at < 0) continue;
      covered.add(q);
      count++;
      if (idx < 0 || at < idx) {
        idx = at;
        len = q.length;
      }
    }
    if (count === 0) continue;
    candidates.push({ hit: { kind: b.kind, snippet: snippetAround(b.text, idx, len) }, count });
  }
  if (covered.size < qs.length) return []; // some term missing → AND fails
  // Stable sort: blocks covering more terms snippet first, ties keep order.
  candidates.sort((a, b) => b.count - a.count);
  return candidates.slice(0, MAX_HITS_PER_SESSION).map((c) => c.hit);
}

interface Resolved {
  sessionId: string;
  title: string;
  cwd: string;
  host: string;
  source: 'vibe' | 'claude';
  updatedAt: number;
}

// -- local scan (mtime-cached) ------------------------------------------------

interface LocalDoc {
  mtime: number;
  updatedAt: number;
  cwd: string;
  title: string;
  blocks: ChatBlock[];
}
const localCache = new Map<string, LocalDoc>();

/** Parse a local transcript once per (id, mtime); reuse until it changes. */
function getLocalDoc(ref: FileRef): LocalDoc | null {
  const cached = localCache.get(ref.id);
  if (cached && cached.mtime === ref.mtime) return cached;
  let content: string;
  try {
    content = fs.readFileSync(ref.file, 'utf8');
  } catch (err) {
    log.debug('search read failed', err);
    return null;
  }
  const { blocks, cwd } = parseTranscriptBlocks(content);
  const firstUser = blocks.find((b) => b.kind === 'user');
  const title = firstUser && 'text' in firstUser
    ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
  const doc: LocalDoc = {
    mtime: ref.mtime,
    updatedAt: ref.mtime,
    cwd: cwd || '',
    title: title || 'Untitled session',
    blocks,
  };
  if (localCache.size > LOCAL_SCAN_CAP) localCache.clear();
  localCache.set(ref.id, doc);
  return doc;
}

function resolveLocal(claudeSessionId: string, doc: LocalDoc, byClaude: Map<string, StoredSession>): Resolved | null {
  const stored = byClaude.get(claudeSessionId);
  const sessionId = stored?.id ?? claudeSessionId;
  // Local dismissals hide the bare Claude id; check both forms for safety.
  if (sessionStore.isHidden(claudeSessionId) || sessionStore.isHidden(sessionId)) return null;
  return {
    sessionId,
    title: stored?.title ?? doc.title,
    cwd: stored?.cwd ?? doc.cwd,
    host: stored?.host ?? config.localName,
    source: stored ? 'vibe' : 'claude',
    updatedAt: stored?.updatedAt ?? doc.updatedAt,
  };
}

// -- remote scan --------------------------------------------------------------

/** cwd/title fallback from the head when parseSessionMeta has no user message. */
function deriveHeadMeta(head: string): { cwd: string; title: string } {
  const { blocks, cwd } = parseTranscriptBlocks(head);
  const firstUser = blocks.find((b) => b.kind === 'user');
  const title = firstUser && 'text' in firstUser
    ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    : '';
  return { cwd: cwd || '', title: title || 'Untitled session' };
}

function resolveRemote(host: RemoteHost, rh: RemoteSearchHit, meta: DiscoveredSession | null): Resolved | null {
  const sessionId = encodeRemoteId(host.name, rh.claudeSessionId);
  // Remote dismissals hide the host-namespaced id; check both forms for safety.
  if (sessionStore.isHidden(sessionId) || sessionStore.isHidden(rh.claudeSessionId)) return null;

  const stored = sessionStore.get(sessionId);
  const fallback = !meta?.cwd || !meta?.title ? deriveHeadMeta(rh.head) : { cwd: '', title: '' };
  const cwd = stored?.cwd ?? meta?.cwd ?? fallback.cwd;
  const title = stored?.title ?? meta?.title ?? fallback.title;
  const model = stored?.model ?? meta?.model ?? config.defaultModel;
  const updatedAt = stored?.updatedAt ?? rh.mtime;

  // Cache so a result absent from the session list still opens over SSH.
  hub.cacheRemoteSession(sessionId, { host: host.name, sshTarget: host.ssh, cwd, model, title });

  return {
    sessionId,
    title,
    cwd,
    host: host.name,
    source: stored ? 'vibe' : 'claude',
    updatedAt,
  };
}

// -- orchestration ------------------------------------------------------------

/** Full-text search across local + remote conversations (messages only).
 *  Remote hosts are limited to the ones `account` owns; the local scan is
 *  admin-only (the local machine is admin-only). */
export async function searchConversations(query: string, limit = 50, account: string = ADMIN_ACCOUNT): Promise<SearchResult[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  // Index stored sessions by their Claude id for local identity resolution.
  const byClaude = new Map<string, StoredSession>();
  if (account === ADMIN_ACCOUNT) {
    for (const s of sessionStore.list()) if (s.claudeSessionId) byClaude.set(s.claudeSessionId, s);
  }

  const results: SearchResult[] = [];

  // Local: scan every transcript file (most-recent first), bounded.
  if (account === ADMIN_ACCOUNT) {
    try {
      const all = candidateFiles();
      if (all.length > LOCAL_SCAN_CAP) log.debug(`search capped to ${LOCAL_SCAN_CAP} of ${all.length} local sessions`);
      const refs = all.sort((a, b) => b.mtime - a.mtime).slice(0, LOCAL_SCAN_CAP);
      for (const ref of refs) {
        const doc = getLocalDoc(ref);
        if (!doc) continue;
        const hits = findHits(doc.blocks, terms);
        if (hits.length === 0) continue;
        const resolved = resolveLocal(ref.id, doc, byClaude);
        if (!resolved) continue;
        if (!sessionVisible(account, resolved.sessionId)) continue;
        results.push({ ...resolved, hits });
      }
    } catch (err) {
      log.warn('local search failed', err);
    }
  }

  // Remote: one grep-filtered SSH round-trip per host the account owns (in
  // parallel; a down host contributes nothing).
  await Promise.all(
    hostRegistry.listFor(account).map(async (host) => {
      try {
        for (const rh of await searchRemoteHost(host, terms)) {
          const hits = findHits(parseTranscriptBlocks(rh.matches).blocks, terms);
          if (hits.length === 0) continue; // matched only tool I/O
          const meta = parseSessionMeta(rh.head.split('\n'), rh.claudeSessionId, {
            createdFallback: rh.mtime,
            updatedAt: rh.mtime,
          });
          const resolved = resolveRemote(host, rh, meta);
          if (!resolved) continue;
          results.push({ ...resolved, hits });
        }
      } catch (err) {
        log.debug(`remote search failed for ${host.name}`, err);
      }
    }),
  );

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.slice(0, limit);
}
