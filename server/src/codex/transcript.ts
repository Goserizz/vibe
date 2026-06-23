import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';
import { parseCodexResponseItem } from './normalize.js';

// ---------------------------------------------------------------------------
// Vibe-owned transcript — authoritative for Codex sessions Vibe drives.
//
// Codex stores conversations as plain-JSONL rollouts under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. That's simple enough to read
// directly (no sqlite/protobuf like Cursor), but for sessions we drive we still
// persist the normalized blocks to a simple JSONL under ~/.vibe so snapshot/
// reconnect are reliable and engine-agnostic. The rollout parser below is only a
// best-effort fallback for sessions created outside Vibe.
// ---------------------------------------------------------------------------

function transcriptFile(sessionId: string): string {
  return path.join(config.codexTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read a Vibe-persisted Codex transcript (empty if none yet). */
export function readCodexTranscript(sessionId: string): ChatBlock[] {
  let raw: string;
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
      /* skip a corrupt line */
    }
  }
  return blocks;
}

/** Append a finished turn's blocks to the Vibe-persisted transcript. */
export function appendCodexBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.codexTranscriptsDir, { recursive: true });
    fs.appendFileSync(transcriptFile(sessionId), blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
  } catch (err) {
    log.warn('failed to persist codex transcript', err);
  }
}

/** Remove a Vibe-persisted transcript (on session delete). */
export function deleteCodexTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Best-effort parse of Codex's on-disk rollout for sessions created outside Vibe.
//
// Each line is `{timestamp, type, payload}`. `response_item` lines carry a
// conversation item (message / function_call / function_call_output / reasoning);
// `session_meta` carries id/cwd. We decompose items via the shared
// parseCodexResponseItem and match tool outputs to their calls by id.
// ---------------------------------------------------------------------------

/** Recursively find a rollout file whose name contains the session id. */
function findRollout(sessionId: string): string | undefined {
  const root = config.codexSessionsDir;
  const target = sessionId.toLowerCase();
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.toLowerCase().includes(target)) out.push(full);
    }
  };
  walk(root);
  return out[0];
}

/** Map a rollout's response_items into renderable blocks (tool outputs matched). */
function itemsToBlocks(lines: string[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const toolById = new Map<string, ToolBlock>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj?.type === 'response_item' ? obj.payload : null;
    if (!payload) continue;
    const parts = parseCodexResponseItem(payload);
    for (const p of parts) {
      if (p.kind === 'user') {
        // Skip Codex's injected <environment_context> block; the real prompt is a
        // separate later user item (mirrors Cursor skipping <user_info>).
        if (p.text.startsWith('<environment_context>')) continue;
        blocks.push({ id: `cx_${blocks.length}`, kind: 'user', text: p.text, ts: 0 });
      } else if (p.kind === 'assistant') {
        blocks.push({ id: `cx_${blocks.length}`, kind: 'assistant', text: p.text, streaming: false, ts: 0 });
      } else if (p.kind === 'thinking') {
        blocks.push({ id: `cx_${blocks.length}`, kind: 'thinking', text: p.text, streaming: false, ts: 0 });
      } else if (p.kind === 'toolCall') {
        const tb: ToolBlock = { id: p.id, kind: 'tool', toolUseId: p.id, name: p.name, input: p.input, status: 'done', ts: 0 };
        toolById.set(p.id, tb);
        blocks.push(tb);
      } else if (p.kind === 'toolResult') {
        const tb = toolById.get(p.id);
        if (tb) {
          tb.result = p.content;
          tb.isError = p.isError;
          tb.status = p.isError ? 'error' : 'done';
        }
      }
    }
  }
  return blocks;
}

/** Best-effort read of an external Codex session by id (cwd unused; kept for
 *  signature parity with the cursor reader). */
export function readCodexRolloutTranscript(_cwd: string, sessionId: string): ChatBlock[] {
  const file = findRollout(sessionId);
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return itemsToBlocks(raw.split('\n'));
  } catch (err) {
    log.debug('codex rollout transcript failed', err);
    return [];
  }
}
