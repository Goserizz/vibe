import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outlineReadingBounds } from '../../../web/src/lib/outlineGeometry.js';

describe('Frontend outline reading-area bounds', () => {
  it('stops above the floating chat composer, not at the surface bottom', () => {
    assert.deepEqual(outlineReadingBounds({ top: 0, height: 1000 }, { bottom: 1000 }, 64, 900), { top: 64, height: 836 });
  });
  it('shrinks as a multiline input or queued-request area grows', () => {
    const normal = outlineReadingBounds({ top: 0, height: 1000 }, { bottom: 1000 }, 64, 900);
    const grown = outlineReadingBounds({ top: 0, height: 1000 }, { bottom: 1000 }, 64, 720);
    assert.equal(normal.height - grown.height, 180);
    assert.equal(grown.top + grown.height, 720);
  });
  it('aligns with the separate TUI and Vibot message viewport', () => {
    assert.deepEqual(outlineReadingBounds({ top: 0, height: 1000 }, { bottom: 900 }, 64, 900), { top: 64, height: 836 });
    assert.deepEqual(outlineReadingBounds({ top: 64, height: 936 }, { bottom: 900 }, 64, 900), { top: 0, height: 836 });
  });
  it('falls back to the viewport and clamps a very short reading area', () => {
    assert.deepEqual(outlineReadingBounds({ top: 20, height: 980 }, { bottom: 800 }, 64), { top: 44, height: 736 });
    assert.deepEqual(outlineReadingBounds({ top: 20, height: 980 }, { bottom: 1000 }, 64, 40), { top: 20, height: 0 });
  });
});
