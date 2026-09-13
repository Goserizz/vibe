import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interruptedContinuationPrompt, queuedRequestPrompt } from '../../../shared/interruptedContinuation.js';

describe('Interrupted conversation continuation prompt', () => {
  it('announces interruption, refers to the task and asks to verify existing work', () => {
    const prompt = interruptedContinuationPrompt('修复 airflow 失败的链路');
    assert.ok(prompt.startsWith('刚刚对话被中断了，请继续'));
    assert.match(prompt, /原任务提示.*修复 airflow 失败的链路/);
    assert.match(prompt, /确认进度，从中断处继续/);
    assert.match(prompt, /已完成的步骤不要重做/);
    assert.match(prompt, /先核查当前状态/);
    assert.match(prompt, /信息不足/);
  });
  it('bounds a long prompt instead of copying its original body or ending', () => {
    const original = '请继续修复这个项目。'.repeat(10000) + 'DO_NOT_COPY_THE_TAIL';
    const prompt = interruptedContinuationPrompt(original);
    assert.ok(prompt.length < 600);
    assert.ok(!prompt.includes('DO_NOT_COPY_THE_TAIL'));
    assert.ok(prompt.includes('…'));
    assert.notEqual(prompt, original);
  });
  it('keeps Unicode whole and normalizes whitespace/control characters in the hint', () => {
    const prompt = interruptedContinuationPrompt('  检查\n服务\u0000 ' + '😀'.repeat(300));
    assert.match(prompt, /检查 服务/);
    assert.ok(!prompt.includes('\u0000'));
    const hint = prompt.split('\n\n')[1]!;
    assert.ok(hint.endsWith('😀…'));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(hint));
  });
  it('refers to existing attachments without resending the envelope or host paths', () => {
    const envelope = 'The following file(s) are attached to this message — read them with your file-reading tools before responding:\n- /private/path/input.csv';
    for (const original of [envelope, '分析上传的数据\n\n' + envelope]) {
      const prompt = interruptedContinuationPrompt(original);
      assert.ok(prompt.includes('上一轮已经提供的附件'));
      assert.ok(!prompt.includes('/private/path'));
      assert.ok(!prompt.includes('The following file(s)'));
    }
  });
  it('does not turn a generic continue request into an awkward nested task hint', () => {
    for (const text of ['继续', '继续吧。', 'Continue!', 'go on', '']) {
      const prompt = interruptedContinuationPrompt(text);
      assert.ok(prompt.startsWith('刚刚对话被中断了，请继续'));
      assert.ok(!prompt.includes('原任务提示'));
    }
  });
  it('changes only explicitly confirmed continuation dispatch, not ordinary sends', () => {
    const text = 'Original\n\nwith exact whitespace';
    assert.equal(queuedRequestPrompt({ text }), text);
    assert.equal(queuedRequestPrompt({ text, continuation: false }), text);
    assert.equal(queuedRequestPrompt({ text, continuation: true }), interruptedContinuationPrompt(text));
  });
});
