import crypto from 'node:crypto';
import { type NormalizerCallbacks, usageContextTokens } from '../claude/normalize.js';

/** The `tool_call` payload is keyed by tool type, e.g. `{ shellToolCall: {...} }`. */
function pickTool(toolCall: Record<string, any>): { name: string; payload: any } {
  for (const key of Object.keys(toolCall)) {
    if (key.endsWith('ToolCall')) {
      const base = key.slice(0, -'ToolCall'.length);
      return { name: base ? base.charAt(0).toUpperCase() + base.slice(1) : 'tool', payload: toolCall[key] };
    }
  }
  const keys = Object.keys(toolCall);
  return { name: keys[0] ?? 'tool', payload: keys[0] ? toolCall[keys[0]] : toolCall };
}

/** Best-effort extraction of a tool result into display text + error flag. */
function toolResultText(payload: any): { content: string; isError: boolean } {
  const r = payload?.result;
  if (r == null) return { content: '', isError: false };
  if (r.error != null) {
    const e = r.error;
    return { content: typeof e === 'string' ? e : JSON.stringify(e, null, 2), isError: true };
  }
  const s = r.success ?? r;
  if (s && typeof s === 'object') {
    // Shell tool: surface stdout/stderr + a non-zero exit as an error.
    if (typeof s.stdout === 'string' || typeof s.stderr === 'string') {
      const out = `${s.stdout ?? ''}${s.stderr ?? ''}`;
      const isError = typeof s.exitCode === 'number' && s.exitCode !== 0;
      return { content: out.length ? out : '(no output)', isError };
    }
    return { content: JSON.stringify(s, null, 2), isError: false };
  }
  return { content: typeof s === 'string' ? s : JSON.stringify(s), isError: false };
}

/**
 * Translates the Cursor CLI's stream-json into normalized `LiveEvent`s.
 *
 * Unlike Claude (which wraps deltas in `stream_event`), Cursor emits multiple
 * full `assistant` messages: partial fragments carry a `timestamp_ms`, and the
 * authoritative full-text message for a segment carries none. A small state
 * machine stitches partial fragments into one streaming block, then finalizes
 * it on the no-timestamp message (or when a tool/result interrupts the text).
 * Tools arrive as `tool_call` started/completed events keyed by tool type.
 */
export class CursorStreamNormalizer {
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private counter = 0;
  private readonly prefix = crypto.randomUUID();
  /** Whether any assistant text was emitted this turn — gates the result-text fallback. */
  private producedAssistantText = false;
  /** Whether any tool_call arrived this turn — a tool call is always followed by
   *  another model request, so it marks the turn as multi-request. Cursor's
   *  result.usage sums every request in the turn (verified: 3-request probe
   *  reported 3× a single request's numbers), and its stream carries no
   *  per-request usage to recover the watermark from — assistant messages have
   *  none. So on multi-request turns the number cannot be trusted and is
   *  omitted rather than shown inflated. */
  private sawToolCall = false;

  constructor(private readonly cb: NormalizerCallbacks) {}

  private newId(): string {
    return `cur_${this.prefix}_${this.counter++}`;
  }

  /** Finalize any in-flight streaming text block (e.g. before a tool/result). */
  private flushStream(): void {
    if (this.stream) {
      this.cb.onEvent({ k: 'block_end', id: this.stream.id, text: this.stream.text });
      this.stream = null;
    }
  }

  private segment(kind: 'assistant' | 'thinking', text: string, partial: boolean): void {
    if (!text) return;
    if (kind === 'assistant') this.producedAssistantText = true;
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (partial) {
      if (!this.stream) {
        const id = this.newId();
        this.stream = { id, kind, text };
        this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: true, ts: Date.now() } });
      } else {
        // Cursor sometimes re-sends the segment's full text as a "partial"
        // (still carrying timestamp_ms). Appending would duplicate it, so when
        // the incoming text already contains what we've streamed, treat it as
        // authoritative and finalize instead of appending a delta.
        if (this.stream.text && text.startsWith(this.stream.text)) {
          this.cb.onEvent({ k: 'block_end', id: this.stream.id, text });
          this.stream = null;
        } else {
          this.stream.text += text;
          this.cb.onEvent({ k: 'delta', id: this.stream.id, field: 'text', chunk: text });
        }
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

  push(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (typeof message.session_id === 'string' && message.session_id) this.cb.onClaudeSessionId(message.session_id);

    switch (message.type) {
      case 'assistant':
        this.handleAssistant(message);
        return;
      case 'thinking':
        this.handleThinking(message);
        return;
      case 'tool_call':
        this.handleToolCall(message);
        return;
      case 'result':
        this.handleResult(message);
        return;
      case 'error': {
        const text = typeof message.error === 'string' ? message.error
          : typeof message.message === 'string' ? message.message
          : 'cursor-agent error';
        this.cb.onEvent({ k: 'error', text });
        return;
      }
      case 'system': // `init` — session_id already captured above
      case 'user':
      default:
        return;
    }
  }

  private handleAssistant(message: any): void {
    const content = message.message?.content;
    // Partial fragments carry a timestamp; the final full-text message does not.
    const partial = typeof message.timestamp_ms === 'number';
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') this.segment('assistant', String(part.text ?? ''), partial);
      else if (part.type === 'reasoning' || part.type === 'thinking') {
        this.segment('thinking', String(part.text ?? part.thinking ?? ''), partial);
      }
    }
  }

  /** Cursor streams reasoning as top-level `thinking` events: `delta` carries
   *  incremental text, `completed` closes the segment (no text). */
  private handleThinking(message: any): void {
    if (message.subtype === 'completed') {
      if (this.stream && this.stream.kind === 'thinking') this.flushStream();
      return;
    }
    this.segment('thinking', String(message.text ?? ''), true);
  }

  private handleToolCall(message: any): void {
    this.flushStream();
    this.sawToolCall = true;
    const tc = message.tool_call;
    if (!tc || typeof tc !== 'object') return;
    const { name, payload } = pickTool(tc);
    const id = String(message.toolCallId ?? message.call_id ?? '');
    if (!id) return;
    const input = payload?.args ?? payload;
    if (message.subtype === 'completed') {
      const { content, isError } = toolResultText(payload);
      this.cb.onEvent({ k: 'block', block: { id, kind: 'tool', toolUseId: id, name, input, status: isError ? 'error' : 'done', result: content, isError, ts: Date.now() } });
    } else {
      // started (or any other subtype) — show it running.
      this.cb.onEvent({ k: 'block', block: { id, kind: 'tool', toolUseId: id, name, input, status: 'running', ts: Date.now() } });
    }
  }

  private handleResult(message: any): void {
    this.flushStream();
    const isError = Boolean(message.is_error) || message.subtype === 'error';
    // Fallback: if no assistant text streamed this turn but the result carries
    // the reply, surface it so the turn is never left visually empty.
    if (!isError && !this.producedAssistantText) {
      const r = message.result;
      const t = typeof r === 'string' ? r : r && typeof r === 'object' ? String(r.text ?? r.content ?? '') : '';
      if (t.trim()) {
        this.cb.onEvent({ k: 'block', block: { id: `resulttext_${crypto.randomUUID()}`, kind: 'assistant', text: t.trim(), streaming: false, ts: Date.now() } });
      }
    }
    this.cb.onEvent({
      k: 'block',
      block: {
        id: `result_${crypto.randomUUID()}`,
        kind: 'result',
        durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : undefined,
        isError,
        subtype: typeof message.subtype === 'string' ? message.subtype : undefined,
        contextUsed: this.sawToolCall ? undefined : usageContextTokens(message.usage),
        ts: Date.now(),
      },
    });
    if (isError && typeof message.result === 'string' && message.result.trim()) {
      this.cb.onEvent({ k: 'error', text: message.result });
    }
  }
}
