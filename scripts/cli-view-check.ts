/**
 * Smoke-check that CLI transcript rendering emits the coding-agent glyphs
 * for each block kind. Run: npx tsx --tsconfig web/tsconfig.json scripts/cli-view-check.ts
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CliBlockView } from '../web/src/components/CliBlocks';
import type { ChatBlock } from '../shared/protocol';

const now = Date.now();

const blocks: ChatBlock[] = [
  { id: 'u1', kind: 'user', text: 'list the files', ts: now },
  { id: 't1', kind: 'thinking', text: 'I should list the directory.', streaming: false, ts: now },
  {
    id: 'tool1',
    kind: 'tool',
    toolUseId: 'tu1',
    name: 'Bash',
    input: { command: 'ls -la' },
    status: 'done',
    result: 'README.md\npackage.json\n',
    ts: now,
  },
  { id: 'a1', kind: 'assistant', text: 'Here are the files in the repo.', streaming: false, ts: now },
  { id: 'r1', kind: 'result', durationMs: 1200, costUsd: 0.0123, ts: now },
  { id: 'e1', kind: 'error', text: 'something broke', ts: now },
];

const html = blocks.map((block) => renderToStaticMarkup(createElement(CliBlockView, { block }))).join('\n');

assert.match(html, /❯/, 'user prompt glyph');
assert.match(html, /list the files/, 'user text');
assert.match(html, /Thought/, 'collapsed thinking label');
assert.match(html, /Bash\(ls -la\)/, 'CLI tool title');
assert.match(html, /⎿/, 'tool result gutter');
assert.match(html, /■/, 'tool glyph');
assert.match(html, /Here are the files/, 'assistant text');
assert.match(html, /Worked for/, 'turn footer');
assert.match(html, /1\.2s/, 'duration');
assert.match(html, /\$0\.0123/, 'cost');
assert.match(html, /✘/, 'error glyph');
assert.match(html, /something broke/, 'error text');

console.log('cli-view-check ok');
