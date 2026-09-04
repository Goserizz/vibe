import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestZcodeSessionMessages,
  zcodeMessagesToBlocks,
} from '../../src/zcode/transcript.js';

describe('ZCode native transcript activation', () => {
  it('lists the workspace, resumes the session, then reads messages', async () => {
    const sessionId = 'sess_12345678-1234-4234-8234-123456789abc';
    const cwd = '/workspace/example-project';
    const calls: Array<{ method: string; params: unknown }> = [];
    let active = false;
    const messages = [{
      info: { role: 'user', time: { created: 123 } },
      parts: [{ type: 'text', text: '恢复后的历史' }],
    }];

    const result = await requestZcodeSessionMessages(async (method, params) => {
      calls.push({ method, params });
      if (method === 'session/list') {
        return { sessions: [{ sessionId, workspace: { workspacePath: cwd } }] };
      }
      if (method === 'session/resume') {
        assert.deepEqual(params, {
          sessionId,
          workspace: { workspaceKey: cwd, workspacePath: cwd },
        });
        active = true;
        return { session: { sessionId } };
      }
      if (method === 'session/messages') {
        if (!active) throw Object.assign(new Error('Session is not active'), { code: -32004 });
        return { messages };
      }
      throw new Error(`unexpected method ${method}`);
    }, sessionId);

    assert.deepEqual(calls.map((call) => call.method), [
      'session/list',
      'session/resume',
      'session/messages',
    ]);
    assert.deepEqual(zcodeMessagesToBlocks((result as { messages: unknown }).messages), [{
      id: 'zc_user_1',
      kind: 'user',
      text: '恢复后的历史',
      ts: 123,
    }]);
  });
});
