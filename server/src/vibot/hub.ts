import type { Conn } from '../ws/hub.js';
import type { ChatBlock, LiveEvent, VibotConvMeta } from '../../../shared/protocol.js';
import { convStore, toMeta, type StoredConv } from './conversations.js';
import { startVibotRun, applyEventToBlocks, type VibotRunHandle, type VibotRunResult } from './runner.js';
import { loadVibotConfig, vibotConfigured } from './config.js';

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

  constructor(readonly convId: string) {}

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

  /** Post a UI note into this conversation outside a model turn (e.g. a delegate
   *  status update from the watcher). Broadcast live AND persist to blocks, but
   *  keep it out of the LLM message history — it's a status line, not dialogue. */
  appendNote(text: string): void {
    const block: ChatBlock = { id: `vn_${++noteSeq}`, kind: 'assistant', text, streaming: false, ts: Date.now() };
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
  }

  startTurn(text: string, clientMsgId: string, opts?: { silent?: boolean }): boolean {
    if (this.running || this.run) return false;
    if (!vibotConfigured()) return false;

    this.runBaseSeq = this.seq;
    this.turnBlocks = [];
    this.lastActivity = Date.now();
    this.setRunning(true);
    // A normal user turn shows the prompt as a user block. A background wake
    // (silent) seeds the LLM with the same text but skips the user bubble — the
    // caller has already posted a status note as the visible marker.
    if (!opts?.silent) {
      this.emit({ k: 'block', block: { id: clientMsgId, kind: 'user', text, ts: Date.now() } });
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
    // Persist this turn's LLM messages + rendered blocks.
    convStore.appendRun(this.convId, result.newMessages, this.turnBlocks, 1);
    this.turnBlocks = [];
    this.streamKinds.clear();
    this.setRunning(false);
    this.lastActivity = Date.now();
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

  private runtimeFor(convId: string): VibotRuntime | undefined {
    let rt = this.runtimes.get(convId);
    if (rt) return rt;
    const conv = convStore.get(convId);
    if (!conv) return undefined;
    rt = new VibotRuntime(convId);
    this.runtimes.set(convId, rt);
    return rt;
  }

  // -- connection lifecycle --------------------------------------------------

  addConn(conn: Conn): void {
    this.conns.add(conn);
    conn.send({ t: 'vibot_conv_list', convs: convStore.list() });
  }

  removeConn(conn: Conn): void {
    this.conns.delete(conn);
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
    rt.subscribers.add(conn);
    const ok = rt.replay(conn, lastSeq);
    conn.send({ t: 'vibot_subscribed', convId, seq: rt.seq, running: rt.running, reset: !ok });
  }

  unsubscribe(conn: Conn, convId: string): void {
    this.runtimes.get(convId)?.subscribers.delete(conn);
  }

  send(conn: Conn, convId: string, clientMsgId: string, text: string): boolean {
    const rt = this.runtimeFor(convId);
    if (!rt) {
      conn.send({ t: 'error', message: 'vibot conversation not found' });
      return false;
    }
    rt.subscribers.add(conn);
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

  /** A delegated session finished in the background — wake Vibot so it produces
   *  a follow-up reply. Posts the outcome as a visible note, then starts a new
   *  silent turn seeded with the same outcome (so the model reasons about it).
   *  If a turn is already running (the user is actively chatting), fall back to
   *  just the note rather than clobbering the live turn. */
  wake(convId: string, outcomeText: string): void {
    const rt = this.runtimeFor(convId);
    if (!rt) return;
    rt.appendNote(outcomeText);
    if (rt.running) return;
    rt.startTurn(outcomeText, `vw_${++wakeSeq}`, { silent: true });
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
