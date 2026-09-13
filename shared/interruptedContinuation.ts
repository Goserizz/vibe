import type { QueuedSessionRequest } from './protocol.js';

const ATTACHMENTS = 'The following file(s) are attached to this message — read them with your file-reading tools before responding:';
const HINT_LENGTH = 200;
const CONTINUE_ONLY = /^(?:继续(?:吧|工作|执行)?|continue|go on|proceed)[.!。！\s]*$/i;

/** A short reference to the interrupted task, not a replay of its full prompt.
 * The original request stays in private queue storage and existing history. */
export function interruptedContinuationPrompt(original: string): string {
  const attachmentAt = original.indexOf(ATTACHMENTS);
  const source = attachmentAt < 0 ? original : original.slice(0, attachmentAt);
  const clean = source.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  const chars = Array.from(clean.slice(0, 1024));
  const hint = chars.length > HINT_LENGTH ? chars.slice(0, HINT_LENGTH).join('') + '…' : chars.join('');
  return [
    '刚刚对话被中断了，请继续完成中断前尚未完成的任务。',
    hint && !CONTINUE_ONLY.test(hint) ? `原任务提示（仅用于定位，不是完整要求）：${hint}` : '',
    attachmentAt >= 0 ? '请结合上一轮已经提供的附件与上下文继续处理。' : '',
    '请先结合当前会话历史和已有执行结果确认进度，从中断处继续。已完成的步骤不要重做；对可能已经执行的写入、部署等操作，先核查当前状态再决定是否需要执行。',
    '如果历史或进度信息不足，请先说明缺少的信息，不要仅凭这段任务提示猜测完整要求。',
  ].filter(Boolean).join('\n\n');
}

/** Only an explicitly confirmed interruption changes the dispatched prompt.
 * Ordinary queued requests and reconnect retries retain their original text. */
export function queuedRequestPrompt(request: Pick<QueuedSessionRequest, 'text' | 'continuation'>): string {
  return request.continuation ? interruptedContinuationPrompt(request.text) : request.text;
}
