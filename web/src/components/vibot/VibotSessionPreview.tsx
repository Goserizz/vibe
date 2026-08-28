import { useEffect } from 'react';
import { ArrowLeft, ExternalLink } from '../../lib/icons';
import { useStore } from '../../store/store';
import { ChatView } from '../ChatView';
import { cn } from '../../lib/format';

/**
 * Full coding-session UI embedded inside Vibot. Calls {@link useStore.openSession}
 * so Composer / permissions / todos / background tasks all work against the real
 * `activeId` (same path as the coding shell). Vibot chrome is injected via
 * ChatView's `headerStart` / `headerEnd` slots.
 */
export function VibotSessionPreview({
  sessionId,
  onBack,
  onOpenInCoding,
  onOpenSidebar,
  rightTab,
  onToggleTerminal,
  onToggleFiles,
}: {
  sessionId: string;
  onBack: () => void;
  onOpenInCoding: () => void;
  onOpenSidebar: () => void;
  rightTab?: 'terminal' | 'files' | null;
  onToggleTerminal?: () => void;
  onToggleFiles?: () => void;
}) {
  const openSession = useStore((s) => s.openSession);
  const activeId = useStore((s) => s.activeId);
  const cli = useStore((s) => s.viewMode) === 'cli';
  const ready = useStore((s) => s.activeId === sessionId && Boolean(s.sessions.find((x) => x.id === sessionId)));

  useEffect(() => {
    void openSession(sessionId);
  }, [sessionId, openSession]);

  if (!ready) {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center bg-ink-950 text-sm text-slate-600',
          cli && 'font-mono',
        )}
      >
        {activeId === sessionId ? (cli ? '// loading conversation…' : 'Loading conversation…') : cli ? '// opening session…' : 'Opening session…'}
      </div>
    );
  }

  return (
    <ChatView
      onOpenSidebar={onOpenSidebar}
      onNewSession={() => {
        /* no new-session affordance inside Vibot embed */
      }}
      rightTab={rightTab}
      onToggleTerminal={onToggleTerminal}
      onToggleFiles={onToggleFiles}
      headerStart={
        <button
          type="button"
          onClick={onBack}
          title="Back to Vibot chat"
          className={cn(
            'flex shrink-0 items-center justify-center transition',
            cli
              ? 'h-6 border border-ink-700 px-1.5 font-mono text-[10px] text-slate-300 hover:border-ink-600'
              : 'h-8 w-8 rounded-lg text-slate-400 hover:bg-ink-800 hover:text-slate-200',
          )}
        >
          {cli ? 'back' : <ArrowLeft className="h-4 w-4" />}
        </button>
      }
      headerEnd={
        <button
          type="button"
          onClick={onOpenInCoding}
          title="Open in coding mode"
          className={cn(
            'inline-flex shrink-0 items-center transition',
            cli
              ? 'h-6 gap-1 border border-ink-700 px-1.5 font-mono text-[10px] text-slate-300 hover:border-ink-600'
              : 'h-8 gap-1.5 rounded-lg border border-ink-700 px-2.5 text-[12px] text-slate-300 hover:border-ink-600 hover:bg-ink-800 hover:text-slate-100',
          )}
        >
          {cli ? (
            'coding'
          ) : (
            <>
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Open in coding</span>
            </>
          )}
        </button>
      }
    />
  );
}
