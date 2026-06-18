import type { ChatBlock, LiveEvent } from '@shared/protocol';

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
}

export function emptyView(): SessionView {
  return { blocks: [], index: new Map(), lastSeq: 0, loaded: false, running: false };
}

export function viewFromBlocks(blocks: ChatBlock[], seq: number, running: boolean): SessionView {
  const index = new Map<string, number>();
  blocks.forEach((b, i) => index.set(b.id, i));
  return { blocks, index, lastSeq: seq, loaded: true, running };
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
      case 'token_usage':
        // usage is tracked on the session meta/store, not as a block
        break;
      case 'error':
        upsert({ id: `err_${seq}`, kind: 'error', text: ev.text, ts: Date.now() });
        break;
    }
  }

  return { ...view, blocks, index, lastSeq, running };
}
