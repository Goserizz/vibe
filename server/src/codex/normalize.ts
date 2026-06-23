import crypto from 'node:crypto';
import { DEFAULT_CONTEXT_WINDOW, type TokenUsage } from '../../../shared/protocol.js';
import type { NormalizerCallbacks } from '../claude/normalize.js';

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Codex reports usage under `info.total_token_usage` (snake_case, with cached +
 *  reasoning fields). Works for both the live `token_count` event and the rollout
 *  `event_msg` payload (which nest it under `info`). */
export function extractCodexUsage(info: Record<string, any> | undefined): TokenUsage | null {
  if (!info) return null;
  const u = info.total_token_usage ?? info.last_token_usage ?? info;
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens ?? u.reasoning_output_tokens);
  const cacheReadTokens = num(u.cached_input_tokens);
  const cacheCreationTokens = 0;
  const contextUsed = num(u.total_tokens) || inputTokens + cacheReadTokens + outputTokens;
  const contextWindow = num(info.model_context_window) || DEFAULT_CONTEXT_WINDOW;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextUsed, contextWindow };
}

/** Parse a `function_call` arguments string (JSON) into an object, falling back to
 *  the raw string so the tool block always shows something useful. */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Join every text-like content part of a message into one string. */
function joinContent(content: any, want: string[]): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && typeof part === 'object' && want.includes(part.type) && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/** A response_item decomposed into engine-neutral pieces (shared by the live
 *  normalizer and the on-disk rollout reader). */
export type ParsedItem =
  | { kind: 'assistant'; text: string }
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; id: string; name: string; input: unknown }
  | { kind: 'toolResult'; id: string; content: string; isError: boolean };

/** Map a Codex response_item (message / function_call / function_call_output /
 *  reasoning) into neutral pieces. Returns [] for anything we don't render. */
export function parseCodexResponseItem(item: any): ParsedItem[] {
  if (!item || typeof item !== 'object') return [];
  const type = item.type;

  if (type === 'message') {
    const role = item.role;
    if (role === 'user') {
      const t = joinContent(item.content, ['input_text', 'text']).trim();
      return t ? [{ kind: 'user', text: t }] : [];
    }
    if (role === 'assistant') {
      const t = joinContent(item.content, ['output_text', 'text']);
      return t ? [{ kind: 'assistant', text: t }] : [];
    }
    return [];
  }
  if (type === 'reasoning') {
    const summary = joinContent(item.summary, ['summary_text', 'text']);
    const body = joinContent(item.content, ['reasoning_text', 'text']);
    const text = (summary || body).trim();
    return text ? [{ kind: 'thinking', text }] : [];
  }
  if (type === 'function_call') {
    const id = String(item.call_id ?? item.id ?? '');
    if (!id) return [];
    return [{ kind: 'toolCall', id, name: String(item.name ?? 'tool'), input: parseArgs(item.arguments) }];
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const id = String(item.call_id ?? item.id ?? '');
    if (!id) return [];
    const out = item.output;
    const content = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out, null, 2);
    return [{ kind: 'toolResult', id, content, isError: Boolean(item.is_error) }];
  }

  // Live `--json` item types (flat, pre-dispatched) — distinct from the rollout's
  // message/function_call format above. These arrive as `item.started` (in progress)
  // then `item.completed` (with output); tool ids are stable across both.
  if (type === 'agent_message') {
    const t = String(item.text ?? '').trim();
    return t ? [{ kind: 'assistant', text: t }] : [];
  }
  if (type === 'agent_reasoning') {
    const t = String(item.text ?? '').trim();
    return t ? [{ kind: 'thinking', text: t }] : [];
  }
  if (type === 'command_execution') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const parts: ParsedItem[] = [{ kind: 'toolCall', id, name: 'shell', input: { command: item.command } }];
    const done = item.status === 'completed' || item.exit_code != null;
    if (done) {
      const out = typeof item.aggregated_output === 'string' && item.aggregated_output.length ? item.aggregated_output : '(no output)';
      const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
      parts.push({ kind: 'toolResult', id, content: out, isError });
    }
    return parts;
  }
  if (type === 'file_change') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const parts: ParsedItem[] = [{ kind: 'toolCall', id, name: 'edit', input: { changes: changes.map((c: any) => ({ path: c.path, kind: c.kind })) } }];
    if (item.status === 'completed') {
      const summary = changes.length ? changes.map((c: any) => `${c.kind || 'change'} ${c.path}`).join('\n') : '(no changes)';
      parts.push({ kind: 'toolResult', id, content: summary, isError: false });
    }
    return parts;
  }
  return [];
}

/**
 * Translates the Codex CLI's `--json` event stream into normalized `LiveEvent`s.
 *
 * Codex (this build) emits a turn as: `thread.started`, `turn.started`, then a mix
 * of streaming `*_content_delta`s and `item.*` events that wrap a `response_item`
 * (message / function_call / function_call_output / reasoning), then a `token_count`
 * and `turn.completed`/`turn.failed`/`turn.aborted`. Deltas build a streaming text
 * block; the `item.completed` response_item is authoritative and finalizes it — so
 * even if a delta field path is off, the rendered text is correct once the item
 * closes. Field paths are read defensively (this fork's exact schema was recovered
 * from the binary + rollouts, not a live capture, so several candidates are tried).
 */
export class CodexStreamNormalizer {
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private counter = 0;
  private readonly prefix = crypto.randomUUID();
  /** True once a turn end (completed/failed/aborted) was seen — lets the runner
   *  treat a non-zero exit as already-handled rather than a transport error. */
  sawTurnEnd = false;

  constructor(private readonly cb: NormalizerCallbacks) {}

  private newId(): string {
    return `cdx_${this.prefix}_${this.counter++}`;
  }

  /** Finalize any in-flight streaming text block. */
  private flushStream(): void {
    if (this.stream) {
      this.cb.onEvent({ k: 'block_end', id: this.stream.id, text: this.stream.text });
      this.stream = null;
    }
  }

  private segment(kind: 'assistant' | 'thinking', text: string, partial: boolean): void {
    if (!text) return;
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (partial) {
      if (!this.stream) {
        const id = this.newId();
        this.stream = { id, kind, text };
        this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: true, ts: Date.now() } });
      } else {
        this.stream.text += text;
        this.cb.onEvent({ k: 'delta', id: this.stream.id, field: 'text', chunk: text });
      }
    } else if (this.stream) {
      // Authoritative full text for the current streaming segment.
      this.cb.onEvent({ k: 'block_end', id: this.stream.id, text });
      this.stream = null;
    } else {
      const id = this.newId();
      this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: false, ts: Date.now() } });
    }
  }

  /** Apply a response_item's parsed pieces with streaming semantics. Tool calls/
   *  outputs are safe to apply on any item.* subevent (keyed by call_id); assistant/
   *  reasoning text is finalized by the authoritative item payload. */
  private applyParsed(parts: ParsedItem[], finalizeText: boolean): void {
    for (const p of parts) {
      switch (p.kind) {
        case 'assistant':
          if (finalizeText) this.segment('assistant', p.text, false);
          break;
        case 'thinking':
          if (finalizeText) this.segment('thinking', p.text, false);
          break;
        case 'user':
          break; // the hub emits the user's own message at turn start
        case 'toolCall':
          this.flushStream();
          this.cb.onEvent({
            k: 'block',
            block: { id: p.id, kind: 'tool', toolUseId: p.id, name: p.name, input: p.input, status: 'running', ts: Date.now() },
          });
          break;
        case 'toolResult':
          this.cb.onEvent({ k: 'tool_result', toolUseId: p.id, content: p.content, isError: p.isError });
          break;
      }
    }
  }

  push(message: any): void {
    if (!message || typeof message !== 'object') return;
    const type = typeof message.type === 'string' ? message.type : '';

    // The thread id doubles as the resume session id (codex exec resume <id>).
    if (type === 'thread.started' || type === 'session.created') {
      const id = message.thread_id ?? message.threadId ?? message.session_id ?? message.sessionId;
      if (typeof id === 'string' && id) this.cb.onClaudeSessionId(id);
      return;
    }

    if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
      const item = message.item ?? message.raw_response_item ?? (message.payload && message.payload.type ? message.payload : null);
      const parts = parseCodexResponseItem(item);
      // Tool calls/outputs apply on any subevent (id-keyed); text finalizes only on
      // completed/updated so a started+completed pair doesn't double-emit a block.
      this.applyParsed(parts, type !== 'item.started');
      return;
    }

    if (type === 'agent_message_content_delta' || type === 'output_text.delta') {
      this.segment('assistant', pickText(message), true);
      return;
    }
    if (type === 'reasoning_content_delta' || type === 'reasoning_summary_text.delta' || type === 'plan_delta' || type === 'reasoning_raw_content_delta') {
      this.segment('thinking', pickText(message), true);
      return;
    }

    if (type === 'token_count') {
      const usage = extractCodexUsage(message.info ?? message.payload?.info);
      if (usage) this.cb.onEvent({ k: 'token_usage', usage });
      return;
    }

    if (type === 'turn.completed' || type === 'turn_complete' || type === 'task_complete') {
      this.sawTurnEnd = true;
      this.flushStream();
      const usage = extractCodexUsage(message.usage ?? message.info);
      this.cb.onEvent({ k: 'block', block: { id: `result_${crypto.randomUUID()}`, kind: 'result', usage: usage ?? undefined, isError: false, ts: Date.now() } });
      return;
    }
    if (type === 'turn.failed' || type === 'turn_failed') {
      this.sawTurnEnd = true;
      this.flushStream();
      const text = pickError(message);
      this.cb.onEvent({ k: 'block', block: { id: `result_${crypto.randomUUID()}`, kind: 'result', isError: true, subtype: 'error', ts: Date.now() } });
      if (text) this.cb.onEvent({ k: 'error', text });
      return;
    }
    if (type === 'turn.aborted' || type === 'turn_aborted') {
      this.sawTurnEnd = true;
      this.flushStream();
      this.cb.onEvent({ k: 'block', block: { id: `result_${crypto.randomUUID()}`, kind: 'result', isError: true, subtype: 'aborted', ts: Date.now() } });
      return;
    }

    if (type === 'error') {
      const text = pickError(message);
      if (text) this.cb.onEvent({ k: 'error', text });
      return;
    }

    // exec_command_begin/end, patch_apply_end, mcp_tool_call_*, web_search_*,
    // turn.started, config, etc. — the function_call item already carries the tool
    // data; these are lifecycle noise we can safely ignore.
  }
}

/** Pull streaming text from a delta event across this fork's possible field names. */
function pickText(message: any): string {
  return String(message.delta ?? message.text ?? message.content ?? message.delta_text ?? message.chunk ?? '');
}

/** Pull an error message from an error / turn.failed event. */
function pickError(message: any): string {
  if (typeof message.message === 'string') return message.message;
  if (message.error && typeof message.error === 'object' && typeof message.error.message === 'string') return message.error.message;
  if (typeof message.error === 'string') return message.error;
  return '';
}
