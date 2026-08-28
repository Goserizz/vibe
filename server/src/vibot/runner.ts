import crypto from 'node:crypto';
import { log } from '../log.js';
import { type ChatBlock, type LiveEvent } from '../../../shared/protocol.js';
import { convStore } from './conversations.js';
import { streamChat, LlmError, type LlmMessage, type LlmToolCall } from './llm.js';
import { VIBOT_TOOLS, dispatchTool } from './tools.js';
import type { VibotConfig } from '../../../shared/protocol.js';

export interface VibotRunCallbacks {
  onEvent: (ev: LiveEvent) => void;
}

export interface VibotRunOptions {
  convId: string;
  prompt: string;
  config: VibotConfig;
}

export interface VibotRunResult {
  /** LLM messages produced this turn (user prompt + assistant/tool exchanges),
   *  to append to the persisted history. The system message is NOT included —
   *  it is prepended fresh from config on every turn. */
  newMessages: LlmMessage[];
  error?: string;
}

export interface VibotRunHandle {
  abort: () => void;
  done: Promise<VibotRunResult>;
}

/** Safety cap on tool-call rounds per turn so a model loop can't run forever. */
const MAX_ROUNDS = 12;

function parseArgs(raw: string): Record<string, any> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Drive one Vibot turn: stream the model, emit LiveEvents for the rendered
 * transcript, execute any tool calls, and loop until the model stops calling
 * tools. The system prompt is prepended fresh from config each turn (never
 * persisted), so edits apply to future turns immediately.
 */
export function startVibotRun(opts: VibotRunOptions, cb: VibotRunCallbacks): VibotRunHandle {
  const ac = new AbortController();
  const startedAt = Date.now();

  const done = (async (): Promise<VibotRunResult> => {
    const conv = convStore.get(opts.convId);
    const seed: LlmMessage[] = conv?.messages ?? [];
    const system: LlmMessage = { role: 'system', content: opts.config.systemPrompt };

    // This turn's append-only history (user prompt first; assistant/tool follow).
    const turn: LlmMessage[] = [{ role: 'user', content: opts.prompt }];

    // The live messages array sent to the API each round.
    const live = (): LlmMessage[] => [system, ...seed, ...turn];

    // Usage of the last completed round — its prompt already contains the full
    // history, so prompt + completion is the context the next round starts from.
    let contextUsed: number | undefined;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const assistantId = `va_${crypto.randomUUID()}`;
      const thinkingId = `vt_${crypto.randomUUID()}`;
      let text = '';
      let thinking = '';
      let blockOpen = false;
      let thinkingOpen = false;
      let toolCalls: LlmToolCall[] = [];

      const closeThinking = () => {
        if (!thinkingOpen) return;
        thinkingOpen = false;
        cb.onEvent({ k: 'block_end', id: thinkingId, text: thinking });
      };

      try {
        for await (const ev of streamChat({
          baseUrl: opts.config.baseUrl,
          apiKey: opts.config.apiKey,
          model: opts.config.model,
          messages: live(),
          tools: VIBOT_TOOLS,
          temperature: opts.config.temperature,
          reasoning_effort: opts.config.reasoning_effort,
          signal: ac.signal,
        })) {
          if (ev.type === 'thinking') {
            if (!thinkingOpen) {
              thinkingOpen = true;
              cb.onEvent({
                k: 'block',
                block: { id: thinkingId, kind: 'thinking', text: '', streaming: true, ts: Date.now() },
              });
            }
            if (ev.delta) {
              thinking += ev.delta;
              cb.onEvent({ k: 'delta', id: thinkingId, field: 'text', chunk: ev.delta });
            }
          } else if (ev.type === 'text') {
            // Reasoning finishes when visible content (or tools) begins.
            closeThinking();
            if (!blockOpen) {
              blockOpen = true;
              cb.onEvent({ k: 'block', block: { id: assistantId, kind: 'assistant', text: '', streaming: true, ts: Date.now() } });
            }
            if (ev.delta) {
              text += ev.delta;
              cb.onEvent({ k: 'delta', id: assistantId, field: 'text', chunk: ev.delta });
            }
          } else if (ev.type === 'tool_calls') {
            closeThinking();
            toolCalls = ev.calls;
          } else if (ev.type === 'done' && ev.usage) {
            const u = ev.usage;
            const total = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
            if (total > 0) contextUsed = total;
          }
        }
      } catch (err) {
        if (ac.signal.aborted) {
          log.debug('vibot run aborted');
          closeThinking();
          if (blockOpen) cb.onEvent({ k: 'block_end', id: assistantId, text });
          return { newMessages: turn };
        }
        const msg = err instanceof LlmError ? err.message : err instanceof Error ? err.message : String(err);
        log.warn('vibot llm error:', msg);
        closeThinking();
        if (blockOpen) cb.onEvent({ k: 'block_end', id: assistantId, text });
        // Keep a partial assistant message so the exchange stays well-formed.
        if (text) turn.push({ role: 'assistant', content: text });
        cb.onEvent({ k: 'error', text: msg });
        return { newMessages: turn, error: msg };
      }

      // Stream ended with reasoning only (no text / tools yet) — close cleanly.
      closeThinking();

      // Finalize the streamed assistant block.
      if (blockOpen) cb.onEvent({ k: 'block_end', id: assistantId, text });

      // Record the assistant turn (text and/or tool calls). Thinking is UI-only
      // and must not enter the LLM message history.
      if (text || toolCalls.length) {
        const aMsg: LlmMessage = { role: 'assistant', content: text || null };
        if (toolCalls.length) aMsg.tool_calls = toolCalls;
        turn.push(aMsg);
      }

      // No tool calls ⇒ the model produced a final answer; end the turn.
      if (!toolCalls.length) {
        cb.onEvent({
          k: 'block',
          block: {
            id: `vr_${crypto.randomUUID()}`,
            kind: 'result',
            durationMs: Date.now() - startedAt,
            contextUsed,
            ts: Date.now(),
          },
        });
        return { newMessages: turn };
      }

      // Execute each tool call and feed results back for the next round.
      for (const tc of toolCalls) {
        const input = parseArgs(tc.function.arguments);
        cb.onEvent({
          k: 'block',
          block: {
            id: tc.id,
            kind: 'tool',
            toolUseId: tc.id,
            name: tc.function.name,
            input,
            status: 'running',
            ts: Date.now(),
          },
        });
        let result: string;
        let isError = false;
        try {
          result = await dispatchTool(tc.function.name, input, { convId: opts.convId });
        } catch (err) {
          isError = true;
          result = `Tool ${tc.function.name} threw: ${err instanceof Error ? err.message : String(err)}`;
        }
        cb.onEvent({ k: 'tool_result', toolUseId: tc.id, content: result, isError });
        turn.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
      }
    }

    // Hit the round cap — record a gentle stop.
    cb.onEvent({ k: 'block', block: { id: `vr_${crypto.randomUUID()}`, kind: 'result', durationMs: Date.now() - startedAt, contextUsed, ts: Date.now() } });
    return { newMessages: turn };
  })();

  return {
    abort: () => {
      try { ac.abort(); } catch { /* ignore */ }
    },
    done,
  };
}

/** Reduce a live event into a ChatBlock[] snapshot (mirrors the web reducer),
 *  used by the hub to persist a turn's rendered transcript. */
export function applyEventToBlocks(blocks: ChatBlock[], ev: LiveEvent): ChatBlock[] {
  const next = blocks;
  const upsert = (b: ChatBlock) => {
    const at = next.findIndex((x) => x.id === b.id);
    if (at === -1) next.push(b);
    else next[at] = b;
  };
  switch (ev.k) {
    case 'block':
      upsert(ev.block);
      break;
    case 'delta': {
      const at = next.findIndex((b) => b.id === ev.id);
      if (at !== -1 && (next[at].kind === 'assistant' || next[at].kind === 'thinking')) {
        next[at] = { ...next[at], text: (next[at] as { text: string }).text + ev.chunk } as ChatBlock;
      }
      break;
    }
    case 'block_end': {
      const at = next.findIndex((b) => b.id === ev.id);
      if (at !== -1 && (next[at].kind === 'assistant' || next[at].kind === 'thinking')) {
        next[at] = { ...next[at], streaming: false, ...(ev.text != null ? { text: ev.text } : {}) } as ChatBlock;
      }
      break;
    }
    case 'tool_result': {
      const at = next.findIndex((b) => b.id === ev.toolUseId);
      if (at !== -1 && next[at].kind === 'tool') {
        next[at] = { ...next[at], result: ev.content, status: ev.isError ? 'error' : 'done', isError: ev.isError } as ChatBlock;
      }
      break;
    }
    case 'error':
      // errors aren't part of the persisted transcript
      break;
    default:
      break;
  }
  return next;
}
