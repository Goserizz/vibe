import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CursorStreamNormalizer } from '../../src/cursor/normalize.js';
import type { NormalizerCallbacks } from '../../src/claude/normalize.js';
import type { LiveEvent } from '../../../shared/protocol.js';

function run(messages: any[]): LiveEvent[] {
  const events: LiveEvent[] = [];
  const normalizer = new CursorStreamNormalizer({
    onEvent: (event) => events.push(event),
    onClaudeSessionId: () => {},
  } satisfies NormalizerCallbacks);
  for (const message of messages) normalizer.push(message);
  return events;
}

describe('cursor context-token normalization', () => {
  it('keeps Cursor cache buckets additive for a single-request turn', () => {
    const events = run([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          inputTokens: 4_284,
          outputTokens: 713,
          cacheReadTokens: 20_209,
          cacheCreationTokens: 0,
        },
      },
    ]);
    const result = events.find(
      (event) => event.k === 'block' && event.block.kind === 'result',
    );
    assert.equal(
      result?.k === 'block' && result.block.kind === 'result'
        ? result.block.contextUsed
        : undefined,
      25_206,
    );
  });

  it('omits Cursor turn-cumulative usage after a tool call', () => {
    const events = run([
      {
        type: 'tool_call',
        subtype: 'started',
        toolCallId: 'tool-1',
        tool_call: { shellToolCall: { args: { command: 'true' } } },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          inputTokens: 40_000,
          outputTokens: 2_000,
          cacheReadTokens: 300_000,
        },
      },
    ]);
    const result = events.find(
      (event) => event.k === 'block' && event.block.kind === 'result',
    );
    assert.equal(
      result?.k === 'block' && result.block.kind === 'result'
        ? result.block.contextUsed
        : undefined,
      undefined,
    );
  });
});
