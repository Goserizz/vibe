import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallMeta } from '../../src/telegram/tools.js';

/** `toolCallMeta` mirrors web `toolMeta` — these pin the plan-tool aliases so
 *  the two maps can't drift apart. Cursor names its plan tool `CreatePlan`;
 *  ZCode/CodeBuddy also expose `EnterPlanMode`. */
describe('plan tool aliases (telegram mirror of web toolMeta)', () => {
  it('maps every engine plan-exit spelling to the plan kind', () => {
    for (const name of ['ExitPlanMode', 'exit_plan_mode', 'CreatePlan', 'createPlan']) {
      const meta = toolCallMeta(name, {});
      assert.equal(meta.kind, 'plan', `${name} should map to plan`);
      assert.equal(meta.label, 'Plan', `${name} should label as Plan`);
    }
  });

  it('maps EnterPlanMode to the plan kind', () => {
    const meta = toolCallMeta('EnterPlanMode', {});
    assert.equal(meta.kind, 'plan');
    assert.equal(meta.label, 'Plan');
  });

  it('shows the allowedPrompts count as the plan detail', () => {
    const meta = toolCallMeta('ExitPlanMode', {
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    });
    assert.equal(meta.detail, '1 permissions');
  });
});
