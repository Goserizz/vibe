import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { log } from '../log.js';
import { startRun, type RunHandle } from '../claude/runner.js';
import { isContentEvent } from '../claude/retry.js';
import { startCursorRun } from '../cursor/runner.js';
import {
  ensureCursorAcpSessionFromChat,
  recoverCursorChatId,
  resolveCursorSessionSync,
} from '../cursor/discovery.js';
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
  readCodexTranscript,
  readCodexRolloutTranscript,
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
import { startGrokRun } from '../grok/runner.js';
import { resolveGrokSessionSync } from '../grok/discovery.js';
import {
  appendGrokBlocks,
  readGrokNativeTranscript,
  readGrokTranscript,
} from '../grok/transcript.js';
import { startZcodeRun } from '../zcode/runner.js';
import { invalidateZcodeSessionsCache, resolveZcodeSessionSync } from '../zcode/discovery.js';
import {
  appendZcodeBlocks,
  readZcodeNativeTranscript,
  readZcodeTranscript,
} from '../zcode/transcript.js';
import { startCodebuddyRun } from '../codebuddy/runner.js';
import { resolveCodebuddySessionSync } from '../codebuddy/discovery.js';
import {
  appendCodebuddyBlocks,
  readCodebuddyTranscript,
  readCodebuddyNativeTranscript,
  repairLegacyCodebuddyThinkingCarry,
} from '../codebuddy/transcript.js';
import { startOpencodeRun } from '../opencode/runner.js';
import { resolveOpencodeSessionSync } from '../opencode/discovery.js';
import {
  appendOpencodeBlocks,
  readOpencodeNativeTranscript,
  readOpencodeTranscript,
} from '../opencode/transcript.js';
import { startDevinRun } from '../devin/runner.js';
import { resolveDevinSessionSync } from '../devin/discovery.js';
import {
  appendDevinBlocks,
  readDevinNativeTranscript,
  readDevinTranscript,
} from '../devin/transcript.js';
import { readTranscriptBlocks, findTranscriptFile, parseTranscriptBlockLines } from '../sessions/transcript.js';
import { readBlocksWindow, readLinesWindow, readLineAt, truncateForTransfer, type WindowOpts } from '../sessions/window.js';
import { readBlobText } from '../sessions/blobs.js';
import { isClaudeSessionId, resolveClaudeSessionSync } from '../sessions/discovery.js';
import { sessionVisible, metaVisible } from '../sessions/visibility.js';
import { readRemoteAgentTranscript, readRemoteTranscript } from '../remote/discovery.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { mcpRegistry } from '../mcp/registry.js';
import { isMonitorManagementTool, monitorMcpDefinitionFor } from '../monitoring/mcp.js';
import { parseSessionId } from '../remote/sessionId.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import { defaultSwitchPaths } from '../switch/paths.js';
import { ADMIN_ACCOUNT, settleInterruptedTool } from '../../../shared/protocol.js';
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
  SnapshotPage,
  ToolBlock,
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
 * (e.g. the Telegram bot) use {@link CallbackConn}. Each connection carries the
 * account whose token authenticated it — broadcasts and subscription checks
 * filter by it.
 */
export abstract class Conn {
  readonly id = crypto.randomUUID();
  readonly subscriptions = new Set<string>();

  constructor(readonly account: string = ADMIN_ACCOUNT) {}

  isAdmin(): boolean {
    return this.account === ADMIN_ACCOUNT;
  }

  abstract send(msg: ServerEvent): void;

  /** Outbound socket backlog; non-WS conns report 0 so deltas are never dropped. */
  get bufferedAmount(): number {
    return 0;
  }
}

export class WsConn extends Conn {
  constructor(readonly ws: WebSocket, account: string) {
    super(account);
  }

  send(msg: ServerEvent): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  override get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }
}

/** In-process subscriber — used by the Telegram bot (admin context) and any
 *  future adapters. */
export class CallbackConn extends Conn {
  constructor(private readonly onMsg: (msg: ServerEvent) => void, account: string = ADMIN_ACCOUNT) {
    super(account);
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

interface TurnPresentation {
  /** User turns render their original prompt. Monitor turns render only a
   * trusted system notice while the full incident envelope goes to the model. */
  kind: 'user' | 'monitor';
  notice?: string;
}

const OWN_TRANSCRIPT_AGENTS: AgentKind[] = [
  'cursor',
  'codex',
  'kimi',
  'kiro',
  'grok',
  'zcode',
  'codebuddy',
  'opencode',
  'devin',
];

/**
 * Per-session live state: a seq-tagged event log for lossless replay, the set
 * of subscribed connections, the active run, and pending permission prompts.
 */
/** Vibe-normalized transcript dir per agent. Claude is native-only (null). */
function ownTranscriptsDir(agent: AgentKind): string | null {
  switch (agent) {
    case 'cursor': return config.cursorTranscriptsDir;
    case 'codex': return config.codexTranscriptsDir;
    case 'kimi': return config.kimiTranscriptsDir;
    case 'kiro': return config.kiroTranscriptsDir;
    case 'grok': return config.grokTranscriptsDir;
    case 'zcode': return config.zcodeTranscriptsDir;
    case 'codebuddy': return config.codebuddyTranscriptsDir;
    case 'opencode': return config.opencodeTranscriptsDir;
    case 'devin': return config.devinTranscriptsDir;
    default: return null;
  }
}

/** Newest page of the Vibe-persisted transcript for a session, results
 *  truncated for transfer. Null when there is no parseable transcript — the
 *  caller falls back to the agent's native store, like the old
 *  `own.length ? own : native` readers did. */
function ownTranscriptPage(
  sessionId: string,
  agent: AgentKind,
  page: WindowOpts,
): ({ blocks: ChatBlock[] } & SnapshotPage) | null {
  const dir = ownTranscriptsDir(agent);
  if (!dir) return null;
  const file = path.join(dir, `${encodeURIComponent(sessionId)}.jsonl`);
  const win = readBlocksWindow(file, page);
  if (!win || win.blocks.length === 0) return null;
  return {
    blocks: truncateForTransfer(win.blocks, win.offsets),
    hasMore: win.hasMore,
    cursor: win.hasMore ? String(win.startByte) : undefined,
  };
}

/**
 * Read the complete Vibe-owned transcript for agent switching.
 *
 * This is deliberately separate from {@link ownTranscriptPage}: the UI needs
 * bounded pages, while a native-session rebuild must never silently discard
 * everything before the newest page. CodeBuddy goes through its production
 * reader so legacy assistant-side thinking wrappers are normalized before a
 * later adapter sees them.
 */
function ownTranscriptFull(sessionId: string, agent: AgentKind): ChatBlock[] {
  switch (agent) {
    case 'cursor': return readCursorTranscript(sessionId);
    case 'codex': return readCodexTranscript(sessionId);
    case 'kimi': return readKimiTranscript(sessionId);
    case 'kiro': return readKiroTranscript(sessionId);
    case 'grok': return readGrokTranscript(sessionId);
    case 'zcode': return readZcodeTranscript(sessionId);
    case 'codebuddy': return readCodebuddyTranscript(sessionId);
    case 'opencode': return readOpencodeTranscript(sessionId);
    case 'devin': return readDevinTranscript(sessionId);
    default: return [];
  }
}

/** Newest page of a native Claude transcript, folded into blocks. Blocks are
 *  not 1:1 with lines (tool results fold into their tool block), so truncated
 *  results carry no `line:` ref here — the full text stays reachable on the
 *  native side for anything that consumes the transcript directly. */
function claudeTranscriptPage(
  claudeSessionId: string | undefined,
  page: WindowOpts,
): ({ blocks: ChatBlock[] } & SnapshotPage) | null {
  if (!claudeSessionId) return null;
  const file = findTranscriptFile(claudeSessionId);
  if (!file) return null;
  const win = readLinesWindow(file, page);
  if (!win || win.lines.length === 0) return null;
  const { blocks } = parseTranscriptBlockLines(win.lines);
  if (!blocks.length) return null;
  return {
    blocks: truncateForTransfer(blocks),
    hasMore: win.hasMore,
    cursor: win.hasMore ? String(win.startByte) : undefined,
  };
}

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
  /** True between a finished turn's result block and the next content — engine
   *  content arriving in that window is a background-task wake, not a reply to
   *  the user, and gets a notice block first. Covers wakes that happen mid-
   *  output too (no running-state edge in that case). */
  private wakeNoticePending = false;
  /** Headless CLI sessions persist normalized transcripts; this accumulates the turn. */
  private transcript?: CursorTranscriptBuilder;
  /** Blocks already appended to the Vibe JSONL — appends are id-once, matching
   *  the readers (no dedup) so a block is never written twice. */
  private persistedBlockIds = new Set<string>();
  private lastIncrementalPersist = 0;
  /** A replaced runtime must never emit events or write its native id back. */
  private retired = false;
  /** Set when an event since the last flush could have produced persistable
   *  blocks — gates the trailing-flush timer below. */
  private maybePersistable = false;
  /** Fires the flush a throttled emit skipped, so a turn whose last events all
   *  land inside the 3s window still persists while the run sits open on a
   *  persistent background task (no further emits, no finishTurn). */
  private persistTimer?: NodeJS.Timeout;

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
    if (this.agent === 'cursor' || this.agent === 'codex' || this.agent === 'kimi' || this.agent === 'kiro' || this.agent === 'grok' || this.agent === 'zcode' || this.agent === 'codebuddy' || this.agent === 'opencode' || this.agent === 'devin') {
      this.transcript = new CursorTranscriptBuilder();
    }
    // Devin's history lives in its SQLite store; seed it once on adoption so
    // snapshots show the conversation it already had.
    if (this.agent === 'devin' && init.claudeSessionId && readDevinTranscript(this.sessionId).length === 0) {
      appendDevinBlocks(this.sessionId, readDevinNativeTranscript(init.claudeSessionId));
    }
    // Preserve the existing history before a native Kimi/Kiro session is adopted:
    // subsequent snapshots prefer Vibe's normalized transcript.
    if (this.agent === 'kimi' && init.claudeSessionId && readKimiTranscript(this.sessionId).length === 0) {
      appendKimiBlocks(this.sessionId, readKimiWireTranscript(init.claudeSessionId));
    }
    if (this.agent === 'kiro' && init.claudeSessionId && readKiroTranscript(this.sessionId).length === 0) {
      appendKiroBlocks(this.sessionId, readKiroNativeTranscript(init.claudeSessionId));
    }
    if (this.agent === 'grok' && init.claudeSessionId && readGrokTranscript(this.sessionId).length === 0) {
      appendGrokBlocks(this.sessionId, readGrokNativeTranscript(init.claudeSessionId));
    }
    if (this.agent === 'opencode' && init.claudeSessionId && readOpencodeTranscript(this.sessionId).length === 0) {
      appendOpencodeBlocks(this.sessionId, readOpencodeNativeTranscript(init.claudeSessionId));
    }
    // ZCode history lives in its SQLite store and is only reachable by spawning
    // an app-server — seed asynchronously, snapshots race ahead with [] and the
    // first subscribe after adoption picks the transcript up.
    if (this.agent === 'zcode' && init.claudeSessionId && readZcodeTranscript(this.sessionId).length === 0) {
      void readZcodeNativeTranscript(init.claudeSessionId, init.cwd).then((blocks) => {
        if (blocks.length) appendZcodeBlocks(this.sessionId, blocks);
      });
    }
  }

  private emit(ev: LiveEvent): void {
    if (this.retired) return;
    // Engine content with no user message since the last turn ended = a
    // background-task wake — mark it before the content renders. Result/error
    // blocks close a turn and re-arm the detector for the next one.
    if (ev.k === 'block' && ev.block.kind === 'result') this.wakeNoticePending = true;
    else if (ev.k === 'error') this.wakeNoticePending = true;
    else if (this.wakeNoticePending && this.run && isContentEvent(ev)) this.emitWakeNotice();
    else if (ev.k === 'block' && ev.block.kind === 'tool') this.maybeSurfaceAskUserQuestion(ev.block);
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
    // Crash window: keep the persisted transcript within a few seconds of the
    // live stream while a turn runs.
    if (ev.k === 'block' || ev.k === 'block_end' || ev.k === 'tool_result') this.maybePersistable = true;
    this.persistTranscript();
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

  /** A block is safe to append once nothing will mutate it again: streaming
   *  text must have finished, tools must have reached a terminal status. */
  private static blockIsPersistable(b: ChatBlock): boolean {
    if (b.kind === 'assistant' || b.kind === 'thinking') return !b.streaming;
    if (b.kind === 'tool') return b.status === 'done' || b.status === 'error';
    return true;
  }

  /** A thinking block with no text carries nothing — CodeBuddy's engine can
   *  cancel a generation right after its content_block_start, and a force
   *  flush at end of turn would otherwise write the empty shell down as a
   *  permanent "Thinking…" row. */
  private static isGhostThinking(b: ChatBlock): boolean {
    return b.kind === 'thinking' && !(b.text ?? '');
  }

  /** Append not-yet-persisted blocks to the Vibe JSONL. Throttled to ~3s while
   *  a run is live so a service restart mid-turn loses at most a few seconds of
   *  streaming instead of the whole turn; finishTurn force-flushes the rest. */
  private persistTranscript(force = false): void {
    if (!this.transcript) return;
    if (!force) {
      if (!this.run) return;
      if (Date.now() - this.lastIncrementalPersist < 3_000) {
        // The remaining delay may never be paid for by another event (e.g. the
        // turn ended onto a persistent background task that holds the child
        // open) — schedule the flush so the tail isn't lost until the run ends.
        this.scheduleTrailingPersist();
        return;
      }
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.lastIncrementalPersist = Date.now();
    this.maybePersistable = false;
    const pending = this.transcript.blocks.filter(
      (b) => !this.persistedBlockIds.has(b.id)
        && !SessionRuntime.isGhostThinking(b)
        && (force || SessionRuntime.blockIsPersistable(b)),
    );
    if (!pending.length) return;
    for (const b of pending) this.persistedBlockIds.add(b.id);
    if (this.agent === 'codex') appendCodexBlocks(this.sessionId, pending);
    else if (this.agent === 'kimi') appendKimiBlocks(this.sessionId, pending);
    else if (this.agent === 'kiro') appendKiroBlocks(this.sessionId, pending);
    else if (this.agent === 'grok') appendGrokBlocks(this.sessionId, pending);
    else if (this.agent === 'zcode') appendZcodeBlocks(this.sessionId, pending);
    else if (this.agent === 'codebuddy') appendCodebuddyBlocks(this.sessionId, pending);
    else if (this.agent === 'opencode') appendOpencodeBlocks(this.sessionId, pending);
    else if (this.agent === 'devin') appendDevinBlocks(this.sessionId, pending);
    else appendCursorBlocks(this.sessionId, pending);
  }

  private scheduleTrailingPersist(): void {
    if (this.persistTimer || !this.maybePersistable || !this.run) return;
    const wait = Math.max(0, 3_000 - (Date.now() - this.lastIncrementalPersist));
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistTranscript();
    }, wait);
    this.persistTimer.unref?.();
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

  /** A background-task completion started an engine turn — content is about to
   *  appear without a user message, so mark the cause in the chat. */
  private emitWakeNotice(): void {
    this.wakeNoticePending = false;
    const recent = [...this.tasks.values()]
      .filter((t) => t.endedAt != null && Date.now() - t.endedAt < 120_000)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    const desc = recent?.description?.trim();
    const text = desc ? `后台任务「${desc}」完成，唤醒 agent 继续` : '后台任务完成，唤醒 agent 继续';
    this.emit({ k: 'block', block: { id: `sys_${crypto.randomUUID()}`, kind: 'system', text, ts: Date.now() } });
  }

  /** AskUserQuestion tool calls already surfaced (bypass mode dedup). */
  private askedToolIds = new Set<string>();

  /** In bypassPermissions the zcode runtime skips its interaction layer, so an
   *  AskUserQuestion call fails with "requires user answers" and the user sees
   *  nothing. The tool block still streams to us with its questions — surface
   *  the picker ourselves and inject the answer as a user message. */
  private maybeSurfaceAskUserQuestion(block: ToolBlock): void {
    if (
      this.agent !== 'zcode' ||
      this.permissionMode !== 'bypassPermissions' ||
      block.name !== 'AskUserQuestion' ||
      this.askedToolIds.has(block.toolUseId)
    ) {
      return;
    }
    const raw = (block.input as { questions?: unknown } | null)?.questions;
    const questions = Array.isArray(raw) ? raw : [];
    if (!questions.length) return;
    this.askedToolIds.add(block.toolUseId);
    const mapped = questions.map((q) => {
      const item = (q ?? {}) as Record<string, unknown>;
      const options = (Array.isArray(item.options) ? item.options : []).map((o) => {
        const opt = (o ?? {}) as Record<string, unknown>;
        const label = String(opt.label ?? opt.value ?? '');
        return typeof opt.description === 'string' ? { label, description: opt.description } : { label };
      });
      return {
        question: String(item.question ?? 'Question'),
        options,
        multiSelect: item.multiSelect === true,
      };
    });
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName: 'AskUserQuestion',
      input: { questions: mapped, source: 'zcode' },
      ts: Date.now(),
    };
    void this.requestPermission(request).then((decision) => {
      const answers =
        ((decision.updatedInput as { answers?: Record<string, string | string[]> } | undefined)?.answers) ?? {};
      const lines = Object.entries(answers).map(
        ([q, a]) => `- ${q} → ${Array.isArray(a) ? a.join('、') : a}`,
      );
      // No answers (declined, dismissed, or cancelled at turn end): the model
      // has already fallen back to asking in plain text — stay quiet.
      if (!lines.length) return;
      const text = `[AskUserQuestion] 用户在弹窗中回答了你的提问：\n${lines.join('\n')}`;
      const msgId = `ask_${block.toolUseId}`;
      if (this.running) {
        // The model is still mid-turn (it will have fallen back to asking in
        // plain text); steer the answer through the live transport.
        if (this.run?.sendMessage?.(text)) {
          this.runUserTurns += 1;
          this.emit({ k: 'block', block: { id: msgId, kind: 'user', text, ts: Date.now() } });
        }
      } else {
        this.startTurn(text, msgId);
      }
    });
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

  /** Why the most recent startTurn() refused — callers can tell a genuinely
   *  busy turn apart from a stale run handle whose transport already died. */
  turnRejectReason: 'busy' | 'transport-dead' = 'busy';

  startTurn(text: string, clientMsgId: string, presentation: TurnPresentation = { kind: 'user' }): boolean {
    if (this.running) {
      this.turnRejectReason = 'busy';
      return false;
    }
    this.wakeNoticePending = false;
    // 用户气泡里显示的是原始消息；发给 agent 的可能还要拼上切换时暂存的上下文。
    const userText = text;
    const originBlock = (): ChatBlock => presentation.kind === 'monitor'
      ? {
          id: clientMsgId,
          kind: 'system',
          text: presentation.notice?.trim() || '监控事件唤醒 agent 处理',
          ts: Date.now(),
        }
      : { id: clientMsgId, kind: 'user', text: userText, ts: Date.now() };

    // Pick up the latest model/permission/cwd (header changes write to the store).
    const stored = sessionStore.get(this.sessionId);

    // 切换 agent 时若目标方向无法构造原生会话（fidelity=partial），历史会暂存在
    // `switchPrimer` 里，等本会话第一次发消息时作为上下文前缀注入 —— 注入后立即
    // 清空，所以只会注入一次。
    const primer = stored?.switchPrimer;
    if (primer) {
      sessionStore.update(this.sessionId, { switchPrimer: undefined });
      // 立刻落盘：否则进程在这 250ms debounce 窗口内重启会把同一份历史再注入一次。
      sessionStore.flush();
      // 历史放在用户消息之前，模型先读背景再读当前指令。
      text = `${primer}\n\n${text}`;
      this.emit({
        k: 'block',
        block: {
          id: `sw_${crypto.randomUUID()}`,
          kind: 'system',
          text: `已把原会话的完整历史作为上下文注入本轮（本次 ${this.agent} 原生会话写入失败或运行时依赖不可用，已降级为部分保真切换）。`,
          ts: Date.now(),
        },
      });
    }

    // Claude SDK, Kimi ACP, and Codex App Server remain connected while native
    // tasks run. Steer a new user message through that connection instead of
    // rejecting it or starting a competing process for the same session.
    if (this.run) {
      if (!this.run.sendMessage?.(text)) {
        // The transport backing this run is gone (it died while servicing
        // background tasks). The service loop will clear `this.run` on its
        // next 2.5s pass; report the real cause instead of "busy" so the
        // user knows a resend will start a fresh run.
        this.turnRejectReason = 'transport-dead';
        return false;
      }
      this.runUserTurns += 1;
      this.setForegroundRunning(true);
      this.emit({ k: 'block', block: originBlock() });
      return true;
    }

    const cwd = stored?.cwd ?? this.cwd;
    const model = stored?.model ?? this.model;
    const permissionMode = stored?.permissionMode ?? this.permissionMode;
    const effort = stored?.effort ?? this.effort;

    this.runBaseSeq = this.seq;
    this.baselineClaudeSessionId = this.claudeSessionId;
    this.runUserTurns = 1;
    this.lastActivity = Date.now();

    const where = this.sshTarget ? `host=${this.host}` : 'local';
    log.debug(`turn start session=${this.sessionId} agent=${this.agent} ${where} resume=${this.claudeSessionId ?? 'new'} model=${model} cwd=${cwd}`);
    this.setForegroundRunning(true);
    this.emit({ k: 'block', block: originBlock() });

    const runOpts = {
      // `text` 在这里可能已经拼上了切换时注入的历史上下文（partial 方向）。
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
    const monitorMcp = monitorMcpDefinitionFor({
      owner: stored?.owner
        ?? (this.host ? hostRegistry.get(this.host)?.owner : ADMIN_ACCOUNT)
        ?? ADMIN_ACCOUNT,
      sessionId: this.sessionId,
      host: this.host,
    });
    // Built-ins are separate from the user-toggleable registry. Filter a user
    // definition with the reserved name so it cannot shadow the scoped tool.
    const mcpServers: McpServerDef[] = [
      ...mcpRegistry.resolveForScope(this.host ?? 'local').filter((server) => server.name !== 'vibe-monitor'),
      ...(monitorMcp ? [monitorMcp] : []),
    ];
    const builtInMcpServers: McpServerDef[] = monitorMcp ? [monitorMcp] : [];
    const cb = {
      onEvent: (ev: LiveEvent) => this.emit(ev),
      onClaudeSessionId: (id: string) => {
        if (this.retired) return;
        if (!id || id === this.claudeSessionId) return;
        this.claudeSessionId = id;
        // Link the underlying CLI session id to this Vibe session the moment the
        // SDK reports it — not only at turn-end. Background disk discovery
        // (loadAllSessions) dedups transcripts by claudeSessionId against the
        // store; if the link is missing for the whole turn, the in-progress
        // transcript gets listed as a separate "interrupted" session showing the
        // first-message title and the raw model id (e.g. glm-5.2 instead of the
        // opus alias). Long turns (opus) easily span the 60s discovery tick, so
        // this window was hit regularly.
        const stored = sessionStore.get(this.sessionId);
        if (stored && stored.claudeSessionId !== id) {
          sessionStore.update(this.sessionId, { claudeSessionId: id });
        }
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
    } else if (this.agent === 'grok') {
      this.run = startGrokRun(
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
    } else if (this.agent === 'zcode') {
      this.run = startZcodeRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          effort,
          resume: this.claudeSessionId,
          vibeSessionId: this.sessionId,
          mcpServers: builtInMcpServers,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else if (this.agent === 'codebuddy') {
      this.run = startCodebuddyRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          effort,
          resume: this.claudeSessionId,
          allowedTools: [...this.allowedTools],
          // MCP servers resolve where the CLI runs: stdio commands spawn on
          // the session's host, http/sse dial from there.
          mcpServers,
          vibeSessionId: this.sessionId,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else if (this.agent === 'opencode') {
      this.run = startOpencodeRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          effort,
          resume: this.claudeSessionId,
          mcpServers: builtInMcpServers,
          remote: this.sshTarget ? { sshTarget: this.sshTarget, cwd, proxy: this.proxy } : undefined,
        },
        cb,
      );
    } else if (this.agent === 'devin') {
      this.run = startDevinRun(
        {
          prompt: text,
          cwd,
          model,
          permissionMode,
          effort,
          resume: this.claudeSessionId,
          mcpServers: builtInMcpServers,
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

  appendSystemNotice(text: string): void {
    this.emit({
      k: 'block',
      block: { id: `sys_${crypto.randomUUID()}`, kind: 'system', text, ts: Date.now() },
    });
    // A notice can arrive while no engine run exists; persist it immediately
    // instead of waiting for a future user turn.
    this.persistTranscript(true);
  }

  private finishTurn(run: RunHandle): void {
    if (this.retired) return;
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
    // Headless CLI sessions self-persist: force-flush anything the throttled
    // incremental persistence hasn't written yet (including blocks that never
    // reached a "final" state, e.g. text still streaming when the run ended).
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    // A tool still `running` when the run ended lost its result mid-transport
    // (SSH drop, abort). Close it through emit() so live subscribers see the
    // final state and the force flush below persists it — otherwise history
    // renders an eternal "Running…" row stranded after the result block.
    for (const b of this.transcript?.blocks ?? []) {
      const settled = settleInterruptedTool(b);
      if (settled !== b) this.emit({ k: 'block', block: settled });
    }
    this.persistTranscript(true);
    if (this.agent === 'zcode') invalidateZcodeSessionsCache();

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
    // The user explicitly grants the reserved built-in MCP full Monitor
    // management authority. Exact server-qualified names only: an unrelated
    // user MCP exposing a similarly named tool must not inherit this grant.
    if (isMonitorManagementTool(request.toolName)) return Promise.resolve({ allow: true, remember: true });
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

  /** Permanently detach this runtime after an agent/model switch. */
  retire(): void {
    this.retired = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    for (const [, pending] of this.pending) pending.resolve({ allow: false });
    this.pending.clear();
    this.run?.abort();
    this.run = undefined;
    this.subscribers.clear();
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
  /** Serializes agent switches and prevents a message racing the SQLite build. */
  private switchingSessions = new Set<string>();
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
      let nativeId = stored.claudeSessionId;
      if (stored.agent === 'cursor' && nativeId) {
        const cursorPaths = defaultSwitchPaths();
        // A switched Cursor session historically lived only under
        // ~/.cursor/chats. ACP does not search that tree: if its first resume
        // failed it created a fresh UUID and the callback replaced our mapping.
        // Recover both malformed source IDs and those valid-but-empty fallback
        // UUIDs. Legacy recovery outside the time window is accepted only when
        // the native chat's user turns exactly match the Vibe transcript prefix.
        const hasMatchingChat = isClaudeSessionId(nativeId)
          && recoverCursorChatId({
            vibeSessionId: stored.id,
            cwd: stored.cwd,
            title: stored.title,
            updatedAt: stored.updatedAt,
          }, cursorPaths.cursorChatsDir) === nativeId;
        const recovered = (!isClaudeSessionId(nativeId) || !hasMatchingChat)
          ? recoverCursorChatId({
              vibeSessionId: stored.id,
              cwd: stored.cwd,
              title: stored.title,
              updatedAt: stored.updatedAt,
              userTexts: readCursorTranscript(stored.id)
                .filter((block) => block.kind === 'user')
                .map((block) => block.text),
            }, cursorPaths.cursorChatsDir)
          : null;
        if (recovered && recovered !== nativeId) {
          log.warn(`recovered stale Cursor native id session=${stored.id} ${nativeId} -> ${recovered}`);
          nativeId = recovered;
          sessionStore.update(stored.id, { claudeSessionId: recovered });
          sessionStore.flush();
        }
        if (isClaudeSessionId(nativeId)) {
          ensureCursorAcpSessionFromChat(
            nativeId,
            stored.cwd,
            cursorPaths.cursorChatsDir,
            cursorPaths.cursorAcpSessionsDir,
          );
        }
      }
      if (stored.agent === 'codebuddy' && nativeId) {
        repairLegacyCodebuddyThinkingCarry(stored.id, nativeId);
      }
      return {
        cwd: stored.cwd, model: stored.model, permissionMode: stored.permissionMode,
        effort: stored.effort ?? defaultEffort, title: stored.title, claudeSessionId: nativeId,
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
      ensureCursorAcpSessionFromChat(sessionId, cursorInfo.cwd);
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
    // …or from ~/.grok/sessions (Grok Build).
    const grokInfo = resolveGrokSessionSync(sessionId);
    if (grokInfo) {
      return { cwd: grokInfo.cwd, model: grokInfo.model, permissionMode: 'default', effort: defaultEffort, title: grokInfo.title, claudeSessionId: sessionId, agent: 'grok' };
    }
    // …or from the ZCode session index (sidecar of the async discovery pass).
    const zcodeInfo = resolveZcodeSessionSync(sessionId);
    if (zcodeInfo) {
      return { cwd: zcodeInfo.cwd, model: zcodeInfo.model, permissionMode: 'default', effort: defaultEffort, title: zcodeInfo.title, claudeSessionId: sessionId, agent: 'zcode' };
    }
    // …or from ~/.codebuddy/projects (CodeBuddy).
    const codebuddyInfo = resolveCodebuddySessionSync(sessionId);
    if (codebuddyInfo) {
      return { cwd: codebuddyInfo.cwd, model: codebuddyInfo.model, permissionMode: 'default', effort: defaultEffort, title: codebuddyInfo.title, claudeSessionId: sessionId, agent: 'codebuddy' };
    }
    // …or from opencode's SQLite session store.
    const opencodeInfo = resolveOpencodeSessionSync(sessionId);
    if (opencodeInfo) {
      return { cwd: opencodeInfo.cwd, model: opencodeInfo.model, permissionMode: 'default', effort: defaultEffort, title: opencodeInfo.title, claudeSessionId: sessionId, agent: 'opencode' };
    }
    // …or from Devin's SQLite session store.
    const devinInfo = resolveDevinSessionSync(sessionId);
    if (devinInfo) {
      return { cwd: devinInfo.cwd, model: devinInfo.model, permissionMode: 'default', effort: defaultEffort, title: devinInfo.title, claudeSessionId: sessionId, agent: 'devin' };
    }
    return undefined;
  }

  /** Resolve a session's working directory + (for remote) its SSH target — used
   *  to open a terminal on the session's host. */
  locate(sessionId: string): { cwd: string; sshTarget?: string } | undefined {
    const init = this.resolveInit(sessionId);
    return init ? { cwd: init.cwd, sshTarget: init.sshTarget } : undefined;
  }

  /** Make a discovered session durable before attaching long-lived automation
   * to it. A Monitor must remain resumable after the discovery cache and the
   * whole Vibe process are gone. */
  adoptForMonitor(sessionId: string, owner: string): {
    sessionId: string;
    host?: string;
    cwd: string;
  } | undefined {
    if (!sessionVisible(owner, sessionId)) return undefined;
    const existing = sessionStore.get(sessionId);
    if (existing) return { sessionId, host: existing.host, cwd: existing.cwd };
    const rt = this.runtimeFor(sessionId);
    if (!rt) return undefined;
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
      owner,
    });
    // The monitor row is committed synchronously immediately after this call;
    // flush its target mapping first so a crash cannot leave a durable monitor
    // pointing at an ephemeral discovery-cache entry.
    sessionStore.flush();
    this.broadcastMeta(sessionId);
    return { sessionId, host: rt.host, cwd: rt.cwd };
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
    if (!sessionVisible(conn.account, sessionId)) {
      conn.send({ t: 'error', message: 'session not found', sessionId });
      return;
    }
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
    if (!sessionVisible(conn.account, sessionId)) {
      conn.send({ t: 'error', message: 'session not found', sessionId });
      return;
    }
    if (this.switchingSessions.has(sessionId)) {
      conn.send({ t: 'error', message: 'session is switching agent — try again when it finishes', sessionId });
      return;
    }
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
        owner: conn.account,
      });
    }
    rt.subscribers.add(conn);
    conn.subscriptions.add(sessionId);
    const started = rt.startTurn(text, clientMsgId);
    if (!started) {
      conn.send({
        t: 'error',
        message:
          rt.turnRejectReason === 'transport-dead'
            ? 'agent connection lost — resend to start a new run'
            : 'a turn is already running',
        sessionId,
      });
      return;
    }
    // Sending a message counts as activity — refresh updatedAt now so the
    // sidebar reorders immediately instead of waiting for turn end.
    sessionStore.update(sessionId, {});
    this.broadcastMeta(sessionId);
  }

  /** Start a model turn caused by a durable Monitor. The incident envelope is
   * sent to the engine, while chat history receives a concise system notice
   * rather than a fake user message. Busy/switching sessions are not dropped —
   * the monitor worker keeps the event queued and retries later. */
  triggerMonitorTurn(input: {
    owner: string;
    sessionId: string;
    eventId: string;
    notice: string;
    prompt: string;
  }): 'started' | 'busy' | 'switching' | 'not-found' {
    if (!sessionVisible(input.owner, input.sessionId)) return 'not-found';
    if (this.switchingSessions.has(input.sessionId)) return 'switching';
    const rt = this.runtimeFor(input.sessionId);
    if (!rt) return 'not-found';
    if (rt.running) return 'busy';

    // A monitor may target a discovered native session that has not yet been
    // adopted through the browser. Adopt it before the unattended turn so its
    // updated native id and transcript remain durable.
    if (!sessionStore.get(input.sessionId)) {
      sessionStore.adopt({
        id: input.sessionId,
        claudeSessionId: rt.claudeSessionId ?? parseSessionId(input.sessionId).claudeSessionId,
        cwd: rt.cwd,
        title: rt.title,
        model: rt.model,
        permissionMode: rt.permissionMode,
        effort: rt.effort,
        agent: rt.agent,
        host: rt.host,
        owner: input.owner,
      });
    }
    const started = rt.startTurn(
      input.prompt,
      `monitor_${input.eventId}_${crypto.randomUUID()}`,
      { kind: 'monitor', notice: input.notice },
    );
    if (!started) return 'busy';
    sessionStore.update(input.sessionId, {});
    this.broadcastMeta(input.sessionId);
    return 'started';
  }

  /** Persist a monitor lifecycle notice without starting a model turn. */
  appendMonitorNotice(
    owner: string,
    monitorId: string,
    sessionId: string,
    level: 'alert' | 'recovery' | 'escalated',
    text: string,
  ): boolean {
    if (!sessionVisible(owner, sessionId)) return false;
    const rt = this.runtimeFor(sessionId);
    if (rt) {
      rt.appendSystemNotice(text);
      if (sessionStore.get(sessionId)) sessionStore.update(sessionId, {});
      this.broadcastMeta(sessionId);
    }
    for (const conn of this.conns) {
      if (conn.account === owner) conn.send({ t: 'monitor_notice', monitorId, sessionId, level, text });
    }
    return Boolean(rt);
  }

  /** Monitor state is fetched through REST; this lightweight invalidation frame
   * lets an open panel refresh without polling aggressively. */
  broadcastMonitorChanged(owner: string, monitorId: string): void {
    for (const conn of this.conns) {
      if (conn.account === owner) conn.send({ t: 'monitor_changed', monitorId });
    }
  }

  /** Abort a running turn. Returns false when the account can't see the
   *  session (or there is nothing to abort). */
  abort(sessionId: string, account: string = ADMIN_ACCOUNT): boolean {
    if (!sessionVisible(account, sessionId)) return false;
    this.runtimes.get(sessionId)?.abort();
    return true;
  }

  stopTask(conn: Conn, sessionId: string, taskId: string): void {
    if (!sessionVisible(conn.account, sessionId)) {
      conn.send({ t: 'error', message: 'session not found', sessionId });
      return;
    }
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

  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision, account: string = ADMIN_ACCOUNT): boolean {
    if (!sessionVisible(account, sessionId)) return false;
    this.runtimes.get(sessionId)?.resolvePermission(requestId, decision);
    return true;
  }

  /** Conversation history + the seq to subscribe from (see Hub.snapshot).
   *  Paged: without a cursor it returns the newest window (default 200 blocks
   *  or ~2MB of raw transcript); `endByte` walks older pages. Tool results
   *  travel as bounded previews — the unabridged text comes from
   *  Hub.blockResult on demand. */
  async snapshot(
    sessionId: string,
    page: WindowOpts = {},
  ): Promise<{ blocks: ChatBlock[]; seq: number } & SnapshotPage> {
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
    const native = async (readLocal: () => ChatBlock[] | Promise<ChatBlock[]>): Promise<ChatBlock[]> => {
      if (rt?.hasLiveRun() || !sid) return [];
      if (host) return remoteHost ? readRemoteAgentTranscript(remoteHost, agent, sid, cwd) : [];
      return await readLocal();
    };

    // Vibe-driven sessions (everything but Claude) have a normalized transcript
    // under ~/.vibe — page it straight off disk, no full-file read.
    if (agent !== 'claude') {
      const own = ownTranscriptPage(sessionId, agent, page);
      if (own) return { blocks: own.blocks, seq: plan.seq, hasMore: own.hasMore, cursor: own.cursor };
    } else if (!host) {
      // Claude keeps its history in the native ~/.claude transcript; page the
      // raw lines and fold them into blocks (blocks ≠ lines, so no line refs).
      const own = claudeTranscriptPage(sid, page);
      if (own) return { blocks: own.blocks, seq: plan.seq, hasMore: own.hasMore, cursor: own.cursor };
    }

    const readLocal = (): ChatBlock[] | Promise<ChatBlock[]> => {
      switch (agent) {
        case 'cursor': return cwd ? readCursorStoreTranscript(cwd, sid) : [];
        case 'codex': return readCodexRolloutTranscript(cwd, sid);
        case 'kimi': return readKimiWireTranscript(sid);
        case 'kiro': return readKiroNativeTranscript(sid);
        case 'grok': return readGrokNativeTranscript(sid);
        case 'zcode': return readZcodeNativeTranscript(sid, cwd);
        case 'codebuddy': return readCodebuddyNativeTranscript(sid);
        case 'opencode': return readOpencodeNativeTranscript(sid);
        case 'devin': return readDevinNativeTranscript(sid);
        default: return sid ? readTranscriptBlocks(sid).blocks : [];
      }
    };
    const blocks =
      host && agent === 'claude'
        ? remoteHost && sid
          ? await readRemoteTranscript(remoteHost, sid)
          : []
        : await native(readLocal);
    return { blocks: truncateForTransfer(blocks), seq: plan.seq, hasMore: false };
  }

  /**
   * Capture the complete, untruncated history used to rebuild another agent's
   * native session. This must not call {@link snapshot}: that method is a UI
   * transport API and intentionally returns only the newest bounded page.
   *
   * The switch route reserves the session with beginAgentSwitch() before
   * calling this method, so no turn can race the disk snapshot. Keeping this
   * method public also lets recovery tooling verify the exact source count.
   */
  async switchSnapshot(sessionId: string): Promise<{ blocks: ChatBlock[]; seq: number }> {
    const stored = sessionStore.get(sessionId);
    const rt = this.runtimes.get(sessionId);
    if (rt?.hasLiveRun() || rt?.hasActiveBackgroundTasks()) {
      throw new Error('cannot capture switch history while the session is running');
    }

    const { host, claudeSessionId: rawId } = parseSessionId(sessionId);
    const plan = rt
      ? rt.snapshotPlan(stored?.claudeSessionId)
      : { claudeSessionId: stored?.claudeSessionId ?? rawId, seq: 0 };
    const sid = plan.claudeSessionId ?? rawId;
    const fallback = !rt && !stored ? this.resolveInit(sessionId) : undefined;
    const agent: AgentKind = rt?.agent ?? stored?.agent ?? fallback?.agent ?? 'claude';
    const cwd = stored?.cwd ?? rt?.cwd ?? fallback?.cwd ?? '';

    // Vibe's normalized log is authoritative for every non-Claude agent and
    // lives on the Vibe server even when the native CLI is reached over SSH.
    if (agent !== 'claude') {
      const own = ownTranscriptFull(sessionId, agent);
      if (own.length) return { blocks: own, seq: plan.seq };
    }

    if (!sid) return { blocks: [], seq: plan.seq };
    if (host) {
      const remoteHost = hostRegistry.get(host);
      if (!remoteHost) return { blocks: [], seq: plan.seq };
      const blocks = agent === 'claude'
        ? await readRemoteTranscript(remoteHost, sid)
        : await readRemoteAgentTranscript(remoteHost, agent, sid, cwd);
      return { blocks, seq: plan.seq };
    }

    const blocks = await ((): Promise<ChatBlock[]> | ChatBlock[] => {
      switch (agent) {
        case 'cursor': return cwd ? readCursorStoreTranscript(cwd, sid) : [];
        case 'codex': return readCodexRolloutTranscript(cwd, sid);
        case 'kimi': return readKimiWireTranscript(sid);
        case 'kiro': return readKiroNativeTranscript(sid);
        case 'grok': return readGrokNativeTranscript(sid);
        case 'zcode': return readZcodeNativeTranscript(sid, cwd);
        case 'codebuddy': return readCodebuddyNativeTranscript(sid);
        case 'opencode': return readOpencodeNativeTranscript(sid);
        case 'devin': return readDevinNativeTranscript(sid);
        default: return readTranscriptBlocks(sid).blocks;
      }
    })();
    return { blocks, seq: plan.seq };
  }

  /** Full text of one (truncated) tool result — from a persisted blob sidecar
   *  (`blob:`) or by seeking the block's line in the local normalized
   *  transcript (`line:<offset>`). Null when the ref can't be resolved. */
  blockResult(sessionId: string, blockId: string, ref: string): { blockId: string; size: number; text: string } | null {
    if (ref.startsWith('blob:')) {
      const text = readBlobText(ref);
      return text == null ? null : { blockId, size: text.length, text };
    }
    if (/^line:\d+$/.test(ref)) {
      const offset = Number(ref.slice('line:'.length));
      const stored = sessionStore.get(sessionId);
      const rt = this.runtimes.get(sessionId);
      const agent: AgentKind = rt?.agent ?? stored?.agent ?? 'claude';
      // A pre-fix agent switch could copy a `line:` ref into the target
      // transcript even though the byte offset still points at the old agent's
      // file. Old normalized transcripts are intentionally retained, so probe
      // the current agent first and then the other agent-owned logs.
      const candidates = [agent, ...OWN_TRANSCRIPT_AGENTS.filter((candidate) => candidate !== agent)];
      for (const candidate of candidates) {
        const dir = ownTranscriptsDir(candidate);
        if (!dir) continue;
        const file = path.join(dir, `${encodeURIComponent(sessionId)}.jsonl`);
        const hit = readLineAt(file, offset);
        if (!hit) continue;
        try {
          const block = JSON.parse(hit.line) as ChatBlock;
          if (
            block.kind !== 'tool'
            || block.id !== blockId
            || typeof block.result !== 'string'
            || block.resultTruncated === true
            || (typeof block.resultSize === 'number' && block.result.length < block.resultSize)
          ) {
            continue;
          }
          return { blockId, size: block.result.length, text: block.result };
        } catch {
          // Try the next retained agent transcript.
        }
      }
      return null;
    }
    return null;
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.running ?? false;
  }

  hasActiveBackgroundTasks(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.hasActiveBackgroundTasks() ?? false;
  }

  /**
   * Reserve an idle session for an agent switch. While reserved, new messages
   * are rejected so a turn cannot start between transcript capture and rebind.
   */
  beginAgentSwitch(sessionId: string): boolean {
    if (this.switchingSessions.has(sessionId)) return false;
    const rt = this.runtimes.get(sessionId);
    if (rt?.hasLiveRun() || rt?.hasActiveBackgroundTasks()) return false;
    this.switchingSessions.add(sessionId);
    return true;
  }

  /**
   * Replace a cached runtime with one resolved from the freshly updated store.
   * Subscribers and the monotonic event sequence survive the handoff, while
   * the immutable agent/native-session fields come from the new runtime.
   */
  rebindAfterAgentSwitch(sessionId: string): void {
    const init = this.resolveInit(sessionId);
    if (!init) throw new Error('switched session could not be resolved');
    const previous = this.runtimes.get(sessionId);
    const next = new SessionRuntime(sessionId, init, () => this.broadcastMeta(sessionId));
    if (previous) {
      next.seq = previous.seq;
      for (const conn of previous.subscribers) next.subscribers.add(conn);
      previous.retire();
    }
    this.runtimes.set(sessionId, next);
  }

  endAgentSwitch(sessionId: string): void {
    this.switchingSessions.delete(sessionId);
  }

  /** Broadcast updated session metadata — only to connections whose account
   *  can see the session. */
  broadcastMeta(sessionId: string): void {
    const stored = sessionStore.get(sessionId);
    if (!stored) {
      for (const conn of this.conns) {
        if (sessionVisible(conn.account, sessionId)) conn.send({ t: 'session_removed', sessionId });
      }
      return;
    }
    const meta = toMeta(
      stored,
      this.isRunning(sessionId),
      'vibe',
      this.hasActiveBackgroundTasks(sessionId),
    );
    this.broadcastMetaObject(meta);
  }

  /** Broadcast an already-built meta. Used for changes that affect discovered
   *  (non-stored) sessions — e.g. a pin toggle — where broadcastMeta(id) can't
   *  build the meta from the store. */
  broadcastMetaObject(session: SessionMeta): void {
    for (const conn of this.conns) {
      if (metaVisible(conn.account, session)) conn.send({ t: 'session_meta', session });
    }
  }

  broadcastRemoved(sessionId: string): void {
    this.runtimes.delete(sessionId);
    for (const conn of this.conns) {
      if (sessionVisible(conn.account, sessionId)) conn.send({ t: 'session_removed', sessionId });
    }
  }

  /** Tell clients a row left the sidebar list (e.g. discovery refresh). Unlike
   *  broadcastRemoved, this does not tear down an active runtime. */
  broadcastSessionGone(sessionId: string): void {
    for (const conn of this.conns) {
      if (sessionVisible(conn.account, sessionId)) conn.send({ t: 'session_removed', sessionId });
    }
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
