import type { Api, Context } from 'grammy';
import type { InputRichMessage } from '@grammyjs/types';
import { escHtml } from './format.js';

/** Rich messages allow up to 32768 chars; keep a safety margin. */
export const RICH_MAX = 30000;

/** Tags whose inner whitespace Telegram preserves literally. */
const LITERAL_WS_TAGS = new Set(['pre', 'code', 'tg-math', 'tg-math-block']);

/**
 * Rich HTML treats bare `\n` as insignificant whitespace (unlike classic
 * sendMessage HTML). Turn text-node newlines into `<br>` so layouts like
 * /sessions keep their line breaks. Leave `\n` alone inside pre/code/math.
 */
export function materializeRichHtmlNewlines(html: string): string {
  let out = '';
  let literalDepth = 0;
  const re = /<\/?([a-zA-Z0-9-]+)(?:\s[^>]*)?>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok.startsWith('</')) {
      const name = (m[1] ?? '').toLowerCase();
      if (LITERAL_WS_TAGS.has(name) && literalDepth > 0) literalDepth--;
      out += tok;
      continue;
    }
    if (tok.startsWith('<')) {
      const name = (m[1] ?? '').toLowerCase();
      const selfClosing = /\/>$/.test(tok) || name === 'br' || name === 'hr' || name === 'img';
      if (LITERAL_WS_TAGS.has(name) && !selfClosing) literalDepth++;
      out += tok;
      continue;
    }
    out += literalDepth > 0 ? tok : tok.replace(/\n/g, '<br>');
  }
  return out;
}

/**
 * Rich Markdown follows GFM soft-break rules (single `\n` → space).
 * Materialize hard breaks outside fenced code so prose keeps line breaks;
 * leave fences untouched so tables/code stay valid.
 */
export function materializeRichMarkdownNewlines(md: string): string {
  const fences: string[] = [];
  let s = md.replace(/```[\s\S]*?```/g, (block) => {
    const i = fences.length;
    fences.push(block);
    return `\u0000F${i}\u0000`;
  });
  // Trailing two spaces = GFM hard line break.
  s = s.replace(/\n/g, '  \n');
  s = s.replace(/\u0000F(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? '');
  return s;
}

export function richMd(markdown: string): InputRichMessage {
  return { markdown: materializeRichMarkdownNewlines(markdown) };
}

export function richHtml(html: string): InputRichMessage {
  return { html: materializeRichHtmlNewlines(html) };
}

/** Plain text as escaped HTML — no accidental Markdown parsing. */
export function richPlain(text: string): InputRichMessage {
  return richHtml(escHtml(text));
}

type RichOther = Record<string, unknown>;

export async function replyRich(
  ctx: Context,
  rich: InputRichMessage,
  other?: RichOther,
): Promise<Awaited<ReturnType<Context['replyWithRichMessage']>>> {
  return ctx.replyWithRichMessage(rich, other as object);
}

export async function replyHtml(ctx: Context, html: string, other?: RichOther) {
  return replyRich(ctx, richHtml(html), other);
}

export async function replyPlain(ctx: Context, text: string, other?: RichOther) {
  return replyRich(ctx, richPlain(text), other);
}

export async function editRich(
  ctx: Context,
  rich: InputRichMessage,
  other?: RichOther,
): Promise<Awaited<ReturnType<Context['editMessageText']>>> {
  return ctx.editMessageText(rich, other as object);
}

export async function editHtml(ctx: Context, html: string, other?: RichOther) {
  return editRich(ctx, richHtml(html), other);
}

export async function editPlain(ctx: Context, text: string, other?: RichOther) {
  return editRich(ctx, richPlain(text), other);
}

export async function sendRich(
  api: Api,
  chatId: number,
  rich: InputRichMessage,
  other?: RichOther,
) {
  return api.sendRichMessage(chatId, rich, other as object);
}

/** Ephemeral streaming preview (private chats). Must finalize with sendRich. */
export async function sendRichDraft(
  api: Api,
  chatId: number,
  draftId: number,
  rich: InputRichMessage,
  other?: RichOther,
) {
  return api.sendRichMessageDraft(chatId, draftId, rich, other as object);
}

export async function editMessageRich(
  api: Api,
  chatId: number,
  messageId: number,
  rich: InputRichMessage,
  other?: RichOther,
) {
  return api.editMessageText(chatId, messageId, rich, other as object);
}
