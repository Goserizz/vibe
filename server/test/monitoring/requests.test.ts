import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorRequestLoader, type MonitorRequestStatus } from '../../../web/src/store/monitorRequests.js';
import { createMonitorSummaryLoader } from '../../../web/src/store/monitorSummaries.js';
import type { Monitor } from '../../../shared/protocol.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Monitor 面板请求不饥饿', () => {
  it('重叠轮询合并；成功响应在后续刷新尚未完成时立即发布', async () => {
    const pending: ReturnType<typeof deferred<number>>[] = [];
    const committed: number[] = [];
    const states: MonitorRequestStatus[] = [];
    const loader = createMonitorRequestLoader(() => {
      const read = deferred<number>();
      pending.push(read);
      return read.promise;
    }, (value) => committed.push(value), (state) => states.push(state));
    const first = loader.refresh();
    for (let i = 0; i < 20; i++) assert.equal(loader.refresh(), first);
    assert.equal(pending.length, 1);
    pending[0]!.resolve(5);
    await first;
    assert.deepEqual(committed, [5], '不能因请求编号过期丢弃已完成的 HTTP 200 数据');
    assert.ok(states.some((state) => !state.loading && !state.error));
    assert.equal(pending.length, 2, '无论多少次无效化，只排队一次后续读取');
    pending[1]!.resolve(6);
    await flush();
    assert.deepEqual(committed, [5, 6]);
    assert.equal(states.at(-1)?.loading, false);
  });

  it('持续通知也不能阻止发布快照或让刷新调用无限等待', async () => {
    const pending: ReturnType<typeof deferred<number>>[] = [];
    const committed: number[] = [];
    const loader = createMonitorRequestLoader(() => {
      const read = deferred<number>();
      pending.push(read);
      return read.promise;
    }, (value) => committed.push(value));
    let current = loader.refresh();
    for (let i = 0; i < 4; i++) {
      assert.equal(loader.refresh(), current);
      pending[i]!.resolve(i);
      await current;
      assert.deepEqual(committed, Array.from({ length: i + 1 }, (_, index) => index));
      assert.equal(pending.length, i + 2);
      current = loader.refresh();
    }
    loader.reset();
    await current;
    assert.equal(pending.length, 5, '停止后不执行排队的读取');
  });

  it('监控定义和事件独立：事件卡住或超时不阻止定义发布', async () => {
    let definitions: number[] = [];
    let eventStatus: MonitorRequestStatus | undefined;
    const list = createMonitorRequestLoader(async () => [1, 2, 3, 4, 5], (value) => { definitions = value; });
    const events = createMonitorRequestLoader(() => new Promise<never>(() => {}), () => {
      assert.fail('挂起的事件读取不应成功');
    }, (status) => { eventStatus = status; }, 10);
    const history = events.refresh();
    await list.refresh();
    assert.equal(definitions.length, 5);
    assert.equal(eventStatus?.loading, true);
    await history;
    assert.equal(eventStatus?.loading, false);
    assert.match(eventStatus?.error ?? '', /timed out/);
    assert.equal(definitions.length, 5, '事件失败不能清空已知监控');
  });

  it('初次读取失败显示错误并结束 loading；重试成功清除错误', async () => {
    let attempt = 0;
    const states: MonitorRequestStatus[] = [];
    const committed: string[] = [];
    const loader = createMonitorRequestLoader(async () => {
      if (++attempt === 1) throw new Error('Synthetic HTTP 503');
      return 'ready';
    }, (value) => committed.push(value), (state) => states.push(state));
    await loader.refresh();
    assert.deepEqual(states.at(-1), { loading: false, error: 'Synthetic HTTP 503' });
    await loader.refresh();
    assert.deepEqual(committed, ['ready']);
    assert.deepEqual(states.at(-1), { loading: false, error: null });
  });

  it('刷新失败保留最后快照，包括已加载的事件', async () => {
    let fail = false;
    let value = '';
    const loader = createMonitorRequestLoader(async () => {
      if (fail) throw new Error('Synthetic network failure');
      return 'last-good-snapshot';
    }, (snapshot) => { value = snapshot; });
    await loader.refresh();
    fail = true;
    await loader.refresh();
    assert.equal(value, 'last-good-snapshot');
  });

  it('同步抛错同样结束 loading，不留下永远 pending 的 refresh', async () => {
    const states: MonitorRequestStatus[] = [];
    const loader = createMonitorRequestLoader(() => { throw new Error('Synchronous failure'); }, () => {
      assert.fail('读取失败不应发布数据');
    }, (state) => states.push(state));
    await loader.refresh();
    assert.deepEqual(states.at(-1), { loading: false, error: 'Synchronous failure' });
  });

  it('超时主动 abort，即使传输层忽略 abort 也能结束刷新', async () => {
    let signal: AbortSignal | undefined;
    const states: MonitorRequestStatus[] = [];
    const loader = createMonitorRequestLoader((requestSignal) => {
      signal = requestSignal;
      return new Promise<never>(() => {});
    }, () => assert.fail('挂起请求不应发布'), (state) => states.push(state), 10);
    await loader.refresh();
    assert.equal(signal?.aborted, true);
    assert.equal(states.at(-1)?.loading, false);
    assert.match(states.at(-1)?.error ?? '', /timed out/);
  });

  it('超时后的迟到响应不能覆盖成功重试的快照', async () => {
    const late = deferred<string>();
    let attempt = 0;
    const committed: string[] = [];
    const loader = createMonitorRequestLoader(() => ++attempt === 1 ? late.promise : Promise.resolve('new'), (value) => committed.push(value), undefined, 10);
    await loader.refresh();
    await loader.refresh();
    late.resolve('old');
    await flush();
    assert.deepEqual(committed, ['new']);
  });

  it('账号/会话切换 abort 旧读取，迟到数据和错误均不能写回', async () => {
    const old = deferred<string>();
    const fresh = deferred<string>();
    const signals: AbortSignal[] = [];
    const committed: string[] = [];
    const states: MonitorRequestStatus[] = [];
    const loader = createMonitorRequestLoader((signal) => {
      signals.push(signal);
      return signals.length === 1 ? old.promise : fresh.promise;
    }, (value) => committed.push(value), (state) => states.push(state));
    const before = loader.refresh();
    loader.refresh();
    loader.reset();
    const after = loader.refresh();
    assert.equal(signals[0]?.aborted, true);
    fresh.resolve('new account/session');
    await after;
    old.reject(new Error('Old account response'));
    await before;
    await flush();
    assert.deepEqual(committed, ['new account/session']);
    assert.deepEqual(states.at(-1), { loading: false, error: null });
    assert.equal(signals.length, 2, '旧请求的 dirty 标记不能串到新作用域');
  });

  it('成功后清理超时计时器，不误 abort 已完成的读取', async () => {
    let signal: AbortSignal | undefined;
    const loader = createMonitorRequestLoader(async (requestSignal) => {
      signal = requestSignal;
      return 1;
    }, () => {}, undefined, 5);
    await loader.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(signal?.aborted, false);
  });

  it('左右侧栏共享同一份定义，重绑定和删除同步更新', async () => {
    let records = [
      { id: 'm', sessionId: 'old-session', enabled: true, status: 'healthy', consecutiveFailures: 0 },
    ] as Monitor[];
    const snapshots: { records: Monitor[]; sessions: string[] }[] = [];
    const loader = createMonitorSummaryLoader(async () => records, (summaries, definitions) => {
      assert.equal(definitions, records, '右侧直接使用生成左侧标记的同一快照');
      snapshots.push({ records: definitions, sessions: Object.keys(summaries) });
    });
    await loader.refresh();
    records = records.map((monitor) => ({ ...monitor, sessionId: 'new-session' }));
    await loader.refresh();
    records = [];
    await loader.refresh();
    assert.deepEqual(snapshots.map((snapshot) => snapshot.sessions), [['old-session'], ['new-session'], []]);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.records.length), [1, 1, 0]);
  });
});
