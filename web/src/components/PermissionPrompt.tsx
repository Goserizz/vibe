import { useState } from 'react';
import { ShieldQuestion, Check, CheckCheck, Ban, HelpCircle, Circle, CheckCircle2, Square, CheckSquare } from 'lucide-react';
import type { PermissionDecision, PermissionRequest } from '@shared/protocol';
import { useStore } from '../store/store';
import { toolMeta } from './blocks';
import { cn } from '../lib/format';

export function PermissionPrompt({ sessionId }: { sessionId: string }) {
  const pending = useStore((s) => s.pending[sessionId]);
  const respond = useStore((s) => s.respondPermission);
  if (!pending || pending.length === 0) return null;

  // One at a time keeps the surface calm; the rest queue behind it.
  const req = pending[0];
  // AskUserQuestion is a canUseTool tool whose "answer" is the user's selections,
  // so it needs a dedicated picker instead of the generic allow/deny card.
  if (req.toolName === 'AskUserQuestion') return <QuestionPrompt req={req} respond={respond} />;

  const meta = toolMeta(req.toolName, req.input);
  const Icon = meta.icon;

  return (
    <div className="px-4 pb-2 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="glass overflow-hidden rounded-2xl border-amber-400/20 animate-fade-in">
          <div className="flex items-center gap-2.5 border-b border-white/5 bg-amber-400/5 px-4 py-2.5">
            <ShieldQuestion className="h-4 w-4 text-amber-400" />
            <span className="text-[13px] font-medium text-slate-200">Permission required</span>
            {pending.length > 1 && (
              <span className="ml-auto text-[11px] text-slate-500">+{pending.length - 1} more</span>
            )}
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-[13px]">
              <Icon className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="font-medium text-slate-200">{meta.label}</span>
            </div>
            {meta.detail && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[#0b0e14] p-2.5 font-mono text-[12px] text-slate-400">
                {meta.detail}
              </pre>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => respond(req.requestId, { allow: true })}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-ink-950 transition hover:bg-accent-soft"
              >
                <Check className="h-3.5 w-3.5" />
                Allow
              </button>
              <button
                onClick={() => respond(req.requestId, { allow: true, remember: true })}
                className="flex items-center gap-1.5 rounded-lg border border-ink-600 px-3.5 py-2 text-[13px] text-slate-300 transition hover:border-accent/40 hover:text-accent-soft"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Always allow {req.toolName}
              </button>
              <button
                onClick={() => respond(req.requestId, { allow: false })}
                className="ml-auto flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] text-slate-400 transition hover:text-rose-400"
              >
                <Ban className="h-3.5 w-3.5" />
                Deny
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}
interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/**
 * Picker for the AskUserQuestion tool. The tool's input is the model's questions;
 * the user's selections are returned as `updatedInput = { questions, answers }`.
 */
function QuestionPrompt({ req, respond }: { req: PermissionRequest; respond: (id: string, decision: PermissionDecision) => void }) {
  const input = (req.input ?? {}) as { questions?: AskQuestion[] };
  const questions = Array.isArray(input.questions) ? input.questions : [];

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
    // Single-select: picking an option drops any "Other" free text.
    if (!multi) setOtherActive((p) => (p[i] ? { ...p, [i]: false } : p));
  };

  const toggleOther = (i: number, multi: boolean) => {
    setOtherActive((prev) => {
      const next = !prev[i];
      // Single-select: "Other" is mutually exclusive with the options.
      if (next && !multi) setSelected((s) => ({ ...s, [i]: new Set() }));
      return { ...prev, [i]: next };
    });
  };

  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, i) => {
      const a = answerFor(i, !!q.multiSelect);
      if (a !== null) answers[q.question] = a;
    });
    respond(req.requestId, { allow: true, updatedInput: { questions, answers } });
  };

  return (
    <div className="px-4 pb-2 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="glass overflow-hidden rounded-2xl border-accent/20 animate-fade-in">
          <div className="flex items-center gap-2.5 border-b border-white/5 bg-accent/5 px-4 py-2.5">
            <HelpCircle className="h-4 w-4 text-accent" />
            <span className="text-[13px] font-medium text-slate-200">Claude has a question</span>
          </div>
          <div className="space-y-4 px-4 py-3.5">
            {questions.map((q, i) => {
              const multi = !!q.multiSelect;
              return (
                <div key={i}>
                  <div className="flex flex-wrap items-center gap-2">
                    {q.header && (
                      <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">{q.header}</span>
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
                          <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center', sel ? 'text-accent' : 'text-slate-600')}>
                            {multi
                              ? sel ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />
                              : sel ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-slate-200">{opt.label}</span>
                            {opt.description && <span className="mt-0.5 block text-[12px] text-slate-500">{opt.description}</span>}
                          </span>
                        </button>
                      );
                    })}
                    {/* "Other" free-text choice — the schema says the host provides this. */}
                    <div
                      className={cn(
                        'flex items-start gap-2.5 rounded-lg border px-3 py-2 transition',
                        otherActive[i] ? 'border-accent/50 bg-accent/10' : 'border-ink-700 hover:border-ink-600 hover:bg-ink-800/50',
                      )}
                    >
                      <button
                        onClick={() => toggleOther(i, multi)}
                        aria-label="Other"
                        className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center', otherActive[i] ? 'text-accent' : 'text-slate-600')}
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
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-ink-950 transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              Submit
            </button>
            <button
              onClick={() => respond(req.requestId, { allow: false })}
              className="ml-auto flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] text-slate-400 transition hover:text-rose-400"
            >
              <Ban className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
