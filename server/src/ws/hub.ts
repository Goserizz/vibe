import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { log } from '../log.js';
import { startRun, type RunHandle } from '../claude/runner.js';
import { startCursorRun } from '../cursor/runner.js';
import { resolveCursorSessionSync } from '../cursor/discovery.js';
import {
  CursorTranscriptBuilder,
  appendCursorBlocks,
  readCursorStoreTranscript,
  readCursorTranscript,
} from '../cursor/transcript.js';
import { startCodexRun } from '../codex/runner.js';
import { resolveCodexSessionSync } from '../codex/discovery.js';
import {
  appendCodexBlocks,
  readCodexRolloutTranscript,
  readCodexTranscript,
} from '../codex/transcript.js';
import { startKimiRun } from '../kimi/runner.js';
import { resolveKimiSessionSync } from '../kimi/discovery.js';
import {
  appendKimiBlocks,
  readKimiTranscript,
  readKimiWireTranscript,
} from '../kimi/transcript.js';
import { startKiroRun } from '../kiro/runner.js';
import { resolveKiroSessionSync } from '../kiro/discovery.js';
import {
  appendKiroBlocks,
  readKiroNativeTranscript,
  readKiroTranscript,
} from '../kiro/transcript.js';
import { readTranscriptBlocks } from '../sessions/transcript.js';
import { resolveClaudeSessionSync } from '../sessions/discovery.js';
import { readRemoteAgentTranscript, readRemoteTranscript } from '../remote/discovery.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { mcpRegistry } from '../mcp/registry.js';
import { parseSessionId } from '../remote/sessionId.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import type {
  AgentKind,
  AssistantBlock,
  BackgroundTask,
  ChatBlock,
  EffortLevel,
  LiveEvent,
  McpServerDef,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ServerEvent,
  SessionMeta,
  ThinkingBlock,
} from '../../../shared/protocol.js';

interface RuntimeInit {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  title: string;
  claudeSessionId?: string;
  /** Which CLI engine drives the session. */
  agent: AgentKind;
  /** Remote host name (display); undefined for local sessions. */
  host?: string;
  /** SSH target for remote sessions; undefined runs locally via the SDK. */
  sshTarget?: string;
  /** Per-host HTTP(S) proxy injected into the remote agent's env. */
  proxy?: string;
}

/** Cached resolution for a remote session so the (sync) hub can build runtimes. */
interface RemoteSessionInfo {
  host: string;
  sshTarget: string;
  cwd: string;
  model: string;
  title: string;
  agent?: AgentKind;
  proxy?: string;
}

/** Newer events are kept; older ones are evicted once the log passes this size. */
const LOG_CAP = 5000;
/** Above this socket backlog we drop best-effort `delta` frames (text is
 *  reconciled by the authoritative `block` event), but never structural ones. */
const DELTA_BACKPRESSURE_BYTES = 512 * 1024;

function isActiveBackgroundTask(task: BackgroundTask): boolean {
  return task.status === 'pending' || task.status === 'running' || task.status === 'paused';
}

/**
 * A live-event subscriber. Web clients use {@link WsConn}; in-process consumers
 * (e.g. the Telegram bot) use {@link CallbackConn}.
 */
export abstract class Conn {
  readonly id = crypto.randomUUID();
  readonly subscriptions = new Set<string>();

  abstract send(msg: ServerEvent): void;

  /** Outbound socket backlog; non-WS conns report 0 so deltas are never dropped. */
  get bufferedAmount(): number {
    return 0;
  }
}

export class WsConn extends Conn {
  constructor(readonly ws: WebSocket) {
    super();
  }

  send(msg: ServerEvent): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  override get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }
}

/** In-process subscriber — used by the Telegram bot (and any future adapters). */
export class CallbackConn extends Conn {
  constructor(private readonly onMsg: (msg: ServerEvent) => void) {
    super();
  }

  send(msg: ServerEvent): void {
    this.onMsg(msg);
  }
}

interface LoggedEvent {
  seq: number;
  ev: LiveEvent;
}

type MetaListener = () => void;

/**
 * Per-session live state: a seq-tagged event log for lossless replay, the set
 * of subscribed connections, the active run, and pending permission prompts.
 */
class SessionRuntime {
  seq = 0;
  running = false;
  claudeSessionId?: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  title: string;
  readonly agent: AgentKind;
  readonly host?: string;
  readonly sshTarget?: string;
  readonly proxy?: string;
  lastActivity = Date.now();
  readonly subscribers = new Set<Conn>();
  readonly allowedTools = new Set<string>();
  readonly pending = new Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }>();
  readonly tasks = new Map<string, BackgroundTask>();

  private logBuf: LoggedEvent[] = [];
  /** Kind of each still-streaming block id (assistant/thinking), so a finalized
   *  block can be rebuilt for replay even if its opening event was evicted. */
  private streamKinds = new Map<string, 'assistant' | 'thinking'>();
  private runBaseSeq = 0;
  private baselineClaudeSessionId?: string;
  private run?: RunHandle;
  private runUserTurns = 0;
  /** Headless CLI sessions persist normalized transcripts; this accumulates the turn. */
  private transcript?: CursorTranscriptBuilder;
  private turnStartBlocks = 0;

  constructor(
    readonly sessionId: string,
    init: RuntimeInit,
    private readonly onMeta: MetaListener,
  ) {
    this.cwd = init.cwd;
    this.model = init.model;
    this.permissionMode = init.permissionMode;
    this.effort = init.effort;
    this.title = init.title;
    this.claudeSessionId = init.claudeSessionId;
    this.agent = init.agent;
    this.host = init.host;
    this.sshTarget = init.sshTarget;
    this.proxy = init.proxy;
    // Headless CLI agents self-persist through the shared LiveEvent→blocks accumulator.
    if (this.agent === 'cursor' || this.agent === 'codex' || this.agent === 'kimi' || this.agent === 'kiro') {
      this.transcript = new CursorTranscriptBuilder();
    }
    // Preserve the existing history before a native Kimi/Kiro session is adopted:
    // subsequent snapshots prefer Vibe's normalized transcript.
    if (this.agent === 'kimi' && init.claudeSessionId && readKimiTranscript(this.sessionId).length === 0) {
      appendKimiBlocks(this.sessionId, readKimiWireTranscript(init.claudeSessionId));
    }
    if (this.agent === 'kiro' && init.claudeSessionId && readKiroTranscript(this.sessionId).length === 0) {
      appendKiroBlocks(this.sessionId, readKiroNativeTranscript(init.claudeSessionId));
    }
  }

  private emit(ev: LiveEvent): void {
    this.seq += 1;
    const entry: LoggedEvent = { seq: this.seq, ev };
    this.logBuf.push(entry);
    // Mirror events into the normalized transcript accumulator (before pruning).
    this.transcript?.apply(ev);
    // Remember the kind of every in-flight streamed block so a finalized block
    // can still be reconstructed if its opening event has been evicted.
    if (ev.k === 'block' && (ev.block.kind === 'assistant' || ev.block.kind === 'thinking') && ev.block.streaming) {
      this.streamKinds.set(ev.block.id, ev.block.kind);
    }
    this.foldFinalized(ev);
    if (this.logBuf.length > LOG_CAP) this.logBuf.splice(0, this.logBuf.length - LOG_CAP);
    const frame: ServerEvent = { t: 'event', sessionId: this.sessionId, seq: this.seq, ev };
    const skippable = ev.k === 'delta';
    for (const conn of this.subscribers) {
      if (skippable && conn.bufferedAmount > DELTA_BACKPRESSURE_BYTES) continue;
      conn.send(frame);
    }
  }

  /**
   * When a streamed block finalizes, *fold* its deltas into the block event
   * already in the log rather than dropping it: the log stays small **and**
   * every finished block remains self-contained.
   *
   * Dropping the opening `block` event (as an earlier version did) left only a
   * `block_end`, which a client replaying from before the block started has no
   * block to apply — so assistant text that streamed while the session sat in
   * the background disappeared until the page refetched the transcript.
   */
  private foldFinalized(ev: LiveEvent): void {
    let id: string | undefined;
    let finalText: string | undefined;
    if (ev.k === 'block' && (ev.block.kind === 'assistant' || ev.block.kind === 'thinking') && !ev.block.streaming) {
      id = ev.block.id;
      finalText = ev.block.text;
    } else if (ev.k === 'block_end') {
      id = ev.id;
      finalText = ev.text;
    }
    if (!id) return;
    const targetId = id;

    const next: LoggedEvent[] = [];
    // Index (in `next`) of the streaming `block` event we fold into, plus the
    // text accumulated from its deltas (a fallback when the finalizer has none).
    let openAt = -1;
    let streamed: string | undefined;
    for (const e of this.logBuf) {
      const evt = e.ev;
      if (evt.k === 'block' && evt.block.id === targetId && 'streaming' in evt.block && evt.block.streaming) {
        openAt = next.length;
        streamed = (evt.block as AssistantBlock | ThinkingBlock).text;
        next.push(e);
        continue;
      }
      if (evt.k === 'delta' && evt.id === targetId) {
        if (streamed !== undefined) streamed += evt.chunk;
        continue; // folded into the block event below
      }
      next.push(e);
    }

    if (openAt >= 0) {
      const open = next[openAt];
      const block = (open.ev as { k: 'block'; block: ChatBlock }).block as AssistantBlock | ThinkingBlock;
      const text = finalText ?? streamed ?? block.text;
      next[openAt] = { seq: open.seq, ev: { k: 'block', block: { ...block, text, streaming: false } } };
    } else if (ev.k === 'block_end' && finalText != null) {
      // The opening event was evicted (very long turn): rebuild an authoritative
      // block in place of the `block_end` so replay still carries the text.
      const kind = this.streamKinds.get(targetId);
      if (kind && next.length) {
        const last = next[next.length - 1];
        next[next.length - 1] = {
          seq: last.seq,
          ev: { k: 'block', block: { id: targetId, kind, text: finalText, streaming: false, ts: Date.now() } },
        };
      }
    }

    this.streamKinds.delete(targetId);
    this.logBuf = next;
  }

  /** Replay everything after `lastSeq`. Returns false if there's a gap (reset). */
  replay(conn: Conn, lastSeq: number): boolean {
    const oldest = this.logBuf.length ? this.logBuf[0].seq : this.seq + 1;
    const gap = lastSeq > 0 && lastSeq + 1 < oldest && lastSeq < this.seq;
    if (gap) return false;
    // A client ahead of our own seq is holding state from an older runtime
    // incarnation (this runtime was GC'd, or the server restarted). Its blocks
    // can't be reconciled by replay — make it reload the transcript.
    if (lastSeq > this.seq) return false;
    for (const entry of this.logBuf) {
      if (entry.seq > lastSeq) {
        conn.send({ t: 'event', sessionId: this.sessionId, seq: entry.seq, ev: entry.ev });
      }
    }
    return true;
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  taskList(): BackgroundTask[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  hasActiveBackgroundTasks(): boolean {
    return [...this.tasks.values()].some(isActiveBackgroundTask);
  }

  private upsertTask(task: BackgroundTask): void {
    const wasRunning = this.hasActiveBackgroundTasks();
    const previous = this.tasks.get(task.id);
    const merged: BackgroundTask = previous ? { ...previous, ...task } : task;
    this.tasks.set(task.id, merged);
    this.lastActivity = Date.now();
    this.emit({ k: 'task_upsert', task: merged });
    if (wasRunning !== this.hasActiveBackgroundTasks()) this.onMeta();
  }

  /** `running` means a foreground model turn is producing a reply. The agent
   *  transport can remain alive with this false while background tasks run. */
  private setForegroundRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.lastActivity = Date.now();
    this.emit({ k: 'run_state', running });
    this.onMeta();
  }

  /**
   * Decide which transcript to read and the seq to subscribe from, for a
   * freshly opening client. The hub reads the transcript (locally or over SSH).
   *  - live transport: stable history from before it started + replay its events.
   *  - closed transport: the latest transcript contains everything; skip replay.
   */
  snapshotPlan(storeClaudeSessionId: string | undefined): { claudeSessionId?: string; seq: number } {
    if (this.run) {
      return { claudeSessionId: this.baselineClaudeSessionId ?? storeClaudeSessionId, seq: this.runBaseSeq };
    }
    return { claudeSessionId: this.claudeSessionId ?? storeClaudeSessionId, seq: this.seq };
  }

  startTurn(text: string, clientMsgId: string): boolean {
    if (this.running) return false;

    // Claude SDK, Kimi ACP, and Codex App Server remain connected while native
    // tasks run. Steer a new user message through that connection instead of
    // rejecting it or starting a competing process for the same session.
    if (this.run) {
      if (!this.run.sendMessage?.(text)) return false;
      this.runUserTurns += 1;
      this.setForegroundRunning(true);
      this.emit({ k: 'block', block: { id: clientMsgId, kind: 'user', text, ts: Date.now() } });
      return true;
    }

    // Pick up the latest model/permission/cwd (header changes write to the store).
    const stored = sessionStore.get(this.sessionId);
    const cwd = stored?.cwd ?? this.cwd;
    const model = stored?.model ?? this.model;
    const permissionMode = stored?.permissionMode ?? this.permissionMode;
    const effort = stored?.effort ?? this.effort;

    this.runBaseSeq = this.seq;
    this.baselineClaudeSessionId = this.claudeSessionId;
    this.turnStartBlocks = this.transcript?.blocks.length ?? 0;
    this.runUserTurns = 1;
    this.lastActivity = Date.now();

    const where = this.sshTarget ? `host=${this.host}` : 'local';
    log.debug(`turn start session=${this.sessionId} agent=${this.agent} ${where} resume=${this.claudeSessionId ?? 'new'} model=${model} cwd=${cwd}`);
    this.setForegroundRunning(true);
    this.emit({ k: 'block', block: { id: clientMsgId, kind: 'user', text, ts: Date.now() } });

    const runOpts = {
      prompt: text,
      cwd,
      model,
      permissionMode,
      effort,
      resume: this.claudeSessionId,
      allowedTools: [...this.allowedTools],
    };
    // Resolve MCP servers fresh per turn from the registry, scoped to this
    // session's host (or 'local'). Editing MCP config applies to the next turn.
    const mcpServers: McpServerDef[] = mcpRegistry.resolveForScope(this.host ?? 'local');
    const cb = {
      onEvent: (ev: LiveEvent) => this.emit(ev),
      onClaudeSessionId: (id: string) => {
        if (id && id !== this.claudeSessionId) this.claudeSessionId = id;
      },
      requestPermission: (request: PermissionRequest) => this.requestPermission(request),
      onTask: (task: BackgroundTask) => this.upsertTask(task),
      onTurnState: (running: boolean) => this.setForegroundRunning(running),
    };

    if (this.agent === 'cursor') {
      this.run = startCursorRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          resume: this.claudeSessionId,
          mcpServers,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else if (this.agent === 'codex') {
      this.run = startCodexRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          effort,
          resume: this.claudeSessionId,
          mcpServers,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else if (this.agent === 'kimi') {
      this.run = startKimiRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          resume: this.claudeSessionId,
          mcpServers,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else if (this.agent === 'kiro') {
      this.run = startKiroRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          effort,
          resume: this.claudeSessionId,
          mcpServers,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else {
      this.run = this.sshTarget
        ? startRun({ ...runOpts, mcpServers, remote: { sshTarget: this.sshTarget, cwd, proxy: this.proxy } }, cb)
        : startRun({ ...runOpts, mcpServers }, cb);
    }

    const activeRun = this.run;
    void activeRun.done.then(() => this.finishTurn(activeRun));
    return true;
  }

  private finishTurn(run: RunHandle): void {
    if (this.run !== run) return;
    this.run = undefined;
    this.setForegroundRunning(false);
    this.lastActivity = Date.now();
    this.streamKinds.clear();
    // Kimi's detached task manager intentionally lets work outlive the ACP turn;
    // its monitor owns the terminal transition. Other runners keep their
    // transport alive until native tasks settle, so an active task left when
    // those transports end really is an interrupted/orphaned run.
    if (this.agent !== 'kimi') {
      for (const task of [...this.tasks.values()]) {
        if (isActiveBackgroundTask(task)) {
          this.upsertTask({ ...task, status: 'stopped', updatedAt: Date.now(), endedAt: Date.now(), canStop: false });
        }
      }
    }
    // Cancel any still-pending permission prompts.
    for (const [, p] of this.pending) p.resolve({ allow: false });
    this.pending.clear();
    // Headless CLI sessions self-persist: append this turn's blocks to Vibe JSONL.
    if (this.transcript) {
      const blocks = this.transcript.blocks.slice(this.turnStartBlocks);
      if (this.agent === 'codex') appendCodexBlocks(this.sessionId, blocks);
      else if (this.agent === 'kimi') appendKimiBlocks(this.sessionId, blocks);
      else if (this.agent === 'kiro') appendKiroBlocks(this.sessionId, blocks);
      else appendCursorBlocks(this.sessionId, blocks);
    }

    const userTurns = Math.max(1, this.runUserTurns);
    this.runUserTurns = 0;
    const stored = sessionStore.get(this.sessionId);
    if (stored) {
      sessionStore.update(this.sessionId, {
        claudeSessionId: this.claudeSessionId,
        messageCount: stored.messageCount + userTurns,
      });
    } else {
      // A discovered CLI session we just continued — adopt it into Vibe.
      sessionStore.adopt({
        id: this.sessionId,
        claudeSessionId: this.claudeSessionId ?? parseSessionId(this.sessionId).claudeSessionId,
        cwd: this.cwd,
        title: this.title,
        model: this.model,
        permissionMode: this.permissionMode,
        effort: this.effort,
        agent: this.agent,
        messageCount: userTurns,
        host: this.host,
      });
    }
    this.onMeta();
  }

  private requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.requestId, { request, resolve });
      const frame: ServerEvent = { t: 'permission_request', sessionId: this.sessionId, request };
      for (const conn of this.subscribers) conn.send(frame);
    });
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(decision);
    const outcome = decision.allow ? 'allow' : 'deny';
    const frame: ServerEvent = { t: 'permission_resolved', sessionId: this.sessionId, requestId, decision: outcome };
    for (const conn of this.subscribers) conn.send(frame);
    return true;
  }

  abort(): void {
    if (!this.running) return;
    // A permission callback is part of the foreground turn. Resolve it before
    // interrupting so the runner cannot remain blocked on Vibe after Stop.
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ allow: false });
      const frame: ServerEvent = {
        t: 'permission_resolved',
        sessionId: this.sessionId,
        requestId,
        decision: 'deny',
      };
      for (const conn of this.subscribers) conn.send(frame);
    }
    this.pending.clear();
    this.run?.abort();
  }

  async stopTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || !task.canStop || !this.run?.stopTask) return false;
    try {
      await this.run.stopTask(taskId);
      return true;
    } catch (error) {
      log.warn(`task stop failed session=${this.sessionId} task=${taskId}`, error);
      return false;
    }
  }

  hasActivity(): boolean {
    return Boolean(this.run) || this.hasActiveBackgroundTasks() || this.subscribers.size > 0 || this.pending.size > 0;
  }

  hasLiveRun(): boolean {
    return Boolean(this.run);
  }
}

export class Hub {
  private runtimes = new Map<string, SessionRuntime>();
  private conns = new Set<Conn>();
  /** Resolved remote-session info (populated by the API on list/open) so the
   *  synchronous hub can build remote runtimes without an SSH round-trip. */
  private remoteCache = new Map<string, RemoteSessionInfo>();

  /** Called by the API when it discovers/opens a remote session. */
  cacheRemoteSession(sessionId: string, info: RemoteSessionInfo): void {
    this.remoteCache.set(sessionId, info);
  }

  private runtimeFor(sessionId: string): SessionRuntime | undefined {
    let rt = this.runtimes.get(sessionId);
    if (rt) return rt;

    const init = this.resolveInit(sessionId);
    if (!init) return undefined;

    rt = new SessionRuntime(sessionId, init, () => this.broadcastMeta(sessionId));
    this.runtimes.set(sessionId, rt);
    return rt;
  }

  private resolveInit(sessionId: string): RuntimeInit | undefined {
    const stored = sessionStore.get(sessionId);
    const { host, claudeSessionId } = parseSessionId(sessionId);
    const defaultEffort = config.defaultEffort as EffortLevel;

    if (host) {
      // Remote session. Need the SSH target (from the host registry) plus
      // cwd/model from the store (adopted) or the discovery cache (just-listed).
      const remoteHost = hostRegistry.get(host);
      if (!remoteHost) return undefined;
      if (stored) {
        // Use only the real Claude session id we've captured (undefined for a
        // brand-new session → fresh turn). Never fall back to the app id, which
        // isn't a real Claude session and would make `--resume` fail.
        const agent = stored.agent ?? 'claude';
        return {
          cwd: stored.cwd, model: stored.model, permissionMode: stored.permissionMode,
          effort: stored.effort ?? defaultEffort, title: stored.title, claudeSessionId: stored.claudeSessionId,
          agent, host, sshTarget: remoteHost.ssh, proxy: proxyForAgent(remoteHost, agent),
        };
      }
      const cached = this.remoteCache.get(sessionId);
      if (!cached) return undefined;
      return {
        cwd: cached.cwd, model: cached.model, permissionMode: 'default', effort: defaultEffort,
        title: cached.title, claudeSessionId, agent: cached.agent ?? 'claude', host, sshTarget: cached.sshTarget, proxy: cached.proxy,
      };
    }

    // Local session.
    if (stored) {
      return {
        cwd: stored.cwd, model: stored.model, permissionMode: stored.permissionMode,
        effort: stored.effort ?? defaultEffort, title: stored.title, claudeSessionId: stored.claudeSessionId,
        agent: stored.agent ?? 'claude',
      };
    }
    // Maybe a CLI session on this machine — resolve it from ~/.claude (Claude)…
    const info = resolveClaudeSessionSync(sessionId);
    if (info) {
      return { cwd: info.cwd, model: info.model, permissionMode: 'default', effort: defaultEffort, title: info.title, claudeSessionId: sessionId, agent: 'claude' };
    }
    // …or from ~/.cursor/chats (Cursor).
    const cursorInfo = resolveCursorSessionSync(sessionId);
    if (cursorInfo) {
      return { cwd: cursorInfo.cwd, model: cursorInfo.model, permissionMode: 'default', effort: defaultEffort, title: cursorInfo.title, claudeSessionId: sessionId, agent: 'cursor' };
    }
    // …or from ~/.codex/sessions (Codex).
    const codexInfo = resolveCodexSessionSync(sessionId);
    if (codexInfo) {
      return { cwd: codexInfo.cwd, model: codexInfo.model, permissionMode: 'default', effort: defaultEffort, title: codexInfo.title, claudeSessionId: sessionId, agent: 'codex' };
    }
    // …or from ~/.kimi-code (Kimi Code).
    const kimiInfo = resolveKimiSessionSync(sessionId);
    if (kimiInfo) {
      return { cwd: kimiInfo.cwd, model: kimiInfo.model, permissionMode: 'default', effort: defaultEffort, title: kimiInfo.title, claudeSessionId: sessionId, agent: 'kimi' };
    }
    // …or from ~/.kiro/sessions/cli (Kiro CLI).
    const kiroInfo = resolveKiroSessionSync(sessionId);
    if (kiroInfo) {
      return { cwd: kiroInfo.cwd, model: kiroInfo.model, permissionMode: 'default', effort: defaultEffort, title: kiroInfo.title, claudeSessionId: sessionId, agent: 'kiro' };
    }
    return undefined;
  }

  /** Resolve a session's working directory + (for remote) its SSH target — used
   *  to open a terminal on the session's host. */
  locate(sessionId: string): { cwd: string; sshTarget?: string } | undefined {
    const init = this.resolveInit(sessionId);
    return init ? { cwd: init.cwd, sshTarget: init.sshTarget } : undefined;
  }

  addConn(conn: Conn): void {
    this.conns.add(conn);
  }

  removeConn(conn: Conn): void {
    this.conns.delete(conn);
    for (const sessionId of conn.subscriptions) {
      this.runtimes.get(sessionId)?.subscribers.delete(conn);
    }
    conn.subscriptions.clear();
    this.gc();
  }

  subscribe(conn: Conn, sessionId: string, lastSeq: number): void {
    const rt = this.runtimeFor(sessionId);
    if (!rt) {
      conn.send({ t: 'error', message: 'session not found', sessionId });
      return;
    }
    rt.subscribers.add(conn);
    conn.subscriptions.add(sessionId);
    const ok = rt.replay(conn, lastSeq);
    conn.send({
      t: 'subscribed',
      sessionId,
      seq: rt.seq,
      running: rt.running,
      reset: !ok,
      pendingPermissions: rt.pendingRequests(),
      tasks: rt.taskList(),
    });
  }

  unsubscribe(conn: Conn, sessionId: string): void {
    this.runtimes.get(sessionId)?.subscribers.delete(conn);
    conn.subscriptions.delete(sessionId);
  }

  send(conn: Conn, sessionId: string, clientMsgId: string, text: string): void {
    const rt = this.runtimeFor(sessionId);
    if (!rt) {
      conn.send({ t: 'error', message: 'session not found', sessionId });
      return;
    }
    // Continuing a discovered CLI session adopts it into Vibe so running state
    // and metadata broadcast correctly from the start of the turn.
    if (!sessionStore.get(sessionId)) {
      sessionStore.adopt({
        id: sessionId,
        claudeSessionId: rt.claudeSessionId ?? parseSessionId(sessionId).claudeSessionId,
        cwd: rt.cwd,
        title: rt.title,
        model: rt.model,
        permissionMode: rt.permissionMode,
        effort: rt.effort,
        agent: rt.agent,
        host: rt.host,
      });
    }
    rt.subscribers.add(conn);
    conn.subscriptions.add(sessionId);
    const started = rt.startTurn(text, clientMsgId);
    if (!started) {
      conn.send({ t: 'error', message: 'a turn is already running', sessionId });
      return;
    }
    this.broadcastMeta(sessionId);
  }

  abort(sessionId: string): void {
    this.runtimes.get(sessionId)?.abort();
  }

  stopTask(conn: Conn, sessionId: string, taskId: string): void {
    void this.stopTaskForSession(sessionId, taskId).then((stopped) => {
      if (!stopped) conn.send({ t: 'error', message: 'this task cannot be stopped individually', sessionId });
    });
  }

  async stopTaskForSession(sessionId: string, taskId: string): Promise<boolean> {
    return await this.runtimes.get(sessionId)?.stopTask(taskId) ?? false;
  }

  tasks(sessionId: string): BackgroundTask[] {
    return this.runtimes.get(sessionId)?.taskList() ?? [];
  }

  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.runtimes.get(sessionId)?.resolvePermission(requestId, decision);
  }

  /** Conversation history + the seq to subscribe from. Reads the transcript
   *  locally, or over SSH for remote sessions. */
  async snapshot(sessionId: string): Promise<{ blocks: ChatBlock[]; seq: number }> {
    const stored = sessionStore.get(sessionId);
    const rt = this.runtimes.get(sessionId);
    const { host, claudeSessionId: rawId } = parseSessionId(sessionId);

    const plan = rt
      ? rt.snapshotPlan(stored?.claudeSessionId)
      : { claudeSessionId: stored?.claudeSessionId ?? rawId, seq: 0 };
    const sid = plan.claudeSessionId ?? rawId;
    // A discovered session that hasn't been opened yet has neither a runtime nor
    // a store row; resolveInit knows how to identify it (local agent stores, or
    // the remote discovery cache) so history isn't read as the wrong engine.
    const fallback = !rt && !stored ? this.resolveInit(sessionId) : undefined;
    const agent: AgentKind = rt?.agent ?? stored?.agent ?? fallback?.agent ?? 'claude';
    const cwd = stored?.cwd ?? rt?.cwd ?? fallback?.cwd ?? '';
    const remoteHost = host ? hostRegistry.get(host) : undefined;

    /** Native (non-Vibe) history for a session created directly on a CLI. While
     *  a turn is running we rely on the live stream instead, so in-flight blocks
     *  aren't duplicated. */
    const native = async (readLocal: () => ChatBlock[]): Promise<ChatBlock[]> => {
      if (rt?.hasLiveRun() || !sid) return [];
      if (host) return remoteHost ? readRemoteAgentTranscript(remoteHost, agent, sid, cwd) : [];
      return readLocal();
    };

    if (agent === 'cursor') {
      // Vibe-persisted transcript is authoritative for sessions we drove.
      const own = readCursorTranscript(sessionId);
      if (own.length) return { blocks: own, seq: plan.seq };
      // No Vibe transcript yet: best-effort parse the agent's own store
      // (locally, or over SSH for a remote host).
      return { blocks: await native(() => (cwd ? readCursorStoreTranscript(cwd, sid) : [])), seq: plan.seq };
    }

    if (agent === 'codex') {
      const own = readCodexTranscript(sessionId);
      if (own.length) return { blocks: own, seq: plan.seq };
      return { blocks: await native(() => readCodexRolloutTranscript(cwd, sid)), seq: plan.seq };
    }

    if (agent === 'kimi') {
      const own = readKimiTranscript(sessionId);
      if (own.length) return { blocks: own, seq: plan.seq };
      return { blocks: await native(() => readKimiWireTranscript(sid)), seq: plan.seq };
    }

    if (agent === 'kiro') {
      const own = readKiroTranscript(sessionId);
      if (own.length) return { blocks: own, seq: plan.seq };
      return { blocks: await native(() => readKiroNativeTranscript(sid)), seq: plan.seq };
    }

    if (host) {
      const blocks = remoteHost && sid ? await readRemoteTranscript(remoteHost, sid) : [];
      return { blocks, seq: plan.seq };
    }
    return { blocks: sid ? readTranscriptBlocks(sid).blocks : [], seq: plan.seq };
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.running ?? false;
  }

  hasActiveBackgroundTasks(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.hasActiveBackgroundTasks() ?? false;
  }

  /** Broadcast updated session metadata to every connected client. */
  broadcastMeta(sessionId: string): void {
    const stored = sessionStore.get(sessionId);
    if (!stored) {
      for (const conn of this.conns) conn.send({ t: 'session_removed', sessionId });
      return;
    }
    const meta = toMeta(
      stored,
      this.isRunning(sessionId),
      'vibe',
      this.hasActiveBackgroundTasks(sessionId),
    );
    for (const conn of this.conns) conn.send({ t: 'session_meta', session: meta });
  }

  /** Broadcast an already-built meta to every client. Used for changes that
   *  affect discovered (non-stored) sessions — e.g. a pin toggle — where
   *  broadcastMeta(id) can't build the meta from the store. */
  broadcastMetaObject(session: SessionMeta): void {
    for (const conn of this.conns) conn.send({ t: 'session_meta', session });
  }

  broadcastRemoved(sessionId: string): void {
    this.runtimes.delete(sessionId);
    for (const conn of this.conns) conn.send({ t: 'session_removed', sessionId });
  }

  /** Tell clients a row left the sidebar list (e.g. discovery refresh). Unlike
   *  broadcastRemoved, this does not tear down an active runtime. */
  broadcastSessionGone(sessionId: string): void {
    for (const conn of this.conns) conn.send({ t: 'session_removed', sessionId });
  }

  /** Drop idle runtimes that nobody is watching to bound memory. */
  private gc(): void {
    for (const [id, rt] of this.runtimes) {
      if (!rt.hasActivity() && Date.now() - rt.lastActivity > 5 * 60_000) {
        this.runtimes.delete(id);
      }
    }
  }
}

export const hub = new Hub();
