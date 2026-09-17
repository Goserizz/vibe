import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AgentQuestion } from '@shared/protocol';
import { HelpCircle, Loader2, X } from '../lib/icons';
import { cn } from '../lib/format';
import { useStore } from '../store/store';

/** Live/persisted Vibe question records only. Never scan old assistant prose or
 * native rollouts to resurrect a question that wasn't registered by Vibe. */
export function AgentQuestions({ sessionId }: { sessionId: string }) {
  const state = useStore(s => s.agentQuestions[sessionId]);
  const permissionOpen = useStore(s => Boolean(s.pending[sessionId]?.length));
  const refresh = useStore(s => s.refreshAgentQuestions);
  const cli = useStore(s => s.viewMode) === 'cli';
  const [later, setLater] = useState<Set<string>>(new Set());
  const items = state?.items ?? [];
  const ids = items.map(item => item.id).join(',');
  useEffect(() => {
    const current = new Set(ids.split(','));
    setLater(previous => [...previous].every(id => current.has(id)) ? previous : new Set([...previous].filter(id => current.has(id))));
  }, [ids]);
  if (!items.length && !state?.error) return null;
  const showing = items.find(item => !later.has(item.id));
  const defer = (id: string) => setLater(previous => new Set([...previous, id]));
  const reopen = () => setLater(previous => { const next = new Set(previous); if (items[0]) next.delete(items[0].id); return next; });

  return (
    <>
      <section aria-label="Agent questions" className={cn('mx-auto mb-2 flex w-full flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-ink-900 px-3 py-2 text-[12px]', cli ? 'max-w-4xl font-mono' : 'max-w-3xl')}>
        <HelpCircle className="h-4 w-4 shrink-0 text-accent-soft" />
        {state?.error
          ? <span role="status" className="flex-1 text-amber-600 dark:text-amber-300">{state.error}</span>
          : <span className="flex-1 text-slate-300">Codex questions · {items.length} pending</span>}
        {state?.error && <button type="button" onClick={() => refresh(sessionId)} className="text-accent-soft hover:underline">Retry</button>}
        {items.length > 0 && <button type="button" onClick={reopen} className="text-accent-soft hover:underline">Answer questions</button>}
      </section>
      {showing && !permissionOpen && createPortal(
        <AnswerDialog key={showing.id} sessionId={sessionId} question={showing} onLater={() => defer(showing.id)} />,
        document.body,
      )}
    </>
  );
}

function AnswerDialog({ sessionId, question, onLater }: { sessionId: string; question: AgentQuestion; onLater: () => void }) {
  const connected = useStore(s => s.status === 'open');
  const action = useStore(s => s.questionActions[sessionId]?.[question.id]);
  const answer = useStore(s => s.answerAgentQuestion);
  const dismiss = useStore(s => s.dismissAgentQuestion);
  const cli = useStore(s => s.viewMode) === 'cli';
  const [answers, setAnswers] = useState(() => question.questions.map((item, i) => question.answers?.[i] ?? item.options?.[0] ?? ''));
  const [custom, setCustom] = useState(() => question.questions.map((item, i) => !item.options?.includes(question.answers?.[i] ?? item.options?.[0] ?? '')));
  const [confirmRetry, setConfirmRetry] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const busy = question.status === 'sending' || Boolean(action?.sending);
  const locked = busy || !connected;
  const uncertain = question.status === 'uncertain';
  const error = action?.error || question.error;
  const canSend = !locked && answers.every(value => value.trim().length > 0) && (!uncertain || confirmRetry);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('textarea:not(:disabled), input:not(:disabled), button:not(:disabled)')?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  const setAnswer = (index: number, value: string) => setAnswers(previous => previous.map((entry, i) => i === index ? value : entry));
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLater(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])];
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return (
    <div className="fixed inset-x-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      style={{ top: 'var(--shell-top, 0px)', height: 'var(--shell-height, 100dvh)' }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="agent-question-title" onKeyDown={keyDown}
        className={cn('flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-950 text-slate-200 shadow-xl', cli && 'font-mono')}>
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-4 py-3">
          <HelpCircle className="h-4 w-4 text-accent-soft" />
          <h2 id="agent-question-title" className="flex-1 text-sm font-medium">Codex has a question</h2>
          <button type="button" onClick={onLater} aria-label="Answer later" className="rounded p-1 hover:bg-ink-800"><X className="h-4 w-4" /></button>
        </div>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => {
          event.preventDefault();
          if (canSend) answer(sessionId, question.id, answers, uncertain);
        }}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
            <p className="text-[11px] text-slate-500">Codex may keep working while you answer. Replies are saved to this conversation.</p>
            {!connected && <p role="status" className="text-sm text-amber-600 dark:text-amber-300">Disconnected. Reconnect before sending; your draft stays here.</p>}
            {error && <p role="alert" className="text-sm text-amber-600 dark:text-amber-300">{error}</p>}
            {question.questions.map((item, index) => (
              <fieldset key={index} disabled={locked} className="space-y-2">
                <legend className="mb-2 whitespace-pre-wrap text-[13px] font-medium">{item.title}</legend>
                {item.options?.map((option, j) => <label key={option} className={cn('flex cursor-pointer items-start gap-2 rounded border px-3 py-2 text-[13px]',
                  !custom[index] && answers[index] === option ? 'border-accent/50 bg-accent/10' : 'border-ink-700 hover:bg-ink-900')}>
                  <input type="radio" name={`question-${question.id}-${index}`} checked={!custom[index] && answers[index] === option}
                    onChange={() => { setCustom(previous => previous.map((value, i) => i === index ? false : value)); setAnswer(index, option); }}
                    className="mt-0.5 shrink-0" value={String(j)} />
                  <span className="min-w-0 whitespace-pre-wrap break-words">{option}</span>
                </label>)}
                {item.options?.length && <label className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-400">
                  <input type="radio" name={`question-${question.id}-${index}`} checked={custom[index]} onChange={() => {
                    setCustom(previous => previous.map((value, i) => i === index ? true : value)); setAnswer(index, '');
                  }} />Other answer
                </label>}
                {custom[index] && <textarea aria-label={item.title} rows={3} maxLength={65_536} value={answers[index]}
                  onChange={event => setAnswer(index, event.target.value)} placeholder="Enter your answer"
                  className="w-full resize-y rounded border border-ink-600 bg-ink-900 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-accent/60 disabled:opacity-60" />}
              </fieldset>
            ))}
            {uncertain && <label className="flex items-start gap-2 text-[12px] text-amber-600 dark:text-amber-300">
              <input type="checkbox" checked={confirmRetry} disabled={locked} onChange={event => setConfirmRetry(event.target.checked)} />
              I checked the conversation and want to retry. This may send the answer again.
            </label>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ink-700 px-4 py-3 text-[12px]">
            <button type="button" disabled={locked} onClick={() => dismiss(sessionId, question.id)} className="mr-auto rounded px-2 py-1.5 text-slate-400 hover:bg-ink-800 disabled:opacity-40">Dismiss question</button>
            <button type="button" onClick={onLater} className="rounded border border-ink-600 px-3 py-1.5 hover:bg-ink-800">Later</button>
            <button type="submit" disabled={!canSend} className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-ink-700 px-3 py-1.5 text-slate-100 hover:bg-ink-600 disabled:opacity-40">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? 'Sending…' : uncertain ? 'Retry answers' : 'Send answers'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
