import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import { Brain, Check, HelpCircle, Settings, Sparkles } from '../../lib/icons';
import type { ChatBlock, ToolBlock, VibotAskQuestion } from '@shared/protocol';
import { useStore } from '../../store/store';
import { useVibotStore } from '../../store/vibot';
import { BlockView } from '../blocks';
import { CliBlockView } from '../CliBlocks';
import { TaskRail } from '../TaskRail';
import { VibotComposer } from './VibotComposer';
import { useVibotAgentRows, VibotAgentsPane } from './VibotAgentsPane';
import { Glass } from '../LiquidGlass';
import { cn } from '../../lib/format';

/** The Vibot chat surface: header + streamed message list + composer, with a
 *  shared TaskRail (lg+) / composer-stack pane (mobile) for delegated agents. */
export function VibotChat({
  convId,
  onOpenSettings,
  onOpenSession,
  onSessionUnlinked,
}: {
  convId: string | null;
  onOpenSettings: () => void;
  /** Open a linked coding session as the Vibot embedded ChatView preview. */
  onOpenSession: (sessionId: string) => void;
  /** After unlinking a session from this chat (e.g. dismiss preview if it was open). */
  onSessionUnlinked?: (sessionId: string) => void;
}) {
  const blocks = useVibotStore((s) => (convId ? s.views[convId]?.blocks : undefined));
  const running = useVibotStore((s) => (convId ? s.views[convId]?.running ?? false : false));
  const hasApiKey = useVibotStore((s) => s.config?.hasApiKey ?? false);
  const title = useVibotStore((s) => s.convs.find((c) => c.id === convId)?.title ?? 'Vibot');
  const cli = useStore((s) => s.viewMode) === 'cli';

  return (
    <main
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-ink-950',
        cli && 'cli-surface',
      )}
    >
      <header className="shrink-0">
        <Glass className="app-titlebar flex items-center gap-2 border-b border-white/5 px-4 py-2.5 md:px-6" cornerRadius={0} thin>
          <Brain className={running ? 'h-4 w-4 animate-pulse-dot text-accent' : 'h-4 w-4 text-accent'} />
          <span className="truncate text-[14px] font-medium text-slate-100">{title}</span>
          {!hasApiKey && (
            <button
              onClick={onOpenSettings}
              className={cn(
                'ml-2 border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300 transition hover:bg-amber-500/20',
                cli ? 'font-mono text-[11px]' : 'rounded-md text-[11px]',
              )}
            >
              {cli ? 'config' : 'Configure Vibot'}
            </button>
          )}
        </Glass>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-w-0 flex-1 flex-col">
          {convId ? (
            <MessageList blocks={blocks ?? []} convId={convId} />
          ) : (
            <Welcome onOpenSettings={onOpenSettings} hasApiKey={hasApiKey} />
          )}

          {/* Narrow screens: agents sit above the composer (same as coding tasks).
              CLI: top hairline lives on this stack — mirrors ChatView's overlay. */}
          {convId && (
            <div className={cn(cli && 'border-t border-ink-700 bg-ink-950')}>
              <div className="lg:hidden">
                <VibotAgentsPane
                  convId={convId}
                  onOpenSession={onOpenSession}
                  onSessionUnlinked={onSessionUnlinked}
                  layout="composer"
                />
              </div>
              <VibotComposer convId={convId} />
            </div>
          )}
        </section>

        {convId && (
          <VibotTaskRail convId={convId} onOpenSession={onOpenSession} onSessionUnlinked={onSessionUnlinked} />
        )}
      </div>
    </main>
  );
}

/** Same TaskRail shell as coding; only mounts when this chat has linked agents. */
function VibotTaskRail({
  convId,
  onOpenSession,
  onSessionUnlinked,
}: {
  convId: string;
  onOpenSession: (sessionId: string) => void;
  onSessionUnlinked?: (sessionId: string) => void;
}) {
  const { rows } = useVibotAgentRows(convId);
  if (!rows.length) return null;
  return (
    <TaskRail aria-label="Background agents" clearFloatingHeader={false}>
      <VibotAgentsPane
        convId={convId}
        onOpenSession={onOpenSession}
        onSessionUnlinked={onSessionUnlinked}
        layout="rail"
      />
    </TaskRail>
  );
}

function MessageList({ blocks, convId }: { blocks: ChatBlock[]; convId: string }) {
  const viewMode = useStore((s) => s.viewMode);
  const cli = viewMode === 'cli';
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
  }, [blocks, viewMode]);
  useEffect(() => {
    stickRef.current = true;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convId]);

  return (
    <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          'messages-pad mx-auto flex flex-col px-4 pt-8 pb-6 md:px-6',
          cli ? 'max-w-4xl gap-2' : 'max-w-3xl gap-4',
        )}
      >
        {blocks.length === 0 ? (
          <div className={cn('py-20 text-sm text-slate-600', cli ? 'font-mono text-left' : 'text-center')}>
            {cli ? '// send a message to start the conversation' : 'Send a message to start the conversation.'}
          </div>
        ) : (
          blocks.map((b, i) => (
            <Fragment key={b.id}>
              {b.kind === 'user' && i > 0 && (
                <div className={cn('border-t', cli ? 'mt-2 border-ink-700' : 'mt-4 border-white/10')} />
              )}
              {isAskUserQuestionBlock(b) ? (
                <AskUserQuestionCard block={b} />
              ) : cli ? (
                <CliBlockView block={b} />
              ) : (
                <BlockView block={b} />
              )}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}

function Welcome({ onOpenSettings, hasApiKey }: { onOpenSettings: () => void; hasApiKey: boolean }) {
  const cli = useStore((s) => s.viewMode) === 'cli';
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className={cn('flex max-w-md flex-col items-center gap-4', cli ? 'text-left font-mono' : 'text-center')}>
        <div className={cn('flex items-center justify-center bg-accent/15', cli ? 'h-10 w-10' : 'h-14 w-14 rounded-2xl')}>
          <Brain className={cn('text-accent', cli ? 'h-5 w-5' : 'h-7 w-7')} />
        </div>
        <div>
          <h1 className={cn('font-semibold text-slate-100', cli ? 'text-[15px]' : 'text-lg')}>Vibot</h1>
          <p className={cn('mt-1.5 leading-relaxed text-slate-500', cli ? 'text-[12.5px]' : 'text-[13px]')}>
            Your Vibe assistant. It sees every coding session and all configuration across your hosts — ask it what
            you&apos;ve been working on, or have it spin up a new coding conversation to get something built.
          </p>
        </div>
        {!hasApiKey ? (
          <button
            onClick={onOpenSettings}
            className={cn(
              'flex items-center gap-2 bg-accent px-4 py-2 font-semibold text-accent-fg transition hover:bg-accent-soft',
              cli ? 'font-mono text-[12px]' : 'rounded-lg text-[13px]',
            )}
          >
            <Settings className="h-4 w-4" /> {cli ? 'config api' : "Configure Vibot's API"}
          </button>
        ) : (
          <div className={cn('flex items-center gap-1.5 text-slate-600', cli ? 'text-[12px]' : 'text-[12px]')}>
            <Sparkles className="h-3.5 w-3.5 text-accent-soft" /> Click <span className="font-medium text-slate-400">+</span> to start a chat
          </div>
        )}
      </div>
    </div>
  );
}

function isAskUserQuestionBlock(b: ChatBlock): b is ToolBlock {
  return (
    b.kind === 'tool' &&
    (b.name === 'AskUserQuestion' || b.name === 'ask_user_question')
  );
}

/** Transcript card for ask_user_question — questions + chosen answers highlighted. */
function AskUserQuestionCard({ block }: { block: ToolBlock }) {
  const input = (block.input ?? {}) as { questions?: VibotAskQuestion[] };
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers = parseAskAnswers(block.result);
  const running = block.status === 'running';

  return (
    <div className="animate-fade-in rounded-xl border border-accent/20 bg-accent/5 px-3.5 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <HelpCircle className="h-3.5 w-3.5 text-accent" />
        <span className="text-[12px] font-medium text-slate-300">Ask user</span>
        {running && <span className="text-[11px] text-slate-500">waiting…</span>}
      </div>
      {questions.length === 0 && !answers && block.result ? (
        <p className="text-[13px] text-slate-400">{block.result}</p>
      ) : (
        <div className="space-y-3">
          {questions.map((q, i) => {
            const chosen = answers?.[q.question];
            const chosenSet = new Set(
              chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen],
            );
            return (
              <div key={i}>
                <div className="flex flex-wrap items-center gap-2">
                  {q.header && (
                    <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
                      {q.header}
                    </span>
                  )}
                  <span className="text-[13px] text-slate-200">{q.question}</span>
                </div>
                <div className="mt-1.5 space-y-1">
                  {q.options.map((opt) => {
                    const sel = chosenSet.has(opt.label);
                    return (
                      <div
                        key={opt.label}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-2.5 py-1.5',
                          sel ? 'border-accent/50 bg-accent/10' : 'border-transparent text-slate-500',
                        )}
                      >
                        {sel && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
                        <span className="min-w-0">
                          <span className={cn('block text-[12.5px]', sel ? 'font-medium text-slate-200' : 'text-slate-500')}>
                            {opt.label}
                          </span>
                          {opt.description && sel && (
                            <span className="mt-0.5 block text-[11.5px] text-slate-500">{opt.description}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                  {/* Free-text / Other answers that aren't in the option list */}
                  {[...chosenSet]
                    .filter((label) => !q.options.some((o) => o.label === label))
                    .map((label) => (
                      <div
                        key={label}
                        className="flex items-start gap-2 rounded-lg border border-accent/50 bg-accent/10 px-2.5 py-1.5"
                      >
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                        <span className="text-[12.5px] font-medium text-slate-200">{label}</span>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
          {!answers && block.result && !running && (
            <p className="text-[12.5px] text-slate-500">{block.result}</p>
          )}
        </div>
      )}
    </div>
  );
}

function parseAskAnswers(result: string | undefined): Record<string, string | string[]> | null {
  if (!result) return null;
  try {
    const j = JSON.parse(result) as { answers?: Record<string, string | string[]> };
    if (j && typeof j === 'object' && j.answers && typeof j.answers === 'object') return j.answers;
  } catch {
    /* plain-text timeout / dismiss messages */
  }
  return null;
}

