import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beijingClock, beijingDateTime } from '../../../web/src/lib/format.js';

describe('轮次结束日期和时间', () => {
  it('使用 YYYY-MM-DD HH:mm:ss UTC+8，保留秒和时区', () => {
    assert.equal(beijingDateTime(Date.parse('2026-09-08T05:17:28Z')), '2026-09-08 13:17:28 UTC+8');
  });

  it('午夜的日期按北京时间计算，小时为 00 而不是 24', () => {
    assert.equal(beijingDateTime(Date.parse('2026-09-07T16:00:00Z')), '2026-09-08 00:00:00 UTC+8');
  });

  it('跨年时同时更新日期和年份', () => {
    assert.equal(beijingDateTime(Date.parse('2026-12-31T16:00:00Z')), '2027-01-01 00:00:00 UTC+8');
  });

  it('正确处理闰日和不同输入时区', () => {
    assert.equal(beijingDateTime(Date.parse('2028-02-28T11:00:00-05:00')), '2028-02-29 00:00:00 UTC+8');
  });

  it('时间戳 0 是有效时间，不作为缺失值', () => {
    assert.equal(beijingDateTime(0), '1970-01-01 08:00:00 UTC+8');
  });

  it('无效或超出日期范围的时间戳不抛错', () => {
    for (const ts of [NaN, Infinity, -Infinity, Number.MAX_VALUE, 8_640_000_000_000_001]) {
      assert.equal(beijingDateTime(ts), '');
    }
  });

  it('非轮次结束的紧凑系统通知仍保持原来的时间格式', () => {
    assert.equal(beijingClock(Date.parse('2026-09-08T05:17:28Z')), '13:17:28 UTC+8');
  });
});
