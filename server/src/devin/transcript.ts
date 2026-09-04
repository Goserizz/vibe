import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { externalizeResults } from '../sessions/blobs.js';
import { log } from '../log.js';
import { openSqliteReadonly, type SqliteDb } from '../switch/sqlite.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.devinTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a Devin session Vibe drove. */
export function readDevinTranscript(sessionId: string): ChatBlock[] {
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      blocks.push(JSON.parse(line) as ChatBlock);
    } catch {
      /* skip corrupt line */
    }
  }
  return blocks;
}

export function appendDevinBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.devinTranscriptsDir, { recursive: true });
    const persisted = externalizeResults(sessionId, blocks);
    fs.appendFileSync(transcriptFile(sessionId), `${persisted.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist devin transcript', error);
  }
}

export function deleteDevinTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Native transcript (Devin's own SQLite store)
// ---------------------------------------------------------------------------

/**
 * Shape of one `message_nodes.chat_message` row.
 *
 * Devin stores a conversation as a *forest*: every node points at its parent,
 * and a session can hold several chains (system-prefix rebuilds, compactions,
 * rewinds). `sessions.main_chain_id` names the tip of the canonical one, so the
 * readable history is the path from that tip back to a root, reversed.
 *
 * `role` is `system` | `user` | `assistant` | `tool`. An `assistant` node may
 * carry `tool_calls`; the matching `tool` node carries `tool_call_id` and the
 * rendered result text.
 */
interface DevinChatMessage {
  message_id?: string;
  role?: string;
  content?: string;
  tool_calls?: { id?: string; name?: string; arguments?: unknown }[];
  tool_call_id?: string;
  /** `chisel/tool_result_meta.success === false` marks a failed tool call. */
  metadata?: { extensions?: Record<string, { success?: boolean }> };
}

interface DevinNode {
  nodeId: number;
  parent: number | null;
  msg: DevinChatMessage;
  createdAt: number;
}

function parseNode(row: Record<string, unknown>): DevinNode | null {
  const nodeId = Number(row.node_id);
  if (!Number.isFinite(nodeId)) return null;
  let msg: DevinChatMessage | null = null;
  try {
    msg = JSON.parse(String(row.chat_message ?? '')) as DevinChatMessage;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const parentRaw = row.parent_node_id;
  return {
    nodeId,
    parent: parentRaw === null || parentRaw === undefined ? null : Number(parentRaw),
    msg,
    createdAt: Number(row.created_at) || 0,
  };
}

function mainChain(nodes: Map<number, DevinNode>, tipId: number | null): DevinNode[] {
  const start = tipId != null && nodes.has(tipId) ? tipId : null;
  // No usable tip (older/partially written session): take the highest node id,
  // which is the most recently appended message.
  let cursor = start ?? (nodes.size ? Math.max(...nodes.keys()) : null);
  const chain: DevinNode[] = [];
  const seen = new Set<number>();
  while (cursor != null && nodes.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes.get(cursor)!;
    chain.push(node);
    cursor = node.parent;
  }
  return chain.reverse();
}

/** Convert Devin's main chain into Vibe's normalized blocks. */
export function devinNativeBlocks(nodes: Map<number, DevinNode>, tipId: number | null): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  /** Tool blocks awaiting their result node, by Devin tool-call id. */
  const pending = new Map<string, ToolBlock>();

  for (const node of mainChain(nodes, tipId)) {
    const { msg } = node;
    const ts = node.createdAt > 0 ? node.createdAt * 1000 : Date.now();
    const role = msg.role ?? '';

    if (role === 'user') {
      // Trim only to test emptiness — the stored text is kept verbatim, since
      // leading/trailing whitespace is part of the message.
      const text = msg.content ?? '';
      if (text.trim()) blocks.push({ id: `dv_user_${node.nodeId}`, kind: 'user', text, ts });
      continue;
    }

    if (role === 'assistant') {
      // Text comes first: Vibe's canonical turn model attributes a tool call to
      // the assistant message that precedes it, so emitting the calls first
      // would orphan them onto a synthetic empty assistant block.
      const text = msg.content ?? '';
      if (text.trim()) {
        blocks.push({
          id: `dv_assistant_${node.nodeId}`,
          kind: 'assistant',
          text,
          streaming: false,
          ts,
        });
      }
      for (const [index, call] of (msg.tool_calls ?? []).entries()) {
        const id = String(call?.id ?? `dv_tool_${node.nodeId}_${index}`);
        const block: ToolBlock = {
          id,
          kind: 'tool',
          toolUseId: id,
          name: String(call?.name ?? 'tool'),
          input: (call?.arguments as Record<string, unknown>) ?? {},
          status: 'done',
          ts,
        };
        pending.set(id, block);
        blocks.push(block);
      }
      continue;
    }

    if (role === 'tool') {
      const callId = String(msg.tool_call_id ?? '');
      const block = callId ? pending.get(callId) : undefined;
      if (!block) continue;
      block.result = msg.content ?? '';
      block.status = 'done';
      const success = msg.metadata?.extensions?.['chisel/tool_result_meta']?.success;
      // Only an explicit `false` means failure — the field is absent on most
      // real tool nodes, which are all successes.
      if (success === false) block.isError = true;
      pending.delete(callId);
    }
    // `system` nodes (system prefix, skills catalogue) are intentionally
    // dropped — they're regenerated per turn, not conversation history.
  }
  return blocks;
}

/**
 * Read a native Devin session out of a specific SQLite store.
 *
 * Best-effort: returns `[]` when the session is gone or the `better-sqlite3`
 * addon is unavailable (Vibe keeps working without it, and remote hosts are
 * covered by `readRemoteDevinTranscript`). The path is a parameter so tests can
 * read a throwaway copy instead of the real `~/.local/share/devin` database.
 */
export function readDevinNativeTranscriptAt(dbPath: string, sessionId: string): ChatBlock[] {
  const db: SqliteDb | null = openSqliteReadonly(dbPath);
  if (!db) return [];
  try {
    const session = db
      .prepare('select main_chain_id from sessions where id = ?')
      .get(sessionId) as { main_chain_id?: number | null } | undefined;
    if (!session) return [];

    const rows = db
      .prepare('select node_id, parent_node_id, chat_message, created_at from message_nodes where session_id = ?')
      .all(sessionId) as Record<string, unknown>[];
    const nodes = new Map<number, DevinNode>();
    for (const row of rows) {
      const node = parseNode(row);
      if (node) nodes.set(node.nodeId, node);
    }
    if (!nodes.size) return [];

    const tip = session.main_chain_id ?? null;
    return devinNativeBlocks(nodes, tip);
  } catch (error) {
    log.debug(`devin native transcript failed for ${sessionId}`, error);
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Read a local native Devin session from this machine's store. */
export function readDevinNativeTranscript(sessionId: string): ChatBlock[] {
  return readDevinNativeTranscriptAt(config.devinSessionsDb, sessionId);
}
