import { useState } from 'react';
import { HelpCircle, Check, Ban, Circle, CheckCircle2, Square, CheckSquare } from '../../lib/icons';
import type { VibotAskQuestion, VibotAskRequest } from '@shared/protocol';
import { useVibotStore } from '../../store/vibot';
import { cn } from '../../lib/format';
import { Glass } from '../LiquidGlass';

/**
 * Interactive ask-user modal for Vibot (mirrors QuestionPrompt in
 * PermissionPrompt.tsx). Shows one pending request at a time for the active
 * conversation; the rest stay queued in the store.
 */
export function VibotQuestionPrompt({ convId }: { convId: string }) {
  const pending = useVibotStore((s) => s.asks[convId]);
  const answerAsk = useVibotStore((s) => s.answerAsk);
  if (!pending || pending.length === 0) return null;

  const req = pending[0];
  return (
    <AskDialog
      key={req.callId}
      req={req}
      onSubmit={(answers) => answerAsk(convId, req.callId, answers)}
      onCancel={() => answerAsk(convId, req.callId, {})}
    />
  );
}

function AskDialog({
  req,
  onSubmit,
  onCancel,
}: {
  req: VibotAskRequest;
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}) {
  const questions = Array.isArray(req.questions) ? req.questions : [];

  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [otherActive, setOtherActive] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  const answerFor = (i: number, multi: boolean): string | string[] | null => {
    const labels = [...(selected[i] ?? [])];
    if (otherActive[i] && (otherText[i] ?? '').trim()) labels.push((otherText[i] ?? '').trim());
    if (!labels.length) return null;
    return multi ? labels : labels[0];
  };
  const answered = (i: number) => answerFor(i, !!questions[i]?.multiSelect) !== null;
  const canSubmit = questions.length > 0 && questions.every((_, i) => answered(i));

  const toggleOption = (i: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = new Set(prev[i] ?? []);
      if (multi) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [i]: cur };
    });
    if (!multi) setOtherActive((p) => (p[i] ? { ...p, [i]: false } : p));
  };

  const toggleOther = (i: number, multi: boolean) => {
    setOtherActive((prev) => {
      const next = !prev[i];
      if (next && !multi) setSelected((s) => ({ ...s, [i]: new Set() }));
      return { ...prev, [i]: next };
    });
  };

  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q: VibotAskQuestion, i: number) => {
      const a = answerFor(i, !!q.multiSelect);
      if (a !== null) answers[q.question] = a;
    });
    onSubmit(answers);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vibot-question-prompt-title"
    >
      <Glass className="w-full max-w-3xl rounded-2xl border border-accent/20" cornerRadius={16}>
        <div className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <div className="flex items-center gap-2.5 border-b border-white/5 bg-accent/5 px-4 py-2.5">
            <HelpCircle className="h-4 w-4 text-accent" />
            <span id="vibot-question-prompt-title" className="text-[13px] font-medium text-slate-200">
              Vibot has a question
            </span>
          </div>
          <div className="space-y-4 overflow-y-auto overscroll-contain px-4 py-3.5">
            {questions.map((q, i) => {
              const multi = !!q.multiSelect;
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
                  <div className="mt-2 space-y-1.5">
                    {q.options.map((opt) => {
                      const sel = selected[i]?.has(opt.label);
                      return (
                        <button
                          key={opt.label}
                          onClick={() => toggleOption(i, opt.label, multi)}
                          className={cn(
                            'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition',
                            sel ? 'border-accent/50 bg-accent/10' : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800/50',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center',
                              sel ? 'text-accent' : 'text-slate-600',
                            )}
                          >
                            {multi
                              ? sel ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />
                              : sel ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-slate-200">{opt.label}</span>
                            {opt.description && (
                              <span className="mt-0.5 block text-[12px] text-slate-500">{opt.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                    <div
                      className={cn(
                        'flex items-start gap-2.5 rounded-lg border px-3 py-2 transition',
                        otherActive[i] ? 'border-accent/50 bg-accent/10' : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800/50',
                      )}
                    >
                      <button
                        onClick={() => toggleOther(i, multi)}
                        aria-label="Other"
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center',
                          otherActive[i] ? 'text-accent' : 'text-slate-600',
                        )}
                      >
                        {multi
                          ? otherActive[i] ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />
                          : otherActive[i] ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <button onClick={() => toggleOther(i, multi)} className="block text-[13px] font-medium text-slate-200">
                          Other
                        </button>
                        {otherActive[i] && (
                          <input
                            autoFocus
                            value={otherText[i] ?? ''}
                            onChange={(e) => setOtherText((p) => ({ ...p, [i]: e.target.value }))}
                            placeholder="Type your answer…"
                            className="mt-1.5 w-full rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1.5 text-[13px] text-slate-200 outline-none focus:border-accent/50"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-white/5 px-4 py-3">
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              Submit
            </button>
            <button
              onClick={onCancel}
              className="ml-auto flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] text-slate-400 transition hover:text-rose-400"
            >
              <Ban className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
        </div>
      </Glass>
    </div>
  );
}
