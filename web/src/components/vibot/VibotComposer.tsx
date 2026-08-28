import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from '../../lib/icons';
import { useStore } from '../../store/store';
import { useVibotStore } from '../../store/vibot';
import { cn } from '../../lib/format';
import { Glass } from '../LiquidGlass';
import { CliPromptTextarea } from '../CliPromptTextarea';

/** A trimmed composer for Vibot: plain text only (no attachments, agent, or
 *  effort controls — Vibot doesn't code, it orchestrates). */
export function VibotComposer({ convId }: { convId: string }) {
  const running = useVibotStore((s) => s.views[convId]?.running ?? false);
  const sendMessage = useVibotStore((s) => s.sendMessage);
  const abort = useVibotStore((s) => s.abort);
  const cli = useStore((s) => s.viewMode) === 'cli';
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // CJK IME (e.g. pinyin) handling — see Composer.tsx for the full rationale.
  const composingRef = useRef(false);
  const endedAtRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cli ? 220 : 200)}px`;
  }, [text, cli]);

  useEffect(() => {
    ref.current?.focus();
  }, [convId, cli]);

  const submit = () => {
    const v = text.trim();
    if (!v || running) return;
    sendMessage(v);
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const justEnded = endedAtRef.current > 0 && Date.now() - endedAtRef.current < 10;
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229 || justEnded) return;
    e.preventDefault();
    submit();
  };

  const compositionHandlers = {
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      endedAtRef.current = Date.now();
    },
  };

  const actionButton = running ? (
    <button
      onClick={abort}
      title="Stop current response"
      aria-label="Stop current response"
      className={cn(
        'flex shrink-0 items-center justify-center text-[#fff] transition hover:bg-rose-500',
        cli ? 'h-8 bg-rose-500/90 px-2 font-mono text-[11px]' : 'h-9 w-9 rounded-xl bg-rose-500/90',
      )}
    >
      {cli ? 'stop' : <Square className="h-4 w-4 fill-current" />}
    </button>
  ) : (
    <button
      onClick={submit}
      disabled={!text.trim()}
      title="Send"
      className={cn(
        'flex shrink-0 items-center justify-center text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500',
        cli ? 'h-8 bg-accent px-2 font-mono text-[11px]' : 'h-9 w-9 rounded-xl bg-accent',
      )}
    >
      {cli ? 'send' : <ArrowUp className="h-4 w-4" />}
    </button>
  );

  if (cli) {
    // Shell chrome (❯ + CliPromptTextarea) matches coding Composer; top hairline
    // is on the parent stack in VibotChat (same role as ChatView's cli overlay).
    return (
      <div className="shrink-0 bg-ink-950 px-4 pb-5 pt-2 md:px-6">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-end gap-2">
            <span className="select-none pb-2 font-mono text-[14px] text-accent">❯</span>
            <CliPromptTextarea
              textareaRef={ref}
              value={text}
              onChange={setText}
              onKeyDown={onKeyDown}
              placeholder={running ? 'vibot working…' : 'vibot › enter to send'}
              {...compositionHandlers}
            />
            {actionButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pb-6 pt-1 md:px-6">
      <div className="mx-auto max-w-3xl">
        <Glass
          className={cn(
            'relative',
            !running && 'focus-within:ring-2 focus-within:ring-accent/15',
            running && 'composer-running',
          )}
          cornerRadius={16}
          thin
        >
          <div className="flex items-end gap-2 px-3 py-2.5">
            <textarea
              ref={ref}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              {...compositionHandlers}
              placeholder={running ? 'Vibot is working…' : 'Ask Vibot — it sees all your sessions and config'}
              className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
            />
            {actionButton}
          </div>
        </Glass>
      </div>
    </div>
  );
}
