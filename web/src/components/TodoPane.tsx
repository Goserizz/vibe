import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Circle, ListTodo, Loader2 } from 'lucide-react';
import type { ChatBlock, Todo, TodoStatus } from '@shared/protocol';
import { useStore } from '../store/store';
import { toolKind } from './blocks';
import { cn } from '../lib/format';

function pickString(obj: Record<string, any>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Tolerant parse of one todo item — accepts the field-name variants different
 *  engines emit (content/text/title, status/state, activeForm/active_form). */
function parseTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, any>;
  const content = pickString(obj, ['content', 'text', 'title', 'subject', 'description', 'task']);
  if (content == null) return null;
  const rawStatus = String(obj.status ?? obj.state ?? '')
    .toLowerCase()
    .replace(/[_\-\s]/g, '');
  let status: TodoStatus = 'pending';
  if (rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'complete') status = 'completed';
  else if (rawStatus === 'inprogress' || rawStatus === 'active' || rawStatus === 'running') status = 'in_progress';
  const activeForm = pickString(obj, ['activeForm', 'active_form', 'activeform']);
  return { content, status, activeForm };
}

/** The agent's current todo list, derived from the conversation. `TodoWrite`
 *  (and variants) carries the FULL list on every call, so the most recent
 *  todo-kind tool block is the source of truth. Returns null when the agent has
 *  never set a list (or cleared it), so callers can render nothing. */
export function latestTodos(blocks: ChatBlock[] | undefined): Todo[] | null {
  if (!blocks) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'tool' && toolKind(b.name) === 'todo') {
      const arr = (b.input as any)?.todos;
      if (!Array.isArray(arr)) return null;
      const todos = arr.map(parseTodo).filter((t): t is Todo => t !== null);
      return todos.length ? todos : null;
    }
  }
  return null;
}

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'in_progress') return <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-accent" />;
  if (status === 'completed') return <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-400/80" />;
  return <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-slate-600" />;
}

/** Persistent task list shown above the composer. Reflects the latest TodoWrite
 *  snapshot for the session and stays in view across turns. Renders nothing when
 *  the agent has no active list. */
export function TodoPane({ sessionId }: { sessionId: string }) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const todos = useMemo(() => latestTodos(blocks), [blocks]);
  const [open, setOpen] = useState(true);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  const pct = Math.round((done / todos.length) * 100);

  return (
    <div className="mx-auto mb-2 max-w-3xl px-4 md:px-6">
      <div className="animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/80 backdrop-blur-sm">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-ink-800/40"
        >
          <ListTodo className="h-4 w-4 shrink-0 text-accent-soft" />
          <span className="text-[12.5px] font-medium text-slate-200">Tasks</span>
          <span className="rounded-full bg-white/5 px-1.5 py-px text-[10px] font-medium text-slate-400">
            {done}/{todos.length}
          </span>
          <ChevronRight className={cn('ml-auto h-3.5 w-3.5 text-slate-600 transition-transform', open && 'rotate-90')} />
        </button>
        {/* Progress bar — always visible so a collapsed pane still shows progress. */}
        <div className="h-1 w-full bg-white/5">
          <div className="h-1 bg-accent/70 transition-all" style={{ width: `${pct}%` }} />
        </div>
        {open && (
          <ul className="max-h-48 overflow-y-auto px-1.5 py-1.5">
            {todos.map((t, idx) => {
              const label = t.status === 'in_progress' ? t.activeForm || t.content : t.content;
              return (
                <li key={idx} className="flex items-start gap-2 rounded-lg px-1.5 py-1">
                  <StatusIcon status={t.status} />
                  <span
                    className={cn(
                      'text-[12.5px] leading-relaxed',
                      t.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-300',
                    )}
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
