import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from '../../lib/icons';
import { useVibotStore } from '../../store/vibot';
import { cn } from '../../lib/format';
import { Glass } from '../LiquidGlass';

/** A trimmed composer for Vibot: plain text only (no attachments, agent, or
 *  effort controls — Vibot doesn't code, it orchestrates). */
export function VibotComposer({ convId }: { convId: string }) {
  const running = useVibotStore((s) => s.views[convId]?.running ?? false);
  const sendMessage = useVibotStore((s) => s.sendMessage);
  const abort = useVibotStore((s) => s.abort);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // CJK IME (e.g. pinyin) handling — see Composer.tsx for the full rationale.
  // KeyboardEvent.isComposing is unreliable on macOS: the Enter that confirms a
  // candidate fires *after* compositionend with isComposing === false (by then
  // our composing flag is already clear too), so that Enter would wrongly send.
  // We also ignore Enter for a short window after a composition ends — that rogue
  // Enter always lands within milliseconds, whereas a real send comes much later.
  const composingRef = useRef(false);
  const endedAtRef = useRef(0);

  // Auto-grow the textarea up to a cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const v = text.trim();
    if (!v || running) return;
    sendMessage(v);
    setText('');
  };

  return (
    <div className="shrink-0 px-4 pb-6 pt-1 md:px-6">
      <div className="mx-auto max-w-3xl">
        <Glass
          className={cn(
            'relative',
            // While a turn is running the border already glows/breathes, so skip
            // the focus ring to avoid stacking two accent outlines on top of each other.
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
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                // Ignore the Enter that confirms an IME candidate (see composingRef comment).
                const justEnded = endedAtRef.current > 0 && Date.now() - endedAtRef.current < 10;
                if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229 || justEnded) return;
                e.preventDefault();
                submit();
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                endedAtRef.current = Date.now();
              }}
              placeholder={running ? 'Vibot is working…' : 'Ask Vibot — it sees all your sessions and config'}
              className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
            />
            {running ? (
              <button
                onClick={abort}
                title="Stop current response"
                aria-label="Stop current response"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/90 text-[#fff] transition hover:bg-rose-500"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!text.trim()}
                title="Send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </Glass>
      </div>
    </div>
  );
}
