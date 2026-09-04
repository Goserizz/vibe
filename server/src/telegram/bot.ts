import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from '../config.js';
import { log } from '../log.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import { awaitFullSessionList, prefetchSessionList } from '../sessions/list.js';
import { getRecentProjects } from '../projects.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { hub } from '../ws/hub.js';
import { resolveRemoteSession } from '../remote/discovery.js';
import { parseSessionId } from '../remote/sessionId.js';
import type { AgentKind, EffortLevel, PermissionMode, SessionMeta } from '../../../shared/protocol.js';
import { telegramState } from './state.js';
import {
  HELP_TEXT,
  clip,
  escHtml,
  formatSessionCard,
  formatSessionLine,
} from './format.js';
import { editHtml, editPlain, replyHtml, replyPlain, replyRich, richMd } from './rich.js';
import { formatRecentConversation } from './history.js';
import {
  isStopText,
  parsePermissionCallback,
  sendPermissionPrompt,
  streamTurnToChat,
} from './turn.js';
import {
  handleAskCallback,
  handleAskOtherText,
  handleExitPlanCallback,
  isAwaitingAskOther,
} from './interactive.js';
import {
  createSessionFromArgs,
  handleNewSessionCallback,
  handleNewSessionText,
  rememberNewPrefs,
  startNewSessionWizard,
} from './newSession.js';

type BotContext = Context;

const PAGE_SIZE = 8;
const effortLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const permissionModes = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
const agents = new Set(['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy', 'opencode', 'devin']);

/** Cache the last listed sessions per chat so /use N and session buttons resolve. */
const listCache = new Map<number, SessionMeta[]>();

/** Chats currently streaming a turn — ignore overlapping prompts. */
const busyChats = new Set<number>();

/**
 * Telegram reply keyboards persist on the client until remove_keyboard is sent.
 * Older builds left a sticky Stop button; clear it for known chats on startup.
 */
async function clearStickyReplyKeyboards(bot: Bot): Promise<void> {
  for (const chatId of telegramState.chatIds()) {
    try {
      const msg = await bot.api.sendMessage(chatId, '\u2060', {
        reply_markup: { remove_keyboard: true },
        disable_notification: true,
      });
      try {
        await bot.api.deleteMessage(chatId, msg.message_id);
      } catch {
        // carrier may already be gone
      }
    } catch (err) {
      log.warn('telegram clear sticky keyboard failed', chatId, err);
    }
  }
}

/** True for Telegram bot commands (`/new`, `/start@bot`), not filesystem paths (`/root/vibe`). */
function isBotCommand(text: string): boolean {
  return /^\/[A-Za-z_][A-Za-z0-9_]*(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
}

function allowed(userId: number | undefined): boolean {
  if (!userId) return false;
  if (config.telegramAllowlist.length === 0) return true;
  return config.telegramAllowlist.includes(userId);
}

async function ensureRemoteCached(sessionId: string): Promise<void> {
  const { host, claudeSessionId } = parseSessionId(sessionId);
  if (!host || sessionStore.get(sessionId)) return;
  const remoteHost = hostRegistry.get(host);
  if (!remoteHost) return;
  const hit = await resolveRemoteSession(remoteHost, claudeSessionId);
  if (hit) {
    hub.cacheRemoteSession(sessionId, {
      host: remoteHost.name,
      sshTarget: remoteHost.ssh,
      cwd: hit.session.cwd,
      model: hit.session.model,
      title: hit.session.title,
      agent: hit.agent,
      proxy: proxyForAgent(remoteHost, hit.agent),
    });
  }
}

function sessionsKeyboard(sessions: SessionMeta[], page: number, activeId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const start = page * PAGE_SIZE;
  const slice = sessions.slice(start, start + PAGE_SIZE);
  for (let i = 0; i < slice.length; i++) {
    const s = slice[i];
    const n = start + i + 1;
    const mark = s.id === activeId ? '▸ ' : '';
    const label = clip(`${mark}${n}. ${s.title}`.replace(/\n/g, ' '), 60);
    kb.text(label, `use:${n}`).row();
  }
  const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  if (totalPages > 1) {
    if (page > 0) kb.text('◀ Prev', `page:${page - 1}`);
    kb.text(`${page + 1}/${totalPages}`, 'page:noop');
    if (page + 1 < totalPages) kb.text('Next ▶', `page:${page + 1}`);
  }
  return kb;
}

async function replySessionList(ctx: BotContext, page = 0): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const sessions = await awaitFullSessionList();
  listCache.set(chatId, sessions);
  const activeId = telegramState.get(chatId).sessionId;
  if (sessions.length === 0) {
    await replyPlain(ctx, 'No sessions yet. Use /new to create one.');
    return;
  }
  const start = page * PAGE_SIZE;
  const slice = sessions.slice(start, start + PAGE_SIZE);
  const lines = slice.map((s, i) => formatSessionLine(s, start + i + 1, s.id === activeId));
  await replyHtml(ctx, clip(`Sessions (${sessions.length}):\n\n${lines.join('\n\n')}`), {
    reply_markup: sessionsKeyboard(sessions, page, activeId),
  });
}

function resolveSessionRef(chatId: number, ref: string): SessionMeta | undefined {
  const sessions = listCache.get(chatId) ?? [];
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return sessions[n - 1];
  return sessions.find((s) => s.id === ref || s.id.endsWith(ref) || s.claudeSessionId === ref);
}

async function getActiveMeta(chatId: number): Promise<SessionMeta | undefined> {
  const id = telegramState.get(chatId).sessionId;
  if (!id) return undefined;
  const stored = sessionStore.get(id);
  if (stored) return toMeta(stored, hub.isRunning(id), 'vibe', hub.hasActiveBackgroundTasks(id));
  const sessions = listCache.get(chatId) ?? (await awaitFullSessionList());
  listCache.set(chatId, sessions);
  return sessions.find((s) => s.id === id);
}

/**
 * Show the most recent exchange of a session after switching to it. Reads the
 * normalized transcript via the hub (local file or SSH for remote sessions).
 * Best-effort: a transcript read failure just skips the recap rather than
 * blocking the switch.
 */
async function sendRecentConversation(ctx: BotContext, sessionId: string): Promise<void> {
  let blocks;
  try {
    blocks = (await hub.snapshot(sessionId)).blocks;
  } catch (err) {
    log.debug('telegram recent conversation snapshot failed', sessionId, err);
    return;
  }
  const body = formatRecentConversation(blocks);
  if (!body) {
    await replyPlain(ctx, 'No conversation yet — send a message to start.');
    return;
  }
  await replyRich(ctx, richMd(`**Recent conversation**\n\n${body}`));
}

export function startTelegramBot(): { stop: () => Promise<void> } | null {
  const token = config.telegramBotToken;
  if (!token) {
    log.debug('telegram bot disabled (set VIBE_TELEGRAM_BOT_TOKEN to enable)');
    return null;
  }

  const bot = new Bot<BotContext>(token);
  bot.api.config.use(autoRetry());

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!allowed(uid)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
      else if (ctx.message) await replyPlain(ctx, 'Unauthorized. Ask the Vibe owner to add your user id to VIBE_TELEGRAM_ALLOWLIST.');
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const uid = ctx.from?.id;
    await replyHtml(
      ctx,
      clip(
        `Hey${ctx.from?.first_name ? `, ${escHtml(ctx.from.first_name)}` : ''} — Vibe is ready.\n` +
          (uid ? `Your Telegram user id: <code>${uid}</code>\n\n` : '\n') +
          HELP_TEXT,
      ),
    );
  });

  bot.command('help', async (ctx) => {
    await replyHtml(ctx, HELP_TEXT);
  });

  bot.command(['sessions', 'ls'], async (ctx) => {
    await replySessionList(ctx, 0);
  });

  bot.command('status', async (ctx) => {
    const chatId = ctx.chat!.id;
    const meta = await getActiveMeta(chatId);
    if (!meta) {
      await replyPlain(ctx, 'No active session. /sessions to pick one, or /new to create.');
      return;
    }
    await replyHtml(ctx, formatSessionCard(meta));
  });

  bot.command('tasks', async (ctx) => {
    const sessionId = telegramState.get(ctx.chat!.id).sessionId;
    if (!sessionId) {
      await replyPlain(ctx, 'No active session. /sessions to pick one, or /new to create.');
      return;
    }
    const tasks = hub.tasks(sessionId);
    if (!tasks.length) {
      await replyPlain(ctx, 'No background tasks in the active session.');
      return;
    }
    const lines = tasks.map((task) => {
      const icon = task.status === 'running' || task.status === 'pending' ? '⏳'
        : task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏹';
      return `${icon} <code>${escHtml(task.id)}</code> · ${escHtml(task.status)}\n${escHtml(clip(task.description, 240))}`;
    });
    await replyHtml(ctx, clip(`Background tasks\n\n${lines.join('\n\n')}\n\n/task &lt;id&gt; for details and output.\n/taskstop &lt;id&gt; to stop a running task.`));
  });

  bot.command('task', async (ctx) => {
    const sessionId = telegramState.get(ctx.chat!.id).sessionId;
    const taskId = ((ctx.match as string | undefined) ?? '').trim();
    if (!sessionId || !taskId) {
      await replyHtml(ctx, 'Usage: /task &lt;task-id&gt; — see /tasks');
      return;
    }
    const task = hub.tasks(sessionId).find((entry) => entry.id === taskId);
    if (!task) {
      await replyPlain(ctx, `Task ${taskId} was not found in the active session.`);
      return;
    }

    const lines = [
      `<b>${escHtml(task.description || task.id)}</b>`,
      `<code>${escHtml(task.id)}</code>`,
      `${escHtml(task.agent)} · ${escHtml(task.kind)} · ${escHtml(task.status)}`,
      `started: ${escHtml(new Date(task.startedAt).toISOString())}`,
      `updated: ${escHtml(new Date(task.updatedAt).toISOString())}`,
    ];
    if (task.endedAt) lines.push(`ended: ${escHtml(new Date(task.endedAt).toISOString())}`);
    if (task.processId) lines.push(`process: <code>${escHtml(task.processId)}</code>`);
    if (task.exitCode != null) lines.push(`exit code: <code>${task.exitCode}</code>`);
    if (task.activity) lines.push(`activity: ${escHtml(task.activity)}`);
    if (task.cwd) lines.push(`cwd: <code>${escHtml(clip(task.cwd, 1_000))}</code>`);
    if (task.command) lines.push(`\n<b>Command</b>\n<pre>${escHtml(clip(task.command, 4_000))}</pre>`);
    if (task.detail && task.detail !== task.command) lines.push(`\n<b>Instructions</b>\n${escHtml(clip(task.detail, 4_000))}`);
    if (task.summary && task.summary !== task.output) lines.push(`\n<b>Summary</b>\n${escHtml(clip(task.summary, 4_000))}`);
    if (task.error) lines.push(`\n<b>Error</b>\n<pre>${escHtml(clip(task.error, 4_000))}</pre>`);
    lines.push(task.output
      ? `\n<b>Captured output</b>\n<pre>${escHtml(clip(task.output, 16_000))}</pre>`
      : '\n<b>Captured output</b>\nNo output captured yet.');
    if (task.outputFile) lines.push(`source: <code>${escHtml(clip(task.outputFile, 1_000))}</code>`);
    await replyHtml(ctx, lines.join('\n'));
  });

  bot.command('taskstop', async (ctx) => {
    const sessionId = telegramState.get(ctx.chat!.id).sessionId;
    const taskId = ((ctx.match as string | undefined) ?? '').trim();
    if (!sessionId || !taskId) {
      await replyHtml(ctx, 'Usage: /taskstop &lt;task-id&gt; — see /tasks');
      return;
    }
    const stopped = await hub.stopTaskForSession(sessionId, taskId);
    await replyPlain(ctx, stopped ? `Stop requested for ${taskId}.` : 'That task is not running or cannot be stopped individually.');
  });

  bot.command('use', async (ctx) => {
    const chatId = ctx.chat!.id;
    const ref = (ctx.match as string | undefined)?.trim();
    if (!ref) {
      await replyHtml(ctx, 'Usage: /use &lt;n|id&gt; — see /sessions');
      return;
    }
    if (!listCache.has(chatId)) listCache.set(chatId, await awaitFullSessionList());
    const meta = resolveSessionRef(chatId, ref);
    if (!meta) {
      await replyPlain(ctx, 'Session not found. Run /sessions and try again.');
      return;
    }
    await ensureRemoteCached(meta.id);
    telegramState.setSession(chatId, meta.id);
    await replyHtml(ctx, `Active session:\n${formatSessionCard(meta)}`);
    await sendRecentConversation(ctx, meta.id);
  });

  bot.command('projects', async (ctx) => {
    const projects = getRecentProjects(15);
    if (projects.length === 0) {
      await replyPlain(ctx, 'No recent projects found under ~/.claude.');
      return;
    }
    const lines = projects.map((p, i) => `<b>${i + 1}.</b> <code>${escHtml(p.path)}</code>`);
    await replyHtml(ctx, clip(`Recent projects:\n\n${lines.join('\n')}\n\n/new &lt;path&gt; to start.`));
  });

  bot.command('new', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = ((ctx.match as string | undefined) ?? '').trim();
    if (!arg) {
      await startNewSessionWizard(ctx);
      return;
    }
    // Quick path: /new [/path] [agent=claude] [model=opus] [host=name] [auto=1] [title=…] [mode=…] [effort=…]
    const opts: Record<string, string> = {};
    let cwd = '';
    for (const p of arg.split(/\s+/)) {
      const eq = p.indexOf('=');
      if (eq > 0) opts[p.slice(0, eq)] = p.slice(eq + 1);
      else if (!cwd) cwd = p; // first bare token is the working directory
    }
    const auto = /^(1|true|yes)$/i.test(opts.auto ?? '');
    try {
      const draft = {
        cwd: auto ? undefined : cwd,
        autoCwd: auto || undefined,
        host: opts.host ?? '',
        agent: agents.has(opts.agent!) ? (opts.agent as AgentKind) : undefined,
        model: opts.model,
        title: opts.title,
        permissionMode: permissionModes.has(opts.mode!) ? (opts.mode as PermissionMode) : undefined,
        effort: effortLevels.has(opts.effort!) ? (opts.effort as EffortLevel) : undefined,
      };
      const meta = await createSessionFromArgs(draft);
      rememberNewPrefs(chatId, {
        ...draft,
        model: meta.model,
        agent: meta.agent,
        permissionMode: meta.permissionMode,
        effort: meta.effort,
      });
      telegramState.setSession(chatId, meta.id);
      telegramState.setDraft(chatId, undefined);
      await replyHtml(ctx, `Created & activated:\n${formatSessionCard(meta)}\n\nSend a message to start.`);
    } catch (err) {
      await replyPlain(ctx, `Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command('cancel', async (ctx) => {
    telegramState.setDraft(ctx.chat!.id, undefined);
    await replyPlain(ctx, 'Cancelled.');
  });

  bot.command('delete', async (ctx) => {
    const chatId = ctx.chat!.id;
    const id = telegramState.get(chatId).sessionId;
    if (!id) {
      await replyPlain(ctx, 'No active session.');
      return;
    }
    const stored = sessionStore.get(id);
    sessionStore.remove(id);
    sessionStore.hide(id);
    if (stored?.claudeSessionId) sessionStore.hide(stored.claudeSessionId);
    hub.broadcastRemoved(id);
    telegramState.setSession(chatId, undefined);
    await replyPlain(ctx, 'Session dismissed from Vibe.');
  });

  bot.command('rename', async (ctx) => {
    const chatId = ctx.chat!.id;
    const id = telegramState.get(chatId).sessionId;
    const title = ((ctx.match as string | undefined) ?? '').trim();
    if (!id || !title) {
      await replyHtml(ctx, 'Usage: /rename &lt;title&gt; (with an active session)');
      return;
    }
    const updated = sessionStore.update(id, { title });
    if (!updated) {
      await replyPlain(ctx, 'Session is not Vibe-managed yet — send a message first, then rename.');
      return;
    }
    hub.broadcastMeta(id);
    await replyHtml(ctx, `Renamed to <b>${escHtml(title)}</b>`);
  });

  bot.command('model', async (ctx) => {
    const chatId = ctx.chat!.id;
    const id = telegramState.get(chatId).sessionId;
    const model = ((ctx.match as string | undefined) ?? '').trim();
    if (!id || !model) {
      await replyHtml(ctx, 'Usage: /model &lt;name&gt;');
      return;
    }
    let updated = sessionStore.update(id, { model });
    if (!updated) {
      await replyPlain(ctx, 'Adopt the session first by sending a message, then /model.');
      return;
    }
    hub.broadcastMeta(id);
    await replyHtml(ctx, `Model → <code>${escHtml(model)}</code>`);
  });

  bot.command('effort', async (ctx) => {
    const chatId = ctx.chat!.id;
    const id = telegramState.get(chatId).sessionId;
    const effort = ((ctx.match as string | undefined) ?? '').trim();
    if (!id || !effortLevels.has(effort)) {
      await replyHtml(ctx, 'Usage: /effort &lt;low|medium|high|xhigh|max|ultra&gt;');
      return;
    }
    const updated = sessionStore.update(id, { effort: effort as EffortLevel });
    if (!updated) {
      await replyPlain(ctx, 'Adopt the session first by sending a message, then /effort.');
      return;
    }
    hub.broadcastMeta(id);
    await replyHtml(ctx, `Effort → <code>${escHtml(effort)}</code>`);
  });

  bot.command('mode', async (ctx) => {
    const chatId = ctx.chat!.id;
    const id = telegramState.get(chatId).sessionId;
    const mode = ((ctx.match as string | undefined) ?? '').trim();
    if (!id || !permissionModes.has(mode)) {
      await replyHtml(ctx, 'Usage: /mode &lt;default|plan|acceptEdits|bypassPermissions&gt;');
      return;
    }
    const updated = sessionStore.update(id, { permissionMode: mode as PermissionMode });
    if (!updated) {
      await replyPlain(ctx, 'Adopt the session first by sending a message, then /mode.');
      return;
    }
    hub.broadcastMeta(id);
    await replyHtml(ctx, `Permission mode → <code>${escHtml(mode)}</code>`);
  });

  bot.command(['abort', 'stop'], async (ctx) => {
    const chatId = ctx.chat!.id;
    const id = telegramState.get(chatId).sessionId;
    if (!id) {
      await replyPlain(ctx, 'No active session.');
      return;
    }
    if (!hub.isRunning(id) && !busyChats.has(chatId)) {
      await replyPlain(ctx, 'No turn is running.');
      return;
    }
    hub.abort(id);
    await replyPlain(ctx, 'Stopped.');
  });

  // Session picker / pagination callbacks
  bot.callbackQuery(/^use:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const n = Number(ctx.match![1]);
    if (!listCache.has(chatId)) listCache.set(chatId, await awaitFullSessionList());
    const meta = resolveSessionRef(chatId, String(n));
    if (!meta) {
      await ctx.answerCallbackQuery({ text: 'Stale list — run /sessions', show_alert: true });
      return;
    }
    await ensureRemoteCached(meta.id);
    telegramState.setSession(chatId, meta.id);
    await ctx.answerCallbackQuery({ text: `Using #${n}` });
    await replyHtml(ctx, `Active session:\n${formatSessionCard(meta)}`);
    await sendRecentConversation(ctx, meta.id);
  });

  bot.callbackQuery(/^page:(\d+|noop)$/, async (ctx) => {
    const key = ctx.match![1];
    if (key === 'noop') {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    const page = Number(key);
    // Edit the original list message when possible.
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const sessions = listCache.get(chatId) ?? (await awaitFullSessionList());
    listCache.set(chatId, sessions);
    const activeId = telegramState.get(chatId).sessionId;
    const start = page * PAGE_SIZE;
    const slice = sessions.slice(start, start + PAGE_SIZE);
    const lines = slice.map((s, i) => formatSessionLine(s, start + i + 1, s.id === activeId));
    try {
      await editHtml(ctx, clip(`Sessions (${sessions.length}):\n\n${lines.join('\n\n')}`), {
        reply_markup: sessionsKeyboard(sessions, page, activeId),
      });
    } catch {
      await replySessionList(ctx, page);
    }
  });

  // New-session wizard callbacks (machine / agent / model / …)
  bot.callbackQuery(/^ns:/, async (ctx) => {
    await handleNewSessionCallback(ctx);
  });

  // Permission decisions (generic allow/always/deny)
  bot.callbackQuery(/^p:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const parsed = parsePermissionCallback(ctx.callbackQuery.data);
    if (!parsed || chatId == null) {
      await ctx.answerCallbackQuery({ text: 'Invalid', show_alert: true });
      return;
    }
    const sessionId = telegramState.get(chatId).sessionId;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: 'No active session', show_alert: true });
      return;
    }
    hub.resolvePermission(sessionId, parsed.requestId, {
      allow: parsed.allow,
      remember: parsed.remember,
    });
    const label = parsed.remember ? 'Always allow' : parsed.allow ? 'Allow' : 'Deny';
    await ctx.answerCallbackQuery({ text: label });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await editPlain(ctx, `Permission → ${label}`);
    } catch {
      /* message may be too old to edit */
    }
  });

  // AskUserQuestion interactive picker
  bot.callbackQuery(/^aq:/, async (ctx) => {
    await handleAskCallback(ctx);
  });

  // ExitPlanMode approve / reject
  bot.callbackQuery(/^ep:/, async (ctx) => {
    await handleExitPlanCallback(ctx);
  });

  // Plain text: draft wizard or chat turn
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    // Skip real bot commands (`/new`), but keep absolute paths (`/root/vibe`).
    if (!text || isBotCommand(text)) return;

    if (await handleNewSessionText(ctx, text)) return;

    // AskUserQuestion "Other" free text — allowed even while the turn is busy.
    if (isAwaitingAskOther(chatId)) {
      if (await handleAskOtherText(bot.api, chatId, text)) return;
    }

    const sessionId = telegramState.get(chatId).sessionId;
    if (!sessionId) {
      await replyPlain(ctx, 'No active session. /sessions to pick one, or /new to create.');
      return;
    }

    if (busyChats.has(chatId) || hub.isRunning(sessionId)) {
      // Typed stop phrases abort the in-flight turn.
      if (isStopText(text)) {
        hub.abort(sessionId);
        await replyPlain(ctx, 'Stopped.');
        return;
      }
      await replyPlain(ctx, 'A turn is already running. Send /abort (or Stop / 停止) to interrupt.');
      return;
    }

    await ensureRemoteCached(sessionId);
    busyChats.add(chatId);
    try {
      await streamTurnToChat(bot.api, chatId, sessionId, text, {
        onPermission: (req) => {
          void sendPermissionPrompt(bot.api, chatId, sessionId, req);
        },
      });
    } catch (err) {
      log.warn('telegram turn failed', err);
      await replyPlain(ctx, `Turn failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busyChats.delete(chatId);
    }
  });

  bot.catch((err) => {
    log.warn('telegram bot error', err);
  });

  log.ok('telegram bot starting…');
  // Warm session list so the first /sessions is not a multi-second SSH wait.
  prefetchSessionList();
  if (config.telegramAllowlist.length) {
    log.info('telegram allowlist:', config.telegramAllowlist.join(', '));
  } else {
    log.warn('telegram allowlist empty — any user who finds the bot can use it (set VIBE_TELEGRAM_ALLOWLIST)');
  }

  // Register the / menu so Telegram shows command hints in the chat input.
  const commands = [
    { command: 'start', description: 'Start & show your user id' },
    { command: 'help', description: 'Show help' },
    { command: 'sessions', description: 'List sessions' },
    { command: 'use', description: 'Switch session: /use <n|id>' },
    { command: 'new', description: 'New session (machine, agent, model, …)' },
    { command: 'status', description: 'Show active session' },
    { command: 'tasks', description: 'List background tasks' },
    { command: 'task', description: 'Show task details: /task <id>' },
    { command: 'taskstop', description: 'Stop one task: /taskstop <id>' },
    { command: 'abort', description: 'Stop the current turn' },
    { command: 'stop', description: 'Stop the current turn' },
    { command: 'model', description: 'Set model: /model <name>' },
    { command: 'effort', description: 'Set effort: /effort <level>' },
    { command: 'mode', description: 'Set permission mode' },
    { command: 'rename', description: 'Rename session: /rename <title>' },
    { command: 'delete', description: 'Dismiss active session' },
    { command: 'projects', description: 'Recent working directories' },
    { command: 'cancel', description: 'Cancel /new wizard' },
  ];

  void bot.api
    .setMyCommands(commands)
    .then(() => log.ok('telegram commands registered'))
    .catch((err) => log.warn('failed to register telegram commands', err));

  // Drop queued updates from before this process started. Without this,
  // a restart (especially SIGKILL / hung stop) re-delivers the last user
  // messages and the bot re-runs those turns against the agent.
  void bot.start({
    drop_pending_updates: true,
    onStart: (info) => {
      log.ok(`telegram bot @${info.username} online`);
      // Reply keyboards stick on the client until remove_keyboard is sent.
      // We no longer show Stop there — clear any leftover from older builds.
      void clearStickyReplyKeyboards(bot);
    },
  });

  return {
    stop: async () => {
      await bot.stop();
    },
  };
}
