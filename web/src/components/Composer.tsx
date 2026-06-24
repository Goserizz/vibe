import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useStore } from '../store/store';
import { agentLabel, cn } from '../lib/format';

export function Composer({ sessionId }: { sessionId: string }) {
  const running = useStore((s) => s.views[sessionId]?.running ?? false);
  const agentName = useStore((s) => agentLabel(s.sessions.find((session) => session.id === sessionId)?.agent ?? 'claude'));
  const sendMessage = useStore((s) => s.sendMessage);
  const abort = useStore((s) => s.abort);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to a sensible cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Refocus when switching sessions.
  useEffect(() => {
    ref.current?.focus();
  }, [sessionId]);

  const submit = () => {
    if (running) return;
    const value = text.trim();
    if (!value) return;
    sendMessage(value);
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 px-4 pb-0 pt-1 md:px-6 md:pb-4">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'glass flex items-end gap-2 rounded-2xl px-3 py-2.5 transition',
            'focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/15',
          )}
        >
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={running ? `${agentName} is working…` : `Message ${agentName} — Enter to send, Shift+Enter for newline`}
            className="max-h-[220px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          {running ? (
            <button
              onClick={abort}
              title="Stop"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/90 text-[#fff] transition hover:bg-rose-500"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim()}
              title="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-ink-950 transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
