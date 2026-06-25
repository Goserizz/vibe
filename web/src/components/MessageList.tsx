import { useEffect, useLayoutEffect, useRef } from 'react';
import { useStore } from '../store/store';
import { BlockView } from './blocks';

export function MessageList({ sessionId }: { sessionId: string }) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Track whether the user is parked at the bottom; only then do we auto-follow.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

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
      <div className="messages-pad mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-20 md:px-6">
        {blocks.length === 0 ? (
          <div className="py-20 text-center text-sm text-slate-600">
            Send a message to start the conversation.
          </div>
        ) : (
          blocks.map((b) => <BlockView key={b.id} block={b} />)
        )}
      </div>
    </div>
  );
}
