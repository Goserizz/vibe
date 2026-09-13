import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { CodexStreamNormalizer } from '../../src/codex/normalize.js';
import { parseCodexAsyncQuestion } from '../../src/codex/questions.js';
import { startCodexAppServerRun } from '../../src/codex/appServer.js';
import type { RunCallbacks } from '../../src/claude/types.js';

const question = { type: 'agentMessage', id: 'question-call', text: 'Provide an account label. Enable logs?',
  phase: 'final_answer', delivery: 'async', questions: [
    { title: 'Account label', options: null }, { title: 'Enable logs?', options: ['No', 'Yes'] },
  ] };
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

describe('Codex live async question decoding', () => {
  it('preserves free text, choices and final_answer async metadata', () => {
    assert.deepEqual(parseCodexAsyncQuestion(question), { id: 'question-call', questions: [
      { title: 'Account label' }, { title: 'Enable logs?', options: ['No', 'Yes'] },
    ] });
  });
  it('does not infer prompts from plain prose or old rollout function calls', () => {
    assert.equal(parseCodexAsyncQuestion({ ...question, delivery: undefined }), null);
    assert.equal(parseCodexAsyncQuestion({ type: 'function_call', name: 'request_user_input_async', arguments: JSON.stringify(question) }), null);
    assert.equal(parseCodexAsyncQuestion({ ...question, questions: null }), null);
  });
  it('rejects malformed/oversized forms and normalizes nullable options', () => {
    for (const questions of [[], [{ title: '' }], [{ title: 'Label', options: [null] }], Array.from({ length: 21 }, () => ({ title: 'Too many' }))]) {
      assert.equal(parseCodexAsyncQuestion({ ...question, questions }), null);
    }
    assert.equal(parseCodexAsyncQuestion({ ...question, questions: [{ title: 'x'.repeat(16_385) }] }), null);
    assert.deepEqual(parseCodexAsyncQuestion({ ...question, questions: [{ title: ' Label ', options: [] }] })?.questions, [{ title: 'Label' }]);
  });
  it('emits one live question on completion and keeps the original text', () => {
    const events: any[] = [], questions: any[] = [];
    const normalizer = new CodexStreamNormalizer({ onEvent: event => events.push(event), onClaudeSessionId: () => {}, onAsyncQuestion: item => questions.push(item) });
    normalizer.push({ type: 'item.started', item: question });
    normalizer.push({ type: 'item.updated', item: question });
    assert.equal(questions.length, 0);
    normalizer.push({ type: 'item.completed', item: question });
    normalizer.push({ type: 'item.completed', item: question });
    assert.equal(questions.length, 1);
    assert.ok(events.some(event => event.k === 'block' && event.block.text === question.text));
  });
});

class FakeCodex extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  requests: any[] = [];
  steering: 'accept' | 'reject' | 'hang' = 'accept';
  private buffer = '';
  constructor() {
    super();
    this.stdin.on('data', data => {
      this.buffer += data.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, nl)); this.buffer = this.buffer.slice(nl + 1);
        if (!message.method || message.id == null) continue;
        this.requests.push(message);
        if (message.method === 'turn/steer') {
          if (this.steering === 'hang') continue;
          if (this.steering === 'reject') { this.send({ id: message.id, error: { code: -32600, message: 'No active turn' } }); continue; }
          this.send({ id: message.id, result: { turnId: 'turn-1' } }); continue;
        }
        if (message.method === 'turn/start') this.notify('turn/started', { threadId: 'native-q', turn: { id: 'turn-1' } });
        const result = message.method.startsWith('thread/resume') ? { thread: { id: 'native-q', turns: [{ id: 'old-turn', items: [{ ...question, id: 'historical-question' }] }] } }
          : message.method === 'turn/start' ? { turn: { id: 'turn-1' } }
            : message.method === 'thread/backgroundTerminals/list' ? { data: [] } : {};
        this.send({ id: message.id, result });
      }
    });
    this.stdin.on('finish', () => { this.stdout.end(); this.stderr.end(); this.emit('close', 0); });
  }
  send(message: unknown) { this.stdout.write(JSON.stringify(message) + '\n'); }
  notify(method: string, params: unknown) { this.send({ method, params }); }
  finish() { this.notify('turn/completed', { threadId: 'native-q', turn: { id: 'turn-1', status: 'completed', items: [] } }); }
  kill() { this.stdin.end(); return true; }
}
function setup() {
  const child = new FakeCodex(), questions: any[] = [], nativeIds: string[] = [];
  const callbacks: RunCallbacks = { onEvent: () => {}, onClaudeSessionId: id => nativeIds.push(id), requestPermission: async () => ({ allow: false }), onAsyncQuestion: question => questions.push(question) };
  const handle = startCodexAppServerRun({ prompt: 'Synthetic only', cwd: '/tmp', model: 'auto', permissionMode: 'default', effort: 'high', resume: 'native-q' }, callbacks,
    { spawn: (() => child as unknown as ChildProcess) as typeof spawn, prepareMcp: async () => undefined, answerTimeoutMs: 25 });
  return { child, handle, questions, nativeIds };
}

describe('Codex native answer delivery', () => {
  it('accepts questions without stopping generation and steers with the native turn precondition', async () => {
    const { child, handle, questions } = setup();
    try {
      await tick();
      assert.equal(questions.length, 0, 'Resuming native history must not recreate historical questions');
      child.notify('item/completed', { threadId: 'native-q', turnId: 'turn-1', item: question });
      assert.equal(questions.length, 1);
      assert.equal(await handle.steerMessage!('User answer', 'client-answer'), true);
      const request = child.requests.find(item => item.method === 'turn/steer');
      assert.deepEqual(request.params, { threadId: 'native-q', expectedTurnId: 'turn-1', clientUserMessageId: 'client-answer', input: [{ type: 'text', text: 'User answer', text_elements: [] }] });
      assert.equal(child.requests.filter(item => item.method === 'turn/start').length, 1);
    } finally { child.finish(); await handle.done; }
  });
  it('does not accept answers before a turn is available or after teardown', async () => {
    const { child, handle } = setup();
    assert.equal(await handle.steerMessage!('Answer', 'id'), false);
    await tick(); child.finish(); await handle.done;
    assert.equal(await handle.steerMessage!('Answer', 'id'), false);
  });
  it('explicit native rejection is safe to queue, but a missing ACK is uncertain', async () => {
    const { child, handle } = setup();
    try {
      await tick(); child.steering = 'reject';
      assert.equal(await handle.steerMessage!('Answer', 'id'), false);
      child.steering = 'hang';
      await assert.rejects(handle.steerMessage!('Answer', 'id2'), /uncertain/);
    } finally { child.finish(); await handle.done; }
  });
  it('descendant notifications cannot rebind the root or create its question forms', async () => {
    const { child, handle, questions, nativeIds } = setup();
    try {
      await tick();
      child.notify('thread/started', { thread: { id: 'other-thread' } });
      child.notify('turn/started', { threadId: 'other-thread', turn: { id: 'other-turn' } });
      child.notify('item/completed', { threadId: 'other-thread', item: question });
      assert.equal(questions.length, 0);
      assert.deepEqual(nativeIds, ['native-q']);
      await handle.steerMessage!('Answer', 'id');
      assert.equal(child.requests.find(item => item.method === 'turn/steer').params.expectedTurnId, 'turn-1');
    } finally { child.finish(); await handle.done; }
  });
});
