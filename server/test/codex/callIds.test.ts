import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_CALL_ID_MAX_LENGTH, codexCallIdAliases } from '../../src/codex/callIds.js';
import { codexRolloutBlocks } from '../../src/codex/transcript.js';
import { switchSessionAgent } from '../../src/switch/index.js';
import { toCanonicalTurns } from '../../src/switch/canonical.js';
import { makeTempEnv, fixtureLongToolIds, turnsForCompare } from '../switch/helpers.js';

describe('Codex imported tool call IDs', () => {
  it('keeps 64-character IDs and shortens oversized IDs without prefix collisions', () => {
    const valid = 'v'.repeat(64);
    const oversized = ['x'.repeat(65), `${'a'.repeat(85)}0`, `${'a'.repeat(85)}1`];
    const aliases = codexCallIdAliases([valid, ...oversized, oversized[0]!]);
    assert.equal(aliases.has(valid), false);
    assert.equal(aliases.size, 3);
    assert.equal(new Set(aliases.values()).size, 3);
    for (const alias of aliases.values()) {
      assert.ok(alias.length <= CODEX_CALL_ID_MAX_LENGTH);
      assert.match(alias, /^call_vibe_[a-f0-9]+$/);
    }
    assert.deepEqual(aliases, codexCallIdAliases([...oversized].reverse()));
  });

  it('reserves even a later short source ID that matches an earlier generated alias', () => {
    const original = 'long'.repeat(30);
    const conflict = codexCallIdAliases([original]).get(original)!;
    const aliases = codexCallIdAliases([original, conflict]);
    assert.equal(aliases.has(conflict), false);
    assert.notEqual(aliases.get(original), conflict);
    assert.deepEqual(aliases, codexCallIdAliases([conflict, original]));
  });

  it('writes API-compatible pairs and reads original IDs and full content back from native history', async () => {
    const env = makeTempEnv('codex-call-ids');
    try {
      const source = fixtureLongToolIds();
      const before = JSON.stringify(source);
      const outcome = await switchSessionAgent({
        session: {
          id: 'long-call-id-session',
          title: 'Sample imported session',
          agent: 'zcode',
          model: 'auto',
          cwd: '/workspace/sample',
          permissionMode: 'default',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
          messageCount: 1,
        },
        targetAgent: 'codex',
      }, { fs: env.fs, paths: env.paths, sourceBlocks: source });
      assert.equal(JSON.stringify(source), before);
      assert.deepEqual(outcome.blocks, source, 'normalized transcript keeps the original IDs');
      const raw = (await env.fs.readFile(outcome.files[0]!))!;
      const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
      const nativeCalls = rows.filter((row) => row.payload.type === 'function_call');
      const nativeOutputs = rows.filter((row) => row.payload.type === 'function_call_output');
      assert.equal(nativeCalls.length, 2);
      assert.equal(nativeOutputs.length, 2);
      assert.notEqual(nativeCalls[0].payload.call_id, nativeCalls[1].payload.call_id);
      assert.equal(rows[0].type, 'session_meta');
      assert.equal(Object.keys(rows[0].vibe.callIdAliases).length, 2);
      for (const row of rows) {
        assert.equal(row.payload.vibe, undefined, 'provenance must stay outside provider payloads');
        if (row.payload.call_id) assert.ok(row.payload.call_id.length <= 64);
      }
      for (let i = 0; i < nativeCalls.length; i++) {
        assert.equal(nativeCalls[i].payload.call_id, nativeOutputs[i].payload.call_id);
        const sourceTool = toCanonicalTurns(source)[0]!.assistants.flatMap((assistant) => assistant.tools)[i]!;
        assert.equal(nativeOutputs[i].payload.output, sourceTool.result);
        assert.equal(Boolean(nativeOutputs[i].payload.is_error), sourceTool.isError);
      }
      assert.deepEqual(turnsForCompare(codexRolloutBlocks(raw)), turnsForCompare(source));
    } finally {
      env.cleanup();
    }
  });
});
