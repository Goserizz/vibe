import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { findGrokSessionDir } from './discovery.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.grokTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a Grok session Vibe drove. */
export function readGrokTranscript(sessionId: string): ChatBlock[] {
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

export function appendGrokBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.grokTranscriptsDir, { recursive: true });
    fs.appendFileSync(transcriptFile(sessionId), `${blocks.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist grok transcript', error);
  }
}

export function deleteGrokTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const value = content as { text?: unknown; content?: unknown };
  if (typeof value.text === 'string') return value.text;
  return textOfContent(value.content);
}

function contentListText(content: unknown): string {
  if (!Array.isArray(content)) return textOfContent(content);
  return content.map((item) => textOfContent(item)).filter(Boolean).join('\n');
}

function unwrapUpdate(record: any): any {
  if (!record || typeof record !== 'object') return null;
  if (record.sessionUpdate) return record;
  if (record.update?.sessionUpdate) return record.update;
  if (record.params?.update?.sessionUpdate) return record.params.update;
  return null;
}

/**
 * Best-effort rendering of a native Grok CLI `updates.jsonl` (ACP session
 * update events, one JSON object per line).
 */
export function grokNativeBlocks(raw: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const tools = new Map<string, ToolBlock>();
  let assistant: { id: string; text: string; ts: number } | null = null;
  let thinking: { id: string; text: string; ts: number } | null = null;
  let user: { id: string; text: string; ts: number } | null = null;
  let lineNo = 0;

  const flushAssistant = () => {
    if (!assistant?.text) {
      assistant = null;
      return;
    }
    blocks.push({ id: assistant.id, kind: 'assistant', text: assistant.text, streaming: false, ts: assistant.ts });
    assistant = null;
  };
  const flushThinking = () => {
    if (!thinking?.text) {
      thinking = null;
      return;
    }
    blocks.push({ id: thinking.id, kind: 'thinking', text: thinking.text, streaming: false, ts: thinking.ts });
    thinking = null;
  };
  const flushUser = () => {
    if (!user?.text) {
      user = null;
      return;
    }
    blocks.push({ id: user.id, kind: 'user', text: user.text, ts: user.ts });
    user = null;
  };

  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const update = unwrapUpdate(record);
    if (!update) continue;
    const kind = update.sessionUpdate;
    const ts = Number(update.ts ?? record.ts ?? 0) || 0;

    if (kind === 'user_message_chunk') {
      flushAssistant();
      flushThinking();
      const text = textOfContent(update.content);
      if (!text) continue;
      if (!user) user = { id: `gk_user_${lineNo}`, text, ts };
      else user.text += text;
      continue;
    }
    if (kind === 'agent_message_chunk') {
      flushUser();
      flushThinking();
      const text = textOfContent(update.content);
      if (!text) continue;
      if (!assistant) assistant = { id: `gk_assistant_${lineNo}`, text, ts };
      else assistant.text += text;
      continue;
    }
    if (kind === 'agent_thought_chunk') {
      flushUser();
      flushAssistant();
      const text = textOfContent(update.content);
      if (!text) continue;
      if (!thinking) thinking = { id: `gk_think_${lineNo}`, text, ts };
      else thinking.text += text;
      continue;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      flushUser();
      flushAssistant();
      flushThinking();
      const id = String(update.toolCallId ?? `gk_tool_${lineNo}`);
      const prev = tools.get(id);
      const name = String(update.title || update.kind || prev?.name || 'tool');
      const input = update.rawInput ?? update.raw_input ?? prev?.input ?? {};
      const result = contentListText(update.rawOutput ?? update.content);
      const status = update.status === 'failed' ? 'error' : update.status === 'completed' ? 'done' : 'done';
      const block: ToolBlock = {
        id,
        kind: 'tool',
        toolUseId: id,
        name,
        input,
        status,
        result: result || prev?.result,
        isError: status === 'error',
        ts: prev?.ts || ts,
      };
      tools.set(id, block);
      const existing = blocks.findIndex((b) => b.kind === 'tool' && b.id === id);
      if (existing >= 0) blocks[existing] = block;
      else blocks.push(block);
    }
  }
  flushUser();
  flushThinking();
  flushAssistant();
  return blocks;
}

/** Read a local native Grok CLI session log (`updates.jsonl`). */
export function readGrokNativeTranscript(sessionId: string): ChatBlock[] {
  const dir = findGrokSessionDir(sessionId);
  if (!dir) return [];
  try {
    return grokNativeBlocks(fs.readFileSync(path.join(dir, 'updates.jsonl'), 'utf8'));
  } catch {
    return [];
  }
}
