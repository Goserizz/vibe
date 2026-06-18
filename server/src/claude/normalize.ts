import crypto from 'node:crypto';
import { DEFAULT_CONTEXT_WINDOW, type LiveEvent, type TokenUsage } from '../../../shared/protocol.js';

export interface NormalizerCallbacks {
  onEvent: (ev: LiveEvent) => void;
  onClaudeSessionId: (id: string) => void;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function extractUsage(usage: Record<string, unknown> | undefined): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const cacheCreationTokens = num(usage.cache_creation_input_tokens);
  const contextUsed = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextUsed, contextWindow: DEFAULT_CONTEXT_WINDOW };
}

/**
 * Translates the Claude Code stream-json message stream into normalized
 * `LiveEvent`s. Shared by the local SDK runner and the remote (SSH+CLI) runner
 * since both speak the exact same stream-json protocol.
 *
 * Text and thinking stream incrementally via partial messages; the full
 * `assistant` message (delivered one content block at a time) provides the
 * authoritative blocks. A per-message offset reconstructs absolute block
 * indices so streamed and final blocks share ids and reconcile cleanly.
 */
export class StreamNormalizer {
  private currentMessageId = '';
  private readonly streamKindByIndex = new Map<number, 'assistant' | 'thinking'>();
  private readonly assistantOffset = new Map<string, number>();

  constructor(private readonly cb: NormalizerCallbacks) {}

  private blockId(index: number): string {
    return `${this.currentMessageId || 'msg'}:${index}`;
  }

  push(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (message.session_id) this.cb.onClaudeSessionId(message.session_id);

    switch (message.type) {
      case 'stream_event':
        this.handleStreamEvent(message.event);
        return;
      case 'assistant':
        this.handleAssistant(message);
        return;
      case 'user':
        this.handleUser(message);
        return;
      case 'result':
        this.handleResult(message);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(event: any): void {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'message_start':
        this.currentMessageId = event.message?.id || this.currentMessageId;
        return;
      case 'content_block_start': {
        const idx = num(event.index);
        const block = event.content_block;
        if (block?.type === 'text') {
          this.streamKindByIndex.set(idx, 'assistant');
          this.cb.onEvent({ k: 'block', block: { id: this.blockId(idx), kind: 'assistant', text: '', streaming: true, ts: Date.now() } });
        } else if (block?.type === 'thinking') {
          this.streamKindByIndex.set(idx, 'thinking');
          this.cb.onEvent({ k: 'block', block: { id: this.blockId(idx), kind: 'thinking', text: '', streaming: true, ts: Date.now() } });
        }
        return;
      }
      case 'content_block_delta': {
        const idx = num(event.index);
        const kind = this.streamKindByIndex.get(idx);
        if (!kind) return;
        const delta = event.delta;
        const chunk = delta?.type === 'text_delta' ? delta.text
          : delta?.type === 'thinking_delta' ? delta.thinking
          : '';
        if (chunk) this.cb.onEvent({ k: 'delta', id: this.blockId(idx), field: 'text', chunk });
        return;
      }
      case 'content_block_stop': {
        const idx = num(event.index);
        if (this.streamKindByIndex.has(idx)) {
          this.cb.onEvent({ k: 'block_end', id: this.blockId(idx) });
          this.streamKindByIndex.delete(idx);
        }
        return;
      }
      default:
        return;
    }
  }

  private handleAssistant(message: any): void {
    const msgId = message.message?.id || this.currentMessageId;
    const content = message.message?.content;
    const ts = Date.now();
    if (Array.isArray(content)) {
      const base = this.assistantOffset.get(msgId) ?? 0;
      content.forEach((part: any, i: number) => {
        const idx = base + i;
        if (part?.type === 'text') {
          this.cb.onEvent({ k: 'block', block: { id: `${msgId}:${idx}`, kind: 'assistant', text: String(part.text ?? ''), streaming: false, ts } });
        } else if (part?.type === 'thinking') {
          this.cb.onEvent({ k: 'block', block: { id: `${msgId}:${idx}`, kind: 'thinking', text: String(part.thinking ?? ''), streaming: false, ts } });
        } else if (part?.type === 'tool_use') {
          const id = String(part.id);
          this.cb.onEvent({ k: 'block', block: { id, kind: 'tool', toolUseId: id, name: String(part.name ?? 'tool'), input: part.input, status: 'running', ts } });
        }
      });
      this.assistantOffset.set(msgId, base + content.length);
    }
    const usage = extractUsage(message.message?.usage);
    if (usage) this.cb.onEvent({ k: 'token_usage', usage });
  }

  private handleUser(message: any): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part?.type === 'tool_result') {
        const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        this.cb.onEvent({ k: 'tool_result', toolUseId: String(part.tool_use_id ?? ''), content: text, isError: Boolean(part.is_error) });
      }
    }
  }

  private handleResult(message: any): void {
    const usage = extractUsage(message.usage);
    if (usage) this.cb.onEvent({ k: 'token_usage', usage });
    this.cb.onEvent({
      k: 'block',
      block: {
        id: `result_${crypto.randomUUID()}`,
        kind: 'result',
        usage: usage ?? undefined,
        costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
        durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : undefined,
        isError: Boolean(message.is_error),
        subtype: typeof message.subtype === 'string' ? message.subtype : undefined,
        ts: Date.now(),
      },
    });
  }
}
