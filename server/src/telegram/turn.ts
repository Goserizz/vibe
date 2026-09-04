import crypto from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import type { InputRichMessage } from '@grammyjs/types';
import { CallbackConn, hub } from '../ws/hub.js';
import { log } from '../log.js';
import type { LiveEvent, PermissionRequest, ServerEvent } from '../../../shared/protocol.js';
import { clip, escHtml } from './format.js';
import { editMessageRich, RICH_MAX, richHtml, richMd, richPlain, sendRich, sendRichDraft } from './rich.js';
import { formatToolCallHtml, formatToolCallMd, isBareToolCall } from './tools.js';
import { sendAskUserPrompt, sendExitPlanPrompt } from './interactive.js';

/** Base interval between draft pushes. Telegram 429s repeated edits to the same
 *  draft and autoRetry then backs off for seconds — freezing thinking and main
 *  text. 700ms alone isn't enough (confirmed a 5.6s backoff), so the worker
 *  adapts: slows toward EDIT_MAX_MS when a push stalls, recovers when fast. */
const EDIT_MIN_MS = 700;
/** Ceiling the adaptive interval backs off to after 429 stalls. */
const EDIT_MAX_MS = 3000;
/** Telegram clears "typing…" after ~5s — refresh just under that. */
const TYPING_EVERY_MS = 4000;
/**
 * Draft previews expire ~30s after the last received frame. Idle keepalive
 * re-sends the current rich_message with the same draft_id so the client
 * can refresh reception_date before TTL (e.g. long tool calls).
 */
const DRAFT_KEEPALIVE_MS = 12_000;
const DRAFT_KEEPALIVE_CHECK_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Non-zero draft id for sendRichMessageDraft (stable for one editor lifetime). */
function newDraftId(): number {
  const n = (Date.now() % 1_000_000_000) ^ (Math.floor(Math.random() * 0xfffff) + 1);
  return n === 0 ? 1 : Math.abs(n);
}

/** Keep the chat's "bot is typing…" indicator alive for a long turn. */
function startTypingPulse(api: Api, chatId: number): () => void {
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    void api.sendChatAction(chatId, 'typing').catch(() => undefined);
  };
  beat();
  const timer = setInterval(beat, TYPING_EVERY_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

type Channel = 'thinking' | 'tool' | 'main';

type QueueItem =
  | { kind: Channel; value: string }
  | { kind: 'tool_fix'; from: string; to: string }
  /** Finalize the whole current draft (new thinking block → new bubble). */
  | { kind: 'round' }
  /** Current thinking block finished — hide thinking preview. */
  | { kind: 'thinking_end' }
  | { kind: 'end' | 'err'; value?: string };

/** Tagged stream piece: thinking / tools / reply each get their own message. */
export type TurnPiece =
  | { channel: 'thinking'; text: string }
  | { channel: 'tool'; text: string }
  | { channel: 'main'; text: string }
  /** Replace a previously streamed tool announce line with a richer one. */
  | { channel: 'tool_fix'; from: string; to: string }
  /** New thinking block — finalize prior draft as its own bubble. */
  | { channel: 'round' }
  /** Thinking finished — hide the live thinking preview. */
  | { channel: 'thinking_end' };

/**
 * Async stream for a Vibe turn. Thinking / tools / assistant text are tagged
 * channels; a `round` piece is emitted only when a new thinking block starts so
 * Telegram can finalize the previous draft as its own bubble.
 */
export async function* turnPieceStream(
  sessionId: string,
  prompt: string,
  opts: {
    onPermission?: (req: PermissionRequest) => void;
  } = {},
): AsyncGenerator<TurnPiece> {
  const queue: QueueItem[] = [];
  let wake: (() => void) | null = null;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  const push = (item: QueueItem) => {
    queue.push(item);
    nudge();
  };

  const texts = new Map<string, string>();
  const kinds = new Map<string, 'assistant' | 'thinking'>();
  const yielded = new Map<string, number>();
  /** toolUseId → last announced "→ …" line (no trailing newline). */
  const announcedTools = new Map<string, string>();
  let anyAssistant = false;
  let thinkingStarted = false;
  let thinkingOpen = false;

  const endThinking = () => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    push({ kind: 'thinking_end' });
  };

  const pushChunks = (channel: Channel, growth: string) => {
    const CHUNK = 500;
    let offset = 0;
    while (offset < growth.length) {
      const end = Math.min(offset + CHUNK, growth.length);
      push({ kind: channel, value: growth.slice(offset, end) });
      offset = end;
    }
  };

  const emitThinkingGrowth = (id: string) => {
    const text = texts.get(id) ?? '';
    const prev = yielded.get(id) ?? 0;
    if (prev === 0) {
      // New thinking block → finalize the previous draft as its own bubble.
      const priorBubble = thinkingStarted || anyAssistant || announcedTools.size > 0;
      if (priorBubble) {
        push({ kind: 'round' });
        thinkingStarted = false;
      }
      if (!thinkingStarted) {
        thinkingStarted = true;
        thinkingOpen = true;
        push({ kind: 'thinking', value: 'Thinking...\n' });
      }
    }
    if (text.length <= prev) return;
    thinkingOpen = true;
    pushChunks('thinking', text.slice(prev));
    yielded.set(id, text.length);
  };

  const emitAssistantGrowth = (id: string) => {
    const text = texts.get(id) ?? '';
    const prev = yielded.get(id) ?? 0;
    if (text.length <= prev) return;
    // Multiple assistant blocks stay in the same bubble; only thinking starts a new one.
    endThinking();
    if (prev === 0 && anyAssistant) push({ kind: 'main', value: '\n\n' });
    anyAssistant = true;
    pushChunks('main', text.slice(prev));
    yielded.set(id, text.length);
  };

  const apply = (ev: LiveEvent) => {
    switch (ev.k) {
      case 'block': {
        const b = ev.block;
        if (b.kind === 'assistant') {
          kinds.set(b.id, 'assistant');
          texts.set(b.id, b.text);
          emitAssistantGrowth(b.id);
        } else if (b.kind === 'thinking') {
          kinds.set(b.id, 'thinking');
          texts.set(b.id, b.text);
          emitThinkingGrowth(b.id);
          if (!b.streaming) endThinking();
        } else if (b.kind === 'tool') {
          // Tools mean this thinking cycle is done — hide before showing the call.
          endThinking();
          const line = `→ ${formatToolCallMd(b.name, b.input)}`;
          const prev = announcedTools.get(b.toolUseId);
          const bare = isBareToolCall(b.name, b.input);
          // Wait for args (or completion) before showing a useless "→ Grep"/"→ Read".
          if (!prev && bare && b.status === 'running') break;
          if (!prev) {
            announcedTools.set(b.toolUseId, line);
            push({ kind: 'tool', value: `${line}\n` });
          } else if (line !== prev) {
            announcedTools.set(b.toolUseId, line);
            push({ kind: 'tool_fix', from: prev, to: line });
          }
        } else if (b.kind === 'error') {
          endThinking();
          push({ kind: 'main', value: `\n\nError: ${b.text}` });
        } else if (b.kind === 'system') {
          endThinking();
          push({ kind: 'main', value: `\n\n⚡ ${b.text}` });
        }
        break;
      }
      case 'delta': {
        const kind = kinds.get(ev.id);
        if (kind !== 'assistant' && kind !== 'thinking') break;
        texts.set(ev.id, (texts.get(ev.id) ?? '') + ev.chunk);
        if (kind === 'assistant') emitAssistantGrowth(ev.id);
        else emitThinkingGrowth(ev.id);
        break;
      }
      case 'block_end': {
        if (kinds.get(ev.id) === 'thinking') {
          if (ev.text != null) {
            texts.set(ev.id, ev.text);
            emitThinkingGrowth(ev.id);
          }
          endThinking();
          break;
        }
        if (ev.text != null && kinds.get(ev.id) === 'assistant') {
          texts.set(ev.id, ev.text);
          emitAssistantGrowth(ev.id);
        }
        break;
      }
      case 'tool_result':
        // Call line already finalized when detail arrived; result text is omitted.
        break;
      case 'run_state':
        if (!ev.running) push({ kind: 'end' });
        break;
      case 'error':
        push({ kind: 'main', value: `\n\nError: ${ev.text}` });
        break;
      default:
        break;
    }
  };

  const conn = new CallbackConn((msg: ServerEvent) => {
    if (msg.t === 'event' && msg.sessionId === sessionId) {
      apply(msg.ev);
    } else if (msg.t === 'permission_request' && msg.sessionId === sessionId) {
      opts.onPermission?.(msg.request);
    } else if (msg.t === 'error' && (!msg.sessionId || msg.sessionId === sessionId)) {
      push({ kind: 'err', value: msg.message });
      push({ kind: 'end' });
    }
  });

  hub.addConn(conn);
  const { seq } = await hub.snapshot(sessionId);
  hub.subscribe(conn, sessionId, seq);
  hub.send(conn, sessionId, crypto.randomUUID(), prompt);

  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
      }
      const item = queue.shift()!;
      if ((item.kind === 'thinking' || item.kind === 'tool' || item.kind === 'main') && item.value) {
        yield { channel: item.kind, text: item.value };
      } else if (item.kind === 'tool_fix') {
        yield { channel: 'tool_fix', from: item.from, to: item.to };
      } else if (item.kind === 'round') {
        yield { channel: 'round' };
      } else if (item.kind === 'thinking_end') {
        yield { channel: 'thinking_end' };
      } else if (item.kind === 'err') {
        yield { channel: 'main', text: `\n\nError: ${item.value ?? 'error'}` };
      } else if (item.kind === 'end') {
        break;
      }
    }
    if (!anyAssistant) yield { channel: 'main', text: '(no text output)' };
  } finally {
    hub.removeConn(conn);
  }
}

function splitTelegram(text: string, max = RICH_MAX): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

type TurnSeg = { channel: Channel; text: string };

/** Merge consecutive same-channel pieces for stable section order. */
function mergeSegs(segs: TurnSeg[]): TurnSeg[] {
  const out: TurnSeg[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.channel === seg.channel) last.text += seg.text;
    else out.push({ channel: seg.channel, text: seg.text });
  }
  return out;
}

type ThinkingMode = 'draft' | 'omit' | 'plain';

/** Strip the synthetic "Thinking..." lead-in we inject at stream start. */
function stripThinkingHeader(text: string): string {
  const header = 'Thinking...';
  if (text === header || text.startsWith(header + '\n')) {
    return text.slice(header.length).replace(/^\n/, '').trim();
  }
  return text;
}

/**
 * Live thinking preview: only the latest *completed* paragraph (blank-line
 * separated). A paragraph is shown only after the next blank line closes it;
 * the trailing in-progress paragraph is withheld. The next completed paragraph
 * replaces the one currently on screen.
 */
function latestCompletedThinkingParagraph(text: string): string {
  // Do not trim trailing whitespace — trailing blank lines mark paragraph completion.
  let cleaned = text.replace(/^\uFEFF/, '');
  const header = 'Thinking...';
  if (cleaned === header || cleaned.startsWith(header + '\n')) {
    cleaned = cleaned.slice(header.length).replace(/^\n/, '');
  }
  if (!cleaned.trim()) return '';

  const parts = cleaned.split(/\n\s*\n/);
  const trailingComplete = /\n\s*\n\s*$/.test(cleaned);
  // If text does not end with a blank line, the last part is still generating.
  const lastCompleteIdx = trailingComplete ? parts.length - 1 : parts.length - 2;

  for (let i = lastCompleteIdx; i >= 0; i--) {
    const p = parts[i]!.replace(/^\n+|\n+$/g, '');
    if (p.trim()) return p;
  }
  return '';
}

/**
 * One markdown document for the whole turn (thinking → tools → main).
 * - draft: native `<tg-thinking>` (RichBlockThinking; draft-only)
 * - omit: drop thinking (final sendRichMessage)
 * - plain: thinking as blockquote (edit fallback when drafts unavailable)
 * Returns '' when there is nothing meaningful yet (never a lone "…" placeholder).
 *
 * Live display rules:
 * - Thinking shows only the latest completed paragraph (next replaces previous).
 * - Once thinking ends (tools / body / thinking_end), thinking is hidden.
 */
function buildTurnMarkdown(segs: TurnSeg[], thinking: ThinkingMode = 'draft'): string {
  const merged = mergeSegs(segs);
  const hasMain = merged.some((s) => s.channel === 'main' && s.text.replace(/^\uFEFF/, '').trim());
  const hasTool = merged.some((s) => s.channel === 'tool' && s.text.replace(/^\uFEFF/, '').trim());
  const hideThinking = hasMain || hasTool;
  let lastThinkingIdx = -1;
  if (thinking !== 'omit' && !hideThinking) {
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i]!.channel === 'thinking') {
        lastThinkingIdx = i;
        break;
      }
    }
  }

  const chunks: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i]!;
    if (seg.channel === 'thinking') {
      if (thinking === 'omit' || hideThinking || i !== lastThinkingIdx) continue;
      // Do not trim — trailing blank lines mark completed paragraphs.
      const raw = seg.text.replace(/^\uFEFF/, '');
      let t = latestCompletedThinkingParagraph(raw);
      // Keep the thinking module visible while the first paragraph is still generating.
      if (!t) {
        const hasAny = stripThinkingHeader(raw).trim().length > 0;
        if (!hasAny && !raw.includes('Thinking...')) continue;
        t = '…';
      }
      if (thinking === 'draft') {
        const inner = escHtml(t).replace(/\n/g, '<br>');
        chunks.push(`<tg-thinking>${inner}</tg-thinking>`);
      } else {
        // plain: sendRichMessage rejects <tg-thinking>
        chunks.push(t.split('\n').map((ln) => `> ${ln}`).join('\n'));
      }
      continue;
    }

    let t = seg.text.replace(/^\uFEFF/, '').trim();
    if (!t) continue;
    if (seg.channel === 'tool') {
      if (t === 'Tools' || t.startsWith('Tools\n')) {
        t = t.slice('Tools'.length).replace(/^\n/, '').trim();
      }
      if (!t) continue;
      // Tool lines are pre-formatted markdown (bold name + code detail), so emit
      // as-is \u2014 fencing would hide the bold. Paths/commands are already wrapped
      // in inline code / fenced blocks by formatToolCallMd.
      chunks.push(t);
    } else {
      chunks.push(t);
    }
  }
  return chunks.join('\n\n');
}

/**
 * Interrupt helpers for Telegram.
 * No Stop keyboard is attached to messages (avoids carrier flashes). Use
 * /abort, /stop, or type Stop / 停止 / 中断 while a turn is running.
 */
export function isStopText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^(?:⏹\s*)?(?:stop|abort|停止|中断|取消生成)$/i.test(t);
}

/**
 * Stream a turn as rich draft(s). A new thinking block finalizes the previous
 * draft as its own bubble; tools and assistant text stay in the current draft.
 * Falls back to send+edit if drafts are unavailable.
 */
export async function streamTurnToChat(
  api: Api,
  chatId: number,
  sessionId: string,
  prompt: string,
  opts: { onPermission?: (req: PermissionRequest) => void } = {},
): Promise<void> {
  const stopTyping = startTypingPulse(api, chatId);
  try {
    await streamTurnToChatInner(api, chatId, sessionId, prompt, opts);
  } finally {
    stopTyping();
  }
}

async function streamTurnToChatInner(
  api: Api,
  chatId: number,
  sessionId: string,
  prompt: string,
  opts: { onPermission?: (req: PermissionRequest) => void } = {},
): Promise<void> {
  let draftId = newDraftId();
  const segs: TurnSeg[] = [];
  let usedDraft = false;
  /** False after draft API failure — use send/edit. */
  let liveDraft = true;
  let draftFailed = false;
  let messageId: number | undefined;
  /** Last draft/edit API send start (for min-interval pacing). */
  let lastEdit = 0;
  /** Adaptive push interval; backs off toward EDIT_MAX_MS on 429 stalls. */
  let editInterval = EDIT_MIN_MS;
  /** Last successful draft push (content or keepalive). Reset on every output. */
  let lastDraftAt = 0;
  let editChain: Promise<void> = Promise.resolve();
  /** Coalesce: content arrived; needs another draft frame. */
  let flushWanted = false;
  /** Bypass EDIT_MIN_MS once (finalize / commit). */
  let flushImmediate = false;
  let flushWorkerActive = false;
  let broken = false;
  let sawAny = false;
  let finished = false;
  let bubbled = false;
  /** After thinking_end / tools / body — do not render thinking in the live draft. */
  let hideThinking = false;

  const dropThinkingSegs = () => {
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i]!.channel === 'thinking') segs.splice(i, 1);
    }
  };

  const clipBody = (plain: string): string | null => {
    const body = plain.trim();
    if (!body || body === '…') return null;
    if (body.length <= RICH_MAX) return body;
    return body.slice(0, RICH_MAX - 1) + '…';
  };

  /** Prefer markdown; on parse failure use plain HTML. Returns the exact payload sent. */
  const buildPayload = async (
    body: string,
    via: 'draft' | 'edit',
  ): Promise<InputRichMessage | null> => {
    const sendOne = async (rich: InputRichMessage) => {
      if (via === 'draft') {
        await sendRichDraft(api, chatId, draftId, rich);
        usedDraft = true;
        lastDraftAt = Date.now();
      } else if (messageId == null) {
        const msg = await sendRich(api, chatId, rich);
        messageId = msg.message_id;
      } else {
        await editMessageRich(api, chatId, messageId, rich);
      }
    };

    const md = richMd(body);
    try {
      await sendOne(md);
      return md;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/message is not modified/i.test(msg)) {
        if (via === 'draft') lastDraftAt = Date.now();
        return md;
      }
      const plain = richPlain(body);
      try {
        await sendOne(plain);
        return plain;
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        if (/message is not modified/i.test(msg2)) {
          if (via === 'draft') lastDraftAt = Date.now();
          return plain;
        }
        if (via === 'draft') {
          log.warn('telegram rich draft unavailable, falling back to edit', msg2);
          draftFailed = true;
          liveDraft = false;
        } else {
          log.warn('telegram rich edit failed', msg2);
        }
        return null;
      }
    }
  };

  /** Push current round body via draft (same draft_id) or edit fallback. */
  const pushLive = async () => {
    if (finished) return;

    const mode: ThinkingMode = hideThinking ? 'omit' : 'draft';
    const plainMode: ThinkingMode = hideThinking ? 'omit' : 'plain';

    // Prefer drafts so native <tg-thinking> blocks stream correctly.
    if (liveDraft && !draftFailed) {
      const draftBody = clipBody(buildTurnMarkdown(segs, mode));
      if (!draftBody) {
        // Thinking just ended with nothing else yet — clear the thinking preview.
        if (hideThinking && usedDraft) await buildPayload('\u2060', 'draft');
        return;
      }
      const ok = await buildPayload(draftBody, 'draft');
      if (ok) return;
    }

    // Edit fallback: include thinking as blockquotes (tg-thinking is draft-only).
    const editBody = clipBody(buildTurnMarkdown(segs, plainMode));
    if (!editBody) return;
    const ok = await buildPayload(editBody, 'edit');
    if (!ok) broken = true;
  };

  const persistWith = async (parts: string[], firstPayload?: InputRichMessage | null) => {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const primary = i === 0 && firstPayload ? firstPayload : richMd(part);
      try {
        await sendRich(api, chatId, primary);
      } catch (err) {
        log.warn('telegram rich send failed', err);
        try {
          await sendRich(api, chatId, richPlain(part));
        } catch (err2) {
          log.warn('telegram plain fallback failed', err2);
        }
      }
    }
  };

  /**
   * Smooth draft updates: one worker drains `flushWanted`, paced at EDIT_MIN_MS.
   * Tool arg polls used to call flush(true) per tick and queue many full-document
   * Telegram uploads — unfinished thinking then dripped out one RTT at a time.
   */
  const kickFlush = () => {
    if (flushWorkerActive) return;
    flushWorkerActive = true;
    editChain = editChain
      .then(async () => {
        while (flushWanted && !finished && !broken) {
          // Pace pushes at `editInterval` (adaptive), always with the latest
          // content — pushLive reads `segs` fresh. The previous "re-pace if new
          // content arrived" branch never pushed under fast streaming; this one
          // always pushes once per interval and slows down on 429 backoff.
          const wait = flushImmediate
            ? 0
            : Math.max(0, editInterval - (Date.now() - lastEdit));
          flushImmediate = false;
          if (wait > 0) await sleep(wait);
          if (finished || broken) return;
          flushWanted = false;
          const pushStart = Date.now();
          await pushLive();
          const pushMs = Date.now() - pushStart;
          lastEdit = Date.now();
          if (pushMs > 1000) {
            // Push stalled — autoRetry backed off a 429 (or network). Back off
            // our own cadence so we stop re-tripping the limit and freezing.
            editInterval = Math.min(Math.max(editInterval * 2, 1500), EDIT_MAX_MS);
            log.warn('telegram push stalled', `${pushMs}ms — backing off to ${editInterval}ms`);
          } else if (editInterval > EDIT_MIN_MS) {
            editInterval = Math.max(editInterval - 300, EDIT_MIN_MS);
          }
        }
      })
      .finally(() => {
        flushWorkerActive = false;
        if (flushWanted && !finished && !broken) kickFlush();
      });
  };

  const flush = (force: boolean) => {
    if (finished) return;
    flushWanted = true;
    if (force) flushImmediate = true;
    kickFlush();
  };

  /** Reset draft/edit state for the next bubble (leaves `segs` intact). */
  const resetDraftState = () => {
    flushWanted = false;
    flushImmediate = false;
    hideThinking = false;
    draftId = newDraftId();
    usedDraft = false;
    messageId = undefined;
    broken = false;
    lastEdit = 0;
    lastDraftAt = 0;
    // Keep liveDraft/draftFailed — if drafts failed once, stay on edit path.
  };

  /** Persist one reply round as a Telegram bubble. Returns true if a bubble was sent. */
  const persistRound = async (roundSegs: TurnSeg[]): Promise<boolean> => {
    const hasContent =
      roundSegs.some((s) => s.channel !== 'thinking' && s.text.trim()) ||
      roundSegs.some((s) => s.channel === 'thinking' && s.text.trim());
    if (!hasContent) return false;

    const finalBody = clipBody(buildTurnMarkdown(roundSegs, 'omit'));
    // omit drops thinking — if this round was thinking-only, nothing to persist.
    if (!finalBody) return false;
    const parts = splitTelegram(finalBody);

    if (liveDraft && usedDraft && !draftFailed) {
      // Clear thinking from the live draft before the final bubble (omit).
      const draftBody = clipBody(buildTurnMarkdown(roundSegs, 'omit'));
      if (draftBody) await buildPayload(draftBody, 'draft');
      await persistWith(parts);
    } else if (broken || messageId == null) {
      await persistWith(parts);
    } else {
      const first = parts[0]!;
      const edited = await buildPayload(first, 'edit');
      if (!edited) await persistWith(parts);
      else if (parts.length > 1) await persistWith(parts.slice(1));
    }
    bubbled = true;
    return true;
  };

  /**
   * New thinking block or tool call line ready: finalize the previous draft as
   * a bubble when it has tools/main. Thinking-only rounds keep the same
   * draft_id so the next thinking segment replaces the previous preview.
   */
  const commitRound = async () => {
    flush(true);
    await editChain;
    if (finished || segs.length === 0) return;

    const roundSegs = segs.splice(0, segs.length);
    const persisted = await persistRound(roundSegs);
    if (persisted) {
      resetDraftState();
      liveDraft = !draftFailed;
    } else {
      // Keep draft_id / usedDraft — next thinking overwrites this preview.
      flushWanted = false;
      flushImmediate = false;
      hideThinking = false;
      lastEdit = 0;
    }
  };

  /** End of turn: finalize whatever is left as the last bubble. */
  const commitRemaining = async () => {
    flush(true);
    await editChain;
    if (finished || segs.length === 0) return;
    await persistRound(segs.slice());
    segs.length = 0;
    resetDraftState();
  };

  // Before draft TTL (~30s), re-send current rich_message with the same draft_id.
  const keepalive = setInterval(() => {
    if (finished || broken) return;
    editChain = editChain.then(async () => {
      if (finished || broken) return;
      if (!liveDraft || draftFailed || !usedDraft) return;
      if (Date.now() - lastDraftAt < DRAFT_KEEPALIVE_MS) return;
      await pushLive();
    });
  }, DRAFT_KEEPALIVE_CHECK_MS);

  try {
    for await (const piece of turnPieceStream(sessionId, prompt, opts)) {
      if (piece.channel === 'round') {
        await commitRound();
        continue;
      }

      if (piece.channel === 'thinking_end') {
        hideThinking = true;
        dropThinkingSegs();
        flush(true);
        continue;
      }

      if (piece.channel === 'tool_fix') {
        let replaced = false;
        for (let i = segs.length - 1; i >= 0; i--) {
          const seg = segs[i]!;
          if (seg.channel !== 'tool' || !seg.text.includes(piece.from)) continue;
          seg.text = seg.text.replace(piece.from, piece.to);
          replaced = true;
          break;
        }
        if (!replaced) {
          // Original announce already finalized into a prior bubble — append update.
          const last = segs[segs.length - 1];
          const line = `${piece.to}\n`;
          if (last && last.channel === 'tool') last.text += line;
          else segs.push({ channel: 'tool', text: line });
        }
        hideThinking = true;
        dropThinkingSegs();
        sawAny = true;
        // Coalesce with normal pacing — force-flush storms made unfinished
        // thinking drip out one Telegram RTT at a time while tools update.
        flush(false);
        continue;
      }

      // The assistant's actual reply begins: if tool calls have accumulated in
      // this bubble, finalize them as their own group first — so a reply's tools
      // land in ONE bubble instead of one bubble per call.
      if (
        piece.channel === 'main' &&
        segs.some((s) => s.channel === 'tool' && s.text.trim()) &&
        !segs.some((s) => s.channel === 'main')
      ) {
        await commitRound();
      }

      sawAny = true;
      if (piece.channel === 'thinking') {
        hideThinking = false;
      } else if (piece.channel === 'tool' || piece.channel === 'main') {
        // Thinking cycle over — hide immediately (tools count as post-thinking).
        hideThinking = true;
        dropThinkingSegs();
      }
      const last = segs[segs.length - 1];
      if (last && last.channel === piece.channel) last.text += piece.text;
      else segs.push({ channel: piece.channel, text: piece.text });
      // Only tools force an immediate flush (they're short, discrete events).
      // Main text is coalesced at EDIT_MIN_MS — force-flushing per token piled on
      // edits and tripped Telegram's 429 backoff, which made the reply stutter.
      flush(piece.channel === 'tool');
    }

    if (!sawAny && !bubbled) {
      await sendRich(api, chatId, richPlain('(no text output)'));
      return;
    }

    await commitRemaining();
  } finally {
    finished = true;
    flushWanted = false;
    clearInterval(keepalive);
  }
}

/** Inline keyboard for a permission prompt. */
export function permissionKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Allow', `p:${requestId}:a`)
    .text('Always', `p:${requestId}:A`)
    .text('Deny', `p:${requestId}:d`);
}

export async function sendPermissionPrompt(
  api: Api,
  chatId: number,
  sessionId: string,
  request: PermissionRequest,
): Promise<void> {
  if (request.toolName === 'AskUserQuestion') {
    await sendAskUserPrompt(api, chatId, sessionId, request);
    return;
  }
  // A non-empty `plan` marks a plan-review request even if the tool name
  // arrived in a non-canonical spelling the server didn't rewrite.
  if (request.toolName === 'ExitPlanMode' || (typeof request.plan === 'string' && request.plan.trim())) {
    await sendExitPlanPrompt(api, chatId, request);
    return;
  }

  const summary = formatToolCallHtml(request.toolName, request.input);
  const inputPreview = (() => {
    try {
      const s = typeof request.input === 'string' ? request.input : JSON.stringify(request.input, null, 2);
      return clip(s, 600);
    } catch {
      return '(unprintable)';
    }
  })();
  const html = clip(`Permission: ${summary}\n<pre>${escHtml(inputPreview)}</pre>`);
  try {
    await sendRich(api, chatId, richHtml(html), {
      reply_markup: permissionKeyboard(request.requestId),
    });
  } catch (err) {
    log.warn('telegram permission prompt failed', err);
  }
}

/** Resolve a permission callback_data of the form `p:<requestId>:a|A|d`. */
export function parsePermissionCallback(data: string): {
  requestId: string;
  allow: boolean;
  remember: boolean;
} | null {
  if (!data.startsWith('p:')) return null;
  const parts = data.split(':');
  if (parts.length < 3) return null;
  const decision = parts[parts.length - 1];
  const requestId = parts.slice(1, -1).join(':');
  if (!requestId || !['a', 'A', 'd'].includes(decision!)) return null;
  return {
    requestId,
    allow: decision === 'a' || decision === 'A',
    remember: decision === 'A',
  };
}
