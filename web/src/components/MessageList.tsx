import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import { useStore } from '../store/store';
import { BlockView } from './blocks';
import { CliBlockView } from './CliBlocks';
import { cn } from '../lib/format';

export function MessageList({
  sessionId,
  bottomPad,
  embedded,
}: {
  sessionId: string;
  bottomPad?: number;
  /** Vibot (and similar) embeds: solid header above, skip floating-titlebar padding. */
  embedded?: boolean;
}) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const viewMode = useStore((s) => s.viewMode);
  const cli = viewMode === 'cli';
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Track whether the user is parked at the bottom; only then do we auto-follow.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  // Re-anchor on new blocks and when the floating composer stack resizes (the
  // task pane collapsing, say), since that changes the padding below the list.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks, bottomPad, viewMode]);

  // Snap to bottom when switching sessions.
  useEffect(() => {
    stickRef.current = true;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  if (!blocks) {
    return <div className="flex-1" />;
  }

  return (
    <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          'messages-pad mx-auto flex flex-col px-4 md:px-6',
          cli ? 'max-w-4xl gap-2' : 'max-w-3xl gap-4',
          embedded ? 'pt-6 pb-8' : 'pt-28 md:pt-20',
        )}
        // Measured composer-stack height wins over the CSS fallback, so the last
        // message always parks above it — including when the task pane is open.
        style={bottomPad ? { paddingBottom: `${bottomPad + 8}px` } : undefined}
      >
        {blocks.length === 0 ? (
          <div className={cn('py-20 text-sm text-slate-600', cli ? 'font-mono text-left' : 'text-center')}>
            {cli ? '// send a message to start the conversation' : 'Send a message to start the conversation.'}
          </div>
        ) : (
          blocks.map((b, i) => (
            <Fragment key={b.id}>
              {/* Turn boundary: a hairline between the previous answer and the
                  user's next question (not before the first message). Drawn
                  with border utilities so the high-contrast theme picks it
                  up like every other hairline. */}
              {b.kind === 'user' && i > 0 && (
                <div className={cn('border-t', cli ? 'mt-2 border-ink-700' : 'mt-4 border-white/10')} />
              )}
              {cli ? <CliBlockView block={b} /> : <BlockView block={b} />}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
