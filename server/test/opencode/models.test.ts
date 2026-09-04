import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupOpencodeWindow,
  parseOpencodeModels,
  parseOpencodeModelsVerbose,
} from '../../src/opencode/models.js';
import { opencodeVariantValue } from '../../src/opencode/acp.js';

const VERBOSE_SAMPLE = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "limit": {
    "context": 200000,
    "input": 160000,
    "output": 32000
  }
}

opencode/gpt-5.4
{
  "id": "gpt-5.4",
  "providerID": "opencode",
  "name": "GPT 5.4",
  "limit": {
    "context": 400000,
    "input": 272000,
    "output": 128000
  }
}

opencode/no-limit-model
{
  "id": "no-limit-model",
  "providerID": "opencode",
  "name": "No Limit"
}
`;

describe('opencode models --verbose 解析', () => {
  it('解析模型列表、显示名与 context window', () => {
    const { models, windows } = parseOpencodeModelsVerbose(VERBOSE_SAMPLE);
    assert.deepEqual(
      models.map((m) => m.value),
      ['auto', 'opencode/big-pickle', 'opencode/gpt-5.4', 'opencode/no-limit-model'],
    );
    assert.equal(models.find((m) => m.value === 'opencode/big-pickle')?.label, 'Big Pickle');
    assert.deepEqual(windows, {
      'opencode/big-pickle': 200000,
      'opencode/gpt-5.4': 400000,
    });
  });

  it('无 JSON 块时回退到纯行解析', () => {
    const { models, windows } = parseOpencodeModelsVerbose('opencode/big-pickle\nopencode/gpt-5.4\n');
    assert.deepEqual(
      models.map((m) => m.value),
      ['auto', 'opencode/big-pickle', 'opencode/gpt-5.4'],
    );
    assert.deepEqual(windows, {});
  });

  it('损坏的 JSON 块不影响其它条目', () => {
    const { models, windows } = parseOpencodeModelsVerbose('opencode/a\n{not json\n}\n\nopencode/b\n{"id":"b","limit":{"context":128000}}\n');
    assert.ok(models.some((m) => m.value === 'opencode/a'));
    assert.equal(windows['opencode/b'], 128000);
    assert.equal(windows['opencode/a'], undefined);
  });

  it('纯行解析保持可用', () => {
    const models = parseOpencodeModels('opencode/big-pickle\nopencode/gpt-5.4\n');
    assert.deepEqual(
      models.map((m) => m.value),
      ['auto', 'opencode/big-pickle', 'opencode/gpt-5.4'],
    );
  });
});

describe('opencode effort → variant', () => {
  it('直通已知档位，ultra 收敛到 max', () => {
    assert.equal(opencodeVariantValue('low'), 'low');
    assert.equal(opencodeVariantValue('medium'), 'medium');
    assert.equal(opencodeVariantValue('high'), 'high');
    assert.equal(opencodeVariantValue('xhigh'), 'xhigh');
    assert.equal(opencodeVariantValue('max'), 'max');
    assert.equal(opencodeVariantValue('ultra'), 'max');
  });
  it('空值与未知档位省略（走 opencode 默认）', () => {
    assert.equal(opencodeVariantValue(undefined), undefined);
    assert.equal(opencodeVariantValue('nothink'), undefined);
    assert.equal(opencodeVariantValue('enabled'), undefined);
  });
});
describe('opencode context window 查询', () => {
  const map = { 'opencode/big-pickle': 200000, 'other/gpt-x': 128000 };
  it('完整 id 命中', () => {
    assert.equal(lookupOpencodeWindow(map, 'opencode/big-pickle'), 200000);
  });
  it('裸 id 按后缀匹配', () => {
    assert.equal(lookupOpencodeWindow(map, 'big-pickle'), 200000);
    assert.equal(lookupOpencodeWindow(map, 'anything/gpt-x'), 128000);
  });
  it('auto 与未知模型返回 undefined', () => {
    assert.equal(lookupOpencodeWindow(map, 'auto'), undefined);
    assert.equal(lookupOpencodeWindow(map, ''), undefined);
    assert.equal(lookupOpencodeWindow(map, 'opencode/unknown-9'), undefined);
    assert.equal(lookupOpencodeWindow({}, 'opencode/big-pickle'), undefined);
  });
});
