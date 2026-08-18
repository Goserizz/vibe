import crypto from 'node:crypto';
import { type NormalizerCallbacks, usageContextTokens } from '../claude/normalize.js';

function displayText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as any).text ?? '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Normalize Kimi Code's `-p --output-format stream-json` JSONL records. */
export class KimiStreamNormalizer {
  private readonly prefix = crypto.randomUUID();
  private counter = 0;
  private finished = false;
  /** Latest usage snapshot seen on any record, reported at turn end. */
  private contextUsed?: number;

  constructor(private readonly cb: NormalizerCallbacks) {}

  private newId(kind: string): string {
    return `kimi_${kind}_${this.prefix}_${this.counter++}`;
  }

  push(message: any): void {
    if (!message || typeof message !== 'object') return;

    const used = usageContextTokens(message.usage);
    if (used) this.contextUsed = used;

    if (message.role === 'meta' && message.type === 'session.resume_hint') {
      const sessionId = typeof message.session_id === 'string' ? message.session_id : '';
      if (sessionId) this.cb.onClaudeSessionId(sessionId);
      return;
    }

    if (message.role === 'assistant') {
      const text = displayText(message.content);
      if (text) {
        this.cb.onEvent({
          k: 'block',
          block: { id: this.newId('text'), kind: 'assistant', text, streaming: false, ts: Date.now() },
        });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const id = String(call?.id ?? this.newId('tool'));
          const name = String(call?.function?.name ?? call?.name ?? 'tool');
          const input = parseArguments(call?.function?.arguments ?? call?.arguments);
          this.cb.onEvent({
            k: 'block',
            block: { id, kind: 'tool', toolUseId: id, name, input, status: 'running', ts: Date.now() },
          });
        }
      }
      return;
    }

    if (message.role === 'tool') {
      const toolUseId = String(message.tool_call_id ?? message.id ?? '');
      if (!toolUseId) return;
      const isError = Boolean(message.is_error ?? message.error);
      const content = displayText(message.content ?? message.error) || '(no output)';
      this.cb.onEvent({ k: 'tool_result', toolUseId, content, isError });
      return;
    }

    if (message.role === 'error' || message.type === 'error') {
      const text = displayText(message.error ?? message.message ?? message.content) || 'Kimi Code error';
      this.cb.onEvent({ k: 'error', text });
    }
  }

  finish(durationMs: number, isError = false): void {
    if (this.finished) return;
    this.finished = true;
    this.cb.onEvent({
      k: 'block',
      block: {
        id: this.newId('result'),
        kind: 'result',
        durationMs,
        isError,
        subtype: isError ? 'error' : 'success',
        contextUsed: this.contextUsed,
        ts: Date.now(),
      },
    });
  }
}
