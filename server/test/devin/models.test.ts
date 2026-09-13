import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDevinModels,
  parseFusionSpec,
  parseFusionUid,
  resolveDevinVariant,
  resolveFusionUid,
  devinFamilyForModel,
  type DevinCatalog,
} from '../../src/devin/models.js';

/** A trimmed copy of `devin models list --format json` around the fusion
 *  family: two plain families plus fusion variants covering plain, tiered and
 *  undifferentiated-normal combinations. */
const CATALOG_JSON = JSON.stringify({
  families: [
    {
      family_uid: 'claude-opus-5',
      family_label: 'Claude Opus 5',
      variants: [
        { model_uid: 'claude-opus-5', max_context_tokens: 200000 },
        { model_uid: 'claude-opus-5-medium', max_context_tokens: 200000 },
        { model_uid: 'claude-opus-5-high', max_context_tokens: 200000 },
      ],
    },
    {
      family_uid: 'gpt-5.6-sol',
      family_label: 'GPT-5.6 Sol',
      variants: [{ model_uid: 'gpt-5.6-sol-high', max_context_tokens: 400000 }],
    },
    {
      family_uid: 'swe-2',
      family_label: 'SWE-2',
      variants: [{ model_uid: 'swe-2', max_context_tokens: 128000 }],
    },
    {
      family_uid: 'glm-5.2',
      family_label: 'GLM-5.2',
      variants: [{ model_uid: 'glm-5.2', max_context_tokens: 128000 }],
    },
    {
      family_uid: 'fusion',
      family_label: 'Fusion',
      variants: [
        { model_uid: 'fusion-claude-opus-5-medium-sidekick-swe-2-medium', max_context_tokens: 1000000 },
        { model_uid: 'fusion-claude-opus-5-high-sidekick-swe-2-medium', max_context_tokens: 1000000 },
        { model_uid: 'fusion-claude-opus-5-high-fast-sidekick-swe-2-medium', max_context_tokens: 1000000 },
        { model_uid: 'fusion-claude-opus-5-high-sidekick-swe-2-high', max_context_tokens: 1000000 },
        { model_uid: 'fusion-gpt-5-6-sol-high-sidekick-glm-5-2', max_context_tokens: 1000000 },
      ],
    },
  ],
});

function catalog(): DevinCatalog {
  return parseDevinModels(CATALOG_JSON);
}

describe('devin fusion catalog', () => {
  it('surfaces the fusable models per role instead of a flat variant list', () => {
    const cat = catalog();
    const fusion = cat.models.find((m) => m.value === 'fusion');
    assert.ok(fusion?.fusion, 'fusion model carries structured refs');
    assert.deepEqual(
      fusion.fusion.strong.map((r) => r.value).sort(),
      ['claude-opus-5', 'gpt-5-6-sol'],
    );
    assert.deepEqual(
      fusion.fusion.normal.map((r) => r.value).sort(),
      ['glm-5-2', 'swe-2'],
    );
    // Dots are normalised to dashes, labels resolved from the plain families.
    const sol = fusion.fusion.strong.find((r) => r.value === 'gpt-5-6-sol');
    assert.equal(sol?.label, 'GPT-5.6 Sol');
    // A strong model with several tiers exposes its ladder; the pinned
    // glm-5.2 normal exposes none.
    assert.ok(fusion.fusion.strong.find((r) => r.value === 'claude-opus-5')?.efforts?.length);
    assert.equal(fusion.fusion.normal.find((r) => r.value === 'glm-5-2')?.efforts, undefined);
    // No generic effort ladder on the fusion entry — tiers live inside the pair.
    assert.equal(fusion.efforts, undefined);
  });

  it('does not affect plain families', () => {
    const cat = catalog();
    const opus = cat.models.find((m) => m.value === 'claude-opus-5');
    assert.deepEqual(opus?.efforts, ['medium', 'high']);
    assert.equal(opus?.fusion, undefined);
  });
});

describe('devin fusion uid and spec parsing', () => {
  it('parses concrete variant uids', () => {
    assert.deepEqual(parseFusionUid('fusion-claude-opus-5-high-sidekick-swe-2-medium'), {
      strong: 'claude-opus-5',
      strongEffort: 'high',
      normal: 'swe-2',
      normalEffort: 'medium',
    });
    // Tier suffixes on either side are tolerated.
    assert.deepEqual(parseFusionUid('fusion-gpt-5-6-sol-high-fast-sidekick-glm-5-2'), {
      strong: 'gpt-5-6-sol',
      strongEffort: 'high',
      normal: 'glm-5-2',
      normalEffort: undefined,
    });
    assert.equal(parseFusionUid('claude-opus-5-high'), undefined);
  });

  it('parses stored selection specs', () => {
    assert.deepEqual(parseFusionSpec('fusion:claude-opus-5:high+swe-2:medium'), {
      strong: 'claude-opus-5',
      strongEffort: 'high',
      normal: 'swe-2',
      normalEffort: 'medium',
    });
    assert.deepEqual(parseFusionSpec('fusion:gpt-5-6-sol+swe-2'), {
      strong: 'gpt-5-6-sol',
      strongEffort: undefined,
      normal: 'swe-2',
      normalEffort: undefined,
    });
    assert.equal(parseFusionSpec('claude-opus-5'), undefined);
  });
});

describe('devin fusion resolution', () => {
  it('maps a selection onto the best matching variant', () => {
    const cat = catalog();
    const fusion = cat.variants.get('fusion')!;
    // Exact pair + efforts.
    assert.equal(
      resolveFusionUid({ strong: 'claude-opus-5', strongEffort: 'high', normal: 'swe-2', normalEffort: 'medium' }, fusion),
      'fusion-claude-opus-5-high-sidekick-swe-2-medium',
    );
    // Plain variant beats the tiered one at equal fit.
    assert.equal(
      resolveFusionUid({ strong: 'claude-opus-5', strongEffort: 'high', normal: 'swe-2' }, fusion),
      'fusion-claude-opus-5-high-sidekick-swe-2-medium',
    );
    // Missing effort snaps to the nearest tier on the ladder.
    assert.equal(
      resolveFusionUid({ strong: 'claude-opus-5', strongEffort: 'xhigh', normal: 'swe-2', normalEffort: 'medium' }, fusion),
      'fusion-claude-opus-5-high-sidekick-swe-2-medium',
    );
    // Unknown pair: no variant.
    assert.equal(
      resolveFusionUid({ strong: 'claude-opus-5', normal: 'glm-5-2' }, fusion),
      undefined,
    );
  });

  it('resolves stored specs at turn time via resolveDevinVariant', () => {
    const cat = catalog();
    assert.equal(
      resolveDevinVariant('fusion:claude-opus-5:high+swe-2:medium', undefined, cat).uid,
      'fusion-claude-opus-5-high-sidekick-swe-2-medium',
    );
    // Context window rides along from the matched variant.
    assert.equal(
      resolveDevinVariant('fusion:gpt-5-6-sol:high+glm-5-2', undefined, cat).contextWindow,
      1000000,
    );
    // A spec whose pair the catalog cannot serve degrades to the plain family.
    assert.equal(resolveDevinVariant('fusion:unknown-model:high+swe-2', undefined, cat).uid, 'fusion');
    // Concrete uids keep flowing through untouched.
    assert.equal(
      resolveDevinVariant('fusion-claude-opus-5-high-sidekick-swe-2-medium', undefined, cat).uid,
      'fusion-claude-opus-5-high-sidekick-swe-2-medium',
    );
  });

  it('maps fusion values back to the fusion family for pickers', () => {
    const cat = catalog();
    assert.equal(devinFamilyForModel('fusion:claude-opus-5:high+swe-2', cat), 'fusion');
    assert.equal(devinFamilyForModel('fusion-claude-opus-5-high-sidekick-swe-2-medium', cat), 'fusion');
    assert.equal(devinFamilyForModel('claude-opus-5-high', cat), 'claude-opus-5');
  });
});
