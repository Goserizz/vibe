import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

/**
 * Locate a Claude transcript by its (globally unique) session id. We search the
 * project folders directly instead of reconstructing the lossy directory name
 * encoding Claude uses for cwd.
 */
export function findTranscriptFile(claudeSessionId: string): string | null {
  const root = config.claudeProjectsDir;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return null;
  }
  const target = `${claudeSessionId}.jsonl`;
  for (const dir of dirs) {
    const candidate = path.join(dir, target);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface RawEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

const INTERNAL_PREFIXES = [
  '<command-name>',
  '<local-command-stdout>',
  '<command-message>',
  'Caveat: The messages below',
];

function isInternal(text: string): boolean {
  const t = text.trimStart();
  return INTERNAL_PREFIXES.some((p) => t.startsWith(p));
}

function toMs(ts?: string): number {
  if (!ts) return Date.now();
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

/**
 * Parse Claude JSONL transcript *content* into the normalized block model. Tool
 * results are folded back into their originating tool block by tool_use_id.
 * Works for both local files and content fetched from a remote host over SSH.
 */
export function parseTranscriptBlocks(content: string): { blocks: ChatBlock[]; cwd?: string } {
  const lines = content.split('\n');
  const blocks: ChatBlock[] = [];
  const toolById = new Map<string, ToolBlock>();
  let cwd: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.cwd && !cwd) cwd = entry.cwd;

    const role = entry.message?.role;
    const content = entry.message?.content;
    const ts = toMs(entry.timestamp);
    const baseId = entry.uuid || `t_${blocks.length}`;
    if (entry.isMeta || entry.isSidechain) continue;
    if (role !== 'user' && role !== 'assistant') continue;

    // String content is a plain user/assistant text turn.
    if (typeof content === 'string') {
      const text = content;
      if (text && !isInternal(text)) {
        blocks.push({ id: baseId, kind: role === 'user' ? 'user' : 'assistant', text, ts, streaming: false } as ChatBlock);
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    content.forEach((part: any, idx: number) => {
      if (!part || typeof part !== 'object') return;
      if (part.type === 'text') {
        const text = String(part.text ?? '');
        if (!text || isInternal(text)) return;
        if (role === 'user') {
          blocks.push({ id: `${baseId}_u${idx}`, kind: 'user', text, ts });
        } else {
          blocks.push({ id: `${baseId}_a${idx}`, kind: 'assistant', text, streaming: false, ts });
        }
      } else if (part.type === 'thinking') {
        const text = String(part.thinking ?? part.text ?? '');
        if (text) blocks.push({ id: `${baseId}_think${idx}`, kind: 'thinking', text, streaming: false, ts });
      } else if (part.type === 'tool_use') {
        const block: ToolBlock = {
          id: String(part.id ?? `${baseId}_tool${idx}`),
          kind: 'tool',
          toolUseId: String(part.id ?? `${baseId}_tool${idx}`),
          name: String(part.name ?? 'tool'),
          input: part.input,
          status: 'running',
          ts,
        };
        toolById.set(block.toolUseId, block);
        blocks.push(block);
      } else if (part.type === 'tool_result') {
        const toolUseId = String(part.tool_use_id ?? '');
        const resultText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        const target = toolById.get(toolUseId);
        if (target) {
          target.result = resultText;
          target.status = part.is_error ? 'error' : 'done';
          target.isError = Boolean(part.is_error);
        }
      }
    });
  }

  return { blocks, cwd };
}

/** Read and parse a local transcript by its (globally unique) session id. */
export function readTranscriptBlocks(claudeSessionId: string): { blocks: ChatBlock[]; cwd?: string } {
  const file = findTranscriptFile(claudeSessionId);
  if (!file) return { blocks: [] };
  try {
    return parseTranscriptBlocks(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn('failed to read transcript', err);
    return { blocks: [] };
  }
}
