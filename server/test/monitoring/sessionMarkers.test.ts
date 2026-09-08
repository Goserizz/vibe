import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Monitor } from '../../../shared/protocol.js';
import { monitorBadgeInfo, summarizeSessionMonitors, type SessionMonitorSummary } from '../../../shared/monitorSummary.js';
import { createMonitorSummaryLoader } from '../../../web/src/store/monitorSummaries.js';

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 'monitor-test', name: 'Synthetic monitor', sessionId: 'session-test',
    enabled: true, status: 'healthy', intervalMs: 60_000,
    probe: { kind: 'command', command: 'true', timeoutMs: 1_000 },
    actionMode: 'notify', instructions: 'Report only.', maxWakeAttempts: 1,
    remindEveryMs: 60_000, notifyOnRecovery: true,
    createdAt: 1, updatedAt: 1, consecutiveFailures: 0, ...overrides,
  };
}

describe('会话列表 Monitor 标记', () => {
  it('无监控或未绑定会话的监控不显示标记', () => {
    assert.deepEqual(summarizeSessionMonitors([monitor({ sessionId: undefined })]), {});
    assert.equal(monitorBadgeInfo(undefined), null);
    assert.equal(monitorBadgeInfo({ total: 0, enabled: 0, attention: 0 }), null);
  });

  it('按稳定 Vibe id 聚合，不混淆远端 host 或来源 agent 的原生 id', () => {
    const result = summarizeSessionMonitors([
      monitor({ sessionId: 'same-id' }),
      monitor({ sessionId: 'msi::same-id', status: 'paused', enabled: false }),
    ]);
    assert.deepEqual(result['same-id'], { total: 1, enabled: 1, attention: 0 });
    assert.deepEqual(result['msi::same-id'], { total: 1, enabled: 0, attention: 0 });
    assert.equal(monitorBadgeInfo(result['same-id'])?.tone, 'enabled');
    assert.equal(monitorBadgeInfo(result['msi::same-id'])?.tone, 'paused');
  });

  it('多个监控显示数量与启用/暂停比例', () => {
    const result = summarizeSessionMonitors([
      monitor(), monitor({ status: 'checking' }), monitor({ status: 'draft', enabled: false }),
    ])['session-test'];
    assert.deepEqual(result, { total: 3, enabled: 2, attention: 0 });
    assert.deepEqual(monitorBadgeInfo(result), { tone: 'enabled', label: 'Monitors: 2/3 enabled; 1 paused or draft' });
  });

  it('告警与探测器错误均显示异常；重新检查期间保留异常，恢复后才清除', () => {
    for (const state of [
      monitor({ status: 'firing' }), monitor({ status: 'error' }),
      monitor({ status: 'checking', consecutiveFailures: 1 }),
    ]) {
      const summary = summarizeSessionMonitors([state])['session-test'];
      assert.equal(monitorBadgeInfo(summary)?.tone, 'attention');
      assert.match(monitorBadgeInfo(summary)!.label, /1 need attention/);
    }
    assert.equal(monitorBadgeInfo(summarizeSessionMonitors([monitor()])['session-test'])?.tone, 'enabled');
  });

  it('暂停的历史错误不伪装成正在监控；全部暂停/草稿有灰色标记', () => {
    const summary = summarizeSessionMonitors([
      monitor({ enabled: false, status: 'paused', consecutiveFailures: 5 }),
      monitor({ enabled: false, status: 'draft' }),
    ])['session-test'];
    assert.deepEqual(summary, { total: 2, enabled: 0, attention: 0 });
    assert.deepEqual(monitorBadgeInfo(summary), { tone: 'paused', label: 'Monitors: 0/2 enabled; all paused or draft' });
  });

  it('新快照的删除、改绑不会在旧会话上留下标记', () => {
    const old = summarizeSessionMonitors([monitor()]);
    const rebound = summarizeSessionMonitors([monitor({ sessionId: 'new-session' })]);
    assert.ok(old['session-test']);
    assert.equal(rebound['session-test'], undefined);
    assert.equal(rebound['new-session']?.enabled, 1);
    assert.deepEqual(summarizeSessionMonitors([]), {});
  });
});

describe('Monitor 标记共享快照加载', () => {
  it('WS 突发事件合并；在途变化重新拉取，连续事件不会阻止标记显示', async () => {
    const pending: ((value: Monitor[]) => void)[] = [];
    const snapshots: Record<string, SessionMonitorSummary>[] = [];
    const loader = createMonitorSummaryLoader(() => new Promise((resolve) => pending.push(resolve)), (s) => snapshots.push(s));
    const first = loader.refresh();
    assert.equal(loader.refresh(), first);
    assert.equal(loader.refresh(), first);
    assert.equal(pending.length, 1, '整个列表共用一个在途请求');
    pending[0]!([monitor()]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 1, '即使有更新排队，也应显示最近已完成的快照');
    assert.equal(pending.length, 2);
    await first;
    assert.equal(snapshots.length, 1, '调用者等待当前请求，而不是无限等待后续刷新');
    pending[1]!([monitor({ enabled: false, status: 'paused' })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1]!['session-test']?.enabled, 0, '后续新快照成为最终状态');
  });

  it('退出/切换账号后丢弃旧响应，不阻塞新账号加载', async () => {
    const pending: ((value: Monitor[]) => void)[] = [];
    const snapshots: Record<string, SessionMonitorSummary>[] = [];
    const loader = createMonitorSummaryLoader(() => new Promise((resolve) => pending.push(resolve)), (s) => snapshots.push(s));
    const old = loader.refresh();
    loader.reset();
    const next = loader.refresh();
    pending[1]!([monitor({ sessionId: 'new-account-session' })]);
    await next;
    pending[0]!([monitor({ sessionId: 'old-account-session' })]);
    await old;
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!['old-account-session'], undefined);
    assert.ok(snapshots[0]!['new-account-session']);
  });

  it('请求失败保留原标记；下次成功的空快照能清除标记', async () => {
    const snapshots: Record<string, SessionMonitorSummary>[] = [];
    let attempt = 0;
    const loader = createMonitorSummaryLoader(async () => {
      if (++attempt === 2) throw new Error('Synthetic network outage');
      return attempt === 1 ? [monitor()] : [];
    }, (s) => snapshots.push(s));
    await loader.refresh();
    await loader.refresh();
    assert.equal(snapshots.length, 1);
    await loader.refresh();
    assert.deepEqual(snapshots[1], {});
  });
});
