import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleInterruptedTool,
  settleInterruptedTools,
  sortBlocksChronologically,
  type ChatBlock,
  type ToolBlock,
} from '../../../shared/protocol.js';

function tool(partial: Partial<ToolBlock>): ToolBlock {
  return {
    id: 't1',
    kind: 'tool',
    toolUseId: 't1',
    name: 'Write',
    input: {},
    status: 'running',
    ts: 100,
    ...partial,
  };
}

describe('settleInterruptedTool(s)', () => {
  it('closes a running tool with a note, keeping its identity fields', () => {
    const b = tool({ id: 'call_x', input: { file_path: '/tmp/a' } });
    const out = settleInterruptedTool(b);
    assert.equal(out.id, 'call_x');
    assert.equal(out.name, 'Write');
    assert.deepEqual(out.input, { file_path: '/tmp/a' });
    assert.equal(out.status, 'done');
    assert.ok(out.result && out.result.includes('结果未送达'));
    assert.ok(!out.isError);
  });

  it('returns the same reference for finished tools and non-tool blocks', () => {
    const done = tool({ status: 'done', result: 'ok' });
    const text: ChatBlock = { id: 'a', kind: 'assistant', text: 'hi', streaming: false, ts: 1 };
    assert.equal(settleInterruptedTool(done), done);
    assert.equal(settleInterruptedTool(text), text);
  });

  it('array form settles only the running tools', () => {
    const run1 = tool({ id: 'r1', status: 'running' });
    const run2 = tool({ id: 'r2', status: 'running', ts: 2 });
    const blocks: ChatBlock[] = [
      { id: 'u', kind: 'user', text: 'q', ts: 1 },
      run1,
      tool({ id: 'd1', status: 'done', result: 'ok' }),
      run2,
    ];
    const out = settleInterruptedTools(blocks);
    assert.equal(out[0], blocks[0]);
    assert.equal((out[1] as ToolBlock).status, 'done');
    assert.equal(out[2], blocks[2]);
    assert.equal((out[3] as ToolBlock).status, 'done');
    // Pure — the input blocks are untouched.
    assert.equal(run1.status, 'running');
    assert.equal(run2.status, 'running');
  });
});

describe('sortBlocksChronologically', () => {
  it('restores order for a tool force-flushed after the result block', () => {
    // The exact shape of the bug: a stuck-running Write skipped every
    // incremental flush, so the turn-end flush appended it after the result
    // block even though its ts is 28 minutes older.
    const fileOrder: ChatBlock[] = [
      { id: 'user', kind: 'user', text: 'q', ts: 100 },
      { id: 'asst', kind: 'assistant', text: 'done', streaming: false, ts: 400 },
      { id: 'result', kind: 'result', ts: 500 },
      tool({ id: 'phantom', ts: 200 }),
    ];
    const sorted = sortBlocksChronologically(fileOrder);
    assert.deepEqual(sorted.map((b) => b.id), ['user', 'phantom', 'asst', 'result']);
  });

  it('is stable for equal timestamps and does not mutate the input', () => {
    const blocks: ChatBlock[] = [
      { id: 'a', kind: 'user', text: '1', ts: 0 },
      { id: 'b', kind: 'user', text: '2', ts: 0 },
      { id: 'c', kind: 'user', text: '3', ts: 0 },
    ];
    const sorted = sortBlocksChronologically(blocks);
    assert.deepEqual(sorted.map((b) => b.id), ['a', 'b', 'c']);
    assert.deepEqual(blocks.map((b) => b.id), ['a', 'b', 'c']);
    assert.notEqual(sorted, blocks);
  });

  it('is a no-op for already-ordered transcripts', () => {
    const blocks: ChatBlock[] = [
      { id: 'a', kind: 'user', text: '1', ts: 10 },
      { id: 'b', kind: 'user', text: '2', ts: 10 },
      { id: 'c', kind: 'user', text: '3', ts: 20 },
    ];
    assert.deepEqual(sortBlocksChronologically(blocks).map((b) => b.id), ['a', 'b', 'c']);
  });
});
