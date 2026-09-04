import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexStreamNormalizer, parseCodexResponseItem } from '../../src/codex/normalize.js';
import type { NormalizerCallbacks } from '../../src/claude/normalize.js';
import type { LiveEvent } from '../../../shared/protocol.js';

describe('codex fileChange edit blocks', () => {
  function run(items: any[]): LiveEvent[] {
    const events: LiveEvent[] = [];
    const cb: NormalizerCallbacks = {
      onEvent: (ev: LiveEvent) => events.push(ev),
      onClaudeSessionId: () => {},
    } as unknown as NormalizerCallbacks;
    const n = new CodexStreamNormalizer(cb);
    for (const item of items) n.push({ type: 'item.completed', item });
    return events;
  }

  const diff = '@@ -1,3 +1,3 @@\n line one\n-line two\n+LINE TWO edited\n line three\n';

  it('keeps the per-change diff in the edit result and labels object kinds', () => {
    const events = run([{
      type: 'fileChange',
      id: 'exec-1',
      status: 'completed',
      changes: [{ path: '/tmp/a.txt', kind: { type: 'update', move_path: null }, diff }],
    }]);
    const block = events.find((e) => e.k === 'block' && (e as any).block.kind === 'tool') as any;
    assert.ok(block, 'edit tool block emitted');
    assert.equal(block.block.name, 'edit');
    assert.deepEqual(block.block.input.changes, [{ path: '/tmp/a.txt', kind: 'update' }]);
    const result = events.find((e) => e.k === 'tool_result') as any;
    assert.equal(result.toolUseId, 'exec-1');
    assert.match(result.content, /@@ -1,3 \+1,3 @@/);
    assert.match(result.content, /-line two/);
    assert.match(result.content, /\+LINE TWO edited/);
    assert.ok(!result.content.includes('[object Object]'));
  });

  it('joins multiple changes and falls back to `kind path` without a diff', () => {
    const events = run([{
      type: 'fileChange',
      id: 'exec-2',
      status: 'completed',
      changes: [
        { path: '/tmp/new.ts', kind: { type: 'add' }, diff: '@@\n+export {};\n' },
        { path: '/tmp/old.ts', kind: { type: 'delete' } },
      ],
    }]);
    const result = events.find((e) => e.k === 'tool_result') as any;
    assert.match(result.content, /\/tmp\/new\.ts\n@@\n\+export \{\};/);
    assert.match(result.content, /delete \/tmp\/old\.ts/);
    const block = events.find((e) => e.k === 'block' && (e as any).block.kind === 'tool') as any;
    assert.deepEqual(
      block.block.input.changes.map((c: any) => c.kind),
      ['add', 'delete'],
    );
  });

  it('accepts the snake_case live variant and plain-string kinds', () => {
    const parts = parseCodexResponseItem({
      type: 'file_change',
      id: 'exec-3',
      status: 'completed',
      changes: [{ path: '/tmp/x', kind: 'update', diff: '@@\n-a\n+b\n' }],
    });
    const call = parts.find((p) => p.kind === 'toolCall');
    const result = parts.find((p) => p.kind === 'toolResult');
    assert.ok(call && result);
    assert.deepEqual((call as { input: any }).input.changes, [{ path: '/tmp/x', kind: 'update' }]);
    assert.match((result as { content: string }).content, /\+b/);
  });

  it('does not stringify a move as [object Object]', () => {
    const events = run([{
      type: 'fileChange',
      id: 'exec-4',
      status: 'completed',
      changes: [{ path: '/tmp/a', kind: { type: 'update', move_path: '/tmp/b' } }],
    }]);
    const result = events.find((e) => e.k === 'tool_result') as any;
    assert.equal(result.content, 'update → /tmp/b /tmp/a');
  });
});

describe('codex context-token normalization', () => {
  it('uses last_token_usage.total_tokens without re-adding cached input', () => {
    const events: LiveEvent[] = [];
    const normalizer = new CodexStreamNormalizer({
      onEvent: (event) => events.push(event),
      onClaudeSessionId: () => {},
    } satisfies NormalizerCallbacks);
    normalizer.push({
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 16_332,
          cached_input_tokens: 11_008,
          output_tokens: 491,
          reasoning_output_tokens: 97,
          total_tokens: 16_823,
        },
        model_context_window: 200_000,
      },
    });
    normalizer.push({ type: 'turn.completed' });

    const result = events.find(
      (event) => event.k === 'block' && event.block.kind === 'result',
    );
    assert.deepEqual(
      result?.k === 'block' && result.block.kind === 'result'
        ? { contextUsed: result.block.contextUsed, contextWindow: result.block.contextWindow }
        : undefined,
      { contextUsed: 16_823, contextWindow: 200_000 },
    );
  });

  it('maps App Server duration and last-context usage into the turn footer', () => {
    const events: LiveEvent[] = [];
    const normalizer = new CodexStreamNormalizer({
      onEvent: (event) => events.push(event),
      onClaudeSessionId: () => {},
    } satisfies NormalizerCallbacks);
    normalizer.push({ type: 'turn.started', id: 'turn-1', startedAt: 1_788_488_000 });
    normalizer.push({
      type: 'thread/tokenUsage/updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        last: {
          inputTokens: 198_400,
          cachedInputTokens: 190_000,
          outputTokens: 600,
          reasoningOutputTokens: 200,
          totalTokens: 199_000,
        },
        total: {
          inputTokens: 900_000,
          cachedInputTokens: 800_000,
          outputTokens: 20_000,
          reasoningOutputTokens: 10_000,
          totalTokens: 920_000,
        },
        modelContextWindow: 1_000_000,
      },
    });
    normalizer.push({ type: 'turn.completed', id: 'turn-1', durationMs: 363_400 });

    const result = events.find(
      (event) => event.k === 'block' && event.block.kind === 'result',
    );
    assert.deepEqual(
      result?.k === 'block' && result.block.kind === 'result'
        ? {
            durationMs: result.block.durationMs,
            contextUsed: result.block.contextUsed,
            contextWindow: result.block.contextWindow,
          }
        : undefined,
      { durationMs: 363_400, contextUsed: 199_000, contextWindow: 1_000_000 },
    );
  });

  it('does not leak an earlier App Server turn usage into the next turn', () => {
    const results: Array<{ contextUsed?: number; contextWindow?: number; durationMs?: number }> = [];
    const normalizer = new CodexStreamNormalizer({
      onEvent: (event) => {
        if (event.k === 'block' && event.block.kind === 'result') results.push(event.block);
      },
      onClaudeSessionId: () => {},
    } satisfies NormalizerCallbacks);
    normalizer.push({ type: 'turn.started', id: 'turn-a' });
    normalizer.push({
      type: 'thread/tokenUsage/updated',
      tokenUsage: { last: { totalTokens: 123_456 }, total: { totalTokens: 999_999 }, modelContextWindow: 1_000_000 },
    });
    normalizer.push({ type: 'turn.completed', id: 'turn-a', durationMs: 1_000 });
    normalizer.push({ type: 'turn.started', id: 'turn-b' });
    normalizer.push({ type: 'turn.completed', id: 'turn-b', durationMs: 2_000 });

    assert.deepEqual(results.map((block) => ({
      durationMs: block.durationMs,
      contextUsed: block.contextUsed,
      contextWindow: block.contextWindow,
    })), [
      { durationMs: 1_000, contextUsed: 123_456, contextWindow: 1_000_000 },
      { durationMs: 2_000, contextUsed: undefined, contextWindow: undefined },
    ]);
  });
});
