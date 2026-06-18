import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { log } from '../log.js';
import { startRun, type RunHandle } from '../claude/runner.js';
import { startRemoteRun } from '../remote/runner.js';
import { readTranscriptBlocks } from '../sessions/transcript.js';
import { resolveClaudeSessionSync } from '../sessions/discovery.js';
import { readRemoteTranscript } from '../remote/discovery.js';
import { hostRegistry } from '../remote/hosts.js';
import { parseSessionId } from '../remote/sessionId.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import type {
  ChatBlock,
  EffortLevel,
  LiveEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ServerEvent,
} from '../../../shared/protocol.js';

interface RuntimeInit {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  title: string;
  claudeSessionId?: string;
  /** Remote host name (display); undefined for local sessions. */
  host?: string;
  /** SSH target for remote sessions; undefined runs locally via the SDK. */
  sshTarget?: string;
}

/** Cached resolution for a remote session so the (sync) hub can build runtimes. */
interface RemoteSessionInfo {
  host: string;
  sshTarget: string;
  cwd: string;
  model: string;
  title: string;
}

/** Newer events are kept; older ones are evicted once the log passes this size. */
const LOG_CAP = 5000;
/** Above this socket backlog we drop best-effort `delta` frames (text is
 *  reconciled by the authoritative `block` event), but never structural ones. */
const DELTA_BACKPRESSURE_BYTES = 512 * 1024;

export class Conn {
  readonly id = crypto.randomUUID();
  readonly subscriptions = new Set<string>();

  constructor(readonly ws: WebSocket) {}

  send(msg: ServerEvent): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
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
  readonly host?: string;
  readonly sshTarget?: string;
  lastActivity = Date.now();
  readonly subscribers = new Set<Conn>();
  readonly allowedTools = new Set<string>();
  readonly pending = new Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }>();

  private logBuf: LoggedEvent[] = [];
  private runBaseSeq = 0;
  private baselineClaudeSessionId?: string;
  private run?: RunHandle;

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
    this.host = init.host;
    this.sshTarget = init.sshTarget;
  }

  private emit(ev: LiveEvent): void {
    this.seq += 1;
    const entry: LoggedEvent = { seq: this.seq, ev };
    this.logBuf.push(entry);
    this.pruneFinalized(ev);
    if (this.logBuf.length > LOG_CAP) this.logBuf.splice(0, this.logBuf.length - LOG_CAP);
    const frame: ServerEvent = { t: 'event', sessionId: this.sessionId, seq: this.seq, ev };
    const skippable = ev.k === 'delta';
    for (const conn of this.subscribers) {
      if (skippable && conn.bufferedAmount > DELTA_BACKPRESSURE_BYTES) continue;
      conn.send(frame);
    }
  }

  /** When a block is finalized, collapse its streaming deltas in the log so
   *  reconnect replay stays small and authoritative. */
  private pruneFinalized(ev: LiveEvent): void {
    let id: string | undefined;
    if (ev.k === 'block' && (ev.block.kind === 'assistant' || ev.block.kind === 'thinking') && !ev.block.streaming) {
      id = ev.block.id;
    } else if (ev.k === 'block_end') {
      id = ev.id;
    }
    if (!id) return;
    const targetId = id;
    this.logBuf = this.logBuf.filter((e) => {
      const evt = e.ev;
      if (evt.k === 'delta' && evt.id === targetId) return false;
      if (evt.k === 'block' && evt.block.id === targetId && 'streaming' in evt.block && evt.block.streaming) return false;
      return true;
    });
  }

  /** Replay everything after `lastSeq`. Returns false if there's a gap (reset). */
  replay(conn: Conn, lastSeq: number): boolean {
    const oldest = this.logBuf.length ? this.logBuf[0].seq : this.seq + 1;
    const gap = lastSeq > 0 && lastSeq + 1 < oldest && lastSeq < this.seq;
    if (gap) return false;
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

  /**
   * Decide which transcript to read and the seq to subscribe from, for a
   * freshly opening client. The hub reads the transcript (locally or over SSH).
   *  - running: stable history from before this turn + replay the live turn.
   *  - idle: the latest transcript already contains everything; skip live log.
   */
  snapshotPlan(storeClaudeSessionId: string | undefined): { claudeSessionId?: string; seq: number } {
    if (this.running) {
      return { claudeSessionId: this.baselineClaudeSessionId ?? storeClaudeSessionId, seq: this.runBaseSeq };
    }
    return { claudeSessionId: this.claudeSessionId ?? storeClaudeSessionId, seq: this.seq };
  }

  startTurn(text: string, clientMsgId: string): boolean {
    if (this.running) return false;
    // Pick up the latest model/permission/cwd (header changes write to the store).
    const stored = sessionStore.get(this.sessionId);
    const cwd = stored?.cwd ?? this.cwd;
    const model = stored?.model ?? this.model;
    const permissionMode = stored?.permissionMode ?? this.permissionMode;
    const effort = stored?.effort ?? this.effort;

    this.running = true;
    this.runBaseSeq = this.seq;
    this.baselineClaudeSessionId = this.claudeSessionId;
    this.lastActivity = Date.now();

    const where = this.sshTarget ? `host=${this.host}` : 'local';
    log.debug(`turn start session=${this.sessionId} ${where} resume=${this.claudeSessionId ?? 'new'} model=${model} cwd=${cwd}`);
    this.emit({ k: 'run_state', running: true });
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
    const cb = {
      onEvent: (ev: LiveEvent) => this.emit(ev),
      onClaudeSessionId: (id: string) => {
        if (id && id !== this.claudeSessionId) this.claudeSessionId = id;
      },
      requestPermission: (request: PermissionRequest) => this.requestPermission(request),
    };

    this.run = this.sshTarget
      ? startRemoteRun({ ...runOpts, sshTarget: this.sshTarget }, cb)
      : startRun(runOpts, cb);

    void this.run.done.then(() => this.finishTurn());
    return true;
  }

  private finishTurn(): void {
    this.running = false;
    this.run = undefined;
    this.lastActivity = Date.now();
    // Cancel any still-pending permission prompts.
    for (const [, p] of this.pending) p.resolve({ allow: false });
    this.pending.clear();
    this.emit({ k: 'run_state', running: false });

    const stored = sessionStore.get(this.sessionId);
    if (stored) {
      sessionStore.update(this.sessionId, {
        claudeSessionId: this.claudeSessionId,
        messageCount: stored.messageCount + 1,
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
        messageCount: 1,
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
    this.run?.abort();
  }

  hasActivity(): boolean {
    return this.running || this.subscribers.size > 0 || this.pending.size > 0;
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
        return {
          cwd: stored.cwd, model: stored.model, permissionMode: stored.permissionMode,
          effort: stored.effort ?? defaultEffort, title: stored.title, claudeSessionId: stored.claudeSessionId,
          host, sshTarget: remoteHost.ssh,
        };
      }
      const cached = this.remoteCache.get(sessionId);
      if (!cached) return undefined;
      return {
        cwd: cached.cwd, model: cached.model, permissionMode: 'default', effort: defaultEffort,
        title: cached.title, claudeSessionId, host, sshTarget: cached.sshTarget,
      };
    }

    // Local session.
    if (stored) {
      return {
        cwd: stored.cwd, model: stored.model, permissionMode: stored.permissionMode,
        effort: stored.effort ?? defaultEffort, title: stored.title, claudeSessionId: stored.claudeSessionId,
      };
    }
    // Maybe a CLI session on this machine — resolve it from ~/.claude.
    const info = resolveClaudeSessionSync(sessionId);
    if (info) {
      return { cwd: info.cwd, model: info.model, permissionMode: 'default', effort: defaultEffort, title: info.title, claudeSessionId: sessionId };
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

    if (host) {
      const remoteHost = hostRegistry.get(host);
      const blocks = remoteHost && sid ? await readRemoteTranscript(remoteHost, sid) : [];
      return { blocks, seq: plan.seq };
    }
    return { blocks: sid ? readTranscriptBlocks(sid).blocks : [], seq: plan.seq };
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.running ?? false;
  }

  /** Broadcast updated session metadata to every connected client. */
  broadcastMeta(sessionId: string): void {
    const stored = sessionStore.get(sessionId);
    if (!stored) {
      for (const conn of this.conns) conn.send({ t: 'session_removed', sessionId });
      return;
    }
    const meta = toMeta(stored, this.isRunning(sessionId));
    for (const conn of this.conns) conn.send({ t: 'session_meta', session: meta });
  }

  broadcastRemoved(sessionId: string): void {
    this.runtimes.delete(sessionId);
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
