import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentKind, ChatBlock } from '../../../shared/protocol.js';
import { switchSessionAgent, fidelityFor, fidelityMatrix } from '../../src/switch/index.js';
import { transcriptFileFor } from '../../src/switch/paths.js';
import type { StoredSession } from '../../src/sessions/store.js';
import {
  AGENTS,
  loadFixture,
  makeTempEnv,
  readBackNative,
  compareTurns,
  findRecursive,
  type TempEnv,
} from './helpers.js';

/**
 * 方向矩阵：10 个源 agent × 10 个目标 agent = 100 个方向，每个方向一条完整
 * 原生写出 + 生产解析器读回用例（含切到自身）。
 *
 * 断言分档：
 * 标准安装下 100 个方向全部 full；SQLite 原生模块缺失的降级另有契约测试。
 */

/** 每个源 agent 用一条自己格式的真实夹具，尽量贴近真实数据。 */
const SOURCE_FIXTURE: Record<AgentKind, string> = {
  claude: 'claude-native.jsonl', // Claude 没有 Vibe transcript，原生文件就是枢纽来源
  codex: 'codex-tools.jsonl',
  cursor: 'cursor-tools.jsonl',
  kimi: 'kimi-multiturn.jsonl',
  kiro: 'kiro-tools.jsonl',
  grok: 'grok-small.jsonl',
  zcode: 'zcode-multi.jsonl',
  codebuddy: 'codebuddy-tools.jsonl',
  opencode: 'zcode-multi.jsonl',
  devin: 'devin-tools.jsonl',
};

/** Claude 的源是原生 JSONL，其余是归一化 transcript。 */
function isNativeSource(agent: AgentKind): boolean {
  return agent === 'claude';
}

describe('方向矩阵 10×10', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = makeTempEnv('matrix');
  });
  afterEach(() => env.cleanup());

  /** 把源历史按源 agent 的方式落到磁盘上。 */
  async function seed(agent: AgentKind, sessionId: string, blocks: ChatBlock[]): Promise<void> {
    if (isNativeSource(agent)) {
      // Claude：原生 project 目录下的 jsonl（编码目录名用真实规则推出来）。
      const dir = `${env.paths.claudeProjectsDir}/-tmp-proj`;
      await env.fs.mkdirp(dir);
      await env.fs.writeFile(`${dir}/${sessionId}.jsonl`, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);
      return;
    }
    const file = transcriptFileFor(env.paths, agent, sessionId);
    await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
    await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);
  }

  for (const from of AGENTS) {
    for (const to of AGENTS) {
      it(`${from} → ${to}`, async () => {
        const blocks = loadFixture(SOURCE_FIXTURE[from]);
        const sessionId = 'sess-matrix';
        const session: StoredSession = {
          id: sessionId,
          // Claude 的 claudeSessionId 就是原生文件名；其余也用同一个占位 id。
          claudeSessionId: isNativeSource(from) ? sessionId : 'native-src-1',
          title: '矩阵测试会话',
          cwd: '/tmp/proj',
          model: 'auto',
          permissionMode: 'default',
          agent: from,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_002_000,
          messageCount: 1,
        };
        await seed(from, sessionId, blocks);

        const outcome = await switchSessionAgent(
          { session, targetAgent: to, targetModel: 'auto', now: 1_700_000_100_000 },
          { fs: env.fs, paths: env.paths },
        );

        const fidelity = fidelityFor(to);
        assert.equal(fidelity, 'full', `${to} 在标准安装下必须支持原生 SQLite/文件写出`);
        assert.equal(outcome.fidelity, 'full', `${from} → ${to} 必须达到 full`);
        assert.ok(outcome.note.length > 0, '每个方向都要有保真说明文案');

        assert.ok(outcome.nativeId, `${from} → ${to} 应产出原生会话 id`);
        assert.ok(outcome.files.length > 0, 'full 方向必须写出原生文件');
        for (const file of outcome.files) {
          assert.ok(await env.fs.exists(file), `产物文件不存在: ${file}`);
        }
        const back = await readBackNative(to, env, outcome.nativeId);
        // 基线是枢纽格式（outcome.blocks）—— 也就是真正被转换的那份历史。
        // 对 claude 源它来自原生文件解析，对其余 agent 就是归一化 transcript。
        compareTurns(to, outcome.blocks, back.blocks);

        // 无论 full 还是 partial，目标 agent 的归一化 transcript 都要铺好历史，
        // 这样 UI 打开会话立刻能看到完整对话。
        // Claude 例外：它没有 Vibe transcript（UI 直接读它的原生文件），
        // 切换后由 adapter 写出的原生 `~/.claude/projects/**` 承载历史。
        if (to === 'claude') {
          const found = await findRecursive(env.paths.claudeProjectsDir, (n) => n === `${outcome.nativeId}.jsonl`, 2);
          assert.ok(found, '切到 claude 应产出原生会话文件（它就是历史的载体）');
        } else {
          const pivot = transcriptFileFor(env.paths, to, sessionId);
          const persisted = ((await env.fs.readFile(pivot)) ?? '').split('\n').filter(Boolean);
          assert.equal(persisted.length, outcome.blocks.length, '目标 transcript 应原样承载完整历史');
        }
      });
    }
  }

  it('方向矩阵共 100 个方向（10×10，含切到自身）', () => {
    const matrix = fidelityMatrix(AGENTS);
    assert.equal(matrix.length, 100);
    const full = matrix.filter((m) => m.fidelity === 'full').length;
    const partial = matrix.filter((m) => m.fidelity === 'partial').length;
    assert.equal(full, 100, '标准安装下 full 方向数量应为 100');
    assert.equal(partial, 0, '标准安装下不应有 partial 方向');
  });

  it('保真等级只取决于目标 agent，与来源无关', () => {
    for (const to of AGENTS) {
      const levels = new Set(AGENTS.map((from) => fidelityMatrix(AGENTS).find((m) => m.from === from && m.to === to)!.fidelity));
      assert.equal(levels.size, 1, `切到 ${to} 的保真等级不应随来源变化`);
    }
  });

  // -----------------------------------------------------------------------
  // 切到自身（只改模型，历史不动）
  // -----------------------------------------------------------------------
  it('切到同一个 agent 时：历史保留、模型更新', async () => {
    const blocks = loadFixture('codex-tools.jsonl');
    const session: StoredSession = {
      id: 'sess-self',
      claudeSessionId: 'native-self-1',
      title: '自身切换',
      cwd: '/tmp/proj',
      model: 'old-model',
      permissionMode: 'default',
      agent: 'codex',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    };
    const file = transcriptFileFor(env.paths, 'codex', session.id);
    await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
    await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const outcome = await switchSessionAgent(
      { session, targetAgent: 'codex', targetModel: 'new-model', now: 1_700_000_100_000 },
      { fs: env.fs, paths: env.paths },
    );
    assert.equal(outcome.fidelity, 'full');
    const back = await readBackNative('codex', env, outcome.nativeId);
    compareTurns('codex', outcome.blocks, back.blocks);
  });
});
