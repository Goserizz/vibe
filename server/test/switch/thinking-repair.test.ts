import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatBlock } from '../../../shared/protocol.js';
import {
  migrateLegacyCodebuddyNativeJsonl,
  migrateLegacyCodebuddyVibeJsonl,
  parseCodebuddyBlocks,
  repairLegacyCodebuddyThinkingCarry,
} from '../../src/codebuddy/transcript.js';
import {
  THINKING_ARCHIVE_NOTICE,
  THINKING_REFERENCE_CLOSE,
  THINKING_REFERENCE_OPEN,
  parseTurnUserText,
  splitLegacyAssistantThinkingReference,
  toCanonicalTurns,
} from '../../src/switch/canonical.js';

function legacy(thinking: string, answer: string): string {
  return [
    THINKING_REFERENCE_OPEN,
    thinking,
    THINKING_REFERENCE_CLOSE,
    answer,
  ].join('\n\n');
}

describe('CodeBuddy 旧版 assistant-side thinking 自动修复', () => {
  it('原生 JSONL：思考搬到同轮 user 档案、assistant 只留正文，并且幂等', () => {
    const user = {
      id: 'u1', type: 'message', role: 'user', timestamp: 1000,
      sessionId: 'session-1', cwd: '/tmp/project',
      content: [{ type: 'input_text', text: '你好' }],
    };
    const assistant1 = {
      id: 'a1', parentId: 'u1', type: 'message', role: 'assistant', timestamp: 1001,
      sessionId: 'session-1', cwd: '/tmp/project',
      content: [{ type: 'output_text', text: legacy('先用中文问候。', '你好！') }],
      providerData: { model: 'hy4-preview', keep: 'untouched' },
    };
    const assistant2 = {
      id: 'a2', parentId: 'a1', type: 'message', role: 'assistant', timestamp: 1002,
      sessionId: 'session-1', cwd: '/tmp/project',
      content: [{ type: 'output_text', text: legacy('回答身份问题。', '我是 CodeBuddy。') }],
    };
    const corrupt = '{this line deliberately stays corrupt';
    const raw = `${JSON.stringify(user)}\n${JSON.stringify(assistant1)}\n${corrupt}\n${JSON.stringify(assistant2)}\n`;

    const migrated = migrateLegacyCodebuddyNativeJsonl(raw);
    assert.equal(migrated.changedReferences, 2);
    assert.ok(migrated.content.includes(`\n${corrupt}\n`), '未知/损坏行必须原样保留');

    const objects = migrated.content
      .split('\n')
      .filter((line) => line.trim() && line !== corrupt)
      .map((line) => JSON.parse(line) as any);
    const migratedUser = objects.find((entry) => entry.id === 'u1');
    assert.match(migratedUser.content[0].text, new RegExp(THINKING_ARCHIVE_NOTICE));
    assert.match(migratedUser.content[0].text, /【对应历史助手片段 1】\n先用中文问候。/);
    assert.match(migratedUser.content[0].text, /【对应历史助手片段 2】\n回答身份问题。/);
    assert.equal(objects.find((entry) => entry.id === 'a1').content[0].text, '你好！');
    assert.equal(objects.find((entry) => entry.id === 'a2').content[0].text, '我是 CodeBuddy。');
    assert.deepEqual(objects.find((entry) => entry.id === 'a1').providerData, assistant1.providerData);

    const turns = toCanonicalTurns(parseCodebuddyBlocks(migrated.content));
    assert.equal(turns[0]?.user?.text, '你好');
    assert.deepEqual(turns[0]?.assistants.map((assistant) => assistant.text), ['你好！', '我是 CodeBuddy。']);
    assert.deepEqual(
      turns[0]?.assistants.map((assistant) => assistant.thinking),
      ['先用中文问候。', '回答身份问题。'],
    );

    const again = migrateLegacyCodebuddyNativeJsonl(migrated.content);
    assert.equal(again.changedReferences, 0);
    assert.equal(again.content, migrated.content);
  });

  it('Vibe transcript：污染回复恢复为 thinking + 纯 assistant，且普通用户文本不误判', () => {
    const blocks: ChatBlock[] = [
      { id: 'u1', kind: 'user', text: `${THINKING_REFERENCE_OPEN}\n这只是用户原文`, ts: 1000 },
      { id: 'a1', kind: 'assistant', text: legacy('用户发来问候。', '你好！'), streaming: false, ts: 1001 },
    ];
    const raw = `${blocks.map((block) => JSON.stringify(block)).join('\n')}\n`;
    const migrated = migrateLegacyCodebuddyVibeJsonl(raw);
    assert.equal(migrated.changedReferences, 1);

    const parsed = migrated.content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatBlock);
    assert.equal(parsed[0]?.kind, 'user');
    assert.equal((parsed[0] as { text: string }).text, (blocks[0] as { text: string }).text);
    assert.equal(parsed[1]?.kind, 'thinking');
    assert.equal((parsed[1] as { text: string }).text, '用户发来问候。');
    assert.equal(parsed[2]?.kind, 'assistant');
    assert.equal((parsed[2] as { text: string }).text, '你好！');

    const again = migrateLegacyCodebuddyVibeJsonl(migrated.content);
    assert.equal(again.changedReferences, 0);
    assert.equal(again.content, migrated.content);
  });

  it('只有严格的 assistant 前缀才迁移；新 user 档案可无损解析', () => {
    const notPrefix = `说明文字\n${legacy('不应迁移', '正文')}`;
    assert.equal(splitLegacyAssistantThinkingReference(notPrefix), null);

    const ordinaryUser = `${THINKING_REFERENCE_OPEN}\n用户自己输入但没有迁移说明\n${THINKING_REFERENCE_CLOSE}`;
    const parsed = parseTurnUserText(ordinaryUser);
    assert.equal(parsed.text, ordinaryUser);
    assert.equal(parsed.thinkingByAssistant.size, 0);
  });

  it('启动修复器在临时文件上原子落盘，第二次执行不再改写', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-codebuddy-thinking-repair-'));
    try {
      const nativeFile = path.join(root, 'native.jsonl');
      const vibeFile = path.join(root, 'vibe.jsonl');
      const native = [
        {
          id: 'u1', type: 'message', role: 'user', timestamp: 1000,
          content: [{ type: 'input_text', text: '你好' }],
        },
        {
          id: 'a1', type: 'message', role: 'assistant', timestamp: 1001,
          content: [{ type: 'output_text', text: legacy('先问候。', '你好！') }],
        },
      ];
      const vibe: ChatBlock[] = [
        { id: 'u1', kind: 'user', text: '你好', ts: 1000 },
        { id: 'a1', kind: 'assistant', text: legacy('先问候。', '你好！'), streaming: false, ts: 1001 },
      ];
      fs.writeFileSync(nativeFile, `${native.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
      fs.writeFileSync(vibeFile, `${vibe.map((block) => JSON.stringify(block)).join('\n')}\n`, { mode: 0o600 });

      const repaired = repairLegacyCodebuddyThinkingCarry('vibe-id', 'native-id', { nativeFile, vibeFile });
      assert.deepEqual(repaired, { nativeReferences: 1, vibeReferences: 1 });
      assert.equal(fs.readFileSync(nativeFile, 'utf8').includes(THINKING_ARCHIVE_NOTICE), true);
      assert.equal(fs.readFileSync(vibeFile, 'utf8').includes(THINKING_REFERENCE_OPEN), false);
      assert.equal(
        fs.readdirSync(root).some((name) => name.includes('.vibe-thinking-migration-')),
        false,
        '原子 rename 后不能留下临时文件',
      );

      assert.deepEqual(
        repairLegacyCodebuddyThinkingCarry('vibe-id', 'native-id', { nativeFile, vibeFile }),
        { nativeReferences: 0, vibeReferences: 0 },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
