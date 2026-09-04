import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { BlockView } from './blocks';
import { CliBlockView } from './CliBlocks';
import { cn } from '../lib/format';

/** Blocks rendered at once. Paging keeps loaded history small; this bounds
 *  pathological sessions (thousands of blocks) so the DOM stays responsive. */
const RENDER_CAP = 600;

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
  const hasMore = useStore((s) => s.views[sessionId]?.hasMore ?? false);
  const loadingOlder = useStore((s) => s.views[sessionId]?.loadingOlder ?? false);
  const loadOlder = useStore((s) => s.loadOlder);
  const viewMode = useStore((s) => s.viewMode);
  const cli = viewMode === 'cli';
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Anchor across prepended history: keep the viewport parked on the same
  // content while content grows above it (scrollHeight jumps).
  const anchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  // When the loaded set exceeds RENDER_CAP only the newest slice renders
  // until the user expands it.
  const [renderAll, setRenderAll] = useState(false);
  useEffect(() => {
    setRenderAll(false);
  }, [sessionId]);

  // Track whether the user is parked at the bottom; only then do we auto-follow.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    // Near the top with older history left: pull the previous page and keep
    // the reading position stable across the prepend.
    if (el.scrollTop < 80 && hasMore && !loadingOlder) {
      anchorRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop };
      void loadOlder(sessionId);
    }
  };

  // Re-anchor on new blocks and when the floating composer stack resizes (the
  // task pane collapsing, say), since that changes the padding below the list.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor) {
      el.scrollTop = el.scrollHeight - anchor.prevScrollHeight + anchor.prevScrollTop;
      anchorRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
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

  const hidden = renderAll ? 0 : Math.max(0, blocks.length - RENDER_CAP);
  const shown = hidden > 0 ? blocks.slice(hidden) : blocks;

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
          <>
            {(hasMore || hidden > 0) && (
              <div className="flex flex-col items-center gap-2 pb-2 text-xs text-slate-500">
                {hasMore &&
                  (loadingOlder ? (
                    <span className="animate-pulse">正在加载更早的消息…</span>
                  ) : (
                    <button
                      type="button"
                      className="rounded-full border border-white/10 px-3 py-1 hover:bg-white/5"
                      onClick={() => {
                        const el = containerRef.current;
                        if (el) anchorRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop };
                        void loadOlder(sessionId);
                      }}
                    >
                      加载更早的消息
                    </button>
                  ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="rounded-full border border-white/10 px-3 py-1 hover:bg-white/5"
                    onClick={() => setRenderAll(true)}
                  >
                    渲染剩余 {hidden} 条消息（共 {blocks.length} 条）
                  </button>
                )}
              </div>
            )}
            {shown.map((b, i) => (
              <Fragment key={b.id}>
                {/* Turn boundary: a hairline between the previous answer and the
                    user's next question (not before the first message). Drawn
                    with border utilities so the high-contrast theme picks it
                    up like every other hairline. */}
                {b.kind === 'user' && (i > 0 || hidden > 0) && (
                  <div className={cn('border-t', cli ? 'mt-2 border-ink-700' : 'mt-4 border-white/10')} />
                )}
                {cli ? <CliBlockView block={b} /> : <BlockView block={b} />}
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
