import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { AgentKind, ChatBlock } from '../../../shared/protocol.js';
import { switchSessionAgent, adapterFor, fidelityFor } from '../../src/switch/index.js';
import { transcriptFileFor } from '../../src/switch/paths.js';
import { THINKING_REFERENCE_OPEN, toCanonicalTurns } from '../../src/switch/canonical.js';
import type { StoredSession } from '../../src/sessions/store.js';
import {
  AGENTS,
  SYNTHETIC_FIXTURES,
  loadFixture,
  makeTempEnv,
  readBackNative,
  compareTurns,
  findRecursive,
  fixtureWithThinking,
  type TempEnv,
} from './helpers.js';

/** 保真等级为 full 的目标 agent —— 这些方向必须能读回原生产物做等价性断言。 */
const FULL_AGENTS: AgentKind[] = AGENTS.filter((a) => fidelityFor(a) === 'full');

/** 造一个 StoredSession，并把源历史写进源 agent 的 transcript（模拟真实磁盘状态）。 */
function makeSession(over: Partial<StoredSession> & { agent: AgentKind; id?: string }): StoredSession {
  const { agent, ...rest } = over;
  return {
    id: 'sess-test-1',
    title: '测试会话',
    cwd: '/tmp/proj',
    model: 'auto',
    permissionMode: 'default',
    agent,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_002_000,
    messageCount: 2,
    ...rest,
  };
}

async function seedSource(env: TempEnv, session: StoredSession, blocks: ChatBlock[]): Promise<void> {
  const file = transcriptFileFor(env.paths, session.agent ?? 'claude', session.id);
  await env.fs.mkdirp(path.dirname(file));
  await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}${blocks.length ? '\n' : ''}`);
}

describe('adapter 构造 + 往返等价性', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = makeTempEnv('adapter');
  });
  afterEach(() => env.cleanup());

  // -----------------------------------------------------------------------
  // 合成夹具 × 每个 full 目标：严格等价
  // -----------------------------------------------------------------------
  for (const fixture of SYNTHETIC_FIXTURES) {
    for (const target of FULL_AGENTS) {
      it(`${target} ← ${fixture.name}：重建后读回，user/assistant 文本与工具逐一相等`, async () => {
        const blocks = fixture.blocks();
        const session = makeSession({ agent: 'zcode', claudeSessionId: 'sess_src_1' });
        await seedSource(env, session, blocks);

        const outcome = await switchSessionAgent(
          { session, targetAgent: target, now: 1_700_000_100_000 },
          { fs: env.fs, paths: env.paths },
        );

        assert.equal(outcome.fidelity, 'full', `${target} 应达到 full 保真`);
        assert.ok(outcome.nativeId, 'full 方向必须产出原生会话 id');

        const back = await readBackNative(target, env, outcome.nativeId);
        compareTurns(target, blocks, back.blocks);
      });
    }
  }

  // -----------------------------------------------------------------------
  // 真实夹具 × 每个 full 目标
  // -----------------------------------------------------------------------
  const REAL_FIXTURES: { file: string; sourceAgent: AgentKind }[] = [
    { file: 'zcode-multi.jsonl', sourceAgent: 'zcode' },
    { file: 'codex-tools.jsonl', sourceAgent: 'codex' },
    { file: 'kiro-tools.jsonl', sourceAgent: 'kiro' },
    { file: 'kimi-multiturn.jsonl', sourceAgent: 'kimi' },
    { file: 'codebuddy-tools.jsonl', sourceAgent: 'codebuddy' },
    { file: 'cursor-tools.jsonl', sourceAgent: 'cursor' },
    { file: 'grok-small.jsonl', sourceAgent: 'grok' },
  ];

  for (const fixture of REAL_FIXTURES) {
    for (const target of FULL_AGENTS) {
      it(`${target} ← 真实夹具 ${fixture.file}：内容无损`, async () => {
        const blocks = loadFixture(fixture.file);
        const session = makeSession({ agent: fixture.sourceAgent, claudeSessionId: 'sess_real_1' });
        await seedSource(env, session, blocks);

        const outcome = await switchSessionAgent(
          { session, targetAgent: target, now: 1_700_000_100_000 },
          { fs: env.fs, paths: env.paths },
        );

        const back = await readBackNative(target, env, outcome.nativeId);
        compareTurns(target, blocks, back.blocks);
      });
    }
  }

  // -----------------------------------------------------------------------
  // 边界语义
  // -----------------------------------------------------------------------

  it('thinking 默认以明确标注的非签名普通文本携带，归一化 transcript 原样保留', async () => {
    const blocks = loadFixture('grok-small.jsonl'); // 含 1 条 thinking
    assert.ok(blocks.some((b) => b.kind === 'thinking'), '夹具必须含 thinking');
    const session = makeSession({ agent: 'grok', claudeSessionId: 'sess_think' });
    await seedSource(env, session, blocks);

    for (const target of FULL_AGENTS) {
      const outcome = await switchSessionAgent(
        { session, targetAgent: target, now: 1_700_000_100_000 },
        { fs: env.fs, paths: env.paths },
      );
      // 读回没有厂商原生 thinking/reasoning 块；可读内容位于同轮 user 侧迁移档案。
      const back = await readBackNative(target, env, outcome.nativeId);
      assert.equal(
        back.blocks.filter((b) => b.kind === 'thinking').length,
        0,
        `${target} 的原生产物里不应出现 thinking`,
      );
      assert.ok(
        back.blocks.some((b) => b.kind === 'user' && b.text.includes(THINKING_REFERENCE_OPEN)),
        `${target} 应把 thinking 放进同轮 user 侧迁移档案`,
      );
      assert.equal(
        back.blocks.some((b) => b.kind === 'assistant' && b.text.includes(THINKING_REFERENCE_OPEN)),
        false,
        `${target} 不得把迁移标记写成 assistant 输出范式`,
      );
      assert.ok(
        toCanonicalTurns(back.blocks).some((turn) =>
          turn.assistants.some((assistant) => Boolean(assistant.thinking?.trim())),
        ),
        `${target} 原生产物读回后必须仍能关联到对应 thinking`,
      );
      // 但枢纽格式（归一化 transcript）里 thinking 原样保留 —— 不参与新 agent
      // 的推理，却也不从历史里丢失。
      assert.ok(
        outcome.blocks.some((b) => b.kind === 'thinking'),
        '枢纽格式必须保留 thinking',
      );
      if (target === 'claude') continue; // claude 没有 Vibe transcript（原生文件即真相源）
      const pivotFile = transcriptFileFor(env.paths, target, session.id);
      const persisted = (await env.fs.readFile(pivotFile)) ?? '';
      const kinds = persisted.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as ChatBlock).kind);
      assert.ok(kinds.includes('thinking'), '归一化 transcript 必须保留 thinking（不参与推理但也不丢失）');
    }
  });

  it('carryThinking=false 时完全不把 thinking 写入目标原生产物', async () => {
    const blocks = fixtureWithThinking();
    const session = makeSession({ agent: 'grok', claudeSessionId: 'sess_think_off' });
    await seedSource(env, session, blocks);

    for (const target of FULL_AGENTS) {
      const outcome = await switchSessionAgent(
        { session, targetAgent: target, carryThinking: false, now: 1_700_000_100_000 },
        { fs: env.fs, paths: env.paths },
      );
      const back = await readBackNative(target, env, outcome.nativeId);
      assert.equal(
        back.blocks.some((b) =>
          (b.kind === 'user' || b.kind === 'assistant') && b.text.includes(THINKING_REFERENCE_OPEN),
        ),
        false,
        `${target} 关闭开关后仍携带了 thinking`,
      );
      assert.ok(back.blocks.some((b) => b.kind === 'assistant' && b.text === '等于 2。'));
    }
  });

  it('孤儿工具（没有结果）被补上占位结果，满足 tool_use/tool_result 严格配对', async () => {
    const blocks: ChatBlock[] = [
      { id: 'u1', kind: 'user', text: '开始重构', ts: 1000 },
      { id: 'a1', kind: 'assistant', text: '我先搜一下。', ts: 1001, streaming: false },
      { id: 't1', kind: 'tool', toolUseId: 't1', name: 'Grep', input: { pattern: 'foo' }, status: 'running', ts: 1002 },
    ];
    const session = makeSession({ agent: 'zcode', claudeSessionId: 'sess_orphan' });
    await seedSource(env, session, blocks);

    const outcome = await switchSessionAgent(
      { session, targetAgent: 'claude', now: 1_700_000_100_000 },
      { fs: env.fs, paths: env.paths },
    );
    const back = await readBackNative('claude', env, outcome.nativeId);
    const tools = back.blocks.filter((b) => b.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'done', '孤儿工具必须补上结果，否则 Claude API 会拒绝整条会话');
    assert.ok((tools[0].result ?? '').length > 0);
  });

  it('空会话不产出原生对话内容，也不报错', async () => {
    const session = makeSession({ agent: 'zcode', claudeSessionId: 'sess_empty' });
    await seedSource(env, session, []);
    for (const target of AGENTS) {
      const outcome = await switchSessionAgent(
        { session, targetAgent: target, now: 1_700_000_100_000 },
        { fs: env.fs, paths: env.paths },
      );
      assert.ok(outcome, `${target} 对空会话不应报错`);
      assert.equal(outcome.blocks.length, 0);
    }
  });

  it('超长工具输出（256KB）完整保留，不截断', async () => {
    const big = 'y'.repeat(256 * 1024);
    const blocks: ChatBlock[] = [
      { id: 'u1', kind: 'user', text: '读大文件', ts: 1000 },
      { id: 'a1', kind: 'assistant', text: '好。', ts: 1001, streaming: false },
      { id: 't1', kind: 'tool', toolUseId: 't1', name: 'Read', input: { file_path: '/tmp/big' }, status: 'done', result: big, ts: 1002 },
    ];
    const session = makeSession({ agent: 'zcode', claudeSessionId: 'sess_big' });
    await seedSource(env, session, blocks);

    for (const target of FULL_AGENTS) {
      const outcome = await switchSessionAgent(
        { session, targetAgent: target, now: 1_700_000_100_000 },
        { fs: env.fs, paths: env.paths },
      );
      const back = await readBackNative(target, env, outcome.nativeId);
      const tools = back.blocks.filter((b) => b.kind === 'tool');
      assert.equal(tools.length, 1, `${target} 应保留这条工具调用`);
      assert.equal(tools[0].result?.length, big.length, `${target} 截断/膨胀了工具输出`);
    }
  });

  it('时间戳单调递增（原生文件按时间排序，回退会让 CLI 顺序错乱）', async () => {
    const blocks = loadFixture('codex-tools.jsonl');
    const session = makeSession({ agent: 'codex', claudeSessionId: 'sess_ts' });
    await seedSource(env, session, blocks);
    const outcome = await switchSessionAgent(
      { session, targetAgent: 'claude', now: 1_700_000_100_000 },
      { fs: env.fs, paths: env.paths },
    );
    // 直接扫描 claude 产物文件
    const found = await findRecursive(env.paths.claudeProjectsDir, (n) => n === `${outcome.nativeId}.jsonl`, 2);
    assert.ok(found, '未找到 claude 产物');
    const raw = (await env.fs.readFile(found))!;
    const stamps = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => Date.parse((JSON.parse(l) as { timestamp: string }).timestamp));
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i] >= stamps[i - 1], `第 ${i} 行时间戳回退了：${stamps[i]} < ${stamps[i - 1]}`);
    }
  });

  it('重复切换同一会话是幂等的（不会把历史写两遍）', async () => {
    const blocks = loadFixture('grok-small.jsonl');
    const session = makeSession({ agent: 'grok', claudeSessionId: 'sess_idem' });
    await seedSource(env, session, blocks);
    for (let i = 0; i < 3; i += 1) {
      await switchSessionAgent(
        { session, targetAgent: 'kimi', now: 1_700_000_100_000 },
        { fs: env.fs, paths: env.paths },
      );
    }
    const file = transcriptFileFor(env.paths, 'kimi', session.id);
    const lines = ((await env.fs.readFile(file)) ?? '').split('\n').filter(Boolean);
    assert.equal(lines.length, blocks.length, '重复切换把历史写重复了');
  });

  // -----------------------------------------------------------------------
  // SQLite 原生模块缺失时的诚实降级
  // -----------------------------------------------------------------------

  it('better-sqlite3 不可加载时 cursor/zcode 都降级为 partial primer', async () => {
    const previous = process.env.VIBE_SWITCH_DISABLE_SQLITE;
    process.env.VIBE_SWITCH_DISABLE_SQLITE = '1';
    try {
      const blocks = loadFixture('codex-tools.jsonl');
      const session = makeSession({ agent: 'codex', claudeSessionId: 'sess_partial' });
      await seedSource(env, session, blocks);

      for (const target of ['cursor', 'zcode'] as const) {
        assert.equal(fidelityFor(target), 'partial');
        assert.equal(adapterFor(target).newNativeId(), '');
        const outcome = await switchSessionAgent(
          { session, targetAgent: target, now: 1_700_000_100_000 },
          { fs: env.fs, paths: env.paths },
        );
        assert.equal(outcome.fidelity, 'partial');
        assert.equal(outcome.nativeId, '');
        assert.ok(outcome.primer);
        assert.equal(outcome.files.length, 0);
        for (const b of blocks) {
          if (b.kind === 'user' || b.kind === 'assistant') {
            assert.ok(outcome.primer!.includes(b.text.trim().slice(0, 60)));
          } else if (b.kind === 'tool') {
            assert.ok(outcome.primer!.includes(b.name));
            if (b.result) assert.ok(outcome.primer!.includes(b.result.slice(0, 60)));
          }
        }
      }
    } finally {
      if (previous === undefined) delete process.env.VIBE_SWITCH_DISABLE_SQLITE;
      else process.env.VIBE_SWITCH_DISABLE_SQLITE = previous;
    }
  });

  // -----------------------------------------------------------------------
  // adapter 自身的契约
  // -----------------------------------------------------------------------

  it('每个 agent 都有 adapter，且保真等级非 full 即 partial', () => {
    for (const agent of AGENTS) {
      const adapter = adapterFor(agent);
      assert.equal(adapter.agent, agent);
      assert.ok(adapter.fidelity === 'full' || adapter.fidelity === 'partial');
    }
  });

  it('full 方向的 newNativeId 产出非空 id；kimi 用 session_ 前缀', () => {
    assert.match(adapterFor('kimi').newNativeId(), /^session_[0-9a-f-]{36}$/);
    assert.match(adapterFor('zcode').newNativeId(), /^sess_[0-9a-f-]{36}$/);
    assert.match(adapterFor('opencode').newNativeId(), /^ses_[A-Za-z0-9_-]+$/);
    for (const agent of FULL_AGENTS.filter((a) => a !== 'kimi' && a !== 'zcode' && a !== 'opencode')) {
      assert.match(adapterFor(agent).newNativeId(), /^[0-9a-f-]{36}$/, `${agent} 的 id 应是 UUID`);
    }
  });
});
