import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, sshConnectPrefix } from '../remote/ssh.js';
import { type ChatBlock, type McpServerDef, type PermissionDecision, type PermissionMode, type PermissionRequest } from '../../../shared/protocol.js';
import type { RunCallbacks } from '../claude/types.js';
import { toAcpMcpServers } from '../mcp/apply.js';
import { KimiTaskMonitor } from './tasks.js';

type JsonRpcId = number | string;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface JsonRpcErrorPayload {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

class AcpRpcError extends Error {
  readonly code: unknown;
  readonly data: unknown;

  constructor(payload: JsonRpcErrorPayload) {
    super(typeof payload.message === 'string' ? payload.message : JSON.stringify(payload));
    this.name = 'AcpRpcError';
    this.code = payload.code;
    this.data = payload.data;
  }
}

function busyTurn(error: unknown): { turnId?: string } | undefined {
  if (error instanceof AcpRpcError) {
    const data = error.data && typeof error.data === 'object'
      ? error.data as { code?: unknown; details?: { turnId?: unknown } }
      : undefined;
    if (data?.code === 'turn.agent_busy') {
      const value = data.details?.turnId;
      return { turnId: value == null ? undefined : String(value) };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!/turn\.agent_busy|Cannot launch a new turn while another turn/i.test(message)) return undefined;
  const match = message.match(/turn \(ID ([^)]+)\) is active/i);
  return { turnId: match?.[1] };
}

export interface KimiAcpRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  resume?: string;
  /** Vibe-managed MCP servers, passed to session/new (and resume/load). */
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

function buildAcpSpawn(opts: KimiAcpRunOptions): { bin?: string; args: string[]; remote: boolean; cwd?: string } {
  if (!opts.remote) return { bin: config.kimiExecutable, args: ['acp'], remote: false, cwd: opts.cwd };

  const inner = [
    'kimi_fallback="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin/kimi"',
    'if command -v kimi >/dev/null 2>&1; then kimi_bin="$(command -v kimi)"; '
      + 'elif [ -x "$kimi_fallback" ]; then kimi_bin="$kimi_fallback"; '
      + 'else echo "kimi not found" >&2; exit 127; fi',
    'exec "$kimi_bin" acp',
  ].join('\n');
  const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(inner);
  const { bin, opts: sshOpts } = sshConnectPrefix();
  return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const value = content as { text?: unknown; content?: unknown; type?: unknown };
  if (typeof value.text === 'string') return value.text;
  return textOfContent(value.content);
}

function contentListText(content: unknown): string {
  if (!Array.isArray(content)) return textOfContent(content);
  return content.map((item) => textOfContent(item)).filter(Boolean).join('\n');
}

function toolResultFromUpdate(update: any): { content: string; isError: boolean } {
  const raw = update?.rawOutput ?? update?.content;
  const isError = update?.status === 'failed';
  if (raw == null) return { content: '', isError };
  if (typeof raw === 'string') return { content: raw, isError };
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (item?.type === 'content') parts.push(textOfContent(item.content));
      else if (item?.type === 'diff') parts.push(`diff ${item.path ?? ''}`);
      else if (typeof item === 'string') parts.push(item);
      else parts.push(JSON.stringify(item));
    }
    return { content: parts.filter(Boolean).join('\n'), isError };
  }
  return { content: JSON.stringify(raw, null, 2), isError };
}

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

function toolNameFromUpdate(update: any): string | null {
  const title = typeof update?.title === 'string' ? update.title.trim() : '';
  if (title && /^[A-Za-z][A-Za-z0-9_]*$/.test(title)) return title;
  const kind = typeof update?.kind === 'string' ? update.kind : '';
  if (kind && ACP_KIND_NAME[kind]) return ACP_KIND_NAME[kind]!;
  if (kind && kind !== 'other') return kind;
  return null;
}

function enrichToolInput(update: any): Record<string, unknown> | null {
  const raw = update?.rawInput ?? update?.raw_input;
  let input: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) input = { ...(raw as Record<string, unknown>) };
  else if (typeof raw === 'string' && raw) input = { value: raw };

  if (Array.isArray(update?.locations) && update.locations.length) {
    const paths = update.locations.map((item: any) => item?.path).filter((value: unknown): value is string => typeof value === 'string' && !!value);
    if (!input.path && paths.length) input.path = paths[0];
    if (paths.length > 1) input.paths = paths;
  }
  if (Array.isArray(update?.content)) {
    for (const item of update.content) {
      if (!input.path && item?.type === 'diff' && typeof item.path === 'string') input.path = item.path;
    }
  }
  return Object.keys(input).length ? input : null;
}

function taskIdFromText(text: string): string | undefined {
  const match = text.match(/\b(?:bash|agent|task)-[a-z0-9][a-z0-9_-]*\b/i)
    ?? text.match(/(?:task[_\s-]*id|task)\s*[:=]\s*["']?([a-z0-9][a-z0-9_-]*)/i);
  return match ? String(match[1] ?? match[0]) : undefined;
}

function permissionToKimiMode(mode: PermissionMode): string {
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits') return 'auto';
  if (mode === 'bypassPermissions') return 'yolo';
  return 'default';
}

/** One task-aware Kimi ACP connection. It accepts serialized follow-up prompts
 *  while native background tasks keep the session alive. */
export class KimiAcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRpc>();
  private buffer = '';
  private stderr = '';
  private aborted = false;
  private ignoreUpdates = false;
  private closed = false;
  private sessionId: string | null = null;
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private taskMonitor: KimiTaskMonitor | undefined;
  private readonly promptQueue: string[] = [];
  private wakeIdle: (() => void) | undefined;
  private acceptingPrompts = false;
  private promptActive = false;
  private nativeTurnActive = false;
  private interruptRequested = false;
  private readonly nativeBlockSignatures = new Map<string, string>();

  constructor(
    private readonly opts: KimiAcpRunOptions,
    private readonly cb: RunCallbacks,
  ) {}

  abort(): void {
    if (this.aborted || this.closed) return;
    // ACP session/cancel targets the active turn. Keep the ACP process and task
    // monitor alive so detached work can finish and wake the original session.
    this.interruptRequested = true;
    this.interruptCurrentTurn();
    this.wakeIdle?.();
  }

  private interruptCurrentTurn(): void {
    if (!this.interruptRequested || !this.sessionId || (!this.promptActive && !this.nativeTurnActive)) return;
    if (this.child?.stdin?.writable) this.notify('session/cancel', { sessionId: this.sessionId });
  }

  async stopTask(taskId: string): Promise<void> {
    if (!this.taskMonitor) throw new Error('Kimi task control is unavailable for this session');
    await this.taskMonitor.stopTask(taskId);
  }

  sendMessage(text: string): boolean {
    if (!text.trim() || !this.acceptingPrompts || this.promptActive || this.aborted || this.closed) return false;
    this.promptQueue.push(text);
    this.wakeIdle?.();
    return true;
  }

  async run(): Promise<{ error?: string }> {
    const runStartedAt = Date.now() - 1_000;
    const spawnSpec = buildAcpSpawn(this.opts);
    if (!spawnSpec.bin) return { error: 'kimi not found — install Kimi Code or set KIMI_CLI_PATH' };

    this.child = spawn(spawnSpec.bin, spawnSpec.args, {
      cwd: spawnSpec.remote ? undefined : spawnSpec.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (data) => this.onStdout(data.toString()));
    this.child.stderr?.on('data', (data) => {
      this.stderr += data.toString();
    });

    const exitPromise = new Promise<void>((resolve) => {
      this.child!.on('error', (error) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        resolve();
      });
      this.child!.on('close', (code) => {
        this.closed = true;
        this.rejectAll(new Error(cleanRemoteStderr(this.stderr) || `kimi acp exited with code ${code}`));
        resolve();
      });
    });

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'vibe', version: '0.1.0' },
      });

      const cwd = this.opts.remote ? this.opts.remote.cwd : this.opts.cwd;
      this.sessionId = await this.openSession(cwd);
      this.cb.onClaudeSessionId(this.sessionId);
      await this.applySessionConfig();

      // Kimi persists native task state under the session. Watching that stable
      // interface gives ACP clients the same task pane the TUI exposes, while
      // keeping permission requests and Vibe-managed MCP servers on ACP.
      this.taskMonitor = new KimiTaskMonitor(
        this.sessionId,
        this.cb.onTask ?? (() => undefined),
        this.opts.remote?.sshTarget,
        {
          onNativeTurnStart: () => {
            this.nativeTurnActive = true;
            this.cb.onTurnState?.(true);
            this.interruptCurrentTurn();
            this.wakeIdle?.();
          },
          onNativeTurnBlocks: (_turnId, blocks) => this.emitNativeBlocks(blocks),
          onNativeTurnComplete: (turnId, blocks, outcome) =>
            this.completeNativeTurn(turnId, blocks, outcome),
        },
      );
      // Establish EOF before launching the first ACP prompt. From this point on
      // the monitor can distinguish Vibe-owned turns from native task/cron turns
      // and can wait on the exact turn reported by `turn.agent_busy`.
      await this.taskMonitor.scan();
      this.taskMonitor.start();

      this.acceptingPrompts = true;
      await this.runPrompt(this.opts.prompt);
      await this.serviceBackgroundActivity(runStartedAt);
      return {};
    } catch (error) {
      if (this.aborted) return {};
      const message = error instanceof Error ? error.message : String(error);
      const detail = cleanRemoteStderr(this.stderr);
      return { error: detail && !message.includes(detail) ? `${message}\n${detail}` : message };
    } finally {
      this.acceptingPrompts = false;
      this.wakeIdle?.();
      this.taskMonitor?.dispose();
      this.flushStream();
      try {
        this.child?.stdin?.end();
      } catch {
        /* ignore */
      }
      const killer = setTimeout(() => this.child?.kill('SIGKILL'), 2000);
      await exitPromise.catch(() => undefined);
      clearTimeout(killer);
    }
  }

  /** Keep ACP attached while tasks or Kimi-native turns are active. Kimi itself
   *  steers terminal task notifications into the original session; injecting a
   *  second synthetic prompt here races that native turn and duplicates work. */
  private async serviceBackgroundActivity(since: number): Promise<void> {
    const monitor = this.taskMonitor;
    if (!monitor || !this.sessionId) return;
    // Also adopt tasks that were already active when this turn began (for
    // example after a Vibe restart). Once followed, keep watching until their
    // native terminal update arrives; do not replay older settled history.
    const followed = new Set<string>();
    let quietScans = 0;

    while (!this.aborted && !this.closed) {
      const queuedBeforeScan = this.promptQueue.shift();
      if (queuedBeforeScan) {
        await this.runPrompt(queuedBeforeScan);
        quietScans = 0;
        continue;
      }

      await monitor.scan();
      const tasks = monitor.tasks();
      const byId = new Map(tasks.map((task) => [task.id, task]));
      for (const task of tasks) {
        if (task.status === 'pending' || task.status === 'running' || task.status === 'paused') followed.add(task.id);
      }
      const ids = [...new Set([...monitor.observedTaskIds(since), ...followed])];
      const active = ids
        .map((id) => byId.get(id))
        .filter((task) => task && (task.status === 'pending' || task.status === 'running' || task.status === 'paused'));

      const queued = this.promptQueue.shift();
      if (queued) {
        await this.runPrompt(queued);
        quietScans = 0;
        continue;
      }

      if (active.length || monitor.hasNativeTurn() || this.nativeTurnActive) {
        quietScans = 0;
        await this.waitForWork(monitor.pollIntervalMs);
        continue;
      }

      // Allow the atomic task file a short window to appear after prompt
      // completion; after two quiet scans this run is genuinely quiescent.
      if (quietScans++ < 2) {
        await this.waitForWork(monitor.pollIntervalMs);
        continue;
      }
      return;
    }
  }

  private async runPrompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('Kimi session is not ready');
    // Stop may be clicked while ACP is still initializing, before session/prompt
    // exists. Consume that request instead of starting an answer the user has
    // already cancelled.
    if (this.interruptRequested) {
      this.interruptRequested = false;
      this.cb.onTurnState?.(false);
      return;
    }
    this.promptActive = true;
    this.cb.onTurnState?.(true);
    try {
      let retry = 0;
      while (!this.aborted && this.acceptingPrompts) {
        const promptAttempt = this.taskMonitor?.beginPromptAttempt();
        try {
          await this.request('session/prompt', {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text }],
          });
          this.taskMonitor?.finishPromptAttempt(promptAttempt, true);
          this.flushStream();
          return;
        } catch (error) {
          if (this.interruptRequested) {
            this.taskMonitor?.finishPromptAttempt(promptAttempt, true);
            log.debug('kimi reply interrupted');
            return;
          }
          const busy = busyTurn(error);
          this.taskMonitor?.finishPromptAttempt(promptAttempt, !busy);
          if (!busy) throw error;
          retry += 1;
          log.debug(`kimi session busy${busy.turnId ? ` with native turn ${busy.turnId}` : ''}; queued prompt will retry`);

          // Kimi persists an end-of-step record for agent-initiated task/cron
          // turns even though ACP does not expose their lifecycle. Waiting on
          // that exact turn gives us one clean retry instead of polling
          // session/prompt (every rejected poll would append another record).
          const observed = busy.turnId
            ? await this.taskMonitor?.waitForTurnEnd(busy.turnId)
            : false;
          if (this.aborted || !this.acceptingPrompts || this.interruptRequested) return;
          if (!observed) {
            const backoff = Math.min(5_000, 500 * 2 ** Math.min(retry - 1, 4));
            await this.waitForWork(backoff);
          }
        }
      }
    } finally {
      this.flushStream();
      this.promptActive = false;
      this.interruptRequested = false;
      if (!this.nativeTurnActive) this.cb.onTurnState?.(false);
    }
  }

  private emitNativeBlocks(blocks: ChatBlock[]): void {
    this.flushStream();
    for (const block of blocks) {
      const signature = JSON.stringify(block);
      if (this.nativeBlockSignatures.get(block.id) === signature) continue;
      this.nativeBlockSignatures.set(block.id, signature);
      this.cb.onEvent({ k: 'block', block });
    }
  }

  private completeNativeTurn(
    turnId: string,
    blocks: ChatBlock[],
    outcome: 'completed' | 'cancelled' | 'interrupted',
  ): void {
    const interruptedByUser = this.interruptRequested;
    this.emitNativeBlocks(blocks);
    this.nativeTurnActive = false;
    // When an ACP prompt is waiting behind this native turn, preserve the Stop
    // marker so runPrompt exits instead of retrying that prompt immediately.
    if (!this.promptActive) this.interruptRequested = false;
    if (outcome === 'cancelled' && !interruptedByUser && !this.aborted && this.acceptingPrompts) {
      // A native task notification can exhaust its tool loop and end in
      // turn.cancel without producing a final answer. Retry only that failure
      // mode, in the same session, after any user message already queued.
      this.promptQueue.push(
        `<background-task-followup turn-id="${turnId}">\n` +
        'The automatic background-task follow-up was cancelled before a final response. ' +
        'Inspect the latest task state and output, then give a concise final update. ' +
        'Do not restart completed work unless it is necessary.\n' +
        '</background-task-followup>',
      );
    }
    // Keep the foreground state continuously busy if a fallback/user prompt is
    // already queued; runPrompt will own the eventual true→false transition.
    if (!this.promptActive && this.promptQueue.length === 0) this.cb.onTurnState?.(false);
    this.wakeIdle?.();
  }

  private waitForWork(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.wakeIdle === finish) this.wakeIdle = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wakeIdle = finish;
    });
  }

  private async openSession(cwd: string): Promise<string> {
    const mcpServers = await toAcpMcpServers(this.opts.mcpServers ?? []);
    if (this.opts.resume) {
      try {
        this.ignoreUpdates = true;
        await this.request('session/resume', { sessionId: this.opts.resume, cwd, mcpServers });
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (error) {
        log.debug('kimi acp session/resume failed, trying load', error);
      }
      try {
        await this.request('session/load', { sessionId: this.opts.resume, cwd, mcpServers });
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (error) {
        this.ignoreUpdates = false;
        log.warn('kimi acp resume/load failed, starting new session', error);
      }
    }
    const created = await this.request('session/new', { cwd, mcpServers });
    const id = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (!id) throw new Error('session/new did not return sessionId');
    return id;
  }

  private async applySessionConfig(): Promise<void> {
    if (!this.sessionId) return;
    const mode = permissionToKimiMode(this.opts.permissionMode);
    await this.setConfig('mode', mode, () =>
      this.request('session/set_mode', { sessionId: this.sessionId, modeId: mode }));
    if (this.opts.model && this.opts.model !== 'auto') {
      await this.setConfig('model', this.opts.model, () =>
        this.request('session/set_model', { sessionId: this.sessionId, modelId: this.opts.model }));
    }
  }

  private async setConfig(configId: string, value: string, compatibility: () => Promise<any>): Promise<void> {
    try {
      await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    } catch (primaryError) {
      try {
        await compatibility();
      } catch {
        throw primaryError;
      }
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        void this.dispatch(JSON.parse(line));
      } catch {
        /* ignore non-JSON stdout noise */
      }
    }
  }

  private async dispatch(message: any): Promise<void> {
    if (!message || typeof message !== 'object') return;
    if (message.id != null && !message.method && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AcpRpcError(message.error as JsonRpcErrorPayload));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;

    if (message.method === 'session/update') {
      if (!this.ignoreUpdates) this.handleUpdate(message.params?.update);
      return;
    }
    if (message.id == null) return;

    try {
      if (message.method === 'session/request_permission') {
        this.respond(message.id, await this.handleRequestPermission(message.params));
        return;
      }
      this.respond(message.id, {});
    } catch (error) {
      log.warn('kimi acp handler failed', message.method, error);
      this.respond(message.id, { outcome: { outcome: 'cancelled' } });
    }
  }

  private handleUpdate(update: any): void {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = textOfContent(update.content);
      if (text) this.segment('assistant', text);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = textOfContent(update.content);
      if (text) this.segment('thinking', text);
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.flushStream();
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const previous = this.tools.get(id);
      const name = toolNameFromUpdate(update) ?? previous?.name ?? 'tool';
      const enriched = enrichToolInput(update);
      const input = enriched ? { ...(previous?.input ?? {}), ...enriched } : (previous?.input ?? {});
      this.tools.set(id, { name, input });
      const { content, isError } = toolResultFromUpdate(update);
      const status = update.status === 'completed' ? 'done' : update.status === 'failed' || isError ? 'error' : 'running';
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
      if (status === 'done' || status === 'error') {
        this.cb.onEvent({ k: 'tool_result', toolUseId: id, content: content || (status === 'error' ? 'failed' : ''), isError: status === 'error' });
        // Publish a provisional remote task immediately from the tool result;
        // the SSH task monitor replaces it with authoritative status/output on
        // its next scan (and later keeps the native wake turn attached).
        const background = input.run_in_background === true || input.runInBackground === true;
        const taskId = background && this.opts.remote ? taskIdFromText(content) : undefined;
        if (taskId && this.cb.onTask) {
          const description = String(input.description ?? input.command ?? input.prompt ?? `${name} background task`);
          this.cb.onTask({
            id: taskId,
            agent: 'kimi',
            kind: /agent/i.test(name) ? 'subagent' : 'command',
            status: status === 'error' ? 'failed' : 'running',
            description,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            output: content || undefined,
            canStop: false,
          });
        }
      }
      return;
    }
  }

  private async handleRequestPermission(params: any): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };
    const toolCall = params?.toolCall ?? {};
    const toolName = String(toolCall.title || toolCall.kind || toolCall.toolCallId || 'tool');
    const content = contentListText(toolCall.content);
    if (toolName === 'AskUserQuestion') return this.handleAskUserQuestion(params, toolCall, content);
    const rawInput = toolCall.rawInput ?? toolCall.raw_input;
    const input = rawInput ?? {
      kind: toolCall.kind,
      title: toolCall.title,
      description: content || undefined,
    };
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName,
      input,
      plan: /ExitPlanMode/i.test(toolName) && content ? content : undefined,
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    return this.permissionDecision(params, decision);
  }

  /**
   * Kimi routes AskUserQuestion through request_permission with no rawInput:
   * the question text is the toolCall content and the answer choices are the
   * permission options (`q0_opt_*` allow_once + `q0_skip` reject_once). The
   * full question (header, option descriptions) only exists on the tracked
   * tool_call's rawInput. ACP can return exactly one optionId, so the picker
   * is single-select and free-text "Other" can't round-trip — `source: 'kimi'`
   * tells the UIs to hide it.
   */
  private async handleAskUserQuestion(params: any, toolCall: any, content: string): Promise<unknown> {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const raw = this.tools.get(String(toolCall.toolCallId ?? ''))?.input?.questions;
    const rawQuestions = Array.isArray(raw) ? raw : [];
    const asked = content.trim();
    const rawQuestion =
      rawQuestions.find((q: any) => typeof q?.question === 'string' && q.question.trim() === asked) ??
      rawQuestions[0];
    const descByLabel = new Map<string, string>();
    if (Array.isArray(rawQuestion?.options)) {
      for (const o of rawQuestion.options) {
        if (typeof o?.label === 'string' && typeof o?.description === 'string') descByLabel.set(o.label, o.description);
      }
    }
    const askOptions = options
      .filter((option) => option?.kind === 'allow_once' && typeof option?.name === 'string')
      .map((option) => ({ label: option.name as string, description: descByLabel.get(option.name) }));
    if (!asked || !askOptions.length) return { outcome: { outcome: 'cancelled' } };
    const question = {
      question: asked,
      header: typeof rawQuestion?.header === 'string' ? rawQuestion.header : undefined,
      options: askOptions,
    };
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName: 'AskUserQuestion',
      input: { source: 'kimi', questions: [question] },
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    return this.askDecision(options, decision, asked);
  }

  /** Map the picker's answer back to the one optionId ACP lets us select. */
  private askDecision(options: any[], decision: PermissionDecision, asked: string): unknown {
    const skip = options.find((option) => option?.kind === 'reject_once') ??
      options.find((option) => /skip|reject/i.test(String(option?.optionId)));
    const fallback = () => skip?.optionId
      ? { outcome: { outcome: 'selected', optionId: skip.optionId } }
      : { outcome: { outcome: 'cancelled' } };
    if (!decision.allow) return fallback();
    const answers = (decision.updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers;
    const answer = answers?.[asked];
    const label = Array.isArray(answer) ? answer[0] : answer;
    // An answer matching no option must not invent a choice — skip instead.
    if (typeof label !== 'string' || !label) return fallback();
    const match = options.find((option) => option?.kind === 'allow_once' && option?.name === label);
    return match?.optionId
      ? { outcome: { outcome: 'selected', optionId: match.optionId } }
      : fallback();
  }

  private permissionDecision(params: any, decision: PermissionDecision): unknown {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    if (!decision.allow) {
      const reject = options.find((option) => option?.kind === 'reject_once') ?? options.find((option) => /reject/i.test(option?.optionId));
      return { outcome: { outcome: 'selected', optionId: reject?.optionId ?? 'reject' } };
    }
    if (decision.remember) {
      const always = options.find((option) => option?.kind === 'allow_always');
      if (always?.optionId) return { outcome: { outcome: 'selected', optionId: always.optionId } };
    }
    const once = options.find((option) => option?.kind === 'allow_once');
    return { outcome: { outcome: 'selected', optionId: once?.optionId ?? 'approve_once' } };
  }

  private segment(kind: 'assistant' | 'thinking', text: string): void {
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (!this.stream) {
      const id = `kimi_acp_${crypto.randomUUID()}`;
      this.stream = { id, kind, text };
      this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: true, ts: Date.now() } });
      return;
    }
    this.stream.text += text;
    this.cb.onEvent({ k: 'delta', id: this.stream.id, field: 'text', chunk: text });
  }

  private flushStream(): void {
    if (!this.stream) return;
    this.cb.onEvent({ k: 'block_end', id: this.stream.id, text: this.stream.text });
    this.stream = null;
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed || !this.child?.stdin?.writable) return Promise.reject(new Error('acp process closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(payload + '\n', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private respond(id: JsonRpcId, result: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
