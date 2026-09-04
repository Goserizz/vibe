import {
  settleInterruptedTools,
  sortBlocksChronologically,
  type ChatBlock,
  type LiveEvent,
  type SnapshotPage,
} from '@shared/protocol';

/**
 * The rendered conversation for one session plus the live metadata that drives
 * the chat header and composer.
 */
export interface SessionView {
  blocks: ChatBlock[];
  /** id -> array index, for O(1) upserts on the streaming hot path. */
  index: Map<string, number>;
  lastSeq: number;
  loaded: boolean;
  running: boolean;
  /** Older history exists server-side; `cursor` fetches the next page. */
  hasMore: boolean;
  cursor?: string;
  /** A loadOlder() request is in flight (guards double-fires). */
  loadingOlder: boolean;
}

export function emptyView(): SessionView {
  return { blocks: [], index: new Map(), lastSeq: 0, loaded: false, running: false, hasMore: false, loadingOlder: false };
}

/** The settling/filtering viewFromBlocks applies to freshly fetched history —
 *  shared by the first page and prepended older pages. */
function settleHistory(blocks: ChatBlock[], running: boolean): ChatBlock[] {
  const kept = blocks.filter((b) => b.kind !== 'thinking' || b.text);
  const settled = running
    ? kept
    : settleInterruptedTools(kept).map((b) =>
        (b.kind === 'assistant' || b.kind === 'thinking') && b.streaming
          ? { ...b, streaming: false }
          : b,
      );
  return sortBlocksChronologically(settled);
}

export function viewFromBlocks(
  blocks: ChatBlock[],
  seq: number,
  running: boolean,
  page?: SnapshotPage,
): SessionView {
  const index = new Map<string, number>();
  // Empty thinking shells — an agent generation cancelled before its first
  // reasoning token — never render (ThinkingView bails on empty text), so drop
  // them here too. And history is static: a persisted streaming flag would show
  // "Thinking…" forever, and a tool left `running` by a dead transport would
  // pulse "Running…" forever — unless this fetch caught a turn that is live
  // right now. Transcript files are also append-only: a tool stuck `running`
  // is force-flushed after the turn's result block even when its `ts` is
  // older, so restore chronological order by sorting on `ts`.
  const ordered = settleHistory(blocks, running);
  ordered.forEach((b, i) => index.set(b.id, i));
  return {
    blocks: ordered,
    index,
    lastSeq: seq,
    loaded: true,
    running,
    hasMore: page?.hasMore ?? false,
    cursor: page?.cursor,
    loadingOlder: false,
  };
}

/** Prepend one older page onto a loaded view. Older blocks come first; ids
 *  already present keep their existing (newer) copy. */
export function prependPage(view: SessionView, blocks: ChatBlock[], page: SnapshotPage): SessionView {
  const older = settleHistory(blocks, view.running).filter((b) => !view.index.has(b.id));
  const merged = [...older, ...view.blocks];
  const index = new Map<string, number>();
  merged.forEach((b, i) => index.set(b.id, i));
  return { ...view, blocks: merged, index, hasMore: page.hasMore, cursor: page.cursor, loadingOlder: false };
}

/**
 * Apply a batch of live events to a view, producing a new view. Only the
 * blocks that actually change get new object identities, so memoized block
 * components elsewhere can skip re-rendering.
 */
export function reduceView(view: SessionView, events: { seq: number; ev: LiveEvent }[]): SessionView {
  if (events.length === 0) return view;

  const blocks = view.blocks.slice();
  const index = new Map(view.index);
  let { lastSeq, running } = view;

  const upsert = (block: ChatBlock) => {
    const at = index.get(block.id);
    if (at === undefined) {
      index.set(block.id, blocks.length);
      blocks.push(block);
    } else {
      blocks[at] = block;
    }
  };

  for (const { seq, ev } of events) {
    if (seq > lastSeq) lastSeq = seq;
    switch (ev.k) {
      case 'block':
        upsert(ev.block);
        break;
      case 'delta': {
        const at = index.get(ev.id);
        if (at !== undefined) {
          const b = blocks[at];
          if (b.kind === 'assistant' || b.kind === 'thinking') {
            blocks[at] = { ...b, text: b.text + ev.chunk };
          }
        }
        break;
      }
      case 'block_end': {
        const at = index.get(ev.id);
        if (at !== undefined) {
          const b = blocks[at];
          if (b.kind === 'assistant' || b.kind === 'thinking') {
            blocks[at] = { ...b, streaming: false, ...(ev.text != null ? { text: ev.text } : {}) };
          }
        }
        break;
      }
      case 'tool_result': {
        const at = index.get(ev.toolUseId);
        if (at !== undefined) {
          const b = blocks[at];
          if (b.kind === 'tool') {
            blocks[at] = { ...b, result: ev.content, status: ev.isError ? 'error' : 'done', isError: ev.isError };
          }
        }
        break;
      }
      case 'run_state':
        running = ev.running;
        break;
      case 'error':
        upsert({ id: `err_${seq}`, kind: 'error', text: ev.text, ts: Date.now() });
        break;
    }
  }

  return { ...view, blocks, index, lastSeq, running };
}
