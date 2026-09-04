import { StreamNormalizer, type NormalizerCallbacks } from '../claude/normalize.js';
import type { ChatBlock, LiveEvent } from '../../../shared/protocol.js';

/**
 * CodeBuddy is a Claude Code fork and speaks the exact same stream-json
 * protocol (system/init, stream_event, assistant, user, result), so the shared
 * Claude `StreamNormalizer` already covers it — including partial-message
 * streaming, tool_use/tool_result pairing, and result-usage extraction.
 *
 * Fork-specific quirks are handled here (probed on 2.141.0):
 *  - Background-task events carry the agent tag (Claude's normalizer hardcodes
 *    'claude'), so those are relabeled.
 *  - The CLI emits `system/init` frames for a secondary/lite session alongside
 *    the real one (two inits per turn with different session ids; the second
 *    never produces content). The session id is therefore stripped from
 *    system/snapshot frames so only conversation events (assistant/user/result/
 *    stream) can report it.
 *  - Final `assistant` events don't reuse the streaming message id. Claude Code
 *    ends a streamed message with ONE assistant event carrying message_start's
 *    id; this fork emits ONE assistant event PER content block, each under a
 *    fresh uuid. The shared normalizer reconciles streamed and final blocks by
 *    id (`${messageId}:${index}`), so with mismatched ids every block renders
 *    twice — once from the stream, once from the final event. Rewriting the
 *    final events' message id back to the streaming id restores the overlay:
 *    the parent's per-message offset then maps the fork's per-block events to
 *    `gen-…:0`, `gen-…:1`, … exactly where the streamed blocks live, and a new
 *    message_start (new gen id) resets the sequence naturally.
 *  - A final message can also DROP a part the stream produced: the engine
 *    sometimes leaves the reasoning out of the final message (its native log
 *    has no `reasoning` entry for that generation either) even though the
 *    stream emitted thinking at index 0 and text at index 1. The parent's
 *    sequential offset then lands the text part on `gen-…:0` — the thinking
 *    slot — replacing the thinking and rendering the text a second time beside
 *    the streamed `gen-…:1` copy. The overlay parts are therefore re-indexed
 *    by matching their kind against the generation's streamed block layout
 *    (recorded from content_block_start), so each part overlays the slot it
 *    actually streamed from; parts that never streamed get a fresh slot past
 *    the streamed range instead of clobbering a sibling.
 *  - The engine cancels a failed generation mid-stream and retries under a
 *    fresh message id (trace spans show status "cancelled" / "Error streaming
 *    response"). Each cancelled attempt has already emitted
 *    content_block_start(thinking) but no delta and no stop, which the shared
 *    normalizer would turn into an empty streaming block that never closes —
 *    stacking permanent "Thinking…" rows. Empty thinking starts are therefore
 *    held back until their first delta proves the generation is alive; a new
 *    message_start, a result, or a bare stop drops them silently.
 */
export class CodebuddyStreamNormalizer extends StreamNormalizer {
  /** Message id of the most recent message_start — the id streamed blocks use. */
  private lastStreamMessageId: string | undefined;

  /** Thinking blocks opened but not yet shown: id → block, until first delta. */
  private heldThinking = new Map<string, ChatBlock>();

  /** Streamed block kinds by content index for the current generation. */
  private readonly streamedKinds = new Map<number, 'assistant' | 'thinking'>();
  /** Streamed indexes already claimed by a final overlay part this generation. */
  private readonly claimedIndexes = new Set<number>();
  /** Re-indexed targets for the final overlay parts of the assistant event
   *  currently being pushed, consumed in emission order by the onEvent hook. */
  private readonly overlayTargets: number[] = [];

  constructor(cb: NormalizerCallbacks) {
    super({
      ...cb,
      onEvent: (ev: LiveEvent) => {
        // Re-id final overlays onto the slot they streamed from (see class
        // comment) before any held-thinking bookkeeping keys off the id.
        if (
          ev.k === 'block' &&
          'streaming' in ev.block && !ev.block.streaming &&
          this.lastStreamMessageId && ev.block.id.startsWith(`${this.lastStreamMessageId}:`)
        ) {
          const target = this.overlayTargets.shift();
          if (target !== undefined) {
            ev = { ...ev, block: { ...ev.block, id: `${this.lastStreamMessageId}:${target}` } };
          }
        }
        if (ev.k === 'block' && ev.block.kind === 'thinking' && ev.block.streaming && !ev.block.text) {
          this.heldThinking.set(ev.block.id, ev.block);
          return;
        }
        if (ev.k === 'delta') {
          const held = this.heldThinking.get(ev.id);
          if (held) {
            this.heldThinking.delete(ev.id);
            cb.onEvent({ k: 'block', block: held });
          }
        } else if (ev.k === 'block_end' && this.heldThinking.delete(ev.id)) {
          // Stopped with no content — the block was never sent, so swallow the
          // stop too. A final assistant overlay for the same id still renders.
          return;
        } else if (ev.k === 'block' && this.heldThinking.delete(ev.block.id)) {
          // The final overlay replaces the held shell — nothing to release.
        }
        cb.onEvent(ev);
      },
      onTask: (task) => cb.onTask?.({ ...task, agent: 'codebuddy' }),
    });
  }

  /** Map the parts of an incoming final assistant message onto streamed block
   *  indexes by kind. Called before super.push so the onEvent hook can re-id
   *  the blocks the parent is about to emit. */
  private planOverlayTargets(inner: unknown): void {
    const parts = Array.isArray((inner as { content?: unknown[] })?.content)
      ? ((inner as { content: unknown[] }).content)
      : [];
    for (const part of parts as any[]) {
      const kind = part?.type === 'text' ? 'assistant' : part?.type === 'thinking' ? 'thinking' : undefined;
      if (!kind) continue; // tool_use blocks keep their own call ids
      let target: number | undefined;
      for (const [index, streamed] of this.streamedKinds) {
        if (streamed === kind && !this.claimedIndexes.has(index)) {
          target = index;
          break;
        }
      }
      if (target === undefined) {
        // Part never streamed: slot it past the streamed range rather than
        // onto a sibling's index.
        const indexes = [...this.streamedKinds.keys(), ...this.claimedIndexes];
        let next = indexes.length ? Math.max(...indexes) + 1 : 0;
        while (this.streamedKinds.has(next) || this.claimedIndexes.has(next)) next += 1;
        target = next;
      }
      this.claimedIndexes.add(target);
      this.overlayTargets.push(target);
    }
  }

  override push(message: any): void {
    if (!message || typeof message !== 'object') return;
    // Observe message_start ourselves — the parent's currentMessageId is private.
    if (message.type === 'stream_event' && message.event?.type === 'message_start') {
      const id = message.event.message?.id;
      if (typeof id === 'string' && id) this.lastStreamMessageId = id;
      // A new message_start closes the previous generation: anything still
      // held never got content and never will.
      this.heldThinking.clear();
      this.streamedKinds.clear();
      this.claimedIndexes.clear();
      this.overlayTargets.length = 0;
    }
    if (message.type === 'stream_event' && message.event?.type === 'content_block_start') {
      const block = message.event.content_block;
      const index = Number(message.event.index) || 0;
      if (block?.type === 'text') this.streamedKinds.set(index, 'assistant');
      else if (block?.type === 'thinking') this.streamedKinds.set(index, 'thinking');
    }
    if (message.type === 'result') {
      this.heldThinking.clear();
      this.overlayTargets.length = 0;
    }
    if (message.type === 'system' || message.type === 'file-history-snapshot') {
      if (message.session_id !== undefined) {
        super.push({ ...message, session_id: undefined });
        return;
      }
    }
    if (message.type === 'assistant') this.planOverlayTargets(message.message);
    if (message.type === 'assistant' && this.lastStreamMessageId) {
      const inner = message.message;
      if (
        inner && typeof inner === 'object' &&
        typeof inner.id === 'string' && inner.id && inner.id !== this.lastStreamMessageId
      ) {
        super.push({ ...message, message: { ...inner, id: this.lastStreamMessageId } });
        return;
      }
    }
    super.push(message);
  }
}
