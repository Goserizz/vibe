import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RequestQueueStore, MAX_QUEUED_REQUESTS, MAX_REQUEST_BYTES } from '../../src/sessions/requestQueue.js';
import { Hub, CallbackConn } from '../../src/ws/hub.js';
import { sessionStore } from '../../src/sessions/store.js';
import type { RunCallbacks, RunHandle } from '../../src/claude/types.js';
import type { AgentKind, ServerEvent } from '../../../shared/protocol.js';
import { interruptedContinuationPrompt, queuedRequestPrompt } from '../../../shared/interruptedContinuation.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-request-queue-tests-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const directory = () => fs.mkdtempSync(path.join(root, 'queue-'));
const tick = async () => { await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };

describe('持久化待处理请求', () => {
  it('按 FIFO 保存；确认前已落盘，文件私有且不依赖原生 agent 存储', () => {
    const dir = directory(), store = new RequestQueueStore(dir);
    store.enqueue('s', 'admin', 'a', 'First');
    store.enqueue('s', 'admin', 'b', 'Second');
    assert.deepEqual(store.snapshot('s').items.map((item) => item.text), ['First', 'Second']);
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 2);
    assert.equal('owner' in store.snapshot('s').items[0]!, false, '内部账号字段不发到队列 UI');
  });

  it('断线重发同一消息 ID 不重复执行，取消的 ID 也不会复活', () => {
    const store = new RequestQueueStore(directory());
    store.enqueue('s', 'admin', 'a', 'First');
    store.enqueue('s', 'admin', 'a', 'First');
    assert.equal(store.snapshot('s').items.length, 1);
    assert.throws(() => store.enqueue('s', 'admin', 'a', 'Different'), /different text/);
    assert.equal(store.remove('s', 'a'), true);
    store.enqueue('s', 'admin', 'a', 'First');
    assert.equal(store.snapshot('s').items.length, 0);
  });

  it('相同正文但不同消息 ID 是两个独立请求', () => {
    const store = new RequestQueueStore(directory());
    store.enqueue('s', 'admin', 'a', 'Continue');
    store.enqueue('s', 'admin', 'b', 'Continue');
    assert.equal(store.snapshot('s').items.length, 2);
  });

  it('已认领请求也参与去重；认领失败可放回队首', () => {
    const store = new RequestQueueStore(directory());
    store.enqueue('s', 'admin', 'a', 'First');
    store.enqueue('s', 'admin', 'b', 'Second');
    assert.equal(store.claim('s')?.id, 'a');
    assert.equal(store.claim('s'), undefined);
    store.enqueue('s', 'admin', 'a', 'First');
    assert.deepEqual(store.snapshot('s').items.map((item) => item.id), ['b']);
    assert.equal(store.remove('s', 'a'), false, '不能把移除队列误当成中止当前请求');
    store.restore('s');
    assert.deepEqual(store.snapshot('s').items.map((item) => item.id), ['a', 'b']);
  });

  it('服务重启后暂停，保留已认领但未完成的请求供用户确认', () => {
    const dir = directory(), before = new RequestQueueStore(dir);
    before.enqueue('s', 'admin', 'a', 'First');
    before.enqueue('s', 'admin', 'b', 'Second');
    before.claim('s');
    const after = new RequestQueueStore(dir);
    const state = after.snapshot('s');
    assert.equal(state.reason, 'restart');
    assert.equal(state.items[0]?.interrupted, true);
    assert.deepEqual(state.items.map((item) => item.text), ['First', 'Second']);
    assert.equal(after.peek('s'), undefined);
    after.enqueue('s', 'admin', 'a', 'First');
    assert.equal(after.snapshot('s').items.length, 2);
    after.resume('s', 'admin');
    const retried = after.claim('s')!;
    assert.equal(retried.text, 'First', '原始请求仍保留作参考和去重');
    assert.equal(retried.continuation, true);
    assert.equal(queuedRequestPrompt(retried), interruptedContinuationPrompt('First'));
    assert.notEqual(retried.id, 'a', '显式重试不能覆盖先前的用户消息块');
    assert.equal(retried.interrupted, undefined);
  });

  it('只有中断项变为续接；未执行的排队项保持原文与原 ID', () => {
    const dir = directory(), before = new RequestQueueStore(dir);
    before.enqueue('s', 'admin', 'active', 'Interrupted task');
    before.enqueue('s', 'admin', 'waiting', 'Exact next request\nSecond line');
    before.claim('s');
    const restored = new RequestQueueStore(dir);
    restored.resume('s', 'admin');
    const items = restored.snapshot('s').items;
    assert.equal(items[0]?.continuation, true);
    assert.equal(items[1]?.continuation, undefined);
    assert.equal(items[1]?.id, 'waiting');
    assert.equal(queuedRequestPrompt(items[1]!), 'Exact next request\nSecond line');
  });

  it('连续多次中断不会套娃提示词，重复确认也不会重复改写 ID', () => {
    const dir = directory();
    let store = new RequestQueueStore(dir);
    const original = ('原任务：继续修复流水线。' + 'Long details. '.repeat(500)).trimEnd();
    store.enqueue('s', 'admin', 'first', original);
    store.claim('s');
    const ids = new Set(['first']);
    for (let i = 0; i < 3; i++) {
      store = new RequestQueueStore(dir);
      assert.equal(store.snapshot('s').items[0]?.interrupted, true);
      store.resume('s', 'admin');
      const item = store.snapshot('s').items[0]!;
      assert.ok(!ids.has(item.id)); ids.add(item.id);
      assert.equal(item.text, original);
      assert.equal(queuedRequestPrompt(item), interruptedContinuationPrompt(original));
      store.resume('s', 'admin');
      assert.equal(store.snapshot('s').items[0]?.id, item.id);
      store.claim('s');
    }
  });

  it('恢复状态落盘失败时保持原队列，不发布新的续接请求', context => {
    const dir = directory(), before = new RequestQueueStore(dir);
    before.enqueue('s', 'admin', 'a', 'Original'); before.claim('s');
    const restored = new RequestQueueStore(dir);
    const original = restored.snapshot('s');
    context.mock.method(fs, 'renameSync', () => { throw new Error('Synthetic disk failure'); });
    assert.throws(() => restored.resume('s', 'admin'), /could not be saved/);
    assert.deepEqual(restored.snapshot('s'), original);
  });

  it('完整完成的请求重启后不重新排队，剩余请求仍须确认继续', () => {
    const dir = directory(), before = new RequestQueueStore(dir);
    before.enqueue('s', 'admin', 'a', 'First');
    before.enqueue('s', 'admin', 'b', 'Second');
    before.claim('s');
    before.complete('s');
    const after = new RequestQueueStore(dir);
    assert.deepEqual(after.snapshot('s').items.map((item) => item.id), ['b']);
    after.enqueue('s', 'admin', 'a', 'First');
    assert.equal(after.snapshot('s').items.length, 1);
  });

  it('数量和字节上限拒绝额外请求，但不丢弃已经接受的请求', () => {
    const store = new RequestQueueStore(directory());
    for (let i = 0; i < MAX_QUEUED_REQUESTS; i++) store.enqueue('s', 'admin', `m${i}`, 'Small');
    assert.throws(() => store.enqueue('s', 'admin', 'overflow', 'Extra'), /Queue is full/);
    assert.equal(store.snapshot('s').items.length, MAX_QUEUED_REQUESTS);
    assert.throws(() => store.enqueue('bytes', 'admin', 'huge', '字'.repeat(Math.ceil(MAX_REQUEST_BYTES / 3) + 1)), /too large/);
    assert.equal(store.snapshot('bytes').items.length, 0);
  });

  it('存储损坏时拒绝覆盖，并保留原文件', () => {
    const dir = directory(), file = path.join(dir, `${crypto.createHash('sha256').update('s').digest('hex')}.json`);
    fs.writeFileSync(file, 'broken diagnostic fixture');
    const store = new RequestQueueStore(dir);
    assert.throws(() => store.enqueue('s', 'admin', 'a', 'First'), /left untouched/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken diagnostic fixture');
  });

  it('拒绝符号链接队列文件，不读取或覆盖指向的内容', () => {
    const dir = directory(), target = path.join(dir, 'keep.txt');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(dir, `${crypto.createHash('sha256').update('s').digest('hex')}.json`));
    assert.throws(() => new RequestQueueStore(dir).snapshot('s'), /left untouched/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  });

  it('隔离不同 session；删除只清理指定 session 的队列', () => {
    const store = new RequestQueueStore(directory());
    for (const id of ['s', 'k02::s', '../s']) store.enqueue(id, 'admin', id, id);
    store.drop('s');
    assert.equal(store.snapshot('s').items.length, 0);
    assert.equal(store.snapshot('k02::s').items.length, 1);
    assert.equal(store.snapshot('../s').items.length, 1);
  });
});

interface FakeRun {
  agent: AgentKind;
  prompt: string;
  cb: RunCallbacks;
  handle: RunHandle;
  resolve: () => void;
  reject: (error: Error) => void;
  stopped: boolean;
  reused: string[];
}

function setup(agent: AgentKind = 'codebuddy', queueStore = new RequestQueueStore(directory()), existing?: ReturnType<typeof sessionStore.create>) {
  const session = existing ?? sessionStore.create({ cwd: root, model: 'auto', permissionMode: 'default', agent, title: 'Synthetic queue test', owner: 'admin' });
  const frames: ServerEvent[] = [];
  const runs: FakeRun[] = [];
  const hub = new Hub({ queueStore, runFactory: (kind, prompt, cb) => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const run: FakeRun = {
      agent: kind, prompt, cb, resolve, reject, stopped: false, reused: [],
      handle: { done, abort: () => { run.stopped = true; } },
    };
    runs.push(run);
    return run.handle;
  } });
  const conn = new CallbackConn((frame) => frames.push(frame));
  const send = (text: string, id: string = crypto.randomUUID()) => { hub.send(conn, session.id, id, text); return id; };
  const finish = async (run: FakeRun, error = false) => {
    run.cb.onEvent({ k: 'block', block: { id: crypto.randomUUID(), kind: 'result', ts: Date.now(), isError: error } });
    run.resolve();
    await tick();
  };
  const close = () => { hub.prepareForShutdown(); for (const run of runs) run.resolve(); };
  return { session, frames, runs, hub, conn, queueStore, send, finish, close };
}

const agents: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy', 'opencode', 'devin'];
describe('所有编码 agent 的中断续接', () => {
  for (const agent of agents) it(`${agent}: 沿用原会话发送续接提示，不重发原任务`, async () => {
    const dir = directory(), before = setup(agent, new RequestQueueStore(dir));
    const original = '修复工作流并检查结果：' + '仅用于原始任务的长说明。'.repeat(100);
    const nativeId = crypto.randomUUID();
    let recovered: ReturnType<typeof setup> | undefined;
    try {
      before.send(original, 'original-user-id');
      before.runs[0]!.cb.onClaudeSessionId(nativeId);
      before.send('尚未执行的下一条请求', 'next-user-id');
      before.hub.prepareForShutdown();
      await before.finish(before.runs[0]!);
      recovered = setup(agent, new RequestQueueStore(dir), before.session);
      recovered.hub.subscribe(recovered.conn, recovered.session.id, 0);
      assert.equal(recovered.runs.length, 0, '重启/订阅不能自动续接');
      recovered.hub.changeRequestQueue(recovered.conn, recovered.session.id, 'resume');
      recovered.hub.changeRequestQueue(recovered.conn, recovered.session.id, 'resume');
      assert.equal(recovered.runs.length, 1, '重复确认不能重复派发');
      assert.equal(recovered.runs[0]?.agent, agent);
      assert.equal(recovered.runs[0]?.prompt, interruptedContinuationPrompt(original));
      assert.equal(sessionStore.get(recovered.session.id)?.claudeSessionId, nativeId);
      const userBlocks = recovered.frames.flatMap(frame => frame.t === 'event' && frame.ev.k === 'block' && frame.ev.block.kind === 'user' ? [frame.ev.block] : []);
      assert.equal(userBlocks.length, 1);
      assert.notEqual(userBlocks[0]?.id, 'original-user-id');
      assert.equal(userBlocks[0]?.text, interruptedContinuationPrompt(original));
      await recovered.finish(recovered.runs[0]!);
      assert.equal(recovered.runs[1]?.prompt, '尚未执行的下一条请求');
      await recovered.finish(recovered.runs[1]!);
    } finally { before.close(); recovered?.close(); }
  });
});
describe('所有编码 agent 的轮次后排队', () => {
  for (const agent of agents) it(`${agent}: 不打断当前输出，完成后按 FIFO 逐条执行`, async () => {
    const test = setup(agent);
    try {
      test.send('First', 'a');
      test.runs[0]!.cb.onEvent({ k: 'block', block: { id: 'answer', kind: 'assistant', text: 'Still working', streaming: true, ts: Date.now() } });
      test.send('Second', 'b');
      test.send('Third', 'c');
      assert.equal(test.runs.length, 1);
      assert.equal(test.runs[0]?.stopped, false);
      assert.deepEqual(test.queueStore.snapshot(test.session.id).items.map((item) => item.id), ['b', 'c']);
      const userIds = () => test.frames.flatMap((frame) => frame.t === 'event' && frame.ev.k === 'block' && frame.ev.block.kind === 'user' ? [frame.ev.block.id] : []);
      assert.deepEqual(userIds(), ['a'], '排队请求不能提前成为对话历史');
      assert.equal(test.frames.filter((frame) => frame.t === 'send_ack').length, 3);
      await test.finish(test.runs[0]!);
      assert.deepEqual(test.runs.map((run) => run.prompt), ['First', 'Second']);
      await test.finish(test.runs[1]!);
      assert.deepEqual(test.runs.map((run) => run.prompt), ['First', 'Second', 'Third']);
      await test.finish(test.runs[2]!);
      assert.deepEqual(userIds(), ['a', 'b', 'c']);
      assert.equal(test.hub.isRunning(test.session.id), false);
    } finally { test.close(); }
  });
});

describe('排队运行边界与账号隔离', () => {
  it('停止当前回复时暂停余下队列，明确继续后才执行', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.hub.abort(t.session.id, 'admin');
      assert.equal(t.runs[0]?.stopped, true);
      await t.finish(t.runs[0]!);
      assert.equal(t.runs.length, 1);
      assert.equal(t.queueStore.snapshot(t.session.id).reason, 'stopped');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'resume');
      assert.equal(t.runs.length, 2);
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('失败暂停而不消耗余下请求；可移除一条后再继续', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second', 'b'); t.send('Third', 'c');
      await t.finish(t.runs[0]!, true);
      assert.equal(t.runs.length, 1);
      assert.equal(t.queueStore.snapshot(t.session.id).reason, 'error');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'remove', 'b');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'resume');
      assert.equal(t.runs[1]?.prompt, 'Third');
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('一次瞬时错误后正常成功，不把队列永久暂停', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.runs[0]!.cb.onEvent({ k: 'error', text: 'Synthetic retry warning' });
      await t.finish(t.runs[0]!);
      assert.equal(t.runs.length, 2);
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('同一 runner 的失败尝试结束后重试成功，继续余下请求', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      const run = t.runs[0]!;
      run.cb.onEvent({ k: 'error', text: 'Synthetic retry warning' });
      run.cb.onTurnState?.(false);
      await tick();
      assert.equal(t.runs.length, 1);
      run.cb.onTurnState?.(true);
      await t.finish(run);
      assert.equal(t.runs[1]?.prompt, 'Second');
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('自动重试成功不能覆盖用户手动暂停的决定', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'pause');
      const run = t.runs[0]!;
      run.cb.onEvent({ k: 'error', text: 'Synthetic retry warning' });
      run.cb.onTurnState?.(false);
      run.cb.onTurnState?.(true);
      await t.finish(run);
      assert.equal(t.runs.length, 1);
      assert.equal(t.queueStore.snapshot(t.session.id).reason, 'manual');
    } finally { t.close(); }
  });

  it('运行 Promise 异常拒绝时也释放运行状态并暂停队列', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.runs[0]!.reject(new Error('Synthetic transport failure'));
      await tick();
      assert.equal(t.hub.isRunning(t.session.id), false);
      assert.equal(t.runs.length, 1);
      assert.equal(t.queueStore.snapshot(t.session.id).reason, 'error');
    } finally { t.close(); }
  });

  it('没有后台任务时等旧传输关闭，不把请求丢进正在关闭的 runner', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.runs[0]!.handle.sendMessage = () => { assert.fail('Closing transport must not receive another prompt'); };
      t.runs[0]!.cb.onTurnState?.(false);
      await tick();
      assert.equal(t.runs.length, 1);
      await t.finish(t.runs[0]!);
      assert.equal(t.runs.length, 2);
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('真正存活的后台任务连接可在前台回复结束后接收下一条', async () => {
    const t = setup('codex');
    try {
      t.send('First'); t.send('Second');
      const run = t.runs[0]!;
      run.handle.sendMessage = (text) => { run.reused.push(text); return true; };
      run.cb.onTask?.({ id: 'bg', agent: 'codex', kind: 'command', status: 'running', description: 'Synthetic', startedAt: 1, updatedAt: 1, canStop: true });
      run.cb.onEvent({ k: 'block', block: { id: 'done', kind: 'result', ts: Date.now() } });
      run.cb.onTurnState?.(false);
      await tick();
      assert.deepEqual(run.reused, ['Second']);
      assert.equal(t.runs.length, 1, '不启动竞争同一原生会话的第二个进程');
      await t.finish(run);
    } finally { t.close(); }
  });

  it('重新订阅能读到当前队列，重复 send 不重排、不重复执行', async () => {
    const t = setup();
    try {
      t.send('First', 'a'); t.send('Second', 'b');
      t.hub.removeConn(t.conn);
      const frames: ServerEvent[] = [];
      const second = new CallbackConn((frame) => frames.push(frame));
      t.hub.subscribe(second, t.session.id, 0);
      const snapshot = frames.find((frame) => frame.t === 'subscribed');
      assert.ok(snapshot?.t === 'subscribed');
      assert.deepEqual(snapshot.requestQueue?.items.map((item) => item.id), ['b']);
      t.hub.send(second, t.session.id, 'b', 'Second');
      assert.equal(t.queueStore.snapshot(t.session.id).items.length, 1);
      await t.finish(t.runs[0]!); await t.finish(t.runs[1]!);
      t.hub.send(second, t.session.id, 'a', 'First');
      assert.equal(t.runs.length, 2);
    } finally { t.close(); }
  });

  it('其他账号不能发送、读取、删除或继续本会话的队列', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Private request', 'b');
      const frames: ServerEvent[] = [], outsider = new CallbackConn((frame) => frames.push(frame), 'bob');
      t.hub.send(outsider, t.session.id, 'intrusion', 'No');
      t.hub.subscribe(outsider, t.session.id, 0);
      for (const action of ['pause', 'resume', 'remove'] as const) t.hub.changeRequestQueue(outsider, t.session.id, action, 'b');
      assert.ok(frames.every((frame) => frame.t === 'error'));
      assert.equal(JSON.stringify(frames).includes('Private request'), false);
      assert.equal(t.queueStore.snapshot(t.session.id).items.length, 1);
    } finally { t.close(); }
  });

  it('删除会话后旧回调不能继续派发或复活队列', async () => {
    const t = setup();
    t.send('First'); t.send('Second');
    t.hub.broadcastRemoved(t.session.id);
    t.runs[0]!.cb.onTurnState?.(false);
    t.runs[0]!.resolve();
    await tick();
    assert.equal(t.runs.length, 1);
    assert.equal(t.queueStore.snapshot(t.session.id).items.length, 0);
    t.close();
  });

  it('手动暂停不打断当前任务，暂停后新请求继续保留在队尾', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'pause');
      assert.equal(t.runs[0]?.stopped, false);
      await t.finish(t.runs[0]!);
      t.send('Third');
      assert.equal(t.runs.length, 1);
      assert.deepEqual(t.queueStore.snapshot(t.session.id).items.map((item) => item.text), ['Second', 'Third']);
    } finally { t.close(); }
  });

  it('后台连接拒绝新提示时保留队首，关闭后用新 runner 继续', async () => {
    const t = setup('codex');
    try {
      t.send('First'); t.send('Second', 'b');
      const run = t.runs[0]!;
      run.handle.sendMessage = () => false;
      run.cb.onTask?.({ id: 'bg', agent: 'codex', kind: 'command', status: 'running', description: 'Synthetic', startedAt: 1, updatedAt: 1, canStop: true });
      run.cb.onTurnState?.(false);
      await tick();
      assert.equal(t.runs.length, 1);
      assert.deepEqual(t.queueStore.snapshot(t.session.id).items.map((item) => item.id), ['b']);
      await t.finish(run);
      assert.equal(t.runs[1]?.prompt, 'Second');
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('待执行用户请求优先于 Monitor 自动唤醒', async () => {
    const t = setup();
    try {
      t.send('First'); t.send('Second');
      t.runs[0]!.cb.onTurnState?.(false);
      assert.equal(t.hub.triggerMonitorTurn({ owner: 'admin', sessionId: t.session.id, eventId: 'diagnostic', notice: 'Synthetic monitor', prompt: 'Monitor work' }), 'busy');
      await t.finish(t.runs[0]!);
      assert.equal(t.runs[1]?.prompt, 'Second');
      await t.finish(t.runs[1]!);
    } finally { t.close(); }
  });

  it('暂停队列后可切换 agent；旧回调不能破坏新 runner 的队列', async () => {
    const t = setup('codebuddy');
    try {
      t.send('First'); t.send('Second', 'b');
      t.hub.changeRequestQueue(t.conn, t.session.id, 'pause');
      await t.finish(t.runs[0]!);
      assert.equal(t.hub.beginAgentSwitch(t.session.id), true);
      sessionStore.update(t.session.id, { agent: 'codex' });
      t.hub.rebindAfterAgentSwitch(t.session.id);
      t.hub.endAgentSwitch(t.session.id);
      t.hub.changeRequestQueue(t.conn, t.session.id, 'resume');
      assert.equal(t.runs[1]?.agent, 'codex');
      assert.equal(t.runs[1]?.prompt, 'Second');
      t.send('Third', 'c');
      t.runs[0]!.cb.onTurnState?.(true);
      t.runs[0]!.cb.onTurnState?.(false);
      assert.equal(t.queueStore.peek(t.session.id), undefined, '新 runner 的 active 记录不能被旧回调清除');
      await t.finish(t.runs[1]!);
      assert.equal(t.runs[2]?.prompt, 'Third');
      await t.finish(t.runs[2]!);
    } finally { t.close(); }
  });

  it('启动器同步异常时保留请求并解除假运行状态', () => {
    const queues = new RequestQueueStore(directory());
    const session = sessionStore.create({ cwd: root, model: 'auto', permissionMode: 'default', agent: 'codebuddy', owner: 'admin' });
    const hub = new Hub({ queueStore: queues, runFactory: () => { throw new Error('Synthetic launch failure'); } });
    const conn = new CallbackConn(() => {});
    hub.send(conn, session.id, 'a', 'Keep this prompt');
    assert.equal(hub.isRunning(session.id), false);
    assert.equal(queues.snapshot(session.id).items[0]?.text, 'Keep this prompt');
    assert.equal(queues.snapshot(session.id).reason, 'error');
    hub.prepareForShutdown();
  });

  it('队列保存失败不会 ACK，也不会启动原生 agent', () => {
    const dir = directory();
    const session = sessionStore.create({ cwd: root, model: 'auto', permissionMode: 'default', agent: 'codebuddy', owner: 'admin' });
    fs.writeFileSync(path.join(dir, `${crypto.createHash('sha256').update(session.id).digest('hex')}.json`), 'invalid fixture');
    const frames: ServerEvent[] = [];
    const hub = new Hub({ queueStore: new RequestQueueStore(dir), runFactory: () => { assert.fail('Rejected request must not launch'); } });
    hub.send(new CallbackConn((frame) => frames.push(frame)), session.id, 'failed-id', 'Keep this prompt');
    assert.equal(frames.some((frame) => frame.t === 'send_ack'), false);
    assert.ok(frames.some((frame) => frame.t === 'error' && frame.clientMsgId === 'failed-id'));
    hub.prepareForShutdown();
  });

  it('停机不会清掉在途记录或自动开始下一条', async () => {
    const dir = directory(), store = new RequestQueueStore(dir), t = setup('codebuddy', store);
    t.send('First', 'a'); t.send('Second', 'b');
    t.hub.prepareForShutdown();
    await t.finish(t.runs[0]!);
    assert.equal(t.runs.length, 1);
    const restored = new RequestQueueStore(dir).snapshot(t.session.id);
    assert.equal(restored.paused, true);
    assert.deepEqual(restored.items.map((item) => item.id), ['a', 'b']);
    assert.equal(restored.items[0]?.interrupted, true);
    t.close();
  });
});
