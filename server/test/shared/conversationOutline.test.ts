import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationHeadings, mergeConversationHeadings, newestFirstConversationHeadings, outlineDropdownPlacement, outlinePanelBounds, outlinePlacement, outlineRenderWindow } from '../../../shared/conversationOutline.js';
import type { ChatBlock } from '../../../shared/protocol.js';

describe('Conversation outline data and responsive placement', () => {
  it('indexes only user messages, not assistant text, thoughts, tools or monitor notices', () => {
    const blocks: ChatBlock[] = [
      { id: 'u1', kind: 'user', text: '  Question\n one  ', ts: 1 },
      { id: 'a', kind: 'assistant', text: 'Assistant question?', streaming: false, ts: 1 },
      { id: 's', kind: 'system', text: 'Monitor woke up', ts: 1 },
      { id: 't', kind: 'thinking', text: 'Private', streaming: false, ts: 1 },
      { id: 'tool', kind: 'tool', toolUseId: 'tool', name: 'Read', input: {}, result: 'secret result', status: 'done', ts: 1 },
      { id: 'u2', kind: 'user', text: 'Question one', ts: 2 },
    ];
    assert.deepEqual(conversationHeadings(blocks).map(({ id, text }) => ({ id, text })), [
      { id: 'u1', text: 'Question one' }, { id: 'u2', text: 'Question one' },
    ]);
  });
  it('hides attachment envelopes and supports image/attachment-only questions', () => {
    const attachment = 'The following file(s) are attached to this message — read them with your file-reading tools before responding:\n- /private/host/file.png';
    const entries = conversationHeadings([
      { kind: 'user', id: 'a', text: 'Explain this\n\n' + attachment, ts: 1 },
      { kind: 'user', id: 'b', text: attachment, ts: 2 },
      { kind: 'user', id: 'c', text: '', images: ['synthetic-image'], ts: 3 },
    ]);
    assert.deepEqual(entries.map(entry => entry.text), ['Explain this', '附件提问', '图片提问']);
    assert.ok(!JSON.stringify(entries).includes('/private/host'));
  });
  it('bounds previews without splitting emoji or interpreting HTML', () => {
    const text = '<script>example</script>' + '😀'.repeat(500);
    const entry = conversationHeadings([{ kind: 'user', id: 'q', text, ts: 1 }])[0]!;
    assert.equal(Array.from(entry.text).length, 181);
    assert.ok(entry.text.endsWith('😀…'));
    assert.ok(entry.text.startsWith('<script>'));
  });
  it('deduplicates overlapping pages by ID, not identical question text, and keeps live updates', () => {
    assert.deepEqual(mergeConversationHeadings([{ id: 'same', text: 'old', ts: 1 }, { id: 'different', text: 'old', ts: 2 }], [{ id: 'same', text: 'new', ts: 1 }]),
      [{ id: 'same', text: 'new', ts: 1 }, { id: 'different', text: 'old', ts: 2 }]);
  });
  it('uses the actual left gutter; a narrowed task/file pane chooses the task dropdown', () => {
    const wide = outlinePlacement(1500, 350);
    assert.equal(wide.wide, true); assert.ok(wide.left >= 0); assert.ok(wide.left + wide.panelWidth < 350);
    assert.equal(outlinePlacement(900, 66).wide, false);
    assert.equal(outlinePlacement(390, 0).wide, false);
  });
  it('shows newest questions first without mutating history or reordering equal timestamps', () => {
    const entries = [{ id: 'old', text: 'Old question' }, { id: 'middle', text: 'Question', ts: 1 }, { id: 'new', text: 'Newest question', ts: 1 }];
    assert.deepEqual(newestFirstConversationHeadings(entries).map(entry => entry.id), ['new', 'middle', 'old']);
    assert.deepEqual(entries.map(entry => entry.id), ['old', 'middle', 'new']);
    assert.equal(newestFirstConversationHeadings(entries)[0], entries[2], 'Keep the same ID and entry for jump targeting');
    assert.deepEqual(newestFirstConversationHeadings([]), []);
  });
  it('also shows search matches newest first and keeps repeated question texts distinct', () => {
    const entries = [{ id: 'old', text: 'RETRY handling' }, { id: 'other', text: 'Deployment' }, { id: 'new', text: 'retry handling' }];
    assert.deepEqual(newestFirstConversationHeadings(entries, '  Retry  ').map(entry => entry.id), ['new', 'old']);
    assert.deepEqual(newestFirstConversationHeadings(entries, 'missing'), []);
  });
  it('fits a dropdown under a task header and flips above a composer near the bottom', () => {
    const rail = outlineDropdownPlacement({ left: 900, top: 80, bottom: 120, width: 290 }, { width: 1200, height: 800 });
    assert.equal(rail.down, true); assert.ok(rail.left + rail.width <= 1188);
    const mobile = outlineDropdownPlacement({ left: 16, top: 550, bottom: 590, width: 358 }, { width: 390, height: 650 });
    assert.equal(mobile.down, false); assert.ok(mobile.left + mobile.width <= 378);
    assert.ok(mobile.bottom! - mobile.maxHeight >= 12);
  });
  it('fills the conversation surface below the floating header, without a 500px cap', () => {
    assert.deepEqual(outlinePanelBounds({ top: 0, height: 1050 }, 64), { top: 64, height: 986 });
    assert.deepEqual(outlinePanelBounds({ top: 20, height: 1400 }, 100), { top: 80, height: 1320 });
  });
  it('includes the composer-side gutter and handles a normal-flow Vibot header', () => {
    // The message viewport may be shorter; docking uses the containing surface.
    assert.deepEqual(outlinePanelBounds({ top: 72, height: 900 }, 72), { top: 0, height: 900 });
    assert.deepEqual(outlinePanelBounds({ top: 72, height: 900 }), { top: 0, height: 900 });
    assert.deepEqual(outlinePanelBounds({ top: 0, height: 40 }, 64), { top: 40, height: 0 });
  });
  it('accounts for a short visual viewport when the mobile keyboard opens', () => {
    const pos = outlineDropdownPlacement({ left: 16, top: 280, bottom: 320, width: 358 }, { width: 390, height: 320, top: 30 });
    assert.equal(pos.down, false); assert.ok(pos.bottom! - pos.maxHeight >= 42);
  });
  it('renders a bounded window around a deep question without dropping its identity', () => {
    const window = outlineRenderWindow(10_000, 90);
    assert.ok(window.start <= 90 && window.end > 90); assert.equal(window.end - window.start, 600);
    assert.deepEqual(outlineRenderWindow(10_000), { start: 9400, end: 10_000 });
    assert.deepEqual(outlineRenderWindow(120, 10), { start: 0, end: 120 });
    assert.deepEqual(outlineRenderWindow(10_000, 90, true), { start: 0, end: 10_000 });
  });
});
