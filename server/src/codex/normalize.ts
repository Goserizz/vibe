import crypto from 'node:crypto';
import { type NormalizerCallbacks, usageContextTokens } from '../claude/normalize.js';

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

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** Codex fileChange change kinds arrive as objects (`{type:"update",move_path}`),
 *  older builds as plain strings. Collapse either to a stable label. */
function changeKindLabel(kind: unknown): string {
  if (typeof kind === 'string' && kind) return kind;
  if (kind && typeof kind === 'object') {
    const k = kind as Record<string, unknown>;
    const type = typeof k.type === 'string' ? k.type : '';
    const move = typeof k.move_path === 'string' && k.move_path
      ? k.move_path
      : typeof k.movePath === 'string' ? k.movePath : '';
    if (type && move) return `${type} → ${move}`;
    if (type) return type;
  }
  return 'change';
}

/** One result segment per change — `kind path` header plus the change's unified
 *  diff body — so the frontend renders the same red/green edit lines as other
 *  engines (its diff parser ignores the header lines). */
function fileChangeResult(changes: any[]): string {
  return changes
    .map((c) => {
      const path = typeof c?.path === 'string' ? c.path : '(unknown file)';
      const diff = typeof c?.diff === 'string' ? c.diff.trimEnd() : '';
      return diff ? `${path}\n${diff}` : `${changeKindLabel(c?.kind)} ${path}`;
    })
    .join('\n');
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
    const summary = joinContent(item.summary, ['summary_text', 'text'])
      || (Array.isArray(item.summary) ? item.summary.filter((part: unknown) => typeof part === 'string').join('\n') : '');
    const body = joinContent(item.content, ['reasoning_text', 'text'])
      || (Array.isArray(item.content) ? item.content.filter((part: unknown) => typeof part === 'string').join('\n') : '');
    // Rollout response_items store reasoning in `summary`/`content`, while the
    // current `codex exec --json` stream emits a flat `{ type: "reasoning",
    // text: "..." }` item. Accept both shapes so live summaries are not dropped.
    const direct = typeof item.text === 'string' ? item.text : '';
    const text = (summary || body || direct).trim();
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
  // App Server v2 uses camelCase tagged items.
  if (type === 'agentMessage') {
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
  if (type === 'commandExecution') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const parts: ParsedItem[] = [{ kind: 'toolCall', id, name: 'shell', input: { command: item.command, cwd: item.cwd } }];
    const done = item.status === 'completed' || item.status === 'failed' || item.exitCode != null;
    if (done) {
      const out = typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length ? item.aggregatedOutput : '(no output)';
      const isError = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      parts.push({ kind: 'toolResult', id, content: out, isError });
    }
    return parts;
  }
  if (type === 'file_change' || type === 'fileChange') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const camel = type === 'fileChange';
    const changes = Array.isArray(item.changes) ? item.changes : [];
    // Keep `kind` a plain label and let the diff ride in the result text; the
    // per-change diff is what the frontend needs to color the edit lines.
    const parts: ParsedItem[] = [{
      kind: 'toolCall',
      id,
      name: 'edit',
      input: { changes: changes.map((c: any) => ({ path: c?.path, kind: changeKindLabel(c?.kind) })) },
    }];
    const done = camel
      ? item.status === 'completed' || item.status === 'failed'
      : item.status === 'completed';
    if (done) {
      parts.push({ kind: 'toolResult', id, content: fileChangeResult(changes) || '(no changes)', isError: item.status === 'failed' });
    }
    return parts;
  }
  if (type === 'mcpToolCall') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const name = [item.server, item.tool].filter(Boolean).join('.') || 'mcp';
    const parts: ParsedItem[] = [{ kind: 'toolCall', id, name, input: item.arguments ?? {} }];
    if (item.status === 'completed' || item.status === 'failed') {
      const isError = item.status === 'failed' || item.error != null;
      parts.push({ kind: 'toolResult', id, content: displayValue(item.error ?? item.result) || '(no output)', isError });
    }
    return parts;
  }
  if (type === 'dynamicToolCall') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const parts: ParsedItem[] = [{ kind: 'toolCall', id, name: String(item.tool ?? 'tool'), input: item.arguments ?? {} }];
    if (item.status === 'completed' || item.status === 'failed') {
      const isError = item.status === 'failed' || item.success === false;
      parts.push({ kind: 'toolResult', id, content: displayValue(item.contentItems) || (isError ? 'failed' : '(no output)'), isError });
    }
    return parts;
  }
  if (type === 'collabToolCall') {
    const id = String(item.id ?? '');
    if (!id) return [];
    const parts: ParsedItem[] = [{
      kind: 'toolCall',
      id,
      name: String(item.tool ?? 'agent'),
      input: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model },
    }];
    if (item.status === 'completed' || item.status === 'failed') {
      parts.push({ kind: 'toolResult', id, content: displayValue(item.agentsStates) || item.status, isError: item.status === 'failed' });
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
  /** Latest `token_count` snapshot, reported on the result block at turn end. */
  private lastContextUsed?: number;
  private lastContextWindow?: number;
  /** Wall-clock fallback for protocol variants which omit `durationMs` on the
   *  completed turn. App Server normally supplies an exact duration. */
  private turnStartedAt?: number;

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

  /** Turn-end context fields: the `token_count` snapshot (last_token_usage is
   *  the current context watermark) wins over a turn event's own usage, which
   *  sums the turn's requests and overcounts long agentic turns. */
  private contextFields(usage: any): { contextUsed?: number; contextWindow?: number } {
    return {
      contextUsed: this.lastContextUsed ?? usageContextTokens(usage),
      contextWindow: this.lastContextWindow,
    };
  }

  private startTurn(message: any): void {
    // One App Server process can execute several foreground/background turns.
    // Usage is per turn, so never let the previous turn's watermark leak into
    // a later result when that later turn happens to emit no usage update.
    this.sawTurnEnd = false;
    this.lastContextUsed = undefined;
    this.lastContextWindow = undefined;
    const raw = Number(message?.startedAt ?? message?.started_at);
    this.turnStartedAt = Number.isFinite(raw) && raw > 0
      ? (raw < 1_000_000_000_000 ? raw * 1000 : raw)
      : Date.now();
  }

  private durationFields(message: any): { durationMs?: number } {
    const directRaw = message?.durationMs ?? message?.duration_ms;
    const direct = Number(directRaw);
    if (directRaw != null && Number.isFinite(direct) && direct >= 0) return { durationMs: direct };

    const startedRaw = Number(message?.startedAt ?? message?.started_at);
    const completedRaw = Number(message?.completedAt ?? message?.completed_at);
    const toMs = (value: number): number => value < 1_000_000_000_000 ? value * 1000 : value;
    if (Number.isFinite(startedRaw) && startedRaw > 0
      && Number.isFinite(completedRaw) && completedRaw > 0) {
      return { durationMs: Math.max(0, toMs(completedRaw) - toMs(startedRaw)) };
    }
    if (this.turnStartedAt != null) return { durationMs: Math.max(0, Date.now() - this.turnStartedAt) };
    return {};
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

    if (type === 'turn.started') {
      this.startTurn(message);
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
      // app-server shape: info.last_token_usage is the current context,
      // info.total_token_usage the billing total (grows monotonically — not a
      // context watermark). Older flat events carry usage fields directly.
      const info = message.info ?? {};
      this.lastContextUsed = usageContextTokens(info.last_token_usage ?? message.usage ?? undefined) ?? this.lastContextUsed;
      const window = info.model_context_window ?? message.model_context_window;
      if (typeof window === 'number' && Number.isFinite(window)) this.lastContextWindow = window;
      return;
    }

    if (type === 'thread/tokenUsage/updated') {
      // Codex App Server v2 uses camelCase ThreadTokenUsage, unlike legacy
      // `codex exec --json`'s snake_case token_count event. `last` is the
      // current context watermark; `total` is cumulative billing usage and
      // must not be shown as the next-turn context size.
      const tokenUsage = message.tokenUsage ?? message.token_usage ?? {};
      this.lastContextUsed = usageContextTokens(tokenUsage.last) ?? this.lastContextUsed;
      const window = tokenUsage.modelContextWindow ?? tokenUsage.model_context_window;
      if (typeof window === 'number' && Number.isFinite(window)) this.lastContextWindow = window;
      return;
    }

    if (type === 'turn.completed' || type === 'turn_complete' || type === 'task_complete') {
      this.sawTurnEnd = true;
      this.flushStream();
      this.cb.onEvent({ k: 'block', block: { id: `result_${crypto.randomUUID()}`, kind: 'result', isError: false, ...this.durationFields(message), ...this.contextFields(message.usage), ts: Date.now() } });
      return;
    }
    if (type === 'turn.failed' || type === 'turn_failed') {
      this.sawTurnEnd = true;
      this.flushStream();
      const text = pickError(message);
      this.cb.onEvent({ k: 'block', block: { id: `result_${crypto.randomUUID()}`, kind: 'result', isError: true, subtype: 'error', ...this.durationFields(message), ...this.contextFields(message.usage), ts: Date.now() } });
      if (text) this.cb.onEvent({ k: 'error', text });
      return;
    }
    if (type === 'turn.aborted' || type === 'turn_aborted') {
      this.sawTurnEnd = true;
      this.flushStream();
      this.cb.onEvent({ k: 'block', block: { id: `result_${crypto.randomUUID()}`, kind: 'result', isError: true, subtype: 'aborted', ...this.durationFields(message), ...this.contextFields(message.usage), ts: Date.now() } });
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
