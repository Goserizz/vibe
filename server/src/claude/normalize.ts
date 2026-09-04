import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  type BackgroundTask,
  type BackgroundTaskStatus,
  type LiveEvent,
} from '../../../shared/protocol.js';

export interface NormalizerCallbacks {
  onEvent: (ev: LiveEvent) => void;
  onClaudeSessionId: (id: string) => void;
  onTask?: (task: BackgroundTask) => void;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Context tokens for one model request from provider-reported usage.
 *
 * Providers often expose the same counters under several aliases at once. In
 * particular, CodeBuddy emits both snake_case and camelCase input totals, while
 * Codex reports `cached_input_tokens` as a subset of `input_tokens`. Adding all
 * known fields therefore double-counts the prompt. Prefer an explicit provider
 * total, then select exactly one usage family. Anthropic's
 * `cache_{read,creation}_input_tokens` remain additive because its
 * `input_tokens` excludes those cache buckets; OpenAI's `cached_input_tokens`
 * is deliberately not additive. Returns undefined when no usage is present. */
export function usageContextTokens(usage: any): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;

  // Provider totals already account for cache and reasoning sub-buckets. They
  // also disambiguate hybrid objects that expose two naming conventions.
  for (const key of ['total_tokens', 'totalTokens']) {
    const total = num(usage[key]);
    if (total > 0) return total;
  }

  // OpenAI-compatible prompt_tokens already includes cached prompt tokens.
  const flat = num(usage.prompt_tokens) + num(usage.completion_tokens);
  if (flat > 0) return flat;

  const hasSnake = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cached_input_tokens',
  ].some((key) => usage[key] != null);
  if (hasSnake) {
    const split =
      num(usage.input_tokens)
      + num(usage.cache_creation_input_tokens)
      + num(usage.cache_read_input_tokens)
      + num(usage.output_tokens);
    if (split > 0) return split;
  }

  const hasCamel = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'cacheWriteTokens',
  ].some((key) => usage[key] != null);
  if (hasCamel) {
    // Cursor's inputTokens excludes its cache buckets. cacheCreationTokens and
    // cacheWriteTokens are aliases, so select one rather than summing both.
    const cacheCreation = usage.cacheCreationTokens != null
      ? num(usage.cacheCreationTokens)
      : num(usage.cacheWriteTokens);
    const split =
      num(usage.inputTokens)
      + num(usage.cacheReadTokens)
      + cacheCreation
      + num(usage.outputTokens);
    if (split > 0) return split;
  }

  return undefined;
}

/** Claude Code ≥2.1 reports each model's context window on the result event's
 *  `modelUsage` map (verified against a live stream-json session). */
function modelContextWindow(message: any): number | undefined {
  const modelUsage = message?.modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = (entry as { contextWindow?: unknown } | null)?.contextWindow;
    if (typeof w === 'number' && Number.isFinite(w)) return w;
  }
  return undefined;
}

function readOutputTail(file: unknown, maxBytes = 16_000): string | undefined {
  if (typeof file !== 'string' || !file) return undefined;
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    return buffer.toString('utf8').trim() || undefined;
  } catch {
    // Remote Claude output paths are not readable by the local Vibe server;
    // their progress/completion summary remains available instead.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
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
  /** Accumulated streamed text per block id, so `block_end` can carry the full
   *  text and recover a block even if its deltas were dropped on the wire. */
  private readonly streamTextById = new Map<string, string>();
  private readonly assistantOffset = new Map<string, number>();
  private readonly tasks = new Map<string, BackgroundTask>();
  /** input+cache+output of the last assistant message (= final model request).
   *  The result event's usage sums every request in the turn, which overcounts
   *  the context on multi-round agentic turns. */
  private lastRequestTokens?: number;
  /** Model responses this turn — one full `assistant` message each (partials
   *  arrive as stream_event). Gates the cumulative result.usage fallback. */
  private assistantResponses = 0;

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
      case 'system':
        this.handleSystem(message);
        return;
      default:
        return;
    }
  }

  private handleSystem(message: any): void {
    const subtype = String(message.subtype ?? '');
    if (!subtype.startsWith('task_')) return;
    const id = String(message.task_id ?? '');
    if (!id) return;

    const previous = this.tasks.get(id);
    const now = Date.now();
    let status: BackgroundTaskStatus = previous?.status ?? 'running';
    if (subtype === 'task_started') status = 'running';
    if (subtype === 'task_notification') status = message.status === 'completed'
      ? 'completed'
      : message.status === 'stopped' ? 'stopped' : 'failed';
    const patchStatus = message.patch?.status;
    if (typeof patchStatus === 'string') {
      status = patchStatus === 'killed' ? 'stopped' : patchStatus as BackgroundTaskStatus;
    }

    const taskType = String(message.task_type ?? previous?.kind ?? '');
    const kind: BackgroundTask['kind'] = message.subagent_type || /agent|subagent/i.test(taskType)
      ? 'subagent'
      : /bash|shell|command/i.test(taskType) ? 'command' : (previous?.kind ?? 'other');
    const terminal = status === 'completed' || status === 'failed' || status === 'stopped';
    const summary = typeof message.summary === 'string' ? message.summary.slice(0, 8_000) : undefined;
    const outputFile = typeof message.output_file === 'string' ? message.output_file : previous?.outputFile;
    const output = readOutputTail(outputFile) ?? summary ?? previous?.output;
    const error = typeof message.patch?.error === 'string' ? message.patch.error.slice(0, 8_000) : undefined;
    const task: BackgroundTask = {
      id,
      agent: 'claude',
      kind,
      status,
      description: String(message.description ?? message.patch?.description ?? previous?.description ?? `Task ${id}`),
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      endedAt: terminal ? Number(message.patch?.end_time) || now : previous?.endedAt,
      detail: typeof message.prompt === 'string' ? message.prompt : previous?.detail,
      activity: typeof message.last_tool_name === 'string' ? message.last_tool_name : previous?.activity,
      summary: summary ?? previous?.summary,
      output,
      outputFile,
      canStop: !terminal,
      error: error ?? previous?.error,
    };
    this.tasks.set(id, task);
    this.cb.onTask?.(task);
  }

  private handleStreamEvent(event: any): void {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'message_start':
        this.currentMessageId = event.message?.id || this.currentMessageId;
        return;
      case 'content_block_start': {
        const idx = num(event.index);
        const id = this.blockId(idx);
        const block = event.content_block;
        if (block?.type === 'text') {
          this.streamKindByIndex.set(idx, 'assistant');
          this.streamTextById.set(id, '');
          this.cb.onEvent({ k: 'block', block: { id, kind: 'assistant', text: '', streaming: true, ts: Date.now() } });
        } else if (block?.type === 'thinking') {
          this.streamKindByIndex.set(idx, 'thinking');
          this.streamTextById.set(id, '');
          this.cb.onEvent({ k: 'block', block: { id, kind: 'thinking', text: '', streaming: true, ts: Date.now() } });
        }
        return;
      }
      case 'content_block_delta': {
        const idx = num(event.index);
        const kind = this.streamKindByIndex.get(idx);
        if (!kind) return;
        const id = this.blockId(idx);
        const delta = event.delta;
        const chunk = delta?.type === 'text_delta' ? delta.text
          : delta?.type === 'thinking_delta' ? delta.thinking
          : '';
        if (chunk) {
          this.streamTextById.set(id, (this.streamTextById.get(id) ?? '') + chunk);
          this.cb.onEvent({ k: 'delta', id, field: 'text', chunk });
        }
        return;
      }
      case 'content_block_stop': {
        const idx = num(event.index);
        if (this.streamKindByIndex.has(idx)) {
          const id = this.blockId(idx);
          // Carry the accumulated text so a block whose deltas were dropped
          // mid-stream still finalizes with its full content.
          const text = this.streamTextById.get(id);
          this.cb.onEvent({ k: 'block_end', id, ...(text != null ? { text } : {}) });
          this.streamKindByIndex.delete(idx);
          this.streamTextById.delete(id);
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
    const used = usageContextTokens(message.message?.usage);
    if (used) this.lastRequestTokens = used;
    this.assistantResponses++;
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
    this.cb.onEvent({
      k: 'block',
      block: {
        id: `result_${crypto.randomUUID()}`,
        kind: 'result',
        costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
        durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : undefined,
        isError: Boolean(message.is_error),
        subtype: typeof message.subtype === 'string' ? message.subtype : undefined,
        // Multi-request turns with no per-request usage (e.g. proxy backends
        //  that zero assistant usage) have only the cumulative result.usage —
        //  not a watermark — so omit rather than show an inflated number.
        contextUsed: this.lastRequestTokens
          ?? (this.assistantResponses > 1 ? undefined : usageContextTokens(message.usage)),
        contextWindow: modelContextWindow(message),
        ts: Date.now(),
      },
    });
  }
}
