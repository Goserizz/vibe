import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { isZcodeSessionId } from './discovery.js';
import { withZcodeAppServer } from './appServer.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.zcodeTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a ZCode session Vibe drove. */
export function readZcodeTranscript(sessionId: string): ChatBlock[] {
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

export function appendZcodeBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.zcodeTranscriptsDir, { recursive: true });
    fs.appendFileSync(transcriptFile(sessionId), `${blocks.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist zcode transcript', error);
  }
}

export function deleteZcodeTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Convert a `session/messages` result into normalized blocks. Message shape
 * (probed): `{info:{role:'user'|'assistant', semantics:{kind}, time:{created}},
 *  parts:[{type:'text'|'reasoning'|'tool'|'step-start'|'step-finish'|'timeline', …}]}`.
 * Tool parts carry `{tool, callID, state:{status, input, output, error, time}}`.
 */
export function zcodeMessagesToBlocks(messages: unknown): ChatBlock[] {
  if (!Array.isArray(messages)) return [];
  const blocks: ChatBlock[] = [];
  let n = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const info = (message as { info?: Record<string, unknown> }).info ?? {};
    const role = typeof info.role === 'string' ? info.role : '';
    const kind = typeof (info.semantics as { kind?: unknown } | undefined)?.kind === 'string'
      ? (info.semantics as { kind: string }).kind
      : '';
    // Skip engine-internal timeline entries (model-change separators etc.).
    if (kind && kind !== 'user_prompt' && kind !== 'assistant_response' && role !== 'user') continue;
    const ts = Number((info.time as { created?: unknown } | undefined)?.created) || Date.now();
    for (const part of (message as { parts?: unknown[] }).parts ?? []) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      n += 1;
      switch (p.type) {
        case 'text': {
          const text = typeof p.text === 'string' ? p.text : '';
          if (!text) continue;
          if (role === 'user') {
            blocks.push({ id: `zc_user_${n}`, kind: 'user', text, ts });
          } else {
            blocks.push({ id: `zc_as_${n}`, kind: 'assistant', text, streaming: false, ts });
          }
          continue;
        }
        case 'reasoning': {
          const text = typeof p.text === 'string' ? p.text : '';
          if (!text) continue;
          blocks.push({ id: `zc_th_${n}`, kind: 'thinking', text, streaming: false, ts });
          continue;
        }
        case 'tool': {
          const id = typeof p.callID === 'string' ? p.callID : `zc_tool_${n}`;
          const name = typeof p.tool === 'string' ? p.tool : 'tool';
          const state = (p.state as Record<string, unknown> | undefined) ?? {};
          const status = state.status === 'failed' || state.status === 'error'
            ? 'error'
            : state.status === 'completed'
              ? 'done'
              : 'running';
          const output = state.output ?? state.error;
          const block: ToolBlock = {
            id,
            kind: 'tool',
            toolUseId: id,
            name,
            input: state.input ?? {},
            status,
            result: output == null ? undefined : toolResultText(output),
            isError: status === 'error',
            ts: Number((state.time as { start?: unknown } | undefined)?.start) || ts,
          };
          blocks.push(block);
          continue;
        }
        default:
          // step-start / step-finish / timeline — no rendered content.
          continue;
      }
    }
  }
  return blocks;
}

function toolResultText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2).slice(0, 8000);
  } catch {
    return String(output);
  }
}

/** Read a native ZCode session's history via `zcode app-server` session/messages. */
export async function readZcodeNativeTranscript(sessionId: string): Promise<ChatBlock[]> {
  if (!isZcodeSessionId(sessionId)) return [];
  try {
    const result = await withZcodeAppServer({ timeoutMs: 25_000 }, (request) =>
      request('session/messages', { sessionId }),
    );
    return zcodeMessagesToBlocks((result as { messages?: unknown })?.messages ?? result);
  } catch (error) {
    log.warn('zcode session/messages failed', sessionId, error);
    return [];
  }
}
