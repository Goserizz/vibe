import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentQuestionStore } from '../../src/sessions/agentQuestions.js';
import { RequestQueueStore } from '../../src/sessions/requestQueue.js';
import { Hub, CallbackConn } from '../../src/ws/hub.js';
import { sessionStore } from '../../src/sessions/store.js';
import type { RunCallbacks } from '../../src/claude/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-question-tests-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const directory = () => fs.mkdtempSync(path.join(root, 'store-'));
const questions = [{ title: 'Account label' }, { title: 'Enable logs?', options: ['No', 'Yes'] }];
const answers = ['synthetic account', 'No'];
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

describe('Durable async questions', () => {
  it('is private, survives restart, and does not reconstruct old chat text', () => {
    const dir = directory(), store = new AgentQuestionStore(dir);
    assert.deepEqual(store.snapshot('s', 'native'), { items: [] });
    const id = store.add('s', 'native', 'q', questions);
    assert.equal(fs.statSync(path.join(dir, fs.readdirSync(dir)[0]!)).mode & 0o777, 0o600);
    assert.equal(new AgentQuestionStore(dir).snapshot('s', 'native').items[0]?.id, id);
    assert.deepEqual(store.snapshot('s', 'different-native').items, []);
  });
  it('deduplicates live events, including answered and dismissed forms', () => {
    const store = new AgentQuestionStore(directory());
    const id = store.add('s', 'native', 'q', questions);
    assert.equal(store.add('s', 'native', 'q', questions), id);
    store.begin('s', 'native', id, answers); store.finish('s', id, 'steered');
    store.add('s', 'native', 'q', questions);
    assert.equal(store.snapshot('s', 'native').items.length, 0);
    assert.equal(store.begin('s', 'native', id, answers).duplicate, 'steered');
    assert.throws(() => store.begin('s', 'native', id, ['changed', 'No']), /already answered/);
    const second = store.add('s', 'native', 'q2', questions); store.dismiss('s', 'native', second);
    store.add('s', 'native', 'q2', questions);
    assert.equal(store.snapshot('s', 'native').items.length, 0);
  });
  it('keeps unconfirmed answers for explicit recovery, never blindly replays them', () => {
    const dir = directory(), store = new AgentQuestionStore(dir);
    const id = store.add('s', 'native', 'q', questions), first = store.begin('s', 'native', id, answers);
    const recovered = new AgentQuestionStore(dir);
    assert.equal(recovered.snapshot('s', 'native').items[0]?.status, 'uncertain');
    assert.deepEqual(recovered.snapshot('s', 'native').items[0]?.answers, answers);
    assert.throws(() => recovered.begin('s', 'native', id, answers), /uncertain/);
    const retry = recovered.begin('s', 'native', id, answers, true);
    assert.notEqual(retry.messageId, first.messageId);
  });
  it('validates answer count, content and native/session ownership', () => {
    const store = new AgentQuestionStore(directory()), id = store.add('s', 'native', 'q', questions);
    assert.throws(() => store.begin('other', 'native', id, answers), /not found/);
    assert.throws(() => store.begin('s', 'other-native', id, answers), /not found/);
    assert.throws(() => store.begin('s', 'native', id, ['missing one']));
    assert.throws(() => store.begin('s', 'native', id, ['', 'No']));
    assert.throws(() => store.begin('s', 'native', id, ['x'.repeat(65_537), 'No']));
    assert.equal(store.snapshot('s', 'native').items[0]?.status, 'pending');
  });
  it('bounds unanswered forms and leaves existing data intact on overflow', () => {
    const store = new AgentQuestionStore(directory());
    for (let i = 0; i < 20; i++) store.add('s', 'native', `q-${i}`, questions);
    assert.throws(() => store.add('s', 'native', 'extra', questions), /Too many/);
    assert.equal(store.snapshot('s', 'native').items.length, 20);
  });
  it('fails closed for corrupt and symlink files without overwriting either', () => {
    const dir = directory(), file = path.join(dir, crypto.createHash('sha256').update('s').digest('hex') + '.json');
    fs.writeFileSync(file, 'broken');
    assert.throws(() => new AgentQuestionStore(dir).add('s', 'native', 'q', questions), /left untouched/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
    fs.unlinkSync(file); const external = path.join(dir, 'target'); fs.writeFileSync(external, 'private'); fs.symlinkSync(external, file);
    assert.throws(() => new AgentQuestionStore(dir).snapshot('s'), /left untouched/);
    assert.equal(fs.readFileSync(external, 'utf8'), 'private');
  });
  it('dismissing never fabricates a user answer; clear and delete retain no live forms', () => {
    const dir = directory(), store = new AgentQuestionStore(dir), id = store.add('s', 'native', 'q', questions);
    store.dismiss('s', 'native', id);
    assert.throws(() => store.begin('s', 'native', id, answers), /dismissed/);
    store.add('s', 'native', 'new', questions); store.clear('s');
    assert.equal(store.snapshot('s', 'native').items.length, 0);
    store.drop('s'); assert.equal(fs.readdirSync(dir).length, 0);
  });
});

function setup() {
  const questionStore = new AgentQuestionStore(directory()), queueStore = new RequestQueueStore(directory());
  const session = sessionStore.create({ cwd: root, model: 'auto', permissionMode: 'default', agent: 'codex', owner: 'admin' });
  const nativeId = crypto.randomUUID(); sessionStore.update(session.id, { claudeSessionId: nativeId });
  const frames: import('../../../shared/protocol.js').ServerEvent[] = [];
  const runs: { prompt: string; cb: RunCallbacks; resolve: () => void; steers: { text: string; id: string }[] }[] = [];
  let steer: (text: string, id: string) => Promise<boolean> = async () => true;
  const hub = new Hub({ questionStore, queueStore, runFactory: (_kind, prompt, cb) => {
    let resolve!: () => void; const done = new Promise<void>(yes => { resolve = yes; });
    const run = { prompt, cb, resolve, steers: [] as { text: string; id: string }[] }; runs.push(run);
    return { done, abort: resolve, steerMessage: async (text, id) => { run.steers.push({ text, id }); return steer(text, id); } };
  } });
  const conn = new CallbackConn(frame => frames.push(frame));
  hub.send(conn, session.id, 'initial', 'Initial synthetic request');
  runs[0]!.cb.onAsyncQuestion!({ id: 'qcall', questions });
  const id = questionStore.snapshot(session.id, nativeId).items[0]!.id;
  const finish = async () => { runs.at(-1)!.resolve(); await tick(); };
  const close = () => { hub.prepareForShutdown(); for (const run of runs) run.resolve(); };
  return { hub, conn, session, nativeId, id, frames, runs, questionStore, queueStore, finish, close,
    setSteer: (value: typeof steer) => { steer = value; } };
}

describe('Question routing, lifecycle and isolation', () => {
  it('steers the active turn without joining or disturbing the ordinary FIFO', async () => {
    const t = setup();
    try {
      t.hub.send(t.conn, t.session.id, 'next', 'Next ordinary request');
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs.length, 1); assert.equal(t.runs[0]!.steers.length, 1);
      assert.match(t.runs[0]!.steers[0]!.text, /Account label\n回答：synthetic account/);
      assert.deepEqual(t.queueStore.snapshot(t.session.id).items.map(item => item.text), ['Next ordinary request']);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 0);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 1, 'Retry after a lost client ACK must not duplicate native input');
    } finally { t.close(); }
  });
  it('keeps pending questions after the turn ends, and sends late answers as a new queued turn', async () => {
    const t = setup();
    try {
      await t.finish();
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 1);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs.length, 2); assert.match(t.runs[1]!.prompt, /synthetic account/);
      assert.ok(t.frames.some(f => f.t === 'agent_question_result' && f.ok && f.delivery === 'queued'));
    } finally { t.close(); }
  });
  it('keeps a late answer in a paused queue without silently restarting work', async () => {
    const t = setup();
    try {
      t.hub.send(t.conn, t.session.id, 'wait-before-answer', 'Existing waiting request');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'pause');
      await t.finish();
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs.length, 1);
      assert.equal(t.queueStore.snapshot(t.session.id).paused, true);
      assert.match(t.queueStore.snapshot(t.session.id).items[1]!.text, /synthetic account/);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 0);
    } finally { t.close(); }
  });
  it('does not dispatch if the pre-send durable write fails', async context => {
    const t = setup();
    try {
      context.mock.method(t.questionStore, 'begin', () => { throw new Error('Synthetic disk error'); });
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 0);
      assert.equal(t.queueStore.snapshot(t.session.id).items.length, 0);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items[0]?.status, 'pending');
    } finally { t.close(); }
  });
  it('marks accepted input uncertain if saving completion fails, without auto resending', async context => {
    const t = setup();
    try {
      context.mock.method(t.questionStore, 'finish', () => { throw new Error('Synthetic disk error'); });
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 1);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items[0]?.status, 'uncertain');
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 1);
    } finally { t.close(); }
  });
  it('retains the form and answers if native rejection meets a full ordinary queue', async () => {
    const t = setup();
    try {
      t.setSteer(async () => false);
      for (let i = 0; i < 20; i++) t.hub.send(t.conn, t.session.id, `queued-${i}`, `Wait ${i}`);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.queueStore.snapshot(t.session.id).items.length, 20);
      const form = t.questionStore.snapshot(t.session.id, t.nativeId).items[0]!;
      assert.equal(form.status, 'pending');
      assert.deepEqual(form.answers, answers);
      assert.ok(t.frames.some(frame => frame.t === 'agent_question_result' && !frame.ok && /Queue is full/.test(frame.message ?? '')));
    } finally { t.close(); }
  });
  it('queues definitely rejected steering, but preserves uncertain delivery without auto retry', async () => {
    const t = setup();
    try {
      t.setSteer(async () => { throw new Error('Synthetic transport lost'); });
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items[0]?.status, 'uncertain');
      assert.equal(t.queueStore.snapshot(t.session.id).items.length, 0);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 1);
      t.setSteer(async () => false);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers, true);
      assert.equal(t.queueStore.snapshot(t.session.id).items.length, 1);
      assert.notEqual(t.runs[0]!.steers[0]!.id, t.runs[0]!.steers[1]!.id);
    } finally { t.close(); }
  });
  it('serializes concurrent answers and blocks an agent switch during submission', async () => {
    const t = setup(); let release!: (value: boolean) => void;
    try {
      t.setSteer(() => new Promise(resolve => { release = resolve; }));
      const first = t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      await t.finish();
      assert.equal(t.hub.beginAgentSwitch(t.session.id), false);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 1);
      release(true); await first;
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 0);
    } finally { release?.(false); t.close(); }
  });
  it('rejects another account, unknown ids and answers after explicit dismissal', async () => {
    const t = setup();
    try {
      const foreign: any[] = []; const outsider = new CallbackConn(frame => foreign.push(frame), 'not-owner');
      await t.hub.answerQuestion(outsider, t.session.id, t.id, answers);
      assert.equal(foreign.at(-1)?.ok, false); assert.equal(t.runs[0]!.steers.length, 0);
      await t.hub.answerQuestion(t.conn, t.session.id, 'wrong-id', answers);
      assert.equal(t.runs[0]!.steers.length, 0);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 0);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 0);
    } finally { t.close(); }
  });
  it('replays pending state to reconnecting clients and persists it across service restart', async () => {
    const t = setup();
    try {
      const frames: any[] = [], other = new CallbackConn(frame => frames.push(frame));
      t.hub.subscribe(other, t.session.id, 0);
      assert.equal(frames.find(frame => frame.t === 'subscribed').agentQuestions.items[0].id, t.id);
      t.hub.prepareForShutdown();
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items[0]?.id, t.id);
      await t.hub.answerQuestion(t.conn, t.session.id, t.id, answers);
      assert.equal(t.runs[0]!.steers.length, 0);
    } finally { t.close(); }
  });
  it('agent switch invalidates old forms, and deleted sessions cannot recreate them', async () => {
    const t = setup();
    try {
      await t.finish();
      assert.equal(t.hub.beginAgentSwitch(t.session.id), true);
      sessionStore.update(t.session.id, { agent: 'codebuddy', claudeSessionId: 'new-native' });
      t.hub.rebindAfterAgentSwitch(t.session.id); t.hub.endAgentSwitch(t.session.id);
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 0);
      assert.ok(t.frames.some(frame => frame.t === 'agent_questions' && frame.state.items.length === 0), 'All subscribed tabs must lose the old form');
      t.hub.broadcastRemoved(t.session.id); sessionStore.remove(t.session.id);
      t.runs[0]!.cb.onAsyncQuestion!({ id: 'late', questions });
      assert.equal(t.questionStore.snapshot(t.session.id, t.nativeId).items.length, 0);
    } finally { t.close(); }
  });
});
