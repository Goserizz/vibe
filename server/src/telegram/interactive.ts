import crypto from 'node:crypto';
import { InlineKeyboard, type Context } from 'grammy';
import type { Api } from 'grammy';
import { hub } from '../ws/hub.js';
import { log } from '../log.js';
import type { PermissionRequest } from '../../../shared/protocol.js';
import { clip, escHtml } from './format.js';
import { editMessageRich, RICH_MAX, richHtml, richMd, richPlain, sendRich } from './rich.js';
import { telegramState } from './state.js';

interface AskOption {
  label: string;
  description?: string;
  id?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
  id?: string;
}

interface PendingAsk {
  token: string;
  chatId: number;
  sessionId: string;
  requestId: string;
  questions: AskQuestion[];
  answers: Record<string, string | string[]>;
  qIndex: number;
  multiSelected: Set<string>;
  awaitingOther: boolean;
  /** Cursor/Kimi ACP ask has no free-text Other. */
  allowOther: boolean;
  /** Agent label for the prompt heading ("Claude" / "Cursor" / "Kimi"). */
  agent: string;
  messageId?: number;
}

/** Short-token → pending AskUserQuestion (callback_data must stay ≤64 bytes). */
const asksByToken = new Map<string, PendingAsk>();
/** chatId → token while an ask is open (for Other text + cleanup). */
const askTokenByChat = new Map<number, string>();

function newToken(): string {
  return crypto.randomBytes(4).toString('hex');
}

function parseQuestions(input: unknown): AskQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const question = typeof (q as AskQuestion).question === 'string' ? (q as AskQuestion).question : '';
    if (!question) continue;
    const optionsRaw = Array.isArray((q as AskQuestion).options) ? (q as AskQuestion).options : [];
    const options: AskOption[] = [];
    for (const o of optionsRaw) {
      if (!o || typeof o !== 'object') continue;
      const label = typeof (o as AskOption).label === 'string' ? (o as AskOption).label.trim() : '';
      if (!label) continue;
      const description =
        typeof (o as AskOption).description === 'string' ? (o as AskOption).description : undefined;
      const id = typeof (o as AskOption).id === 'string' ? (o as AskOption).id : undefined;
      options.push({ label, description, id });
    }
    out.push({
      question,
      header: typeof (q as AskQuestion).header === 'string' ? (q as AskQuestion).header : undefined,
      options,
      multiSelect: !!(q as AskQuestion).multiSelect,
      id: typeof (q as AskQuestion).id === 'string' ? (q as AskQuestion).id : undefined,
    });
  }
  return out;
}

function clearAsk(token: string): void {
  const st = asksByToken.get(token);
  if (!st) return;
  asksByToken.delete(token);
  if (askTokenByChat.get(st.chatId) === token) askTokenByChat.delete(st.chatId);
}

/** True when this chat is waiting for free-text "Other" for AskUserQuestion. */
export function isAwaitingAskOther(chatId: number): boolean {
  const tok = askTokenByChat.get(chatId);
  if (!tok) return false;
  return !!asksByToken.get(tok)?.awaitingOther;
}

function askKeyboard(st: PendingAsk): InlineKeyboard {
  const kb = new InlineKeyboard();
  const q = st.questions[st.qIndex];
  if (!q) return kb.text('Cancel', `aq:${st.token}:x`);

  const multi = !!q.multiSelect;
  q.options.forEach((opt, oi) => {
    const mark = multi && st.multiSelected.has(opt.label) ? '✓ ' : '';
    const label = clip(`${mark}${opt.label}`, 56);
    kb.text(label, `aq:${st.token}:o:${st.qIndex}:${oi}`).row();
  });
  if (st.allowOther) {
    kb.text('Other…', `aq:${st.token}:t:${st.qIndex}`).row();
  }
  if (multi) {
    kb.text('Done', `aq:${st.token}:d:${st.qIndex}`);
  }
  kb.text('Cancel', `aq:${st.token}:x`);
  return kb;
}

function askBodyMarkdown(st: PendingAsk): string {
  const q = st.questions[st.qIndex];
  if (!q) return 'No questions.';
  const parts: string[] = [`**${st.agent} has a question**`];
  parts.push(`_Question ${st.qIndex + 1} of ${st.questions.length}_`);
  if (q.header) parts.push(`\`${q.header}\``);
  parts.push(q.question);
  if (q.multiSelect) parts.push('_Select all that apply, then Done._');
  if (st.awaitingOther) parts.push('\n_Reply with your answer as a normal message._');
  return parts.join('\n\n');
}

async function renderAsk(api: Api, st: PendingAsk): Promise<void> {
  const body = clip(askBodyMarkdown(st), RICH_MAX);
  const markup = { reply_markup: askKeyboard(st) };
  try {
    if (st.messageId != null) {
      await editMessageRich(api, st.chatId, st.messageId, richMd(body), markup);
    } else {
      const msg = await sendRich(api, st.chatId, richMd(body), markup);
      st.messageId = msg.message_id;
    }
  } catch (err) {
    try {
      if (st.messageId != null) {
        await editMessageRich(api, st.chatId, st.messageId, richPlain(body), markup);
      } else {
        const msg = await sendRich(api, st.chatId, richPlain(body), markup);
        st.messageId = msg.message_id;
      }
    } catch (err2) {
      log.warn('telegram ask prompt failed', err2 ?? err);
    }
  }
}

async function finishAsk(
  api: Api,
  st: PendingAsk,
  decision: { allow: boolean; updatedInput?: unknown },
  label: string,
): Promise<void> {
  hub.resolvePermission(st.sessionId, st.requestId, decision);
  clearAsk(st.token);
  if (st.messageId != null) {
    try {
      await api.editMessageReplyMarkup(st.chatId, st.messageId, { reply_markup: undefined });
      await editMessageRich(api, st.chatId, st.messageId, richPlain(label));
    } catch {
      /* message may be too old */
    }
  }
}

function recordAnswer(st: PendingAsk, value: string | string[]): void {
  const q = st.questions[st.qIndex];
  if (!q) return;
  st.answers[q.question] = value;
  st.qIndex += 1;
  st.multiSelected = new Set();
  st.awaitingOther = false;
}

async function advanceOrSubmit(api: Api, st: PendingAsk): Promise<void> {
  if (st.qIndex >= st.questions.length) {
    await finishAsk(
      api,
      st,
      { allow: true, updatedInput: { questions: st.questions, answers: st.answers } },
      'Answers submitted',
    );
    return;
  }
  await renderAsk(api, st);
}

/** Start AskUserQuestion interactive prompt. */
export async function sendAskUserPrompt(
  api: Api,
  chatId: number,
  sessionId: string,
  request: PermissionRequest,
): Promise<void> {
  const questions = parseQuestions(request.input);
  if (questions.length === 0) {
    // Nothing to pick — deny so the tool doesn't get empty answers silently.
    hub.resolvePermission(sessionId, request.requestId, { allow: false });
    await sendRich(api, chatId, richPlain('AskUserQuestion had no questions — cancelled.'));
    return;
  }

  // Replace any prior open ask in this chat.
  const prevTok = askTokenByChat.get(chatId);
  if (prevTok) clearAsk(prevTok);

  const source = (request.input as { source?: string } | undefined)?.source;
  // Free-text "Other" can't round-trip through ACP's fixed options.
  const allowOther = !source;
  const agent = source === 'kimi' ? 'Kimi' : source === 'cursor' ? 'Cursor' : 'Claude';

  const token = newToken();
  const st: PendingAsk = {
    token,
    chatId,
    sessionId,
    requestId: request.requestId,
    questions,
    answers: {},
    qIndex: 0,
    multiSelected: new Set(),
    awaitingOther: false,
    allowOther,
    agent,
  };
  asksByToken.set(token, st);
  askTokenByChat.set(chatId, token);
  await renderAsk(api, st);
}

/** Handle `aq:*` callback queries. Returns true if handled. */
export async function handleAskCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('aq:')) return false;

  const parts = data.split(':');
  // aq:<tok>:x | aq:<tok>:o:<qi>:<oi> | aq:<tok>:t:<qi> | aq:<tok>:d:<qi>
  const token = parts[1];
  const action = parts[2];
  if (!token || !action) {
    await ctx.answerCallbackQuery({ text: 'Invalid', show_alert: true });
    return true;
  }

  const st = asksByToken.get(token);
  if (!st) {
    await ctx.answerCallbackQuery({ text: 'Expired', show_alert: true });
    return true;
  }

  const api = ctx.api;

  if (action === 'x') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await finishAsk(api, st, { allow: false }, 'Question cancelled');
    return true;
  }

  const qi = Number(parts[3]);
  if (!Number.isInteger(qi) || qi !== st.qIndex) {
    await ctx.answerCallbackQuery({ text: 'Out of date', show_alert: true });
    return true;
  }
  const q = st.questions[qi];
  if (!q) {
    await ctx.answerCallbackQuery({ text: 'Invalid', show_alert: true });
    return true;
  }

  if (action === 't') {
    st.awaitingOther = true;
    st.multiSelected = new Set();
    await ctx.answerCallbackQuery({ text: 'Type your answer' });
    await renderAsk(api, st);
    return true;
  }

  if (action === 'd') {
    if (!q.multiSelect) {
      await ctx.answerCallbackQuery({ text: 'Not multi-select', show_alert: true });
      return true;
    }
    if (st.multiSelected.size === 0) {
      await ctx.answerCallbackQuery({ text: 'Pick at least one', show_alert: true });
      return true;
    }
    await ctx.answerCallbackQuery({ text: 'OK' });
    recordAnswer(st, [...st.multiSelected]);
    await advanceOrSubmit(api, st);
    return true;
  }

  if (action === 'o') {
    const oi = Number(parts[4]);
    const opt = q.options[oi];
    if (!opt || !Number.isInteger(oi)) {
      await ctx.answerCallbackQuery({ text: 'Invalid option', show_alert: true });
      return true;
    }
    st.awaitingOther = false;
    if (q.multiSelect) {
      if (st.multiSelected.has(opt.label)) st.multiSelected.delete(opt.label);
      else st.multiSelected.add(opt.label);
      await ctx.answerCallbackQuery({ text: st.multiSelected.has(opt.label) ? 'Selected' : 'Cleared' });
      await renderAsk(api, st);
      return true;
    }
    await ctx.answerCallbackQuery({ text: opt.label.slice(0, 40) });
    recordAnswer(st, opt.label);
    await advanceOrSubmit(api, st);
    return true;
  }

  await ctx.answerCallbackQuery({ text: 'Unknown', show_alert: true });
  return true;
}

/** Consume free-text answer when awaiting Other. Returns true if handled. */
export async function handleAskOtherText(api: Api, chatId: number, text: string): Promise<boolean> {
  const tok = askTokenByChat.get(chatId);
  if (!tok) return false;
  const st = asksByToken.get(tok);
  if (!st?.awaitingOther) return false;

  const trimmed = text.trim();
  if (!trimmed) return true;

  const q = st.questions[st.qIndex];
  if (!q) return true;

  if (q.multiSelect) {
    st.multiSelected.add(trimmed);
    st.awaitingOther = false;
    await renderAsk(api, st);
    return true;
  }

  recordAnswer(st, trimmed);
  await advanceOrSubmit(api, st);
  return true;
}

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

function planKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Approve plan', `ep:${requestId}:a`)
    .text('Reject', `ep:${requestId}:d`);
}

/** Show plan markdown + Approve/Reject. */
export async function sendExitPlanPrompt(
  api: Api,
  chatId: number,
  request: PermissionRequest,
): Promise<void> {
  const input = (request.input ?? {}) as { allowedPrompts?: { tool: string; prompt: string }[] };
  const prompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];
  const plan = typeof request.plan === 'string' && request.plan.trim() ? request.plan.trim() : '';

  const chunks: string[] = ['**Plan ready for review**'];
  if (plan) chunks.push(plan);
  else chunks.push('_Claude is ready to exit plan mode and start implementing._');
  if (prompts.length > 0) {
    chunks.push('**Permissions needed**');
    for (const p of prompts.slice(0, 20)) {
      chunks.push(`- ${p.prompt || p.tool}`);
    }
  }
  const body = clip(chunks.join('\n\n'), RICH_MAX);
  const markup = { reply_markup: planKeyboard(request.requestId) };

  try {
    await sendRich(api, chatId, richMd(body), markup);
  } catch (err) {
    try {
      await sendRich(api, chatId, richHtml(escHtml(body)), markup);
    } catch (err2) {
      log.warn('telegram exit-plan prompt failed', err2 ?? err);
    }
  }
}

/** Handle `ep:<requestId>:a|d`. Returns true if handled. */
export async function handleExitPlanCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('ep:')) return false;

  const parts = data.split(':');
  const decision = parts[parts.length - 1];
  const requestId = parts.slice(1, -1).join(':');
  if (!requestId || (decision !== 'a' && decision !== 'd')) {
    await ctx.answerCallbackQuery({ text: 'Invalid', show_alert: true });
    return true;
  }

  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.answerCallbackQuery({ text: 'Invalid', show_alert: true });
    return true;
  }

  const sessionId = telegramState.get(chatId).sessionId;
  if (!sessionId) {
    await ctx.answerCallbackQuery({ text: 'No active session', show_alert: true });
    return true;
  }

  const allow = decision === 'a';
  hub.resolvePermission(sessionId, requestId, { allow });
  const label = allow ? 'Plan approved' : 'Plan rejected';
  await ctx.answerCallbackQuery({ text: label });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    const msg = ctx.callbackQuery?.message;
    if (msg && 'message_id' in msg) {
      await editMessageRich(ctx.api, chatId, msg.message_id, richPlain(label));
    }
  } catch {
    /* message may be too old to edit */
  }
  return true;
}
