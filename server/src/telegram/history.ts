/**
 * Compact recap of a session's most recent conversation, shown by the Telegram
 * bot when switching sessions. Thinking / result blocks are dropped (internal
 * reasoning and per-turn token tallies); tool calls collapse to one `→ Tool`
 * line each — the same shape streamed turns use in `turn.ts`.
 */

import type { ChatBlock } from '../../../shared/protocol.js';
import { clip } from './format.js';
import { formatToolCallMd } from './tools.js';

/** Cap the recap at a recent slice so it fits one Telegram rich bubble. */
const MAX_BLOCKS = 24;
const MAX_CHARS = 6000;

/** Approximate rendered length of a block, for the tail-budget walk. */
function blockCost(b: ChatBlock): number {
  if (b.kind === 'user' || b.kind === 'assistant' || b.kind === 'error') return b.text.length + 8;
  if (b.kind === 'tool') return 80;
  return 0;
}

function formatBlockLine(b: ChatBlock): string {
  if (b.kind === 'user') {
    const t = b.text.trim();
    return t ? `🧑 ${t}` : '';
  }
  if (b.kind === 'assistant') {
    return b.text.trim();
  }
  if (b.kind === 'tool') {
    return `→ ${formatToolCallMd(b.name, b.input)}`;
  }
  if (b.kind === 'error') {
    const t = b.text.trim();
    return t ? `⚠ ${t}` : '';
  }
  return '';
}

/**
 * Build a Telegram markdown view of the most recent conversation. Walks the
 * displayable blocks (user / assistant / tool / error) from the tail until the
 * char budget or block cap is hit, then returns them in chronological order.
 * Returns '' when there is nothing to show.
 */
export function formatRecentConversation(blocks: ChatBlock[]): string {
  const displayable = blocks.filter((b) => b.kind !== 'thinking' && b.kind !== 'result');
  if (displayable.length === 0) return '';

  const take: ChatBlock[] = [];
  let total = 0;
  for (let i = displayable.length - 1; i >= 0; i--) {
    const b = displayable[i]!;
    const cost = blockCost(b);
    if (take.length >= MAX_BLOCKS || total + cost > MAX_CHARS) break;
    take.unshift(b);
    total += cost;
  }

  const lines = take.map(formatBlockLine).filter(Boolean);
  if (lines.length === 0) return '';

  const hidden = displayable.length - take.length;
  const body = lines.join('\n\n');
  const tail = hidden > 0 ? `\n\n_…${hidden} earlier message${hidden === 1 ? '' : 's'} hidden_` : '';
  return clip(body, MAX_CHARS) + tail;
}
