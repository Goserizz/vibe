import { InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { createLocalWorkdir, getRecentProjects, validateDir } from '../projects.js';
import { hostRegistry } from '../remote/hosts.js';
import { createRemoteWorkdir } from '../remote/workdir.js';
import { listCursorModels, listRemoteCursorModels } from '../cursor/models.js';
import { listCodexModels, listRemoteCodexModels } from '../codex/models.js';
import { discoverKimiCapabilities, discoverRemoteKimiCapabilities } from '../kimi/capabilities.js';
import { KIRO_PERMISSIONS, listKiroModels, listRemoteKiroModels } from '../kiro/models.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import { hub } from '../ws/hub.js';
import type { AgentKind, EffortLevel, PermissionMode, SessionMeta } from '../../../shared/protocol.js';
import { telegramState, type ChatState } from './state.js';
import { basename, clip, escHtml, formatSessionCard } from './format.js';
import { editHtml, editPlain, replyHtml, replyPlain } from './rich.js';

export type NewDraft = NonNullable<ChatState['draft']>;
type BotContext = Context;

const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'opusplan', label: 'Opus Plan' },
];

const PERMISSIONS: Record<AgentKind, { value: PermissionMode; label: string }[]> = {
  claude: [
    { value: 'default', label: 'Ask' },
    { value: 'acceptEdits', label: 'Auto-edit' },
    { value: 'plan', label: 'Plan' },
    { value: 'bypassPermissions', label: 'Bypass' },
  ],
  cursor: [
    { value: 'default', label: 'Agent' },
    { value: 'plan', label: 'Plan' },
  ],
  codex: [
    { value: 'default', label: 'Auto' },
    { value: 'plan', label: 'Plan' },
    { value: 'bypassPermissions', label: 'Bypass' },
  ],
  kimi: [
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
    { value: 'acceptEdits', label: 'Auto' },
    { value: 'bypassPermissions', label: 'YOLO' },
  ],
  kiro: KIRO_PERMISSIONS.map((p) => ({ value: p.value, label: p.label })),
};

const EFFORTS_CLAUDE: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

const EFFORTS_CODEX: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
];

/** Per-chat option lists for compact callback_data (Telegram max 64 bytes). */
const pickCache = new Map<number, { models: string[]; cwds: string[] }>();

/** Models per page in the /new model picker (2 columns). */
const MODEL_PAGE_SIZE = 16;

function cacheFor(chatId: number): { models: string[]; cwds: string[] } {
  let c = pickCache.get(chatId);
  if (!c) {
    c = { models: [], cwds: [] };
    pickCache.set(chatId, c);
  }
  return c;
}

function defaultDraft(chatId?: number): NewDraft {
  const saved = chatId != null ? telegramState.get(chatId).lastNew : undefined;
  let host = saved?.host ?? '';
  let cwd = saved?.cwd;
  if (host && !hostRegistry.get(host)) {
    host = '';
    cwd = undefined;
  }
  const agent = (saved?.agent as AgentKind) || (config.defaultAgent as AgentKind) || 'claude';
  return {
    step: 'form',
    host,
    agent,
    model:
      saved?.model ||
      (agent === 'cursor'
        ? config.defaultCursorModel
        : agent === 'codex'
          ? config.defaultCodexModel
          : agent === 'kimi'
            ? config.defaultKimiModel
            : agent === 'kiro'
              ? config.defaultKiroModel
              : config.defaultModel),
    permissionMode:
      saved?.permissionMode || (agent === 'claude' ? 'bypassPermissions' : 'default'),
    effort:
      saved?.effort ||
      (agent === 'codex' ? 'xhigh' : ((config.defaultEffort as EffortLevel) || 'max')),
    cwd,
  };
}

/** Persist create options so the next /new opens with the same choices. */
export function rememberNewPrefs(chatId: number, d: NewDraft): void {
  telegramState.setLastNew(chatId, {
    host: d.host ?? '',
    agent: d.agent,
    model: d.model,
    permissionMode: d.permissionMode,
    effort: d.effort,
    cwd: d.cwd,
  });
}

function mark(current: string | undefined, value: string, label: string): string {
  return current === value ? `✓ ${label}` : label;
}

function machineLabel(host: string | undefined): string {
  if (!host) return `${config.localName} (local)`;
  return host;
}

function permissionLabel(agent: AgentKind, mode: PermissionMode | undefined): string {
  const value = mode ?? 'default';
  return PERMISSIONS[agent]?.find((p) => p.value === value)?.label ?? value;
}

function effortLabel(agent: AgentKind, effort: EffortLevel | undefined): string {
  const value = effort ?? (agent === 'codex' ? 'xhigh' : 'max');
  const levels = agent === 'kimi' || agent === 'cursor' ? [] : agent === 'codex' ? EFFORTS_CODEX : EFFORTS_CLAUDE;
  return levels.find((e) => e.value === value)?.label ?? value;
}

function draftSummary(d: NewDraft): string {
  const agent = (d.agent ?? 'claude') as AgentKind;
  const lines = [
    '<b>New session</b>',
    '',
    `<b>Machine</b>: ${escHtml(machineLabel(d.host))}`,
    `<b>Agent</b>: ${escHtml(agent)}`,
    `<b>Model</b>: <code>${escHtml(d.model ?? '')}</code>`,
    `<b>Permission</b>: ${escHtml(permissionLabel(agent, d.permissionMode as PermissionMode | undefined))}`,
  ];
  if (agent !== 'cursor' && agent !== 'kimi') {
    lines.push(`<b>Effort</b>: ${escHtml(effortLabel(agent, d.effort as EffortLevel | undefined))}`);
  }
  lines.push(`<b>Directory</b>: ${d.autoCwd ? '<i>auto (throwaway)</i>' : d.cwd ? `<code>${escHtml(d.cwd)}</code>` : '<i>not set</i>'}`);
  lines.push(`<b>Title</b>: ${d.title ? escHtml(d.title) : '<i>auto</i>'}`);
  lines.push('', 'Tap a field to change it, then <b>Create</b>.');
  return lines.join('\n');
}

function formKeyboard(d: NewDraft): InlineKeyboard {
  const agent = (d.agent ?? 'claude') as AgentKind;
  const kb = new InlineKeyboard()
    .text('Machine', 'ns:pick:host')
    .text('Agent', 'ns:pick:agent')
    .text('Model', 'ns:pick:model')
    .row()
    .text('Permission', 'ns:pick:perm')
    .text(agent === 'cursor' || agent === 'kimi' ? 'Effort (n/a)' : 'Effort', 'ns:pick:effort')
    .row()
    .text(d.autoCwd ? 'Directory: auto' : d.cwd ? 'Change directory' : 'Set directory…', 'ns:pick:cwd')
    .text(d.title ? 'Change title' : 'Set title…', 'ns:pick:title')
    .row()
    .text('✅ Create', 'ns:create')
    .text('Cancel', 'ns:cancel');
  return kb;
}

function hostKeyboard(d: NewDraft): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(mark(d.host ?? '', '', `${config.localName} (local)`), 'ns:set:host:').row();
  for (const h of hostRegistry.list()) {
    kb.text(mark(d.host ?? '', h.name, h.name), `ns:set:host:${h.name}`).row();
  }
  kb.text('← Back', 'ns:back');
  return kb;
}

function agentKeyboard(d: NewDraft): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const a of ['claude', 'cursor', 'codex', 'kimi', 'kiro'] as AgentKind[]) {
    kb.text(mark(d.agent, a, a[0]!.toUpperCase() + a.slice(1)), `ns:set:agent:${a}`);
  }
  kb.row().text('← Back', 'ns:back');
  return kb;
}

async function permKeyboard(d: NewDraft): Promise<InlineKeyboard> {
  const agent = (d.agent ?? 'claude') as AgentKind;
  const permissions =
    agent === 'kimi'
      ? (d.host ? await discoverRemoteKimiCapabilities(d.host) : await discoverKimiCapabilities()).permissions
      : PERMISSIONS[agent];
  const kb = new InlineKeyboard();
  for (const p of permissions) {
    kb.text(mark(d.permissionMode, p.value, p.label), `ns:set:perm:${p.value}`).row();
  }
  kb.text('← Back', 'ns:back');
  return kb;
}

function effortKeyboard(d: NewDraft): InlineKeyboard {
  const agent = (d.agent ?? 'claude') as AgentKind;
  const levels = agent === 'kimi' || agent === 'cursor' ? [] : agent === 'codex' ? EFFORTS_CODEX : EFFORTS_CLAUDE;
  const kb = new InlineKeyboard();
  for (const e of levels) {
    kb.text(mark(d.effort, e.value, e.label), `ns:set:effort:${e.value}`);
  }
  kb.row().text('← Back', 'ns:back');
  return kb;
}

async function modelOptions(d: NewDraft): Promise<{ value: string; label: string }[]> {
  const agent = (d.agent ?? 'claude') as AgentKind;
  const host = d.host || undefined;
  if (agent === 'claude') return CLAUDE_MODELS;
  if (agent === 'cursor') {
    return host ? await listRemoteCursorModels(host) : await listCursorModels();
  }
  if (agent === 'kimi') {
    return (host ? await discoverRemoteKimiCapabilities(host) : await discoverKimiCapabilities()).models;
  }
  if (agent === 'kiro') {
    return host ? await listRemoteKiroModels(host) : await listKiroModels();
  }
  return host ? await listRemoteCodexModels(host) : listCodexModels();
}

async function modelKeyboard(chatId: number, d: NewDraft, page = 0): Promise<InlineKeyboard> {
  const models = await modelOptions(d);
  const cache = cacheFor(chatId);
  cache.models = models.map((m) => m.value);
  const totalPages = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const start = p * MODEL_PAGE_SIZE;
  const slice = models.slice(start, start + MODEL_PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i]!;
    const abs = start + i;
    kb.text(mark(d.model, m.value, clip(m.label, 28)), `ns:mi:${abs}`);
    if (i % 2 === 1) kb.row();
  }
  if (slice.length % 2 === 1) kb.row();
  if (totalPages > 1) {
    if (p > 0) kb.text('◀ Prev', `ns:mp:${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'ns:mp:noop');
    if (p + 1 < totalPages) kb.text('Next ▶', `ns:mp:${p + 1}`);
    kb.row();
  }
  kb.text('Custom…', 'ns:pick:model_custom').row();
  kb.text('← Back', 'ns:back');
  return kb;
}

async function modelPageForDraft(d: NewDraft): Promise<number> {
  if (!d.model) return 0;
  const models = await modelOptions(d);
  const idx = models.findIndex((m) => m.value === d.model);
  return idx >= 0 ? Math.floor(idx / MODEL_PAGE_SIZE) : 0;
}

function cwdSuggestions(d: NewDraft): { path: string; name: string }[] {
  if (d.host) {
    const seen = new Map<string, { path: string; name: string }>();
    for (const s of sessionStore.list()) {
      if (s.host === d.host && !s.ephemeral && !seen.has(s.cwd)) seen.set(s.cwd, { path: s.cwd, name: basename(s.cwd) });
    }
    return [...seen.values()].slice(0, 8);
  }
  return getRecentProjects(8).map((p) => ({ path: p.path, name: p.name }));
}

function cwdKeyboard(chatId: number, d: NewDraft): InlineKeyboard {
  const suggestions = cwdSuggestions(d);
  const cache = cacheFor(chatId);
  cache.cwds = suggestions.map((p) => p.path);
  const kb = new InlineKeyboard();
  for (let i = 0; i < suggestions.length; i++) {
    const p = suggestions[i]!;
    kb.text(clip(p.name, 40), `ns:ci:${i}`).row();
  }
  kb.text(d.autoCwd ? '✓ Auto-create folder' : 'Auto-create folder', 'ns:auto').row();
  kb.text('Type a path…', 'ns:ask:cwd').row();
  kb.text('← Back', 'ns:back');
  return kb;
}

export async function createSessionFromDraft(d: NewDraft): Promise<SessionMeta> {
  const host = d.host || undefined;
  const wantAuto = !!d.autoCwd && !d.cwd?.trim();
  let cwd = d.cwd?.trim() ?? '';
  if (!wantAuto && !cwd) throw new Error('directory is required');
  if (host && !hostRegistry.get(host)) throw new Error(`unknown host: ${host}`);
  if (wantAuto) {
    // Throwaway folder: mkdir locally or over SSH, then store the absolute path.
    cwd = host ? await createRemoteWorkdir(hostRegistry.get(host)!.ssh) : createLocalWorkdir();
  } else if (!host) {
    const check = validateDir(cwd);
    if (!check.ok) throw new Error(check.error || 'invalid cwd');
    cwd = check.path;
  }
  const agent: AgentKind = (d.agent as AgentKind) || 'claude';
  const session = sessionStore.create({
    cwd,
    model:
      d.model ||
      (agent === 'cursor'
        ? config.defaultCursorModel
        : agent === 'codex'
          ? config.defaultCodexModel
          : agent === 'kimi'
            ? config.defaultKimiModel
            : agent === 'kiro'
              ? config.defaultKiroModel
              : config.defaultModel),
    permissionMode: (d.permissionMode as PermissionMode) || 'default',
    effort: (d.effort as EffortLevel) || (config.defaultEffort as EffortLevel),
    agent,
    title: d.title?.trim() || basename(cwd),
    host,
    ephemeral: wantAuto || undefined,
  });
  const meta = toMeta(session, false, 'vibe');
  hub.broadcastMeta(session.id);
  return meta;
}

function getDraft(chatId: number): NewDraft | undefined {
  return telegramState.get(chatId).draft;
}

function saveDraft(chatId: number, d: NewDraft | undefined): void {
  telegramState.setDraft(chatId, d);
}

async function showForm(ctx: BotContext, chatId: number, d: NewDraft, edit: boolean): Promise<void> {
  d.step = 'form';
  saveDraft(chatId, d);
  const text = draftSummary(d);
  const markup = formKeyboard(d);
  if (edit && ctx.callbackQuery?.message) {
    try {
      await editHtml(ctx, text, { reply_markup: markup });
      return;
    } catch {
      /* fall through to send */
    }
  }
  const msg = await replyHtml(ctx, text, { reply_markup: markup });
  d.messageId = msg.message_id;
  saveDraft(chatId, d);
}

async function showPicker(
  ctx: BotContext,
  title: string,
  markup: InlineKeyboard,
): Promise<void> {
  try {
    await editHtml(ctx, title, { reply_markup: markup });
  } catch {
    await replyHtml(ctx, title, { reply_markup: markup });
  }
}

/** Start the interactive New Session form (same options as the web dialog). */
export async function startNewSessionWizard(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat!.id;
  const d = defaultDraft(chatId);
  await showForm(ctx, chatId, d, false);
}

/** Handle `ns:*` callback queries for the wizard. Returns true if handled. */
export async function handleNewSessionCallback(ctx: BotContext): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data?.startsWith('ns:') || chatId == null) return false;

  let d = getDraft(chatId);
  if (!d && data !== 'ns:cancel') {
    d = defaultDraft(chatId);
    saveDraft(chatId, d);
  }

  await ctx.answerCallbackQuery().catch(() => undefined);

  if (data === 'ns:cancel') {
    saveDraft(chatId, undefined);
    try {
      await editPlain(ctx, 'Cancelled.');
    } catch {
      await replyPlain(ctx, 'Cancelled.');
    }
    return true;
  }

  if (data === 'ns:back' || data === 'ns:form') {
    await showForm(ctx, chatId, d!, true);
    return true;
  }

  if (data === 'ns:create') {
    try {
      const meta = await createSessionFromDraft(d!);
      rememberNewPrefs(chatId, d!);
      telegramState.setSession(chatId, meta.id);
      saveDraft(chatId, undefined);
      const text = `Created & activated:\n${formatSessionCard(meta)}\n\nSend a message to start.`;
      try {
        await editHtml(ctx, text);
      } catch {
        await replyHtml(ctx, text);
      }
    } catch (err) {
      await replyPlain(ctx, `Failed: ${err instanceof Error ? err.message : String(err)}`);
      await showForm(ctx, chatId, d!, false);
    }
    return true;
  }

  if (data === 'ns:pick:host') {
    d!.step = 'form';
    saveDraft(chatId, d!);
    await showPicker(ctx, '<b>Choose machine</b>', hostKeyboard(d!));
    return true;
  }
  if (data === 'ns:pick:agent') {
    await showPicker(ctx, '<b>Choose agent</b>', agentKeyboard(d!));
    return true;
  }
  if (data === 'ns:pick:model') {
    await showPicker(ctx, '<b>Choose model</b>\n(loading…)', new InlineKeyboard().text('…', 'ns:back'));
    const page = await modelPageForDraft(d!);
    await showPicker(ctx, '<b>Choose model</b>', await modelKeyboard(chatId, d!, page));
    return true;
  }
  if (data.startsWith('ns:mp:')) {
    const raw = data.slice('ns:mp:'.length);
    if (raw === 'noop') return true;
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 0) return true;
    await showPicker(ctx, '<b>Choose model</b>', await modelKeyboard(chatId, d!, page));
    return true;
  }
  if (data === 'ns:pick:perm') {
    await showPicker(ctx, '<b>Permission mode</b>', await permKeyboard(d!));
    return true;
  }
  if (data === 'ns:pick:effort') {
    const agent = d!.agent ?? 'claude';
    if (agent === 'cursor' || agent === 'kimi') {
      await replyPlain(
        ctx,
        agent === 'cursor'
          ? 'Cursor embeds effort in the model id — pick a model instead.'
          : 'Kimi prompt mode does not expose a separate effort setting.',
      );
      await showForm(ctx, chatId, d!, true);
      return true;
    }
    await showPicker(ctx, '<b>Effort</b>', effortKeyboard(d!));
    return true;
  }
  if (data === 'ns:pick:cwd') {
    await showPicker(
      ctx,
      '<b>Working directory</b>\nPick a recent path, or type one.',
      cwdKeyboard(chatId, d!),
    );
    return true;
  }
  if (data === 'ns:auto') {
    // Toggle throwaway-folder mode. Auto and an explicit path are mutually exclusive.
    d!.autoCwd = !d!.autoCwd;
    if (d!.autoCwd) d!.cwd = undefined;
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data === 'ns:pick:title') {
    d!.step = 'title';
    saveDraft(chatId, d!);
    await showPicker(
      ctx,
      '<b>Title</b>\nSend a title as your next message, or skip.',
      new InlineKeyboard().text('Skip (auto)', 'ns:set:title:').text('← Back', 'ns:back'),
    );
    return true;
  }
  if (data === 'ns:pick:model_custom') {
    d!.step = 'model_custom';
    saveDraft(chatId, d!);
    await replyHtml(ctx, 'Send a custom model id (e.g. <code>opus</code> or <code>grok-4.5-fast-xhigh</code>).');
    return true;
  }
  if (data === 'ns:ask:cwd') {
    d!.step = 'cwd';
    saveDraft(chatId, d!);
    await replyHtml(
      ctx,
      'Send the working directory path (e.g. <code>/root/vibe</code> or <code>~/code/app</code>).',
    );
    return true;
  }

  // ns:set:host:<name>  (empty name = local)
  if (data.startsWith('ns:set:host:')) {
    const host = data.slice('ns:set:host:'.length);
    d!.host = host;
    d!.cwd = undefined; // reset cwd when machine changes (same as web UI)
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data.startsWith('ns:set:agent:')) {
    const agent = data.slice('ns:set:agent:'.length) as AgentKind;
    d!.agent = agent;
    d!.model =
      agent === 'cursor'
        ? config.defaultCursorModel
        : agent === 'codex'
          ? config.defaultCodexModel
          : agent === 'kimi'
            ? config.defaultKimiModel
            : agent === 'kiro'
              ? config.defaultKiroModel
              : config.defaultModel;
    d!.permissionMode = agent === 'claude' ? 'bypassPermissions' : 'default';
    d!.effort = agent === 'codex' ? 'xhigh' : 'max';
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data.startsWith('ns:mi:')) {
    const idx = Number(data.slice('ns:mi:'.length));
    const value = cacheFor(chatId).models[idx];
    if (value) d!.model = value;
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data.startsWith('ns:set:perm:')) {
    d!.permissionMode = data.slice('ns:set:perm:'.length) as PermissionMode;
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data.startsWith('ns:set:effort:')) {
    d!.effort = data.slice('ns:set:effort:'.length) as EffortLevel;
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data.startsWith('ns:ci:')) {
    const idx = Number(data.slice('ns:ci:'.length));
    const path = cacheFor(chatId).cwds[idx];
    if (path) {
      d!.cwd = path;
      d!.autoCwd = false;
      if (!d!.title) d!.title = basename(path);
    }
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }
  if (data.startsWith('ns:set:title:')) {
    const title = data.slice('ns:set:title:'.length);
    d!.title = title || undefined;
    d!.step = 'form';
    saveDraft(chatId, d!);
    await showForm(ctx, chatId, d!, true);
    return true;
  }

  return true;
}

/**
 * Handle free-text while the wizard expects a path / title / custom model.
 * Returns true if the message was consumed by the wizard.
 */
export async function handleNewSessionText(ctx: BotContext, text: string): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const d = getDraft(chatId);
  if (!d) return false;

  if (d.step === 'cwd') {
    try {
      if (d.host) {
        d.cwd = text.trim();
      } else {
        const check = validateDir(text);
        if (!check.ok) throw new Error(check.error || 'invalid path');
        d.cwd = check.path;
      }
      d.autoCwd = false;
      if (!d.title) d.title = basename(d.cwd);
      d.step = 'form';
      saveDraft(chatId, d);
      await replyHtml(ctx, `Directory set to <code>${escHtml(d.cwd)}</code>`);
      await showForm(ctx, chatId, d, false);
    } catch (err) {
      await replyPlain(
        ctx,
        `Invalid path: ${err instanceof Error ? err.message : String(err)}\nTry again, or /cancel.`,
      );
    }
    return true;
  }

  if (d.step === 'title') {
    d.title = text.trim() || undefined;
    d.step = 'form';
    saveDraft(chatId, d);
    await showForm(ctx, chatId, d, false);
    return true;
  }

  if (d.step === 'model_custom') {
    d.model = text.trim();
    d.step = 'form';
    saveDraft(chatId, d);
    await showForm(ctx, chatId, d, false);
    return true;
  }

  // Legacy: old drafts with no step / only waiting for cwd
  if (d.step === undefined && d.cwd === undefined) {
    d.step = 'cwd';
    saveDraft(chatId, d);
    return handleNewSessionText(ctx, text);
  }

  return false;
}

/** Quick create from `/new /path key=value…` (no interactive form). */
export async function createSessionFromArgs(input: {
  cwd?: string;
  autoCwd?: boolean;
  host?: string;
  agent?: AgentKind;
  model?: string;
  title?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
}): Promise<SessionMeta> {
  return createSessionFromDraft({
    cwd: input.cwd,
    autoCwd: input.autoCwd,
    host: input.host ?? '',
    agent: input.agent,
    model: input.model,
    title: input.title,
    permissionMode: input.permissionMode,
    effort: input.effort,
  });
}
