import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodebuddyStreamNormalizer } from '../../src/codebuddy/normalize.js';
import type { NormalizerCallbacks } from '../../src/claude/normalize.js';
import type { ChatBlock, LiveEvent } from '../../../shared/protocol.js';

/** Feed stream-json lines through the normalizer and reduce the events the way
 *  the client does (blocks by id, deltas appended, block_end finalizes). */
function run(messages: any[]): ChatBlock[] {
  const events: LiveEvent[] = [];
  const cb: NormalizerCallbacks = {
    onEvent: (ev: LiveEvent) => events.push(ev),
    onClaudeSessionId: () => {},
  };
  const n = new CodebuddyStreamNormalizer(cb);
  for (const message of messages) n.push(message);
  const blocks = new Map<string, ChatBlock>();
  for (const ev of events) {
    if (ev.k === 'block') blocks.set(ev.block.id, { ...ev.block });
    else if (ev.k === 'delta') {
      const b = blocks.get(ev.id);
      if (b && (b.kind === 'assistant' || b.kind === 'thinking')) {
        blocks.set(ev.id, { ...b, text: b.text + ev.chunk });
      }
    } else if (ev.k === 'block_end') {
      const b = blocks.get(ev.id);
      if (b && (b.kind === 'assistant' || b.kind === 'thinking')) {
        blocks.set(ev.id, { ...b, streaming: false, ...(ev.text != null ? { text: ev.text } : {}) });
      }
    }
  }
  return [...blocks.values()];
}

const GEN = '6d24c836874c4a498653411edb8d810c';

function messageStart(id: string): any {
  return { type: 'stream_event', event: { type: 'message_start', message: { id } } };
}

function blockStart(index: number, kind: 'text' | 'thinking'): any {
  return { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: kind } } };
}

function delta(index: number, kind: 'text' | 'thinking', chunk: string): any {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: kind === 'text' ? { type: 'text_delta', text: chunk } : { type: 'thinking_delta', thinking: chunk },
    },
  };
}

function blockStop(index: number): any {
  return { type: 'stream_event', event: { type: 'content_block_stop', index } };
}

/** The fork ends a streamed message with one final `assistant` event per
 *  content block, each under a fresh uuid. */
function finalEvent(parts: any[]): any {
  return { type: 'assistant', message: { id: `01a0-${Math.random().toString(36).slice(2, 10)}`, content: parts } };
}

describe('codebuddy final-message overlay alignment', () => {
  it('keeps thinking and a single text copy when the final message drops the reasoning part', () => {
    const blocks = run([
      messageStart(GEN),
      blockStart(0, 'thinking'),
      delta(0, 'thinking', 'Process is healthy.'),
      blockStop(0),
      blockStart(1, 'text'),
      delta(1, 'text', '进程正常。'),
      blockStop(1),
      // Native log for this generation has no reasoning entry: the final
      // message carries only the text part.
      finalEvent([{ type: 'text', text: '进程正常（52/287）。重新挂监控。' }]),
    ]);
    const texts = blocks.filter((b) => b.kind === 'assistant');
    assert.equal(texts.length, 1, `expected one assistant block, got ${texts.length}`);
    assert.equal(texts[0].id, `${GEN}:1`);
    assert.equal(texts[0].text, '进程正常（52/287）。重新挂监控。');
    const thinking = blocks.filter((b) => b.kind === 'thinking');
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].text, 'Process is healthy.');
  });

  it('overlays per-block finals onto matching streamed slots when reasoning is kept', () => {
    const blocks = run([
      messageStart(GEN),
      blockStart(0, 'thinking'),
      delta(0, 'thinking', 'Think.'),
      blockStop(0),
      blockStart(1, 'text'),
      delta(1, 'text', 'Answer.'),
      blockStop(1),
      finalEvent([{ type: 'thinking', thinking: 'Think.' }]),
      finalEvent([{ type: 'text', text: 'Answer.' }]),
    ]);
    assert.deepEqual(
      blocks.filter((b) => b.kind === 'assistant').map((b) => b.id),
      [`${GEN}:1`],
    );
    assert.deepEqual(
      blocks.filter((b) => b.kind === 'thinking').map((b) => b.id),
      [`${GEN}:0`],
    );
  });

  it('does not duplicate text when the streamed thinking shell never got a delta', () => {
    const blocks = run([
      messageStart(GEN),
      blockStart(0, 'thinking'),
      blockStop(0), // cancelled attempt: no delta, held back
      blockStart(1, 'text'),
      delta(1, 'text', 'Answer.'),
      blockStop(1),
      finalEvent([{ type: 'text', text: 'Answer.' }]),
    ]);
    const texts = blocks.filter((b) => b.kind === 'assistant');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].id, `${GEN}:1`);
    assert.equal(blocks.filter((b) => b.kind === 'thinking').length, 0);
  });

  it('slots a never-streamed final part past the streamed range instead of clobbering', () => {
    const blocks = run([
      messageStart(GEN),
      blockStart(0, 'text'),
      delta(0, 'text', 'Answer.'),
      blockStop(0),
      // Final message gained a thinking part the stream never produced.
      finalEvent([{ type: 'thinking', thinking: 'retro reasoning' }]),
      finalEvent([{ type: 'text', text: 'Answer.' }]),
    ]);
    const text = blocks.find((b) => b.kind === 'assistant');
    assert.equal(text?.id, `${GEN}:0`);
    assert.equal(text?.text, 'Answer.');
    const thinking = blocks.find((b) => b.kind === 'thinking');
    assert.equal(thinking?.id, `${GEN}:1`);
    assert.equal(thinking?.text, 'retro reasoning');
  });

  it('assigns streamed indexes per kind across two streamed text blocks', () => {
    const blocks = run([
      messageStart(GEN),
      blockStart(0, 'thinking'),
      delta(0, 'thinking', 'h'),
      blockStop(0),
      blockStart(1, 'text'),
      delta(1, 'text', 'one'),
      blockStop(1),
      blockStart(2, 'text'),
      delta(2, 'text', 'two'),
      blockStop(2),
      finalEvent([{ type: 'text', text: 'one' }]),
      finalEvent([{ type: 'text', text: 'two' }]),
    ]);
    const texts = blocks.filter((b) => b.kind === 'assistant');
    assert.deepEqual(
      texts.map((b) => [b.id, b.text]),
      [[`${GEN}:1`, 'one'], [`${GEN}:2`, 'two']],
    );
  });

  it('still renders finals when nothing streamed (no message_start)', () => {
    const blocks = run([
      finalEvent([{ type: 'thinking', thinking: 'h' }]),
      finalEvent([{ type: 'text', text: 'Answer.' }]),
    ]);
    assert.equal(blocks.filter((b) => b.kind === 'thinking').length, 1);
    assert.equal(blocks.filter((b) => b.kind === 'assistant').length, 1);
  });

  it('reports CodeBuddy hybrid usage once instead of doubling input tokens', () => {
    const usage = {
      input_tokens: 95_822,
      output_tokens: 312,
      total_tokens: 96_134,
      inputTokens: 95_822,
      outputTokens: 312,
      cache_read_input_tokens: 320,
      cache_creation_input_tokens: 95_502,
    };
    const blocks = run([
      {
        type: 'assistant',
        message: {
          id: 'codebuddy-usage',
          content: [{ type: 'text', text: 'ok' }],
          usage,
        },
      },
      { type: 'result', subtype: 'success', duration_ms: 1, usage },
    ]);
    const result = blocks.find((block) => block.kind === 'result');
    assert.equal(result?.kind === 'result' ? result.contextUsed : undefined, 96_134);
  });
});
