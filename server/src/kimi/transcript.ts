import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { findKimiSessionDir } from './discovery.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.kimiTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a Kimi session Vibe drove. */
export function readKimiTranscript(sessionId: string): ChatBlock[] {
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { blocks.push(JSON.parse(line) as ChatBlock); } catch { /* skip corrupt line */ }
  }
  return blocks;
}

export function appendKimiBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.kimiTranscriptsDir, { recursive: true });
    fs.appendFileSync(transcriptFile(sessionId), `${blocks.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist kimi transcript', error);
  }
}

export function deleteKimiTranscript(sessionId: string): void {
  try { fs.rmSync(transcriptFile(sessionId), { force: true }); } catch { /* ignore */ }
}

function textParts(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function resultText(result: any): { text: string; isError: boolean } {
  const isError = Boolean(result?.error ?? result?.isError);
  const value = result?.error ?? result?.output ?? result;
  if (typeof value === 'string') return { text: value || '(no output)', isError };
  try { return { text: JSON.stringify(value, null, 2), isError }; } catch { return { text: String(value), isError }; }
}

/** Best-effort rendering of a native Kimi Code wire log's content. */
export function kimiWireBlocks(raw: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const tools = new Map<string, ToolBlock>();
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    const ts = Number(record.time) || 0;
    if (record.type === 'turn.prompt' && record.origin?.kind === 'user') {
      const text = textParts(record.input);
      if (text) blocks.push({ id: `kw_user_${lineNo}`, kind: 'user', text, ts });
      continue;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) continue;
    const event = record.event;
    if (event.type === 'content.part') {
      const part = event.part;
      const text = part?.type === 'think' ? String(part.think ?? '') : part?.type === 'text' ? String(part.text ?? '') : '';
      if (!text) continue;
      const kind = part.type === 'think' ? 'thinking' : 'assistant';
      blocks.push({
        id: String(event.uuid ?? `kw_${kind}_${lineNo}`),
        kind,
        text,
        streaming: false,
        ts,
      } as ChatBlock);
    } else if (event.type === 'tool.call') {
      const id = String(event.toolCallId ?? event.uuid ?? `kw_tool_${lineNo}`);
      const block: ToolBlock = {
        id,
        kind: 'tool',
        toolUseId: id,
        name: String(event.name ?? 'tool'),
        input: event.args ?? {},
        status: 'running',
        ts,
      };
      tools.set(id, block);
      blocks.push(block);
    } else if (event.type === 'tool.result') {
      const id = String(event.toolCallId ?? event.parentUuid ?? '');
      const tool = tools.get(id);
      if (!tool) continue;
      const result = resultText(event.result);
      tool.result = result.text;
      tool.isError = result.isError;
      tool.status = result.isError ? 'error' : 'done';
    }
  }
  return blocks;
}

/** Read a local native Kimi Code session's wire log (via the session index). */
export function readKimiWireTranscript(sessionId: string): ChatBlock[] {
  const dir = findKimiSessionDir(sessionId);
  if (!dir) return [];
  try {
    return kimiWireBlocks(fs.readFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), 'utf8'));
  } catch {
    return [];
  }
}
