import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMeta } from '../../../shared/protocol.js';
import { reconcileSessionSnapshot } from '../../src/sessions/list.js';

function meta(overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id'>): SessionMeta {
  return {
    id: overrides.id,
    claudeSessionId: overrides.claudeSessionId,
    title: overrides.title ?? overrides.id,
    cwd: overrides.cwd ?? '/work',
    model: overrides.model ?? 'model',
    permissionMode: overrides.permissionMode ?? 'default',
    effort: overrides.effort ?? 'high',
    agent: overrides.agent ?? 'zcode',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    messageCount: overrides.messageCount ?? 1,
    backgroundTasksRunning: overrides.backgroundTasksRunning ?? false,
    running: overrides.running ?? false,
    source: overrides.source ?? 'vibe',
    host: overrides.host ?? 'local',
  };
}

describe('session-list discovery/store reconciliation', () => {
  it('cannot overwrite a switched mapping with an in-flight stale store snapshot', () => {
    const appId = 'msi::stable-vibe-id';
    const oldNativeId = 'sess_11111111-1111-4111-8111-111111111111';
    const newNativeId = 'sess_22222222-2222-4222-8222-222222222222';
    const stale = meta({ id: appId, claudeSessionId: oldNativeId, model: 'old', updatedAt: 10 });
    const latest = meta({ id: appId, claudeSessionId: newNativeId, model: 'new', updatedAt: 20 });
    const discoveredAlias = meta({
      id: `msi::${newNativeId}`,
      claudeSessionId: newNativeId,
      source: 'zcode',
      host: 'msi',
    });
    const unrelated = meta({ id: 'native-unrelated', source: 'codex' });

    const result = reconcileSessionSnapshot([stale, discoveredAlias, unrelated], [latest]);

    assert.equal(result.filter((session) => session.id === appId).length, 1);
    assert.equal(result.find((session) => session.id === appId)?.claudeSessionId, newNativeId);
    assert.equal(result.find((session) => session.id === appId)?.model, 'new');
    assert.equal(result.some((session) => session.id === discoveredAlias.id), false);
    assert.equal(result.some((session) => session.id === unrelated.id), true);
  });
});
