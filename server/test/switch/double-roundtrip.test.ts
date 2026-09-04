import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentKind, ChatBlock } from '../../../shared/protocol.js';
import { adapterFor } from '../../src/switch/index.js';
import { toCanonicalTurns } from '../../src/switch/canonical.js';
import {
  AGENTS,
  fixtureConsecutiveWakeTurns,
  fixtureConsecutiveUsers,
  fixtureDanglingUser,
  makeTempEnv,
  readBackNative,
  turnsForCompare,
} from './helpers.js';

/** Build one isolated native session and immediately read it through that
 * agent's production parser. A fresh temp root per hop prevents discovery of a
 * previous hop from making the assertion accidentally pass. */
async function nativeHop(
  agent: AgentKind,
  blocks: ChatBlock[],
  label: string,
  now: number,
): Promise<ChatBlock[]> {
  const env = makeTempEnv(label);
  try {
    const adapter = adapterFor(agent);
    assert.equal(adapter.fidelity, 'full', `${agent} 必须以 full fidelity 参加双跳测试`);
    const nativeId = adapter.newNativeId();
    assert.ok(nativeId, `${agent} 必须生成可 resume 的原生 id`);
    const built = await adapter.build({
      fs: env.fs,
      paths: env.paths,
      vibeSessionId: `double-${label}`,
      blocks,
      turns: toCanonicalTurns(blocks),
      cwd: '/tmp/double-roundtrip-project',
      model: 'auto',
      title: '10-agent double roundtrip',
      nativeId,
      now,
      carryThinking: true,
    });
    assert.equal(built.fidelity, 'full');
    for (const file of built.files) {
      assert.ok(file.startsWith(env.root), `测试产物逃出临时目录：${file}`);
    }
    return (await readBackNative(agent, env, built.nativeId)).blocks;
  } finally {
    env.cleanup();
  }
}

describe('真实转换链语义：全部 90 个 A → B → A 双跳', () => {
  let direction = 0;
  for (const from of AGENTS) {
    for (const via of AGENTS) {
      if (via === from) continue;
      direction += 1;
      const index = direction;
      it(`${from} → ${via} → ${from}：user/assistant/thinking/tool 逐字段无损`, async () => {
        // 覆盖两份真实长历史暴露的关键形状：连续 user（前一轮无回复）、同一轮
        // 多段 assistant/thinking/tool，以及多个没有 user、工具先于正文的后台唤醒轮次。
        const source = [
          ...fixtureConsecutiveUsers(),
          ...fixtureConsecutiveWakeTurns(),
          ...fixtureDanglingUser(),
        ];
        const expected = turnsForCompare(source);

        const sourceNative = await nativeHop(from, source, `${index}-source-${from}`, 1_800_000_000_000 + index * 10_000);
        assert.deepEqual(turnsForCompare(sourceNative), expected, `${from} 首次原生写出已丢失`);

        const middleNative = await nativeHop(via, sourceNative, `${index}-via-${via}`, 1_800_000_001_000 + index * 10_000);
        assert.deepEqual(turnsForCompare(middleNative), expected, `${from} → ${via} 中转后丢失`);

        const finalNative = await nativeHop(from, middleNative, `${index}-final-${from}`, 1_800_000_002_000 + index * 10_000);
        assert.deepEqual(turnsForCompare(finalNative), expected, `${from} → ${via} → ${from} 返回后丢失`);
      });
    }
  }
});
