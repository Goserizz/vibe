import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { sshConnectPrefix, loginShellCommand, proxyEnvPrefix, cleanRemoteStderr, streamRemoteCommand } from '../remote/ssh.js';
import type { PermissionDecision, PermissionMode, PermissionRequest } from '../../../shared/protocol.js';
import type { RunCallbacks } from '../claude/types.js';
import { loadAcpToolArgsIndex, lookupAcpToolArgs } from './acpStore.js';

type JsonRpcId = number | string;

interface PendingRpc {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

interface CursorAskQuestion {
  toolCallId?: string;
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}

interface CursorCreatePlan {
  toolCallId?: string;
  name?: string;
  overview?: string;
  plan: string;
  todos?: unknown[];
  allowedPrompts?: { tool: string; prompt: string }[];
}

export interface AcpRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** ACP session id to resume/load; omit for a fresh session. */
  resume?: string;
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

function buildAcpSpawn(opts: AcpRunOptions): { bin?: string; args: string[]; remote: boolean; cwd?: string } {
  if (opts.remote) {
    const inner = `cursor-agent acp`;
    const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(streamRemoteCommand(inner));
    const { bin, opts: sshOpts } = sshConnectPrefix();
    return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
  }
  return { bin: config.cursorExecutable, args: ['acp'], remote: false, cwd: opts.cwd };
}

function textOfContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null) {
    const c = content as { text?: unknown; type?: string };
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

function toolResultFromUpdate(update: any): { content: string; isError: boolean } {
  const raw = update?.rawOutput ?? update?.content;
  if (raw == null) return { content: '', isError: update?.status === 'failed' };
  if (typeof raw === 'string') return { content: raw, isError: update?.status === 'failed' };
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (item?.type === 'content') parts.push(textOfContent(item.content));
      else if (item?.type === 'diff') parts.push(`diff ${item.path ?? ''}`);
      else if (typeof item === 'string') parts.push(item);
      else parts.push(JSON.stringify(item));
    }
    return { content: parts.filter(Boolean).join('\n') || '', isError: update?.status === 'failed' };
  }
  return { content: JSON.stringify(raw, null, 2), isError: update?.status === 'failed' };
}

/** Map ACP ToolKind → names that web/Telegram `toolKind` already understand. */
const ACP_KIND_NAME: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Shell',
  fetch: 'Fetch',
  think: 'Think',
  switch_mode: 'SwitchMode',
};

/**
 * Prefer Cursor's tool title when it looks like a real tool name (Read, Grep,
 * StrReplace, Shell…). Fall back to ACP kind. Returns null on partial updates
 * with neither field so callers keep the previous name.
 */
function toolNameFromUpdate(update: any): string | null {
  const title = typeof update?.title === 'string' ? update.title.trim() : '';
  // Exact tool identifiers from Cursor (matches store.db toolName).
  if (title && /^[A-Za-z][A-Za-z0-9_]*$/.test(title)) return title;

  const kind = typeof update?.kind === 'string' ? update.kind : '';
  if (kind && ACP_KIND_NAME[kind]) return ACP_KIND_NAME[kind]!;
  if (kind && kind !== 'other') return kind;

  // Title like "Reading foo.ts" / "Editing bar" — first word only for kinding.
  if (title) {
    const head = title.split(/[\s:`"']+/)[0] ?? '';
    if (head && /^[A-Za-z][A-Za-z0-9_]*$/.test(head)) return head;
  }
  return null;
}

/**
 * Cursor ACP often ships `rawInput: {}` on the first tool_call; path/args usually
 * arrive via `locations`, nested args, or a later update. Merge without inventing
 * display names — web + Telegram format from the resulting name/input.
 */
function enrichToolInput(update: any): Record<string, unknown> | null {
  const raw = update?.rawInput ?? update?.raw_input;
  let base: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    base = { ...(raw as Record<string, unknown>) };
    for (const nest of ['args', 'arguments', 'input', 'params']) {
      const inner = base[nest];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        base = { ...base, ...(inner as Record<string, unknown>) };
      }
    }
  } else if (typeof raw === 'string' && raw.length > 0) {
    base = { value: raw };
  }

  const hasLocations = Array.isArray(update?.locations) && update.locations.length > 0;
  const hasDiffPath =
    Array.isArray(update?.content) &&
    update.content.some((item: any) => item?.type === 'diff' && typeof item.path === 'string' && item.path);
  const hasBase = Object.keys(base).length > 0;

  if (!hasBase && !hasLocations && !hasDiffPath) return null;

  const input: Record<string, unknown> = { ...base };

  const pathKeys = ['file_path', 'path', 'relativePath', 'filePath', 'target_file'];
  const hasPath = pathKeys.some((k) => input[k] != null && String(input[k]) !== '');

  if (!hasPath && hasLocations) {
    const paths = (update.locations as any[])
      .map((l) => (typeof l?.path === 'string' ? l.path : ''))
      .filter(Boolean);
    if (paths.length === 1) input.path = paths[0];
    else if (paths.length > 1) {
      input.path = paths[0];
      input.paths = paths;
    }
  }

  if (!input.path && Array.isArray(update?.content)) {
    for (const item of update.content) {
      if (item?.type === 'diff' && typeof item.path === 'string' && item.path) {
        input.path = item.path;
        break;
      }
    }
  }

  return input;
}

function mapAskToUiQuestions(params: CursorAskQuestion) {
  return (params.questions ?? []).map((q) => ({
    id: q.id,
    question: q.prompt,
    options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label })),
    multiSelect: !!q.allowMultiple,
  }));
}

function askDecisionToAcp(params: CursorAskQuestion, decision: PermissionDecision): unknown {
  if (!decision.allow) return { outcome: { outcome: 'cancelled' } };
  const ui = decision.updatedInput as { answers?: Record<string, string | string[]> } | undefined;
  const answersRec = ui?.answers ?? {};
  const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
  for (const q of params.questions ?? []) {
    const raw = answersRec[q.prompt];
    if (raw == null) continue;
    const labels = Array.isArray(raw) ? raw : [raw];
    const selectedOptionIds = labels
      .map((label) => q.options.find((o) => o.label === label)?.id)
      .filter((id): id is string => !!id);
    answers.push({ questionId: q.id, selectedOptionIds });
  }
  return { outcome: { outcome: 'answered', answers } };
}

/**
 * One Cursor ACP process for a single turn (initialize → prompt → exit).
 * Maps streaming updates to LiveEvents and interactive methods to requestPermission.
 */
export class CursorAcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRpc>();
  private buffer = '';
  private stderr = '';
  private aborted = false;
  private ignoreUpdates = false;
  private sessionId: string | null = null;
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private closed = false;
  /** Remember name/input across partial tool_call_update frames. */
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** toolCallId → args from ~/.cursor/acp-sessions/<id>/store.db (refreshed on miss). */
  private storeArgs: Map<string, { name?: string; args: Record<string, unknown> }> | null = null;
  /** Poll store.db while a tool is running with empty rawInput. */
  private argsPollers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly opts: AcpRunOptions,
    private readonly cb: RunCallbacks,
  ) {}

  private inputIsWeak(input: Record<string, unknown>): boolean {
    const keys = [
      'path',
      'file_path',
      'relativePath',
      'filePath',
      'target_file',
      'pattern',
      'regex',
      'query',
      'command',
      'cmd',
      'glob',
      'globPattern',
      'url',
    ];
    return !keys.some((k) => input[k] != null && String(input[k]) !== '');
  }

  private mergeStoreArgs(
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
    forceRefresh = false,
  ): { name: string; input: Record<string, unknown> } {
    if (!this.sessionId || !this.inputIsWeak(input)) return { name, input };
    if (forceRefresh || !this.storeArgs) {
      this.storeArgs = loadAcpToolArgsIndex(this.sessionId);
    }
    let hit = lookupAcpToolArgs(this.storeArgs, toolCallId);
    if (!hit && !forceRefresh) {
      this.storeArgs = loadAcpToolArgsIndex(this.sessionId);
      hit = lookupAcpToolArgs(this.storeArgs, toolCallId);
    }
    if (!hit) return { name, input };
    return {
      name: hit.name || name,
      input: { ...hit.args, ...input },
    };
  }

  private stopArgsPoll(toolCallId: string): void {
    const t = this.argsPollers.get(toolCallId);
    if (!t) return;
    clearInterval(t);
    this.argsPollers.delete(toolCallId);
  }

  private stopAllArgsPolls(): void {
    for (const id of [...this.argsPollers.keys()]) this.stopArgsPoll(id);
  }

  /**
   * ACP often emits tool_call with empty rawInput; args land in store.db shortly
   * after. Poll so Web/Telegram can show path/pattern while the tool is still
   * running — same early visibility as the old headless stream.
   */
  private startArgsPoll(toolCallId: string): void {
    if (this.argsPollers.has(toolCallId)) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (this.aborted || this.closed) {
        this.stopArgsPoll(toolCallId);
        return;
      }
      tries += 1;
      const prev = this.tools.get(toolCallId);
      if (!prev) {
        this.stopArgsPoll(toolCallId);
        return;
      }
      if (!this.inputIsWeak(prev.input)) {
        this.stopArgsPoll(toolCallId);
        return;
      }
      const merged = this.mergeStoreArgs(toolCallId, prev.name, prev.input, true);
      if (this.inputIsWeak(merged.input)) {
        if (tries >= 40) this.stopArgsPoll(toolCallId); // ~10s @ 250ms
        return;
      }
      this.tools.set(toolCallId, merged);
      this.cb.onEvent({
        k: 'block',
        block: {
          id: toolCallId,
          kind: 'tool',
          toolUseId: toolCallId,
          name: merged.name,
          input: merged.input,
          status: 'running',
          ts: Date.now(),
        },
      });
      this.stopArgsPoll(toolCallId);
    }, 250);
    this.argsPollers.set(toolCallId, timer);
  }

  abort(): void {
    this.aborted = true;
    this.stopAllArgsPolls();
    if (this.sessionId && this.child?.stdin?.writable) {
      try {
        this.notify('session/cancel', { sessionId: this.sessionId });
      } catch {
        /* ignore */
      }
    }
    this.child?.kill('SIGTERM');
    this.rejectAll(new Error('aborted'));
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async run(): Promise<{ error?: string }> {
    const spawnSpec = buildAcpSpawn(this.opts);
    if (!spawnSpec.bin) {
      return { error: 'cursor-agent not found — install the Cursor CLI or set CURSOR_CLI_PATH' };
    }

    this.child = spawn(spawnSpec.bin, spawnSpec.args, {
      cwd: spawnSpec.remote ? undefined : spawnSpec.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (d) => this.onStdout(d.toString()));
    this.child.stderr?.on('data', (d) => {
      this.stderr += d.toString();
    });

    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      this.child!.on('error', (e) => {
        this.rejectAll(e instanceof Error ? e : new Error(String(e)));
        resolve({ code: -1 });
      });
      this.child!.on('close', (code) => {
        this.closed = true;
        this.stopAllArgsPolls();
        this.rejectAll(new Error(cleanRemoteStderr(this.stderr) || `cursor-agent acp exited with code ${code}`));
        resolve({ code });
      });
    });

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'vibe', version: '1.0.0' },
      });
      await this.request('authenticate', { methodId: 'cursor_login' });

      const cwd = this.opts.remote ? this.opts.remote.cwd : this.opts.cwd;
      this.sessionId = await this.openSession(cwd);
      if (this.sessionId) this.cb.onClaudeSessionId(this.sessionId);

      await this.applySessionConfig();

      await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: this.opts.prompt }],
      });

      this.flushStream();
      return {};
    } catch (err) {
      if (this.aborted) return {};
      const msg = err instanceof Error ? err.message : String(err);
      const detail = cleanRemoteStderr(this.stderr);
      return { error: detail ? `${msg}\n${detail}` : msg };
    } finally {
      this.flushStream();
      try {
        this.child?.stdin?.end();
      } catch {
        /* ignore */
      }
      // Let the process exit; don't wait forever.
      const killer = setTimeout(() => this.child?.kill('SIGKILL'), 2000);
      await exitPromise.catch(() => undefined);
      clearTimeout(killer);
    }
  }

  private async openSession(cwd: string): Promise<string> {
    const mcpServers: unknown[] = [];
    if (this.opts.resume) {
      // Prefer resume (no history replay) so we don't dump old turns into the UI.
      try {
        this.ignoreUpdates = true;
        await this.request('session/resume', { sessionId: this.opts.resume, cwd, mcpServers });
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (err) {
        log.debug('cursor acp session/resume failed, trying load', err);
      }
      try {
        this.ignoreUpdates = true;
        await this.request('session/load', { sessionId: this.opts.resume, cwd, mcpServers });
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (err) {
        this.ignoreUpdates = false;
        log.warn('cursor acp resume/load failed, starting new session', err);
      }
    }
    const created = await this.request('session/new', { cwd, mcpServers });
    const id = typeof created?.sessionId === 'string' ? created.sessionId : null;
    if (!id) throw new Error('session/new did not return sessionId');
    return id;
  }

  private async applySessionConfig(): Promise<void> {
    if (!this.sessionId) return;
    const mode = this.opts.permissionMode === 'plan' ? 'plan' : 'agent';
    // Best-effort: Cursor ACP advertises modes/config options; ignore if unsupported.
    for (const attempt of [
      () => this.request('session/set_mode', { sessionId: this.sessionId, modeId: mode }),
      () => this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'mode', value: mode }),
    ]) {
      try {
        await attempt();
        break;
      } catch {
        /* try next */
      }
    }
    if (this.opts.model) {
      for (const attempt of [
        () => this.request('session/set_model', { sessionId: this.sessionId, modelId: this.opts.model }),
        () => this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: this.opts.model }),
      ]) {
        try {
          await attempt();
          break;
        } catch {
          /* try next */
        }
      }
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: any): Promise<void> {
    if (msg == null || typeof msg !== 'object') return;

    // Response to our request
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = msg.error;
        waiter.reject(new Error(typeof e === 'string' ? e : e.message ?? JSON.stringify(e)));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method !== 'string') return;

    if (msg.method === 'session/update') {
      if (!this.ignoreUpdates) this.handleUpdate(msg.params?.update);
      return;
    }

    // Server-initiated requests that need a response
    if (msg.id == null) return;

    try {
      if (msg.method === 'session/request_permission') {
        const result = await this.handleRequestPermission(msg.params);
        this.respond(msg.id, result);
        return;
      }
      if (msg.method === 'cursor/ask_question') {
        const result = await this.handleAskQuestion(msg.params as CursorAskQuestion);
        this.respond(msg.id, result);
        return;
      }
      if (msg.method === 'cursor/create_plan') {
        const result = await this.handleCreatePlan(msg.params as CursorCreatePlan);
        this.respond(msg.id, result);
        return;
      }
      // Notifications that some agents still send with ids — acknowledge empty.
      if (
        msg.method === 'cursor/update_todos' ||
        msg.method === 'cursor/task' ||
        msg.method === 'cursor/generate_image'
      ) {
        this.respond(msg.id, { outcome: { outcome: 'accepted' } });
        return;
      }
      this.respond(msg.id, {});
    } catch (err) {
      log.warn('cursor acp handler failed', msg.method, err);
      this.respond(msg.id, { outcome: { outcome: 'cancelled' } });
    }
  }

  private handleUpdate(update: any): void {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk') {
      const text = textOfContent(update.content);
      if (text) this.segment('assistant', text, true);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = textOfContent(update.content);
      if (text) this.segment('thinking', text, true);
      return;
    }
    if (kind === 'tool_call') {
      this.flushStream();
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      let name = toolNameFromUpdate(update) ?? 'tool';
      let input = enrichToolInput(update) ?? {};
      // Try store immediately — args are often already written when the call starts.
      ({ name, input } = this.mergeStoreArgs(id, name, input, true));
      this.tools.set(id, { name, input });
      const status = update.status === 'failed' ? 'error' : update.status === 'completed' ? 'done' : 'running';
      this.cb.onEvent({
        k: 'block',
        block: {
          id,
          kind: 'tool',
          toolUseId: id,
          name,
          input,
          status,
          ts: Date.now(),
        },
      });
      if (status === 'running' && this.inputIsWeak(input)) this.startArgsPoll(id);
      else if (status !== 'running') this.stopArgsPoll(id);
      return;
    }
    if (kind === 'tool_call_update') {
      this.flushStream();
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const { content, isError } = toolResultFromUpdate(update);
      const status =
        update.status === 'failed' || isError
          ? 'error'
          : update.status === 'completed'
            ? 'done'
            : update.status === 'in_progress'
              ? 'running'
              : 'running';
      const prev = this.tools.get(id);
      let name = toolNameFromUpdate(update) ?? prev?.name ?? 'tool';
      const enriched = enrichToolInput(update);
      let input = enriched ? { ...(prev?.input ?? {}), ...enriched } : (prev?.input ?? {});
      ({ name, input } = this.mergeStoreArgs(id, name, input, true));
      this.tools.set(id, { name, input });
      this.cb.onEvent({
        k: 'block',
        block: {
          id,
          kind: 'tool',
          toolUseId: id,
          name,
          input,
          status,
          result: content || undefined,
          isError: status === 'error',
          ts: Date.now(),
        },
      });
      if (status === 'running' && this.inputIsWeak(input)) this.startArgsPoll(id);
      else this.stopArgsPoll(id);
      if (status === 'done' || status === 'error') {
        this.cb.onEvent({
          k: 'tool_result',
          toolUseId: id,
          content: content || (status === 'error' ? 'failed' : ''),
          isError: status === 'error',
        });
      }
      return;
    }
  }

  private async handleRequestPermission(params: any): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };

    // Cursor's "Agent" mode is stored as permissionMode `default` and is labeled
    // "Run tools automatically" in the UI. The old headless path used `--force`;
    // mirror that here. Only Plan should surface interactive prompts (plus
    // ask-user / create-plan which use other handlers).
    // `bypassPermissions` / `acceptEdits` also auto-allow when selected.
    if (this.opts.permissionMode !== 'plan') {
      const opts = Array.isArray(params?.options) ? params.options : [];
      const always = opts.find((o: any) => o?.optionId === 'allow-always' || o?.kind === 'allow_always');
      const once = opts.find((o: any) => o?.optionId === 'allow-once' || o?.kind === 'allow_once');
      const pick = always ?? once;
      if (pick?.optionId) return { outcome: { outcome: 'selected', optionId: pick.optionId } };
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
    }

    const toolCall = params?.toolCall ?? {};
    const toolName = String(toolCall.title || toolCall.kind || toolCall.toolCallId || 'tool');
    const input = toolCall.rawInput ?? toolCall;
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName,
      input,
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    if (!decision.allow) {
      const opts = Array.isArray(params?.options) ? params.options : [];
      const reject = opts.find((o: any) => o?.optionId === 'reject-once' || o?.kind === 'reject_once');
      return {
        outcome: {
          outcome: 'selected',
          optionId: reject?.optionId ?? 'reject-once',
        },
      };
    }
    const opts = Array.isArray(params?.options) ? params.options : [];
    if (decision.remember) {
      const always = opts.find((o: any) => o?.optionId === 'allow-always' || o?.kind === 'allow_always');
      if (always?.optionId) return { outcome: { outcome: 'selected', optionId: always.optionId } };
    }
    const once = opts.find((o: any) => o?.optionId === 'allow-once' || o?.kind === 'allow_once');
    return { outcome: { outcome: 'selected', optionId: once?.optionId ?? 'allow-once' } };
  }

  private async handleAskQuestion(params: CursorAskQuestion): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };
    const questions = mapAskToUiQuestions(params);
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName: 'AskUserQuestion',
      input: {
        source: 'cursor',
        title: params.title,
        questions,
      },
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    return askDecisionToAcp(params, decision);
  }

  private async handleCreatePlan(params: CursorCreatePlan): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };
    const plan = typeof params.plan === 'string' ? params.plan : '';
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName: 'ExitPlanMode',
      input: {
        source: 'cursor',
        name: params.name,
        overview: params.overview,
        allowedPrompts: params.allowedPrompts,
        todos: params.todos,
      },
      plan: plan || (params.overview ? String(params.overview) : undefined),
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    if (!decision.allow) return { outcome: { outcome: 'rejected' } };
    return { outcome: { outcome: 'accepted' } };
  }

  private segment(kind: 'assistant' | 'thinking', text: string, partial: boolean): void {
    if (!text) return;
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (partial) {
      if (!this.stream) {
        const id = `acp_${crypto.randomUUID()}`;
        this.stream = { id, kind, text };
        this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: true, ts: Date.now() } });
      } else {
        this.stream.text += text;
        this.cb.onEvent({ k: 'delta', id: this.stream.id, field: 'text', chunk: text });
      }
    } else if (this.stream) {
      this.cb.onEvent({ k: 'block_end', id: this.stream.id, text });
      this.stream = null;
    } else {
      const id = `acp_${crypto.randomUUID()}`;
      this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: false, ts: Date.now() } });
    }
  }

  private flushStream(): void {
    if (this.stream) {
      this.cb.onEvent({ k: 'block_end', id: this.stream.id, text: this.stream.text });
      this.stream = null;
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('acp process closed'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(payload + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private respond(id: JsonRpcId, result: unknown): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private rejectAll(err: Error): void {
    for (const [, w] of this.pending) w.reject(err);
    this.pending.clear();
  }
}
