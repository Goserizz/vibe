import type { SessionMeta } from '../../../shared/protocol.js';

/** Default clip budget for rich messages (Telegram rich limit is 32768). */
const MAX_TG = 30000;

/** Escape text for Telegram HTML / Rich HTML. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Truncate to Telegram's message limit with an ellipsis. */
export function clip(s: string, max = MAX_TG): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function shortenPath(p: string, max = 3): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= max) return p;
  return '…/' + parts.slice(-max).join('/');
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatSessionLine(s: SessionMeta, index: number, active?: boolean): string {
  const mark = active ? '▸ ' : '  ';
  const run = s.running ? ' 🔄' : '';
  const host = s.host ? ` · ${s.host}` : '';
  return `${mark}<b>${index}.</b> ${escHtml(s.title)}${run}\n<code>${escHtml(shortenPath(s.cwd))}</code>${escHtml(host)} · ${escHtml(s.agent)} · ${escHtml(s.model)} · ${relativeTime(s.updatedAt)}`;
}

export function formatSessionCard(s: SessionMeta): string {
  const lines = [
    `<b>${escHtml(s.title)}</b>${s.running ? ' 🔄' : ''}`,
    `<code>${escHtml(s.cwd)}</code>`,
    `${escHtml(s.agent)} · ${escHtml(s.model)} · ${escHtml(s.permissionMode)} · ${escHtml(s.effort)}`,
    `host: ${escHtml(s.host)} · ${relativeTime(s.updatedAt)}`,
  ];
  return lines.join('\n');
}

export const HELP_TEXT = `Vibe Telegram bot — drive your coding agents from chat.

<b>Sessions</b>
/sessions — list sessions
/use &lt;n|id&gt; — switch active session
/status — current session
/new — create a session (remembers last choices)
/new &lt;cwd&gt; — quick create with defaults
/delete — dismiss current session
/rename &lt;title&gt; — rename current session

<b>Chat</b>
Just send a message to talk in the active session (streams live).
While generating: send /abort (/stop) or type Stop / 停止 / 中断 to interrupt.
/tasks — list native background tasks
/task &lt;id&gt; — show task details and captured output
/taskstop &lt;id&gt; — stop one background task

<b>Settings</b>
/model &lt;name&gt; — set model
/effort &lt;low|medium|high|xhigh|max|ultra&gt;
/mode &lt;default|plan|acceptEdits|bypassPermissions&gt;
/projects — recent working directories

<b>Tips</b>
/new opens with your last choices (same options as the web dialog).
Use the numbered buttons under /sessions to switch quickly.`;
