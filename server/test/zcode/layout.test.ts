import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairZcodeBuiltinProviderLayout, zcodeBuiltinProviderPaths } from '../../src/zcode/bundle.js';

describe('ZCode built-in provider layout', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-zcode-layout-'));
    dirs.push(root);
    return root;
  }

  it('links the shipped catalog next to zcode.cjs', () => {
    const root = tree();
    const { expected, shipped } = zcodeBuiltinProviderPaths(root);
    fs.mkdirSync(path.dirname(shipped), { recursive: true });
    fs.writeFileSync(shipped, '{"schemaVersion":1}\n');
    assert.equal(repairZcodeBuiltinProviderLayout(root), true);
    assert.equal(fs.existsSync(expected), true);
    assert.equal(fs.readFileSync(expected, 'utf8'), '{"schemaVersion":1}\n');
    assert.equal(repairZcodeBuiltinProviderLayout(root), false);
  });

  it('does nothing when the shipped catalog is missing', () => {
    const root = tree();
    assert.equal(repairZcodeBuiltinProviderLayout(root), false);
    assert.equal(fs.existsSync(zcodeBuiltinProviderPaths(root).expected), false);
  });
});
