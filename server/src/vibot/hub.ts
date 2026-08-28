import type { Conn } from '../ws/hub.js';
import type { AgentKind, ChatBlock, LiveEvent, VibotConvMeta } from '../../../shared/protocol.js';
import { convStore, toMeta, type StoredConv } from './conversations.js';
import { startVibotRun, applyEventToBlocks, type VibotRunHandle, type VibotRunResult } from './runner.js';
import { loadVibotConfig, vibotConfigured } from './config.js';
import { refreshDelegateWake } from './wakeSuppress.js';
import { log } from '../log.js';

const LOG_CAP = 2000;
const IDLE_GC_MS = 5 * 60_000;
/** Monotonic counter for delegate-note block ids (avoids pulling in crypto). */
let noteSeq = 0;
/** Monotonic counter for background-wake clientMsg ids. */
let wakeSeq = 0;

interface LoggedEvent {
  seq: number;
  ev: LiveEvent;
}

/**
 * One Vibot conversation's live state: a seq-tagged event log for lossless
 * replay (mirrors the coding hub), the set of subscribed connections, the
 * rendered-block accumulator for persistence, and the active run (if any).
 */
class VibotRuntime {
  seq = 0;
  running = false;
  readonly subscribers = new Set<Conn>();
  lastActivity = Date.now();
  private logBuf: LoggedEvent[] = [];
  private streamKinds = new Map<string, 'assistant' | 'thinking'>();
  /** Rendered blocks produced during the in-flight turn (persisted on finish). */
  private turnBlocks: ChatBlock[] = [];
  private runBaseSeq = 0;
  private run?: VibotRunHandle;
  /** LLM prompts waiting to start a silent wake turn once the current run ends.
   *  Keyed by delegate session id so same-session wakes coalesce to the latest
   *  prompt; different sessions stay until drain (joined into one turn).
   *  Visible system notes are posted immediately in {@link VibotHub.wake}, not here. */
  private pendingWakePrompts = new Map<string, string>();
  /** True while the in-flight turn was started as a silent (wake) turn. */
  private silentTurn = false;

  constructor(
    readonly convId: string,
    /** Fired whenever `running` flips so the hub can broadcast sidebar meta. */
    private readonly onRunningChange: () => void,
  ) {}

  /** Remember a wake prompt to fire after the in-flight turn finishes. */
  queueWakePrompt(sessionId: string, promptText: string): void {
    this.pendingWakePrompts.set(sessionId, promptText);
  }

  /** seq++, log, fold, broadcast — without touching the turn-block accumulator.
   *  Used by both the runner's emit and by {@link appendNote} (which must not
   *  pollute the in-flight turn's persisted blocks). */
  private push(ev: LiveEvent): void {
    this.seq += 1;
    const entry: LoggedEvent = { seq: this.seq, ev };
    this.logBuf.push(entry);
    // Track streamed-block kinds so a finalized block can be rebuilt if its
    // opening event was evicted from the log during a very long turn.
    if (ev.k === 'block' && (ev.block.kind === 'assistant' || ev.block.kind === 'thinking') && ev.block.streaming) {
      this.streamKinds.set(ev.block.id, ev.block.kind);
    }
    this.foldFinalized(ev);
    if (this.logBuf.length > LOG_CAP) this.logBuf.splice(0, this.logBuf.length - LOG_CAP);
    const frame = { t: 'vibot_event' as const, convId: this.convId, seq: this.seq, ev };
    for (const conn of this.subscribers) conn.send(frame);
  }

  private emit(ev: LiveEvent): void {
    this.push(ev);
    // Accumulate the rendered transcript for persistence at turn end.
    applyEventToBlocks(this.turnBlocks, ev);
  }

  /** Post a UI system notice into this conversation outside a model turn
   *  (coding-style dashed divider). Broadcast live AND persist to blocks, but
   *  keep it out of the LLM message history — it's a status line, not dialogue. */
  appendNote(text: string): void {
    const block: ChatBlock = { id: `vn_${++noteSeq}`, kind: 'system', text, ts: Date.now() };
    this.push({ k: 'block', block });
    convStore.appendBlock(this.convId, block);
    this.lastActivity = Date.now();
  }

  /**
   * When a streamed assistant block finalizes, fold its deltas into the opening
   * `block` event so the log stays compact AND every finished block is
   * self-contained for replay (ported from the coding hub, trimmed to
   * assistant/thinking). If the opening event was evicted, rebuild the block.
   */
  private foldFinalized(ev: LiveEvent): void {
    let id: string | undefined;
    let finalText: string | undefined;
    if (ev.k === 'block_end') {
      id = ev.id;
      finalText = ev.text;
    } else if (ev.k === 'block' && (ev.block.kind === 'assistant' || ev.block.kind === 'thinking') && !ev.block.streaming) {
      id = ev.block.id;
      finalText = ev.block.text;
    }
    if (!id) return;
    const targetId = id;

    const next: LoggedEvent[] = [];
    let openAt = -1;
    let streamed: string | undefined;
    for (const e of this.logBuf) {
      const evt = e.ev;
      if (evt.k === 'block' && evt.block.id === targetId && 'streaming' in evt.block && evt.block.streaming) {
        openAt = next.length;
        streamed = (evt.block as { text: string }).text;
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
      const block = (open.ev as { k: 'block'; block: ChatBlock }).block as ChatBlock;
      const text = finalText ?? streamed ?? (block as { text: string }).text;
      next[openAt] = { seq: open.seq, ev: { k: 'block', block: { ...block, text, streaming: false } as ChatBlock } };
    } else if (finalText != null) {
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

  /** Replay everything after `lastSeq`; false when the client must reset. */
  replay(conn: Conn, lastSeq: number): boolean {
    const oldest = this.logBuf.length ? this.logBuf[0].seq : this.seq + 1;
    if (lastSeq > 0 && lastSeq + 1 < oldest && lastSeq < this.seq) return false;
    if (lastSeq > this.seq) return false;
    for (const entry of this.logBuf) {
      if (entry.seq > lastSeq) conn.send({ t: 'vibot_event', convId: this.convId, seq: entry.seq, ev: entry.ev });
    }
    return true;
  }

  private setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.lastActivity = Date.now();
    this.emit({ k: 'run_state', running });
    this.onRunningChange();
  }

  startTurn(text: string, clientMsgId: string, opts?: { silent?: boolean; wakeSessionId?: string }): boolean {
    if (this.running || this.run) return false;
    if (!vibotConfigured()) return false;

    this.runBaseSeq = this.seq;
    this.turnBlocks = [];
    this.silentTurn = !!opts?.silent;
    this.lastActivity = Date.now();
    this.setRunning(true);
    // A normal user turn shows the prompt as a user block. A background wake
    // (silent) seeds the LLM with the same text but skips the user bubble — the
    // caller has already posted a status note as the visible marker.
    if (!opts?.silent) {
      this.emit({ k: 'block', block: { id: clientMsgId, kind: 'user', text, ts: Date.now() } });
    } else if (opts.wakeSessionId) {
      // Silent turn may start long after markDelegateWake (queued behind a user
      // turn) — refresh so zcode keeps deferring through the actual wake.
      refreshDelegateWake(opts.wakeSessionId);
    }

    this.run = startVibotRun(
      { convId: this.convId, prompt: text, config: loadVibotConfig() },
      { onEvent: (ev) => this.emit(ev) },
    );
    const active = this.run;
    void active.done.then((result) => this.finishTurn(result, active));
    return true;
  }

  private finishTurn(result: VibotRunResult, run: VibotRunHandle): void {
    if (this.run !== run) return;
    this.run = undefined;
    const wasSilent = this.silentTurn;
    this.silentTurn = false;
    if (wasSilent) {
      const hasAssistant = result.newMessages.some(
        (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0,
      );
      const hasTools = result.newMessages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
      if (!hasAssistant && !hasTools) {
        log.warn(`vibot: silent wake turn produced no assistant output (conv ${this.convId}, ${result.error ?? 'no error'})`);
      }
    }
    // Persist this turn's LLM messages + rendered blocks.
    convStore.appendRun(this.convId, result.newMessages, this.turnBlocks, 1);
    this.turnBlocks = [];
    this.streamKinds.clear();
    this.setRunning(false);
    this.lastActivity = Date.now();
    // Drain deferred background wake prompts (notes were already posted at queue time).
    this.drainPendingWakePrompts();
  }

  /** Start one silent turn for all queued wake prompts (same session → latest only). */
  private drainPendingWakePrompts(): void {
    if (this.pendingWakePrompts.size === 0) return;
    const entries = [...this.pendingWakePrompts.entries()];
    this.pendingWakePrompts.clear();
    if (!vibotConfigured()) return;
    for (const [sid] of entries) refreshDelegateWake(sid);
    this.startTurn(entries.map(([, t]) => t).join('\n\n'), `vw_${++wakeSeq}`, {
      silent: true,
      wakeSessionId: entries.length === 1 ? entries[0][0] : undefined,
    });
  }

  abort(): void {
    this.run?.abort();
  }

  /** History + the seq to subscribe from (run in flight ⇒ baseline + runBaseSeq). */
  snapshotPlan(conv: StoredConv | undefined): { blocks: ChatBlock[]; seq: number } {
    if (this.run) return { blocks: conv?.blocks ?? [], seq: this.runBaseSeq };
    return { blocks: conv?.blocks ?? [], seq: this.seq };
  }

  hasActivity(): boolean {
    return Boolean(this.run) || this.subscribers.size > 0;
  }
}

export class VibotHub {
  private runtimes = new Map<string, VibotRuntime>();
  private conns = new Set<Conn>();
  /**
   * Durable subscribe intent per conversation. Survives idle runtime GC so a
   * rebuilt runtime can reattach the same sockets — without the wake-time
   * "add every connected client" hammer that polluted other chats' streams.
   */
  private subscribersByConv = new Map<string, Set<Conn>>();

  private runtimeFor(convId: string): VibotRuntime | undefined {
    let rt = this.runtimes.get(convId);
    if (rt) return rt;
    const conv = convStore.get(convId);
    if (!conv) return undefined;
    rt = new VibotRuntime(convId, () => this.broadcastMeta(convId));
    // Restore push targets only — seq / logBuf start fresh; clients still use
    // lastSeq + replay/reset on the next vibot_subscribe as before.
    const saved = this.subscribersByConv.get(convId);
    if (saved) {
      for (const c of saved) rt.subscribers.add(c);
    }
    this.runtimes.set(convId, rt);
    return rt;
  }

  private trackSubscriber(convId: string, conn: Conn, rt: VibotRuntime): void {
    let set = this.subscribersByConv.get(convId);
    if (!set) {
      set = new Set();
      this.subscribersByConv.set(convId, set);
    }
    set.add(conn);
    rt.subscribers.add(conn);
  }

  private untrackSubscriber(convId: string, conn: Conn): void {
    const set = this.subscribersByConv.get(convId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.subscribersByConv.delete(convId);
    }
    this.runtimes.get(convId)?.subscribers.delete(conn);
  }

  // -- connection lifecycle --------------------------------------------------

  addConn(conn: Conn): void {
    this.conns.add(conn);
    conn.send({ t: 'vibot_conv_list', convs: convStore.list() });
  }

  removeConn(conn: Conn): void {
    this.conns.delete(conn);
    for (const [convId, set] of this.subscribersByConv) {
      if (!set.delete(conn)) continue;
      if (set.size === 0) this.subscribersByConv.delete(convId);
    }
    for (const rt of this.runtimes.values()) rt.subscribers.delete(conn);
    this.gc();
  }

  // -- subscribe / send ------------------------------------------------------

  subscribe(conn: Conn, convId: string, lastSeq: number): void {
    const rt = this.runtimeFor(convId);
    if (!rt) {
      conn.send({ t: 'error', message: 'vibot conversation not found' });
      return;
    }
    this.trackSubscriber(convId, conn, rt);
    const ok = rt.replay(conn, lastSeq);
    conn.send({ t: 'vibot_subscribed', convId, seq: rt.seq, running: rt.running, reset: !ok });
  }

  unsubscribe(conn: Conn, convId: string): void {
    this.untrackSubscriber(convId, conn);
  }

  send(conn: Conn, convId: string, clientMsgId: string, text: string): boolean {
    const rt = this.runtimeFor(convId);
    if (!rt) {
      conn.send({ t: 'error', message: 'vibot conversation not found' });
      return false;
    }
    this.trackSubscriber(convId, conn, rt);
    const started = rt.startTurn(text, clientMsgId);
    if (!started) {
      conn.send({
        t: 'error',
        message: vibotConfigured() ? 'a turn is already running' : 'Vibot is not configured — set its API key, base URL, and model in Vibot settings.',
      });
      return false;
    }
    this.broadcastMeta(convId);
    return true;
  }

  abort(convId: string): void {
    this.runtimes.get(convId)?.abort();
  }

  /** Conversation history + the seq to subscribe from. */
  async snapshot(convId: string): Promise<{ blocks: ChatBlock[]; seq: number }> {
    const rt = this.runtimes.get(convId);
    const conv = convStore.get(convId);
    if (!conv) return { blocks: [], seq: 0 };
    return rt ? rt.snapshotPlan(conv) : { blocks: conv.blocks, seq: 0 };
  }

  isRunning(convId: string): boolean {
    return this.runtimes.get(convId)?.running ?? false;
  }

  // -- CRUD (broadcasts keep every client's sidebar in sync) -----------------

  listConversations(): VibotConvMeta[] {
    return convStore.list();
  }

  createConversation(title?: string): VibotConvMeta {
    const conv = convStore.create(title);
    const meta = toMeta(conv, false);
    this.broadcast({ t: 'vibot_conv_meta', conv: meta });
    return meta;
  }

  renameConversation(convId: string, title: string): VibotConvMeta | undefined {
    const conv = convStore.rename(convId, title);
    if (!conv) return undefined;
    const meta = toMeta(conv, this.isRunning(convId));
    this.broadcast({ t: 'vibot_conv_meta', conv: meta });
    return meta;
  }

  deleteConversation(convId: string): boolean {
    const existed = convStore.remove(convId);
    this.runtimes.delete(convId);
    this.subscribersByConv.delete(convId);
    if (existed) this.broadcast({ t: 'vibot_conv_removed', convId });
    return existed;
  }

  /** Push the current meta for a conversation to every client (e.g. after a run
   *  flips running, or the title auto-derived from the first message). */
  broadcastMeta(convId: string): void {
    const conv = convStore.get(convId);
    if (!conv) return;
    const rt = this.runtimes.get(convId);
    this.broadcast({ t: 'vibot_conv_meta', conv: toMeta(conv, rt?.running ?? false) });
  }

  /** Post a UI status note into a conversation outside a model turn — used by
   *  the delegate watcher to report permission approvals / completion. The note
   *  is broadcast live and persisted to the transcript (not to LLM history). */
  appendNote(convId: string, text: string): void {
    const rt = this.runtimeFor(convId);
    if (!rt) return;
    rt.appendNote(text);
  }

  /** Record a coding session this Vibot chat opened/continued and broadcast
   *  the updated meta so the sidebar's expandable child list stays in sync. */
  linkSession(
    convId: string,
    session: { id: string; title: string; agent: AgentKind; host: string },
  ): void {
    const conv = convStore.linkSession(convId, session);
    if (!conv) return;
    this.broadcast({ t: 'vibot_conv_meta', conv: toMeta(conv, this.isRunning(convId)) });
  }

  /** Remove a coding-session link from this Vibot chat. Does not delete or stop
   *  the coding session itself. Returns the updated meta, or null if the conv /
   *  link was missing. Caller may also stop a delegate watcher separately. */
  unlinkSession(convId: string, sessionId: string): VibotConvMeta | null {
    const conv = convStore.unlinkSession(convId, sessionId);
    if (!conv) return null;
    const meta = toMeta(conv, this.isRunning(convId));
    this.broadcast({ t: 'vibot_conv_meta', conv: meta });
    return meta;
  }

  /** A delegated session's foreground turn finished — wake Vibot so it produces
   *  a follow-up reply. Posts a short coding-style system notice (visible), then
   *  starts a silent turn seeded with the full LLM prompt (not shown as a user
   *  bubble). If a turn is already running, the note still posts immediately and
   *  only the prompt is queued (same sessionId replaces an older pending prompt). */
  wake(convId: string, noteText: string, promptText: string, sessionId?: string): void {
    const rt = this.runtimeFor(convId);
    if (!rt) {
      log.warn(`vibot: wake skipped — conversation ${convId} not found`);
      return;
    }
    // Subscribers come from subscribersByConv restore in runtimeFor — do not
    // fan out to every vibot socket (that leaked conv A events into chat B).
    rt.appendNote(noteText);
    if (rt.running) {
      rt.queueWakePrompt(sessionId || convId, promptText);
      if (sessionId) refreshDelegateWake(sessionId);
      return;
    }
    rt.startTurn(promptText, `vw_${++wakeSeq}`, { silent: true, wakeSessionId: sessionId });
    this.broadcastMeta(convId);
  }

  private broadcast(ev: Parameters<Conn['send']>[0]): void {
    for (const conn of this.conns) conn.send(ev);
  }

  private gc(): void {
    for (const [id, rt] of this.runtimes) {
      if (!rt.hasActivity() && Date.now() - rt.lastActivity > IDLE_GC_MS) {
        this.runtimes.delete(id);
      }
    }
  }
}

export const vibotHub = new VibotHub();
