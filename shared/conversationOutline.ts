import type { ChatBlock, SnapshotPage } from './protocol.js';

export interface ConversationHeading {
  id: string;
  text: string;
  ts?: number;
}
export interface ConversationOutlinePage extends SnapshotPage {
  entries: ConversationHeading[];
}

// Match the Composer attachment envelope, without exposing host paths in the index.
const ATTACHMENTS = 'The following file(s) are attached to this message — read them with your file-reading tools before responding:';

export function conversationHeadings(blocks: readonly ChatBlock[]): ConversationHeading[] {
  const entries: ConversationHeading[] = [];
  for (const block of blocks) {
    if (block.kind !== 'user' || !block.id) continue;
    const attachmentAt = block.text.indexOf(ATTACHMENTS);
    const raw = attachmentAt < 0 ? block.text : block.text.slice(0, attachmentAt);
    const clean = raw.replace(/\s+/g, ' ').trim();
    const chars = Array.from(clean.slice(0, 1000));
    const text = chars.length > 180 ? chars.slice(0, 180).join('') + '…' : chars.join('');
    entries.push({ id: block.id, text: text || (attachmentAt >= 0 ? '附件提问' : block.images?.length ? '图片提问' : '空消息'), ts: block.ts });
  }
  return entries;
}

export function mergeConversationHeadings(...groups: readonly ConversationHeading[][]): ConversationHeading[] {
  const byId = new Map<string, ConversationHeading>();
  for (const group of groups) for (const entry of group) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/** Reverse presentation only; history paging and message IDs keep their
 * original chronological order, including equal/missing timestamps. */
export function newestFirstConversationHeadings(entries: readonly ConversationHeading[], search = ''): ConversationHeading[] {
  const query = search.trim().toLocaleLowerCase();
  return [...entries].reverse().filter(entry => entry.text.toLocaleLowerCase().includes(query));
}

/** Use the actual transcript gutter, not viewport width: task/file rails also
 * consume room. Narrow containers use the Todo/Monitors task-area dropdown. */
export function outlinePlacement(width: number, gutter: number) {
  const wide = gutter >= 196;
  const panelWidth = wide ? Math.min(248, gutter - 20) : Math.min(320, Math.max(0, width - 24));
  return { wide, panelWidth, left: wide ? gutter - panelWidth - 8 : Math.max(12, width - panelWidth - 12) };
}

/** A docked outline fills the whole conversation surface below its header,
 * including the free gutter beside the composer, not just the message viewport. */
export function outlinePanelBounds(surface: { top: number; height: number }, headerBottom = surface.top) {
  const height = Math.max(0, surface.height);
  const top = Math.min(height, Math.max(0, headerBottom - surface.top));
  return { top, height: height - top };
}

export function outlineDropdownPlacement(anchor: { left: number; top: number; bottom: number; width: number }, screen: { width: number; height: number; top?: number; left?: number }) {
  const top = screen.top ?? 0, left = screen.left ?? 0;
  const width = Math.min(340, Math.max(240, anchor.width), screen.width - 24);
  const below = screen.height + top - anchor.bottom - 18;
  const above = anchor.top - top - 18;
  const down = below >= Math.min(320, above);
  return { width, left: Math.max(left + 12, Math.min(anchor.left, left + screen.width - width - 12)),
    top: down ? Math.max(top + 12, anchor.bottom + 6) : undefined,
    bottom: down ? undefined : anchor.top - 6,
    maxHeight: Math.max(80, Math.min(420, down ? below : above)), down };
}

/** Keep deep-link jumps within a bounded DOM window, even in a huge history. */
export function outlineRenderWindow(total: number, targetIndex = -1, all = false, cap = 600) {
  if (all || total <= cap) return { start: 0, end: total };
  const start = targetIndex < 0 ? total - cap : Math.min(total - cap, Math.max(0, targetIndex - 40));
  return { start, end: Math.min(total, start + cap) };
}
