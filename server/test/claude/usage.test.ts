import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { usageContextTokens } from '../../src/claude/normalize.js';

describe('provider context-token normalization', () => {
  it('adds Anthropic input and cache buckets because they are disjoint', () => {
    assert.equal(usageContextTokens({
      input_tokens: 2_241,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 54_080,
      output_tokens: 68,
    }), 56_389);
  });

  it('uses CodeBuddy total_tokens instead of adding duplicate aliases', () => {
    assert.equal(usageContextTokens({
      input_tokens: 95_822,
      output_tokens: 312,
      total_tokens: 96_134,
      inputTokens: 95_822,
      outputTokens: 312,
      cache_read_input_tokens: 320,
      cache_creation_input_tokens: 95_502,
    }), 96_134);
  });

  it('does not add Codex cached_input_tokens, which is an input subset', () => {
    assert.equal(usageContextTokens({
      input_tokens: 16_332,
      cached_input_tokens: 11_008,
      output_tokens: 491,
      reasoning_output_tokens: 97,
      total_tokens: 16_823,
    }), 16_823);
  });

  it('uses OpenAI prompt/completion totals without adding cache details', () => {
    assert.equal(usageContextTokens({
      prompt_tokens: 8_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 7_000 },
      cached_input_tokens: 7_000,
    }), 8_500);
  });

  it('keeps Cursor camelCase cache buckets additive when no total is supplied', () => {
    assert.equal(usageContextTokens({
      inputTokens: 4_284,
      outputTokens: 713,
      cacheReadTokens: 20_209,
      cacheCreationTokens: 0,
    }), 25_206);
  });

  it('uses a camelCase provider total before its component counters', () => {
    assert.equal(usageContextTokens({
      inputTokens: 85_612,
      outputTokens: 77,
      cacheReadTokens: 12_096,
      totalTokens: 85_689,
    }), 85_689);
  });
});
