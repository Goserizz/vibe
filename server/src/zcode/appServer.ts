import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, sshConnectPrefix } from '../remote/ssh.js';
import {
  type BackgroundTask,
  type EffortLevel,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
} from '../../../shared/protocol.js';
import type { RunCallbacks } from '../claude/types.js';
import { readZcodeConfigSync } from './models.js';
import { isDelegateWakeActive, peekDelegateWakePrompt } from '../vibot/wakeSuppress.js';

/**
 * ZCode Protocol client ("zcode app-server").
 *
 * Newline-delimited JSON-RPC over stdio with NO initialize handshake and no
 * `jsonrpc` field. Shapes below were probed live against zcode 0.16.3:
 *
 *   session/create  {workspace:{workspaceKey,workspacePath}}            → .session.sessionId (+ .settings.model.available)
 *   session/resume  {sessionId, workspace}                              → same shape + messages history (strict schema)
 *   session/subscribe {sessionId, deliveryKind:'desktop-continuous'}
 *   session/setMode   {sessionId, mode: build|edit|plan|yolo}
 *   session/setModel  {sessionId, model:{providerId,modelId}}           (object, not a string)
 *   session/setThoughtLevel {sessionId, thoughtLevel}                   → .settings.thoughtLevel
 *                                                                             (ladders are per-model;
 *                                                                             invalid → "Unsupported
 *                                                                             reasoning effort: <v>")
 *   session/send      {sessionId, content:string, runtimeModel?}        → ack {accepted}; the turn itself
 *                                                                             streams as session/event notifications
 *   session/stop      {sessionId}
 *   session/list      {}                                                → {sessions:[{sessionId,title,workspace,createdAt,updatedAt,…}]}
 *   session/messages  {sessionId}                                       → {messages:[{info:{role,…},parts:[…]}]}
 *
 * Server→client requests (must always be answered):
 *   session/requestRuntimePreferences  → {nativeSearchEnhancementsEnabled:boolean}
 *   interaction/requestPermission      → reply with the chosen option's `response` object VERBATIM
 *
 * Events arrive as `session/event` notifications with an envelope
 * {sessionId, seq, type, payload, turnId}. `model.streaming` payloads carry the
 * actual stream: kind text_delta | reasoning_delta | tool_input_start |
 * tool_input_delta | tool_call | tool_input_end. `tool.updated` carries the
 * lifecycle: kind scheduled | started | result | batch (result has the output).
 *
 * Resumed sessions can refuse `session/send` with -32031 "历史任务使用的模型已不可用"
 * (restoreWarning) — the fix is to pass a full `runtimeModel` (provider details
 * from ~/.zcode/cli/config.json) on the retried send.
 */

type JsonRpcId = number | string;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface ZcodeRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Vibe effort → ZCode thought level (`session/setThoughtLevel`); mapped to
   *  the selected model's own ladder, falling back to the nearest level. */
  effort?: EffortLevel;
  /** Native ZCode session id (sess_<uuid>) to resume. */
  resume?: string;
  /** Vibe session id (hub runtime) — used to detect an in-flight Vibot delegate
   *  wake so this poller can defer instead of starting a second turn. */
  vibeSessionId?: string;
  /** Accepted for interface parity; ZCode configures MCP via its config.json. */
  mcpServers?: unknown;
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

/** Vibe permission modes → ZCode modes (probed: build|edit|plan|yolo). */
function zcodeModeOf(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'edit';
    case 'bypassPermissions':
      return 'yolo';
    default:
      return 'build';
  }
}

/** Rank thought levels so a Vibe effort can fall back to the nearest level a
 *  model's ladder actually offers (low/medium/high/xhigh/max/ultra are Vibe's;
 *  nothink/enabled/disabled appear in ZCode-only ladders). */
const THOUGHT_RANKS: Record<string, number> = {
  disabled: 0,
  nothink: 0,
  low: 1,
  enabled: 2,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};

/** Highest ranked level ≤ the requested effort (or the ladder's lowest when
 *  even that is out of reach). */
function nearestThoughtLevel(effort: string, levels: string[]): string {
  if (levels.includes(effort)) return effort;
  const target = THOUGHT_RANKS[effort] ?? 5;
  const ranked = levels
    .map((l) => ({ l, r: THOUGHT_RANKS[l] ?? 0 }))
    .sort((a, b) => a.r - b.r);
  let best = ranked[0]!.l;
  for (const { l, r } of ranked) {
    if (r <= target) best = l;
  }
  return best;
}

/** Split a `providerID/modelID` model value (empty when unparseable). */
export function splitZcodeModel(value: string): { providerId: string; modelId: string } | null {
  const trimmed = (value || '').trim();
  if (!trimmed || trimmed === 'auto') return null;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/**
 * Build the `runtimeModel` param that clears the resumed-session
 * "model no longer available" restoreWarning. Needs the provider section from
 * ~/.zcode/cli/config.json; a minimal stub breaks the turn, so local-only.
 */
function buildRuntimeModel(model: string): Record<string, unknown> | null {
  const parsed = splitZcodeModel(model);
  const cfg = readZcodeConfigSync();
  if (!parsed || !cfg) return null;
  const provider = cfg.provider?.[parsed.providerId];
  if (!provider) return null;
  const models = Object.entries(provider.models ?? {})
    .map(([id, def]) => ({ modelId: id, label: (def as { name?: string } | undefined)?.name ?? undefined }));
  if (!models.length) models.push({ modelId: parsed.modelId, label: undefined });
  const entry: Record<string, unknown> = {
    revision: `vibe:${Date.now()}`,
    generatedAt: Date.now(),
    model: parsed,
    provider: {
      providerId: parsed.providerId,
      kind: provider.kind === 'openai' || provider.kind === 'openai-compatible' ? provider.kind : 'anthropic',
      source: 'workspace',
      models,
    },
  };
  const options = provider.options as { baseURL?: string; apiKey?: string } | undefined;
  if (options?.baseURL) (entry.provider as Record<string, unknown>).baseURL = options.baseURL;
  if (options?.apiKey) {
    (entry.provider as Record<string, unknown>).apiKey = { source: 'inline', value: options.apiKey };
  }
  return entry;
}

function isStaleModelError(error: unknown): boolean {
  const rpc = (error as { rpc?: { code?: unknown } })?.rpc;
  const message = error instanceof Error ? error.message : String(error);
  return rpc?.code === -32031 || /已不可用|ZCODE_RUNTIME_MODEL_UNAVAILABLE/i.test(message);
}

function buildZcodeSpawn(opts: { remote?: { sshTarget: string; cwd: string; proxy?: string } }) {
  if (!opts.remote) return { bin: config.zcodeExecutable, args: ['app-server'], remote: false };
  const inner = [
    'zcode_fallback="/usr/local/bin/zcode"',
    'if command -v zcode >/dev/null 2>&1; then zcode_bin="$(command -v zcode)"; '
      + 'elif [ -x "$HOME/.local/bin/zcode" ]; then zcode_bin="$HOME/.local/bin/zcode"; '
      + 'elif [ -x "$zcode_fallback" ]; then zcode_bin="$zcode_fallback"; '
      + 'else echo "zcode not found" >&2; exit 127; fi',
    'exec "$zcode_bin" app-server',
  ].join('\n');
  const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(inner);
  const { bin, opts: sshOpts } = sshConnectPrefix();
  return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
}

/** Low-level ZCode Protocol transport: framing + request correlation. */
class ZcodeRpc {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRpc>();
  private buffer = '';
  stderr = '';
  closed = false;
  readonly exitPromise: Promise<void>;

  constructor(
    spawnSpec: { bin?: string; args: string[]; remote: boolean; cwd?: string },
    private readonly onRequest: (id: JsonRpcId, method: string, params: any) => void,
    private readonly onNotification: (method: string, params: any) => void,
    private readonly label: string,
  ) {
    this.child = spawn(spawnSpec.bin!, spawnSpec.args, {
      cwd: spawnSpec.remote ? undefined : spawnSpec.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (data) => this.onStdout(data.toString()));
    this.child.stderr?.on('data', (data) => {
      this.stderr += data.toString();
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.child.on('error', (error) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        resolve();
      });
      this.child.on('close', (code) => {
        this.closed = true;
        this.rejectAll(
          new Error(cleanRemoteStderr(this.stderr) || `${this.label} exited with code ${code}`),
        );
        resolve();
      });
    });
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed || !this.child.stdin?.writable) return Promise.reject(new Error('zcode app-server closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ method, id, params }) + '\n', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed || !this.child.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n', () => undefined);
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed || !this.child.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n', () => undefined);
  }

  /** Graceful close: end stdin so ZCode can flush its SQLite store, then kill. */
  async close(): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exitPromise.catch(() => undefined);
    clearTimeout(killer);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }

  rejectAll(error: Error): void {
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message || typeof message !== 'object') continue;
      if (message.id != null && !message.method && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(Object.assign(new Error(message.error?.message ?? JSON.stringify(message.error)), { rpc: message.error }));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === 'string' && message.id != null) {
        this.onRequest(message.id, message.method, message.params);
        continue;
      }
      if (typeof message.method === 'string') {
        this.onNotification(message.method, message.params);
      }
    }
  }
}

let probeQueue: Promise<unknown> = Promise.resolve();

/**
 * Spawn a short-lived app-server for a one-shot probe (session/list,
 * session/messages). Serialized through a module-level queue: ZCode keeps its
 * state in SQLite, so never run two probes at once.
 */
export async function withZcodeAppServer<T>(
  opts: { cwd?: string; timeoutMs?: number },
  fn: (request: (method: string, params: unknown) => Promise<any>) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    if (!config.zcodeExecutable) throw new Error('zcode not found');
    const rpc = new ZcodeRpc(
      { bin: config.zcodeExecutable, args: ['app-server'], remote: false, cwd: opts.cwd },
      (id, method) => {
        // Client preferences must be answered or later RPCs fail Zod validation.
        if (method === 'session/requestRuntimePreferences') rpc.respond(id, { nativeSearchEnhancementsEnabled: false });
        else rpc.respond(id, {});
      },
      () => undefined,
      'zcode app-server',
    );
    const timeout = setTimeout(() => rpc.kill(), opts.timeoutMs ?? 25_000);
    try {
      return await fn((method, params) => rpc.request(method, params));
    } finally {
      clearTimeout(timeout);
      await rpc.close();
    }
  };
  const result = probeQueue.then(run, run);
  probeQueue = result.catch(() => undefined);
  return result;
}

interface ToolState {
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: string;
}

export interface ZcodeTurnUsage {
  durationMs?: number;
  contextUsed?: number;
  contextWindow?: number;
}

/** The model's context window rides on session/create (`projection.contextWindow`
 *  and `settings.model.available[].contextWindow`), on session/resume, and on
 *  turn event payloads — take whichever numeric value is present. */
function pickContextWindow(value: any): number | undefined {
  const candidates: unknown[] = [value?.projection?.contextWindow, value?.contextWindow];
  const available = value?.settings?.model?.available;
  if (Array.isArray(available)) {
    for (const m of available) candidates.push((m as any)?.contextWindow);
  }
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return undefined;
}

/** One ZCode app-server process for one turn (open → configure → send → await events). */
export class ZcodeAppServerClient {
  private rpc: ZcodeRpc | null = null;
  private aborted = false;
  private sessionId: string | null = null;
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private tools = new Map<string, ToolState>();
  private subscribed = false;
  private currentModel: { providerId: string; modelId: string } | null = null;
  /** Background tasks observed via session/read; keyed by native task id. */
  private tasks = new Map<string, BackgroundTask>();
  /** User prompts queued while the transport services background tasks. */
  private promptQueue: string[] = [];
  private wakeIdle?: () => void;
  /** Per-model thought-level ladders from session/create|resume
   *  (`settings.model.available[].reasoning`), keyed `providerId/modelId`. */
  private reasoning = new Map<string, string[]>();
  private turnUsage: ZcodeTurnUsage = {};
  private contextWindow?: number;
  /** input+output of the last single model request — the context watermark.
   *  turn.completed's usage.totalTokens sums every request in the turn, which
   *  on long agentic turns exceeds the model window (billing total, not size). */
  private lastRequestTokens?: number;
  private settleTurn!: (usage: ZcodeTurnUsage) => void;
  private failTurn!: (error: Error) => void;
  /** Resolves when the CURRENT turn ends; reset by every sendTurn — a shared
   *  one-shot promise would make later turns' awaits return instantly (that
   *  bug played the end-of-turn chime before the reply streamed). */
  private turnDone: Promise<ZcodeTurnUsage> = this.freshTurn();
  /** Result blocks emitted per completed turn — gates the runner's fallback. */
  private turnResults = 0;
  /** Wall clock of the last engine-driven (non-vibe) turn start — dedupes the
   *  polling layer's wake prompt against the harness's native notification. */
  private lastNativeTurnAt = 0;
  /** A native turn has started but not completed — keeps the transport alive;
   *  tearing down mid-notification kills the wake content. */
  private nativeTurnActive = false;
  private vibeDrivenTurn = false;
  /** While a vibe-driven turn streams, the service loop is blocked awaiting it —
   *  so task settles are polled here instead and surfaced as mid-turn notices
   *  (the harness folds the notification into the running turn, which has no
   *  turn boundary hub could detect). Consuming the settle also prevents a
   *  redundant polled wake after the turn ends. */
  private midTurnWatcher?: ReturnType<typeof setInterval>;
  private midTurnWatcherBusy = false;

  private freshTurn(): Promise<ZcodeTurnUsage> {
    const pending = new Promise<ZcodeTurnUsage>((resolve, reject) => {
      this.settleTurn = resolve;
      this.failTurn = reject;
    });
    // A turn nobody awaits (e.g. it fails between awaits) must not crash the
    // process with an unhandled rejection.
    pending.catch(() => undefined);
    return pending;
  }

  private startMidTurnWatcher(): void {
    if (this.midTurnWatcher) return;
    this.midTurnWatcher = setInterval(() => {
      if (this.midTurnWatcherBusy) return;
      this.midTurnWatcherBusy = true;
      void this.refreshTasks()
        .then((settled) => {
          for (const task of settled) {
            const desc = task.description?.trim();
            this.cb.onEvent({
              k: 'block',
              block: {
                id: `sys_bg_${task.id}_${Date.now()}`,
                kind: 'system',
                text: desc ? `后台任务「${desc}」完成` : '后台任务完成',
                ts: Date.now(),
              },
            });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.midTurnWatcherBusy = false;
        });
    }, 5_000);
  }

  private stopMidTurnWatcher(): void {
    if (!this.midTurnWatcher) return;
    clearInterval(this.midTurnWatcher);
    this.midTurnWatcher = undefined;
  }

  /** One result footer per completed engine turn — user and wake turns alike,
   *  so sessions with live background tasks keep their per-turn footers instead
   *  of waiting for a run-level block that may never come. The runner's
   *  end-of-run block only covers runs where no turn ever completed. */
  private emitTurnResult(): void {
    this.turnResults += 1;
    this.cb.onEvent({
      k: 'block',
      block: {
        id: `zcode_turn_result_${Date.now()}`,
        kind: 'result',
        durationMs: this.turnUsage.durationMs,
        isError: false,
        subtype: 'success',
        contextUsed: this.turnUsage.contextUsed,
        contextWindow: this.turnUsage.contextWindow,
        ts: Date.now(),
      },
    });
  }

  constructor(
    private readonly opts: ZcodeRunOptions,
    private readonly cb: RunCallbacks,
  ) {}

  abort(): void {
    this.aborted = true;
    if (this.sessionId && this.rpc && !this.rpc.closed) this.rpc.notify('session/stop', { sessionId: this.sessionId });
    this.rpc?.kill();
  }

  async run(): Promise<{ error?: string; usage?: ZcodeTurnUsage; turnResults?: number }> {
    const spawnSpec = buildZcodeSpawn(this.opts);
    if (!spawnSpec.bin) return { error: 'zcode not found — install ZCode or set ZCODE_CLI_PATH' };

    this.rpc = new ZcodeRpc(
      { ...spawnSpec, cwd: this.opts.cwd },
      (id, method, params) => this.handleRequest(id, method, params),
      (method, params) => {
        if (method === 'session/event') this.handleEvent(params);
        // state.updated / v4/telemetry/event carry no turn content — ignored.
      },
      'zcode app-server',
    );

    try {
      await this.openSession();
      this.cb.onClaudeSessionId(this.sessionId!);
      await this.subscribe();
      await this.applySessionConfig();
      this.cb.onTurnState?.(true);
      this.vibeDrivenTurn = true;
      this.startMidTurnWatcher();
      await this.sendTurn();
      // Race the transport exit: a crash or abort must not leave us awaiting
      // turn events that will never arrive.
      const usage = await Promise.race([
        this.turnDone,
        this.rpc.exitPromise.then(() => {
          throw new Error('zcode app-server exited mid-turn');
        }),
      ]);
      // Background tasks are detached OS processes, but only THIS app-server
      // process can manage/cancel them (a new process sees them as "lost") —
      // so the transport stays alive until they settle (codex pattern).
      this.cb.onTurnState?.(false);
      this.vibeDrivenTurn = false;
      this.stopMidTurnWatcher();
      await this.serviceBackgroundActivity();
      return this.aborted ? {} : { usage, turnResults: this.turnResults };
    } catch (error) {
      if (this.aborted) return {};
      const message = error instanceof Error ? error.message : String(error);
      const detail = cleanRemoteStderr(this.rpc.stderr);
      return { error: detail && !message.includes(detail) ? `${message}\n${detail}` : message };
    } finally {
      this.flushStream();
      this.stopMidTurnWatcher();
      await this.rpc.close();
    }
  }

  private async openSession(): Promise<void> {
    const cwd = this.opts.remote ? this.opts.remote.cwd : this.opts.cwd;
    const workspace = { workspaceKey: cwd, workspacePath: cwd };
    if (this.opts.resume) {
      try {
        const resumed = await this.rpc!.request('session/resume', { sessionId: this.opts.resume, workspace });
        const id = asString(resumed?.session?.sessionId) || this.opts.resume;
        this.sessionId = id;
        this.rememberModel(resumed?.settings?.model?.current);
        this.captureReasoning(resumed);
        this.contextWindow = pickContextWindow(resumed) ?? this.contextWindow;
        return;
      } catch (error) {
        log.warn('zcode session/resume failed, starting new session', error);
      }
    }
    const created = await this.rpc!.request('session/create', { workspace });
    const id = asString(created?.session?.sessionId);
    if (!id) throw new Error('session/create did not return sessionId');
    this.sessionId = id;
    this.rememberModel(created?.settings?.model?.current);
    this.captureReasoning(created);
    this.contextWindow = pickContextWindow(created) ?? this.contextWindow;
  }

  private captureReasoning(response: any): void {
    const available = Array.isArray(response?.settings?.model?.available) ? response.settings.model.available : [];
    for (const entry of available) {
      const ref = (entry as { ref?: { providerId?: unknown; modelId?: unknown } })?.ref;
      const providerId = asString(ref?.providerId);
      const modelId = asString(ref?.modelId);
      const reasoning = (entry as { reasoning?: { enabled?: unknown; levels?: unknown } } | undefined)?.reasoning;
      if (!providerId || !modelId || !reasoning || reasoning.enabled !== true) continue;
      const levels = (Array.isArray(reasoning.levels) ? reasoning.levels : [])
        .map((l) => asString((l as { value?: unknown })?.value))
        .filter(Boolean);
      if (levels.length) this.reasoning.set(`${providerId}/${modelId}`, levels);
    }
  }

  private rememberModel(ref: unknown): void {
    const providerId = asString((ref as { providerId?: unknown } | null)?.providerId);
    const modelId = asString((ref as { modelId?: unknown } | null)?.modelId);
    if (providerId && modelId) this.currentModel = { providerId, modelId };
  }

  private async subscribe(): Promise<void> {
    try {
      await this.rpc!.request('session/subscribe', { sessionId: this.sessionId, deliveryKind: 'desktop-continuous' });
      this.subscribed = true;
    } catch (error) {
      // Without a subscription no session/event notifications arrive; sendTurn
      // falls back to polling session/events.
      log.warn('zcode session/subscribe failed, will poll session/events', error);
    }
  }

  private async applySessionConfig(): Promise<void> {
    try {
      await this.rpc!.request('session/setMode', { sessionId: this.sessionId, mode: zcodeModeOf(this.opts.permissionMode) });
    } catch (error) {
      log.debug('zcode session/setMode failed', error);
    }
    const parsed = splitZcodeModel(this.opts.model);
    if (parsed) {
      try {
        await this.rpc!.request('session/setModel', { sessionId: this.sessionId, model: parsed });
      } catch (error) {
        log.debug('zcode session/setModel failed', this.opts.model, error);
      }
    }
    if (this.opts.effort) {
      const model = parsed ?? this.currentModel;
      const ladder = model ? this.reasoning.get(`${model.providerId}/${model.modelId}`) : undefined;
      // Without the ladder, pass the effort through and let ZCode validate it.
      const level = ladder ? nearestThoughtLevel(this.opts.effort, ladder) : this.opts.effort;
      try {
        await this.rpc!.request('session/setThoughtLevel', { sessionId: this.sessionId, thoughtLevel: level });
      } catch (error) {
        log.debug('zcode session/setThoughtLevel failed', level, error);
      }
    }
  }

  private async sendTurn(content: string = this.opts.prompt): Promise<void> {
    this.turnDone = this.freshTurn();
    const params: Record<string, unknown> = { sessionId: this.sessionId, content };
    try {
      await this.rpc!.request('session/send', params);
    } catch (error) {
      // Resumed sessions refuse sends while a stale model restoreWarning is
      // set; the runtimeModel param re-pins the model and clears it.
      if (!isStaleModelError(error)) throw error;
      const model = this.opts.model !== 'auto' ? this.opts.model : modelRefString(this.currentModel);
      const runtimeModel = model ? buildRuntimeModel(model) : null;
      if (!runtimeModel) throw error;
      log.debug('zcode retrying session/send with runtimeModel', model);
      await this.rpc!.request('session/send', { ...params, runtimeModel });
    }
    if (!this.subscribed) void this.pollUntilSettled();
  }

  /** session/events polling fallback for transports without a subscription. */
  private async pollUntilSettled(): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!this.rpc || this.rpc.closed || this.aborted) return;
      let result: any;
      try {
        result = await this.rpc.request('session/events', { sessionId: this.sessionId });
      } catch {
        return;
      }
      const events = Array.isArray(result?.events) ? result.events : [];
      for (const event of events) {
        if (event && typeof event === 'object' && typeof event.type === 'string') this.handleEvent(event);
      }
      // turnDone settled → the promise below already resolved; nothing to wait on.
      if (events.some((event: any) => event?.type === 'turn.completed' || event?.type === 'turn.failed')) return;
    }
  }

  /** Map `projection.backgroundJobs` rows to Vibe tasks (tolerant of drift). */
  private mapZcodeJobs(rows: unknown, now: number): BackgroundTask[] {
    if (!Array.isArray(rows)) return [];
    const out: BackgroundTask[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as Record<string, unknown>;
      const id = typeof rec.taskId === 'string' ? rec.taskId : '';
      if (!id) continue;
      const kindRaw = String(rec.taskKind ?? '').toLowerCase();
      const statusRaw = String(rec.status ?? '').toLowerCase();
      const status: BackgroundTask['status'] =
        statusRaw === 'completed' ? 'completed'
        : statusRaw === 'failed' || statusRaw === 'error' ? 'failed'
        : statusRaw === 'cancelled' || statusRaw === 'canceled' ? 'stopped'
        : 'running';
      const startedAt = Date.parse(String(rec.startedAt ?? '')) || now;
      out.push({
        id,
        agent: 'zcode',
        kind: kindRaw.includes('agent') || kindRaw.includes('subagent') ? 'subagent' : kindRaw.includes('bash') || kindRaw.includes('command') ? 'command' : 'other',
        status,
        description: String(rec.description ?? rec.command ?? '') || `Task ${id}`,
        startedAt,
        updatedAt: now,
        command: typeof rec.command === 'string' ? rec.command : undefined,
        processId: rec.pid != null ? String(rec.pid) : undefined,
        outputFile: typeof rec.outputPath === 'string' ? rec.outputPath : undefined,
        canStop: status === 'running' && rec.cancellable !== false,
      });
    }
    return out;
  }

  /** Last ~4KB of a task's output file (local sessions only — remote output
   *  paths live on the SSH host and are not readable here). */
  private readOutputTail(file: string | undefined): string | undefined {
    if (!file || this.opts.remote) return undefined;
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - 4_096);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8').slice(-4_000);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Refresh from `session/read` → `projection.backgroundJobs` (probed on
   * 0.16.3: taskId/taskKind/command/description/status/pid/outputPath/
   * cancellable). Disappearance from the list is the terminal edge — a
   * finished task is simply no longer managed. Returns newly settled tasks.
   */
  private async refreshTasks(): Promise<BackgroundTask[]> {
    const now = Date.now();
    let rows: unknown = [];
    try {
      const read = await this.rpc!.request('session/read', { sessionId: this.sessionId });
      rows = (read as { projection?: { backgroundJobs?: unknown } })?.projection?.backgroundJobs ?? [];
    } catch (error) {
      log.debug('zcode session/read failed', error);
      return [];
    }
    const current = this.mapZcodeJobs(rows, now);
    const seen = new Set(current.map((task) => task.id));
    const settled: BackgroundTask[] = [];
    for (const task of current) {
      const previous = this.tasks.get(task.id);
      const output = this.readOutputTail(task.outputFile) ?? previous?.output;
      const merged: BackgroundTask = { ...task, output, startedAt: previous?.startedAt ?? task.startedAt };
      if (previous && previous.status === 'running' && merged.status !== 'running') {
        // mapZcodeJobs never sets endedAt; mark the settle edge so hub's wake
        // notice can name the task (it filters by recently ended tasks).
        merged.endedAt = now;
        settled.push(merged);
      }
      this.tasks.set(task.id, merged);
      this.cb.onTask?.(merged);
    }
    for (const [id, previous] of this.tasks) {
      if (!seen.has(id) && previous.status === 'running') {
        const merged: BackgroundTask = {
          ...previous,
          status: 'completed',
          updatedAt: now,
          endedAt: now,
          canStop: false,
          output: this.readOutputTail(previous.outputFile) ?? previous.output,
        };
        this.tasks.set(id, merged);
        this.cb.onTask?.(merged);
        settled.push(merged);
      }
    }
    return settled;
  }

  /**
   * Queue a user prompt on the still-live transport (hub's sendMessage path —
   * this is what lets the user keep chatting while background tasks run).
   * Returns false when the transport is closing and the caller should start a
   * fresh run instead.
   */
  queueMessage(text: string): boolean {
    if (this.aborted || !text.trim() || !this.rpc || this.rpc.closed) return false;
    this.promptQueue.push(text);
    this.wakeIdle?.();
    return true;
  }

  /** Sleep that a queued prompt can cut short. */
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

  /** Master/slave vs Vibot: when this Vibe session was just woken via a
   *  delegate watcher, Vibot's silent turn owns the follow-up (full summary
   *  prompt). This poller must not start a second turn for the same settle —
   *  native harness turns may still appear (uncancellable); we only skip our
   *  polled duplicate. The wake prompt is already on Vibot via markDelegateWake. */
  private async serviceBackgroundActivity(): Promise<void> {
    // No cap by default — closing the transport orphans running tasks (a new
    // app-server cannot adopt them), and an idle connection polling every
    // 2.5s is cheap. Set VIBE_ZCODE_TASK_SERVICE_HOURS to bound it (hours;
    // unset/0 = unlimited).
    const capHours = Number(process.env.VIBE_ZCODE_TASK_SERVICE_HOURS || 0);
    const deadline = capHours > 0 ? Date.now() + capHours * 60 * 60_000 : Infinity;
    const vibeSessionId = this.opts.vibeSessionId;
    const runQueuedTurn = async (content: string): Promise<void> => {
      this.cb.onTurnState?.(true);
      this.vibeDrivenTurn = true;
      this.startMidTurnWatcher();
      try {
        await this.sendTurn(content);
        await Promise.race([
          this.turnDone,
          this.rpc!.exitPromise.then(() => {
            throw new Error('zcode app-server exited mid-turn');
          }),
        ]);
      } finally {
        this.vibeDrivenTurn = false;
        this.stopMidTurnWatcher();
        this.cb.onTurnState?.(false);
      }
    };
    for (;;) {
      const settled = await this.refreshTasks();
      if (settled.length) {
        // The harness ALSO pushes a native task-notification that starts its own
        // turn; give that immediate channel a short grace so one completion
        // doesn't wake the model twice (two dividers, two replies).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const vibotOwns = isDelegateWakeActive(vibeSessionId);
        const nativeSeen = this.nativeTurnActive || Date.now() - this.lastNativeTurnAt < 10_000;
        if (vibotOwns) {
          // Vibot silent wake is the master follow-up for managed delegates —
          // skip the polled duplicate. Native harness turns may still fire
          // (we can't cancel them); we just don't add a second Vibe-driven turn.
          // Content lives on Vibot via markDelegateWake + vibotHub.wake; if
          // native raced ahead, peekDelegateWakePrompt confirms the summary was
          // already captured for the Vibot turn (no coding-side reinject).
          const captured = peekDelegateWakePrompt(vibeSessionId);
          log.info(
            captured
              ? 'zcode deferring task wake to Vibot delegate follow-up (prompt captured)'
              : 'zcode deferring task wake to Vibot delegate follow-up',
          );
        } else if (!nativeSeen) {
          const details = settled
            .map((task) => `- ${task.id}: ${task.status} — ${task.description}\n${(task.error || task.output || '(no output)').slice(0, 8_000)}`)
            .join('\n\n');
          // Pushed to the TAIL: a user prompt already waiting runs first.
          this.promptQueue.push(
            `<background-task-notification>\n${details}\n</background-task-notification>\n` +
            'The background task state changed while you were idle. Inspect the result, continue any dependent work, and reply with the updated outcome.',
          );
        } else {
          log.info('zcode native task notification is steering the wake; polled prompt skipped');
        }
      }
      const prompt = this.promptQueue.shift();
      if (prompt) {
        try {
          await runQueuedTurn(prompt);
        } catch (error) {
          log.warn('zcode background-task turn failed', error);
        }
        continue;
      }
      // An in-flight native notification turn must finish before the transport
      // may close — tearing down mid-turn kills the wake content.
      const active =
        this.nativeTurnActive ||
        [...this.tasks.values()].some((task) => task.status === 'running' || task.status === 'pending');
      if (!active || this.aborted || Date.now() > deadline) {
        log.info(`zcode transport closing (active=${active} aborted=${this.aborted})`);
        if (active && !this.aborted) log.warn(`zcode background tasks still running after ${capHours}h — closing transport (tasks continue unmanaged)`);
        return;
      }
      await this.waitForWork(2_500);
    }
  }

  /** Stop one background task (only while this transport is alive). */
  async stopTask(taskId: string): Promise<void> {
    try {
      await this.rpc!.request('session/cancelBackgroundTask', { sessionId: this.sessionId, taskId });
    } catch (error) {
      log.debug('zcode session/cancelBackgroundTask failed', taskId, error);
    }
    await this.refreshTasks();
  }

  private handleRequest(id: JsonRpcId, method: string, params: any): void {
    try {
      if (method === 'session/requestRuntimePreferences') {
        this.rpc!.respond(id, { nativeSearchEnhancementsEnabled: false });
        return;
      }
      if (method === 'interaction/requestPermission') {
        void this.handlePermission(params).then(
          (reply) => this.rpc?.respond(id, reply),
          () => this.rpc?.respond(id, { decision: 'deny', reason: 'vibe permission handler failed' }),
        );
        return;
      }
      if (method === 'interaction/requestUserInput') {
        // ZCode routes ExitPlanMode approval AND AskUserQuestion through this
        // channel (not requestPermission). An empty reply reads as "decline",
        // so every branch must answer with an explicit action.
        void this.handleUserInput(params).then(
          (reply) => this.rpc?.respond(id, reply),
          () => this.rpc?.respond(id, { action: 'decline' }),
        );
        return;
      }
      this.rpc!.respond(id, {});
    } catch (error) {
      log.warn('zcode app-server request handler failed', method, error);
      this.rpc?.respond(id, {});
    }
  }

  private async handlePermission(params: any): Promise<unknown> {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const pick = (pred: (option: any) => boolean) => options.find(pred);
    if (this.aborted) {
      return pick((o) => o?.optionId === 'deny')?.response ?? { decision: 'deny', reason: 'aborted' };
    }
    // Always-approve: never surface a prompt even if the session was created
    // before yolo mode was applied.
    if (this.opts.permissionMode === 'bypassPermissions') {
      const allow = pick((o) => o?.optionId === 'allow_once') ?? pick((o) => /allow/i.test(String(o?.optionId ?? o?.kind ?? '')));
      return allow?.response ?? { decision: 'allow', reason: 'bypass' };
    }
    const input = params?.input && typeof params?.input === 'object' ? params.input : { value: params?.input };
    const plan = typeof (input as { plan?: unknown }).plan === 'string' ? (input as { plan: string }).plan : undefined;
    const request: PermissionRequest = {
      requestId: asString(params?.requestId) || crypto.randomUUID(),
      toolName: asString(params?.toolName) || 'tool',
      input,
      plan,
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    return this.permissionReply(options, decision);
  }

  /**
   * `interaction/requestUserInput` carries two shapes (probed on 0.16.3):
   *  - Plan approval: `schema.interaction === 'plan_approval'`; `input` is the
   *    ExitPlanMode tool input (`{plan, allowedPrompts?}`). Mapped to Vibe's
   *    ExitPlanMode permission so the web shows the plan-review modal.
   *  - AskUserQuestion: `schema.toolName` only; `questions` with labeled
   *    options. Answers return as `{action:'accept', content:{answers}}`.
   * Replies must carry an explicit action — anything else (including `{}`)
   * reads as "decline" (`Npa` in the zcode bundle).
   */
  private async handleUserInput(params: any): Promise<unknown> {
    if (this.aborted) return { action: 'decline' };
    // Bypass mode never surfaces prompts (matches the requestPermission path).
    if (this.opts.permissionMode === 'bypassPermissions') return { action: 'accept', content: {} };

    const questions: any[] = Array.isArray(params?.questions) ? params.questions : [];
    const isPlanApproval =
      params?.schema?.interaction === 'plan_approval'
      || questions.some((q) => q?.header === 'Plan' || /implementation plan/i.test(String(q?.question ?? '')));
    const input = asRecord(params?.input) ?? {};

    if (isPlanApproval) {
      const request: PermissionRequest = {
        requestId: asString(params?.requestId) || crypto.randomUUID(),
        toolName: 'ExitPlanMode',
        input,
        plan: typeof input.plan === 'string' ? input.plan : undefined,
        ts: Date.now(),
      };
      const decision = await this.cb.requestPermission(request);
      return decision.allow ? { action: 'accept', content: {} } : { action: 'decline' };
    }

    const mapped = questions
      .filter((q) => Array.isArray(q?.options) && q.options.length)
      .map((q) => ({
        question: asString(q.question) || 'Question',
        header: asString(q.header) || undefined,
        multiSelect: q.multiSelect === true,
        options: q.options.map((o: any) => ({
          label: asString(o?.label) || asString(o?.value),
          description: asString(o?.description) || undefined,
          preview: asString(o?.preview) || undefined,
        })),
      }));
    if (!mapped.length) {
      log.debug('zcode interaction/requestUserInput has no answerable questions', JSON.stringify(params).slice(0, 300));
      return { action: 'decline' };
    }
    const request: PermissionRequest = {
      requestId: asString(params?.requestId) || crypto.randomUUID(),
      toolName: 'AskUserQuestion',
      input: { questions: mapped, source: 'zcode' },
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    if (!decision.allow) return { action: 'decline' };
    const answers = (asRecord(decision.updatedInput) ?? {}).answers;
    return { action: 'accept', content: answers && typeof answers === 'object' ? { answers } : {} };
  }

  /** The reply is the chosen option's `response` object, verbatim. */
  private permissionReply(options: any[], decision: PermissionDecision): unknown {
    if (!decision.allow) {
      const deny = options.find((o) => o?.optionId === 'deny') ?? options.find((o) => /deny|reject/i.test(String(o?.optionId ?? o?.kind ?? '')));
      return deny?.response ?? { decision: 'deny', reason: 'Denied by user' };
    }
    if (decision.remember) {
      const always = options.find((o) => o?.optionId === 'allow_project') ?? options.find((o) => o?.kind === 'allow_always');
      if (always?.response) return always.response;
    }
    const once = options.find((o) => o?.optionId === 'allow_once') ?? options.find((o) => o?.kind === 'allow_once');
    return once?.response ?? { decision: 'allow', reason: 'Approved once' };
  }

  private handleEvent(envelope: any): void {
    if (!envelope || typeof envelope !== 'object') return;
    const sessionId = asString(envelope.sessionId);
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
    const type = asString(envelope.type);
    const payload = envelope.payload;
    const eventWindow = pickContextWindow(payload);
    if (eventWindow) this.contextWindow = eventWindow;
    // Model-response payloads (content + usage) and usage.delta events carry
    // per-request usage; turn.completed does not (its usage is turn-cumulative),
    // so only those update the watermark.
    const requestUsage = asRecord(payload?.usage);
    if (requestUsage && (payload?.content != null || payload?.kind === 'usage.delta' || type === 'usage.delta')) {
      const input = typeof requestUsage.inputTokens === 'number' ? requestUsage.inputTokens : 0;
      const output = typeof requestUsage.outputTokens === 'number' ? requestUsage.outputTokens : 0;
      if (input + output > 0) this.lastRequestTokens = input + output;
    }
    switch (type) {
      case 'model.streaming':
        this.handleStreamPayload(payload);
        return;
      case 'tool.updated':
        this.handleToolUpdated(payload);
        return;
      case 'turn.started':
        // Turns the harness starts on its own (native task notifications) —
        // remembered so the polling layer can skip its duplicate wake prompt.
        if (!this.vibeDrivenTurn) {
          this.lastNativeTurnAt = Date.now();
          this.nativeTurnActive = true;
        }
        return;
      case 'turn.completed': {
        this.nativeTurnActive = false;
        this.flushStream();
        const usage = asRecord(payload?.usage);
        this.turnUsage = {
          durationMs: typeof payload?.duration === 'number' ? payload.duration : undefined,
          contextUsed: this.lastRequestTokens
            ?? (typeof usage?.totalTokens === 'number' ? usage.totalTokens : undefined),
          contextWindow: this.contextWindow,
        };
        this.emitTurnResult();
        this.settleTurn(this.turnUsage);
        return;
      }
      case 'turn.failed': {
        this.nativeTurnActive = false;
        this.flushStream();
        const error = payload?.error ?? payload?.message ?? payload;
        this.failTurn(new Error(typeof error === 'string' ? error : JSON.stringify(error).slice(0, 500)));
        return;
      }
      default:
        // turn.started / session.* / usage.delta / streamRecovery.updated — no
        // block content worth surfacing.
        return;
    }
  }

  private handleStreamPayload(payload: any): void {
    const kind = asString(payload?.kind);
    const delta = asString(payload?.delta);
    if (kind === 'text_delta') {
      if (delta) this.segment('assistant', delta);
      return;
    }
    if (kind === 'reasoning_delta') {
      if (delta) this.segment('thinking', delta);
      return;
    }
    if (kind === 'tool_input_start') {
      this.flushStream();
      this.upsertTool(asString(payload?.toolCallId), { name: asString(payload?.toolName) || 'tool', status: 'running' });
      return;
    }
    if (kind === 'tool_call') {
      this.flushStream();
      const input = asRecord(payload?.input);
      this.upsertTool(asString(payload?.toolCallId), {
        name: asString(payload?.toolName) || 'tool',
        status: 'running',
        ...(input ? { input } : {}),
      });
      return;
    }
    // tool_input_delta / tool_input_end — the parsed input arrives via tool_call.
  }

  private handleToolUpdated(payload: any): void {
    const kind = asString(payload?.kind);
    if (kind === 'result') {
      const result = payload?.result;
      const content = typeof result?.content === 'string'
        ? result.content
        : result != null
          ? JSON.stringify(result).slice(0, 8000)
          : undefined;
      this.upsertTool(asString(payload?.toolCallId), {
        status: result?.success === false ? 'error' : 'done',
        ...(content !== undefined ? { result: content } : {}),
      });
      return;
    }
    if (kind === 'scheduled' || kind === 'started') {
      this.upsertTool(asString(payload?.toolCallId), {
        ...(asString(payload?.toolName) ? { name: asString(payload?.toolName) } : {}),
        status: 'running',
      });
    }
    // 'batch' is a completion summary for a group of tool calls.
  }

  private upsertTool(toolCallId: string, patch: Partial<ToolState> & { name?: string }): void {
    if (!toolCallId) return;
    this.flushStream();
    const previous = this.tools.get(toolCallId);
    const name = patch.name ?? previous?.name ?? 'tool';
    const input = patch.input ?? previous?.input ?? {};
    const status = patch.status ?? previous?.status ?? 'running';
    const result = patch.result ?? previous?.result;
    const state: ToolState = { name, input, status, result };
    this.tools.set(toolCallId, state);
    this.cb.onEvent({
      k: 'block',
      block: {
        id: toolCallId,
        kind: 'tool',
        toolUseId: toolCallId,
        name,
        input,
        status,
        result: result || undefined,
        isError: status === 'error',
        ts: Date.now(),
      },
    });
    if (status === 'done' || status === 'error') {
      this.cb.onEvent({
        k: 'tool_result',
        toolUseId: toolCallId,
        content: result || (status === 'error' ? 'failed' : ''),
        isError: status === 'error',
      });
    }
  }

  private segment(kind: 'assistant' | 'thinking', text: string): void {
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (!this.stream) {
      const id = `zcode_${kind === 'assistant' ? 'as' : 'th'}_${crypto.randomUUID()}`;
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
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function modelRefString(ref: { providerId: string; modelId: string } | null): string {
  return ref ? `${ref.providerId}/${ref.modelId}` : '';
}
