/**
 * OpenAI-compatible Chat Completions client. Vibot speaks this protocol because
 * a single {baseUrl, apiKey, model} triple covers GLM, DeepSeek, Kimi/Moonshot,
 * OpenAI, OpenRouter, and local servers. No SDK dependency — just fetch + SSE.
 */

export interface LlmFunctionCall {
  name: string;
  /** Raw JSON string from the model; the caller JSON.parses it. */
  arguments: string;
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: LlmFunctionCall;
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  /** Assistant messages that requested tool calls carry these. */
  tool_calls?: LlmToolCall[];
  /** `tool` role messages carry the call id they answer. */
  tool_call_id?: string;
  /** Optional function name on `tool` role messages. */
  name?: string;
}

export interface LlmToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export type LlmStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_calls'; calls: LlmToolCall[] }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } };

export interface StreamChatOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  temperature?: number;
  /** OpenAI-style reasoning effort (`minimal`…`max`). Omitted from the body
   *  when unset so the API default applies; endpoints that don't support the
   *  parameter ignore it (Anthropic-style thinking/budget_tokens is not used —
   *  Vibot only speaks the OpenAI-compatible Chat Completions protocol). */
  reasoning_effort?: string;
  signal: AbortSignal;
}

/** Join a base URL and the chat-completions path without doubling slashes. */
export function completionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Drain the buffered tool-call fragments into the OpenAI shape, in index order. */
function drainToolBuf(buf: Map<number, { id: string; name: string; args: string }>): LlmToolCall[] {
  return [...buf.keys()].sort((a, b) => a - b).map((idx) => {
    const b = buf.get(idx)!;
    return {
      id: b.id || `call_${idx}`,
      type: 'function' as const,
      function: { name: b.name, arguments: b.args || '{}' },
    };
  });
}

/**
 * Stream a Chat Completions response, yielding incremental events. Tool calls
 * arrive assembled: OpenAI streams argument fragments per `index`; we buffer
 * them and emit a single `tool_calls` event when the choice finishes (or at
 * stream end). Text yields as it arrives. `done` ends the turn.
 */
export async function* streamChat(opts: StreamChatOpts): AsyncIterable<LlmStreamEvent> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;

  const res = await fetch(completionsUrl(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || detail;
    } catch { /* keep raw */ }
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(res.status, `Authentication failed (${res.status}). Check the Vibot API key and base URL. ${detail}`.trim());
    }
    if (res.status === 404) {
      throw new LlmError(res.status, `Endpoint not found (404) at ${completionsUrl(opts.baseUrl)}. Is the base URL correct and OpenAI-compatible?`.trim());
    }
    throw new LlmError(res.status, `LLM request failed (${res.status}). ${detail}`.trim());
  }

  const toolBuf = new Map<number, { id: string; name: string; args: string }>();
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let toolsEmitted = false;

  const maybeEmitTools = function* (): Generator<LlmStreamEvent> {
    if (toolsEmitted || toolBuf.size === 0) return;
    toolsEmitted = true;
    const calls = drainToolBuf(toolBuf);
    if (calls.length) yield { type: 'tool_calls', calls };
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        line = line.replace(/\r$/, '');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // keepalive / partial — skip
        }
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta;
        // DeepSeek / GLM-style reasoning stream (UI-only; not fed back into messages).
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) yield { type: 'thinking', delta: String(reasoning) };
        if (delta?.content) yield { type: 'text', delta: String(delta.content) };
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const b = toolBuf.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) b.id = tc.id;
            if (tc.function?.name) b.name += tc.function.name;
            if (tc.function?.arguments) b.args += tc.function.arguments;
            toolBuf.set(idx, b);
          }
        }
        if (chunk?.usage) {
          usage = {
            inputTokens: num(chunk.usage.prompt_tokens ?? chunk.usage.input_tokens),
            outputTokens: num(chunk.usage.completion_tokens ?? chunk.usage.output_tokens),
          };
        }
        // A finished choice means no more deltas for it — flush any tool calls.
        if (choice && choice.finish_reason) {
          yield* maybeEmitTools();
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  // Stream ended; flush any tool calls buffered without an explicit finish_reason.
  yield* maybeEmitTools();
  yield { type: 'done', usage };
}
