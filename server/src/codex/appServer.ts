import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { applyCodexMcp } from '../mcp/apply.js';
import {
  cleanRemoteStderr,
  loginShellCommand,
  proxyEnvPrefix,
  shQuote,
  sshConnectPrefix,
} from '../remote/ssh.js';
import { CodexStreamNormalizer } from './normalize.js';
import type { CodexRunOptions } from './runner.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';
import type { BackgroundTask } from '../../../shared/protocol.js';

type RpcId = number | string;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface BackgroundTerminal {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid?: number | null;
}

interface CommandInfo {
  id: string;
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  startedAt: number;
}

function sandboxFor(mode: CodexRunOptions['permissionMode']): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (mode === 'plan') return 'read-only';
  if (mode === 'bypassPermissions') return 'danger-full-access';
  return 'workspace-write';
}

function buildSpawn(opts: CodexRunOptions): { bin?: string; args: string[]; cwd?: string; remote: boolean } {
  if (!opts.remote) return { bin: config.codexExecutable, args: ['app-server'], cwd: opts.cwd, remote: false };
  const inner = `cd ${shQuote(opts.remote.cwd)} && exec codex app-server`;
  const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(inner);
  const { bin, opts: sshOpts } = sshConnectPrefix();
  return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
}

function terminal(status: BackgroundTask['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

/** One task-aware Codex App Server connection. It remains alive after the
 *  foreground turn while background terminals run, and starts an internal turn
 *  whenever one settles so the model can report the result without user input. */
class CodexAppServerRun {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRpc>();
  private buffer = '';
  private stderr = '';
  private closed = false;
  private aborted = false;
  private threadId = '';
  private currentTurnId = '';
  private turnResolve: (() => void) | undefined;
  private turnReject: ((error: Error) => void) | undefined;
  private readonly normalizer: CodexStreamNormalizer;
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly commands = new Map<string, CommandInfo>();
  private readonly stopRequested = new Set<string>();
  private readonly promptQueue: string[] = [];
  private wakeIdle: (() => void) | undefined;
  private acceptingPrompts = false;
  /** A Stop click can arrive before turn/start returns its id. Remember it and
   *  issue turn/interrupt as soon as the id becomes available. */
  private interruptRequested = false;
  private interruptingTurnId = '';
  private exitPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: CodexRunOptions,
    private readonly cb: RunCallbacks,
  ) {
    this.normalizer = new CodexStreamNormalizer(cb);
  }

  handle(): RunHandle {
    return {
      abort: () => this.abort(),
      sendMessage: (text) => this.queueMessage(text),
      stopTask: (taskId) => this.stopTask(taskId),
      done: this.run(),
    };
  }

  private abort(): void {
    if (this.aborted || this.closed) return;
    // turn/interrupt ends only the current answer. Do not terminate app-server:
    // it owns background terminals and must stay attached to observe completion.
    if (this.currentTurnId && this.interruptingTurnId === this.currentTurnId) return;
    this.interruptRequested = true;
    this.interruptCurrentTurn();
  }

  private interruptCurrentTurn(): void {
    if (!this.interruptRequested || !this.threadId || !this.currentTurnId || this.closed) return;
    const turnId = this.currentTurnId;
    this.interruptRequested = false;
    this.interruptingTurnId = turnId;
    void this.request('turn/interrupt', { threadId: this.threadId, turnId })
      .catch((error) => log.warn(`codex reply interrupt failed turn=${turnId}`, error))
      .finally(() => {
        if (this.interruptingTurnId === turnId) this.interruptingTurnId = '';
        // A new turn may have started while this request was in flight.
        this.interruptCurrentTurn();
      });
  }

  private async stopTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || terminal(task.status) || !task.processId) throw new Error('Codex background terminal is not running');
    this.stopRequested.add(taskId);
    const response = await this.request('thread/backgroundTerminals/terminate', {
      threadId: this.threadId,
      processId: task.processId,
    });
    if (response?.terminated === false) throw new Error('Codex did not terminate the background terminal');
  }

  private async run(): Promise<void> {
    try {
      await applyCodexMcp(
        this.opts.mcpServers ?? [],
        this.opts.remote ? { sshTarget: this.opts.remote.sshTarget } : undefined,
      );
      if (this.aborted) return;
      this.spawn();
      await this.request('initialize', {
        clientInfo: { name: 'vibe', title: 'Vibe', version: config.serverVersion },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});

      const common = {
        cwd: this.opts.remote ? this.opts.remote.cwd : this.opts.cwd,
        model: this.opts.model && this.opts.model !== 'auto' ? this.opts.model : undefined,
        approvalPolicy: 'never',
        sandbox: sandboxFor(this.opts.permissionMode),
      };
      const opened = this.opts.resume
        ? await this.request('thread/resume', { threadId: this.opts.resume, ...common })
        : await this.request('thread/start', common);
      this.threadId = String(opened?.thread?.id ?? this.opts.resume ?? '');
      if (!this.threadId) throw new Error('Codex App Server did not return a thread id');
      this.cb.onClaudeSessionId(this.threadId);

      this.acceptingPrompts = true;
      await this.startTurn(this.opts.prompt);
      await this.followBackgroundTasks();
    } catch (error) {
      if (!this.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = cleanRemoteStderr(this.stderr);
        const text = detail && !message.includes(detail) ? `${message}\n${detail}` : message;
        log.error('codex app-server run error:', text);
        this.cb.onEvent({ k: 'error', text });
      }
    } finally {
      this.acceptingPrompts = false;
      this.wakeIdle?.();
      this.closed = true;
      this.turnResolve?.();
      this.rejectAll(new Error('Codex App Server closed'));
      try { this.child?.stdin?.end(); } catch { /* ignore */ }
      const killer = setTimeout(() => this.child?.kill('SIGKILL'), 2_000);
      await this.exitPromise.catch(() => undefined);
      clearTimeout(killer);
    }
  }

  private spawn(): void {
    const spec = buildSpawn(this.opts);
    if (!spec.bin) throw new Error('codex not found — install the Codex CLI or set CODEX_CLI_PATH');
    this.child = spawn(spec.bin, spec.args, {
      cwd: spec.remote ? undefined : spec.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (data) => this.onStdout(data.toString()));
    this.child.stderr?.on('data', (data) => { this.stderr += data.toString(); });
    this.exitPromise = new Promise((resolve) => {
      this.child!.on('error', (error) => {
        this.closed = true;
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        this.turnReject?.(error instanceof Error ? error : new Error(String(error)));
        resolve();
      });
      this.child!.on('close', (code) => {
        this.closed = true;
        const error = new Error(cleanRemoteStderr(this.stderr) || `codex app-server exited with code ${code}`);
        this.rejectAll(error);
        this.turnReject?.(error);
        resolve();
      });
    });
  }

  private async startTurn(text: string): Promise<void> {
    if (this.aborted) return;
    this.cb.onTurnState?.(true);
    try {
      const completion = new Promise<void>((resolve, reject) => {
        this.turnResolve = resolve;
        this.turnReject = reject;
      });
      const response = await this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        cwd: this.opts.remote ? this.opts.remote.cwd : this.opts.cwd,
        model: this.opts.model && this.opts.model !== 'auto' ? this.opts.model : undefined,
        effort: this.opts.effort,
        summary: 'detailed',
        approvalPolicy: 'never',
      });
      this.currentTurnId = String(response?.turn?.id ?? this.currentTurnId);
      this.interruptCurrentTurn();
      await completion;
    } finally {
      this.turnResolve = undefined;
      this.turnReject = undefined;
      this.currentTurnId = '';
      this.cb.onTurnState?.(false);
    }
  }

  private async followBackgroundTasks(): Promise<void> {
    while (!this.aborted) {
      const settled = await this.refreshTasks();
      if (settled.length) {
        const details = settled.map((task) => {
          const result = task.error || task.output || '(no output)';
          return `- ${task.id}: ${task.status} — ${task.description}\n${result.slice(0, 8_000)}`;
        }).join('\n\n');
        // Preserve arrival order: an explicit user prompt already waiting in
        // the queue is handled before this automatic task notification.
        this.promptQueue.push(
          `<background-task-notification>\n${details}\n</background-task-notification>\n` +
          'The background task state changed while you were idle. Inspect the result, continue any dependent work, and reply with the updated outcome.',
        );
      }

      const prompt = this.promptQueue.shift();
      if (prompt) {
        await this.startTurn(prompt);
        continue;
      }
      const active = [...this.tasks.values()].some((task) => !terminal(task.status));
      if (!active) return;
      await this.waitForWork(1_000);
    }
  }

  private queueMessage(text: string): boolean {
    if (!text.trim() || !this.acceptingPrompts || this.aborted || this.closed || this.currentTurnId) return false;
    this.promptQueue.push(text);
    this.wakeIdle?.();
    return true;
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

  /** Refresh the authoritative running-terminal list and return newly settled
   *  tasks. Disappearance from this list is the terminal edge; item/completed
   *  supplies output/exit details when available. */
  private async refreshTasks(): Promise<BackgroundTask[]> {
    let response: any;
    try {
      response = await this.request('thread/backgroundTerminals/list', { threadId: this.threadId, limit: 100 });
    } catch (error) {
      // Older Codex builds do not expose the experimental list API. Treat that
      // as no managed work so ordinary turns still finish normally.
      log.debug('codex background terminal list unavailable', error);
      return [];
    }
    const rows: BackgroundTerminal[] = Array.isArray(response?.data) ? response.data : [];
    const seen = new Set<string>();
    const now = Date.now();
    for (const row of rows) {
      if (!row?.itemId || !row?.processId) continue;
      seen.add(row.itemId);
      const command = this.commands.get(row.itemId);
      const previous = this.tasks.get(row.itemId);
      const task: BackgroundTask = {
        id: row.itemId,
        agent: 'codex',
        kind: 'command',
        status: 'running',
        description: row.command || command?.command || `Command ${row.itemId}`,
        startedAt: previous?.startedAt ?? command?.startedAt ?? now,
        updatedAt: now,
        command: row.command || command?.command,
        cwd: row.cwd || command?.cwd,
        output: command?.output ?? previous?.output,
        processId: row.processId,
        canStop: true,
      };
      this.tasks.set(task.id, task);
      if (!previous
        || previous.processId !== task.processId
        || previous.status !== task.status
        || previous.output !== task.output
        || previous.command !== task.command
        || previous.cwd !== task.cwd) {
        this.cb.onTask?.(task);
      }
    }

    const settled: BackgroundTask[] = [];
    for (const [id, previous] of this.tasks) {
      if (terminal(previous.status) || seen.has(id)) continue;
      const command = this.commands.get(id);
      const stopped = this.stopRequested.delete(id);
      const failed = !stopped && command?.exitCode != null && command.exitCode !== 0;
      const task: BackgroundTask = {
        ...previous,
        status: stopped ? 'stopped' : failed ? 'failed' : 'completed',
        updatedAt: now,
        endedAt: now,
        output: command?.output ?? previous.output,
        exitCode: command?.exitCode,
        canStop: false,
        error: failed ? `Command exited with code ${command?.exitCode}` : previous.error,
      };
      this.tasks.set(id, task);
      this.cb.onTask?.(task);
      settled.push(task);
    }
    return settled;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.onMessage(JSON.parse(line)); } catch { /* ignore stdout noise */ }
    }
  }

  private onMessage(message: any): void {
    if (message?.id != null && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message ?? message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message?.method !== 'string') return;
    // Server requests should be impossible with approvalPolicy=never. Deny any
    // unexpected one explicitly instead of leaving Codex blocked forever.
    if (message.id != null) {
      this.respond(message.id, { decision: 'decline' });
      return;
    }
    this.onNotification(message.method, message.params ?? {});
  }

  private onNotification(method: string, params: any): void {
    if (method === 'thread/started') {
      const id = params?.thread?.id;
      if (typeof id === 'string' && id) {
        this.threadId = id;
        this.cb.onClaudeSessionId(id);
      }
      return;
    }
    if (method === 'turn/started') {
      const turn = params?.turn ?? {};
      this.currentTurnId = String(turn.id ?? this.currentTurnId);
      this.normalizer.push({ ...turn, type: 'turn.started' });
      this.interruptCurrentTurn();
      return;
    }
    if (method === 'item/agentMessage/delta') {
      this.normalizer.push({ type: 'agent_message_content_delta', delta: params.delta });
      return;
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.normalizer.push({ type: 'reasoning_summary_text.delta', delta: params.delta });
      return;
    }
    if (method === 'item/plan/delta') {
      this.normalizer.push({ type: 'plan_delta', delta: params.delta });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      this.captureCommand(item, method === 'item/completed', params.startedAtMs);
      this.normalizer.push({ type: method === 'item/started' ? 'item.started' : 'item.completed', item });
      return;
    }
    if (method === 'item/commandExecution/outputDelta') {
      const id = String(params.itemId ?? '');
      const command = this.commands.get(id);
      if (command && typeof params.delta === 'string') {
        command.output = ((command.output ?? '') + params.delta).slice(-16_000);
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      this.normalizer.push({ ...params, type: 'thread/tokenUsage/updated' });
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn ?? {};
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) this.captureCommand(item, true);
      }
      if (turn.status === 'failed') {
        this.normalizer.push({ ...turn, type: 'turn.failed', error: turn.error });
      } else if (turn.status === 'interrupted') {
        this.normalizer.push({ ...turn, type: 'turn.aborted' });
      } else {
        this.normalizer.push({ ...turn, type: 'turn.completed' });
      }
      this.interruptRequested = false;
      if (this.interruptingTurnId === String(turn.id ?? this.currentTurnId)) this.interruptingTurnId = '';
      this.turnResolve?.();
      return;
    }
    if (method === 'error') {
      this.normalizer.push({ type: 'error', error: params.error ?? params });
    }
  }

  private captureCommand(item: any, completed: boolean, startedAt?: number): void {
    if (item?.type !== 'commandExecution' || !item.id) return;
    const previous = this.commands.get(String(item.id));
    const exitCode = item.exitCode == null ? previous?.exitCode : Number(item.exitCode);
    const info: CommandInfo = {
      id: String(item.id),
      command: String(item.command ?? previous?.command ?? ''),
      cwd: typeof item.cwd === 'string' ? item.cwd : previous?.cwd,
      output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(-16_000) : previous?.output,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      startedAt: Number(startedAt) || previous?.startedAt || Date.now(),
    };
    this.commands.set(info.id, info);
    const task = this.tasks.get(info.id);
    if (completed && task) {
      this.tasks.set(info.id, { ...task, output: info.output, exitCode: info.exitCode, updatedAt: Date.now() });
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed || !this.child?.stdin?.writable) return Promise.reject(new Error('Codex App Server is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: RpcId, result: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function startCodexAppServerRun(opts: CodexRunOptions, cb: RunCallbacks): RunHandle {
  return new CodexAppServerRun(opts, cb).handle();
}
