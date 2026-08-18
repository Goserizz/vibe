import { useEffect, useLayoutEffect, useRef } from 'react';
import { Brain, Settings, Sparkles } from '../../lib/icons';
import type { ChatBlock } from '@shared/protocol';
import { useVibotStore } from '../../store/vibot';
import { BlockView } from '../blocks';
import { VibotComposer } from './VibotComposer';
import { Glass } from '../LiquidGlass';

/** The Vibot chat surface: header + streamed message list + composer. Rendering
 *  reuses BlockView, so Vibot's text/tool/result blocks look identical to the
 *  coding chats. */
export function VibotChat({ convId, onOpenSettings }: { convId: string | null; onOpenSettings: () => void }) {
  const blocks = useVibotStore((s) => (convId ? s.views[convId]?.blocks : undefined));
  const running = useVibotStore((s) => (convId ? s.views[convId]?.running ?? false : false));
  const hasApiKey = useVibotStore((s) => s.config?.hasApiKey ?? false);
  const title = useVibotStore((s) => s.convs.find((c) => c.id === convId)?.title ?? 'Vibot');

  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-ink-950">
      {/* Header */}
      <header className="shrink-0">
        <Glass className="app-titlebar flex items-center gap-2 border-b border-white/5 px-4 py-2.5 md:px-6" cornerRadius={0} thin>
          <Brain className={running ? 'h-4 w-4 animate-pulse-dot text-accent' : 'h-4 w-4 text-accent'} />
          <span className="truncate text-[14px] font-medium text-slate-100">{title}</span>
          {!hasApiKey && (
            <button
              onClick={onOpenSettings}
              className="ml-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 transition hover:bg-amber-500/20"
            >
              Configure Vibot
            </button>
          )}
        </Glass>
      </header>

      {/* Messages */}
      {convId ? (
        <MessageList blocks={blocks ?? []} convId={convId} />
      ) : (
        <Welcome onOpenSettings={onOpenSettings} hasApiKey={hasApiKey} />
      )}

      {/* Composer */}
      {convId && <VibotComposer convId={convId} />}
    </main>
  );
}

function MessageList({ blocks, convId }: { blocks: ChatBlock[]; convId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);
  useEffect(() => {
    stickRef.current = true;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convId]);

  return (
    <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="messages-pad mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-8 pb-6 md:px-6">
        {blocks.length === 0 ? (
          <div className="py-20 text-center text-sm text-slate-600">Send a message to start the conversation.</div>
        ) : (
          blocks.map((b) => <BlockView key={b.id} block={b} />)
        )}
      </div>
    </div>
  );
}

function Welcome({ onOpenSettings, hasApiKey }: { onOpenSettings: () => void; hasApiKey: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15">
          <Brain className="h-7 w-7 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Vibot</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
            Your Vibe assistant. It sees every coding session and all configuration across your hosts — ask it what
            you&apos;ve been working on, or have it spin up a new coding conversation to get something built.
          </p>
        </div>
        {!hasApiKey ? (
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-accent-fg transition hover:bg-accent-soft"
          >
            <Settings className="h-4 w-4" /> Configure Vibot&apos;s API
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-[12px] text-slate-600">
            <Sparkles className="h-3.5 w-3.5 text-accent-soft" /> Click <span className="font-medium text-slate-400">+</span> to start a chat
          </div>
        )}
      </div>
    </div>
  );
}
