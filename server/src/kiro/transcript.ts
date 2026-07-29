import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { ChatBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.kiroTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a Kiro session Vibe drove. */
export function readKiroTranscript(sessionId: string): ChatBlock[] {
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

export function appendKiroBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.kiroTranscriptsDir, { recursive: true });
    fs.appendFileSync(transcriptFile(sessionId), `${blocks.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist kiro transcript', error);
  }
}

export function deleteKiroTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const p = part as { kind?: string; data?: unknown; text?: unknown };
        if (typeof p.data === 'string') return p.data;
        if (typeof p.text === 'string') return p.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Best-effort rendering of a native Kiro CLI event log (`*.jsonl`). */
export function readKiroNativeTranscript(sessionId: string): ChatBlock[] {
  const file = path.join(config.kiroSessionsDir, `${sessionId}.jsonl`);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const blocks: ChatBlock[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = record?.kind;
    const data = record?.data ?? {};
    const ts = Number(data?.meta?.timestamp) || 0;
    if (kind === 'Prompt') {
      const text = contentText(data.content);
      if (text) blocks.push({ id: `kr_user_${lineNo}`, kind: 'user', text, ts });
      continue;
    }
    if (kind === 'AssistantMessage') {
      const text = contentText(data.content);
      if (text) {
        blocks.push({
          id: String(data.message_id ?? `kr_assistant_${lineNo}`),
          kind: 'assistant',
          text,
          streaming: false,
          ts,
        });
      }
      continue;
    }
    if (kind === 'ToolUse' || kind === 'ToolCall') {
      const id = String(data.tool_use_id ?? data.toolCallId ?? data.message_id ?? `kr_tool_${lineNo}`);
      blocks.push({
        id,
        kind: 'tool',
        toolUseId: id,
        name: String(data.name ?? data.tool_name ?? 'tool'),
        input: data.input ?? data.args ?? {},
        status: 'done',
        result: typeof data.output === 'string' ? data.output : undefined,
        ts,
      });
    }
  }
  return blocks;
}
