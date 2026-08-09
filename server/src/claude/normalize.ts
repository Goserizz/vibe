import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  DEFAULT_CONTEXT_WINDOW,
  type BackgroundTask,
  type BackgroundTaskStatus,
  type LiveEvent,
  type TokenUsage,
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
  /** Accumulated streamed text per block id, so `block_end` can carry the full
   *  text and recover a block even if its deltas were dropped on the wire. */
  private readonly streamTextById = new Map<string, string>();
  private readonly assistantOffset = new Map<string, number>();
  private readonly tasks = new Map<string, BackgroundTask>();

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
