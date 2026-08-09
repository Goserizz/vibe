import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Circle, ListTodo, Loader2 } from 'lucide-react';
import type { ChatBlock, Todo, TodoStatus, ToolBlock } from '@shared/protocol';
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

/** A todo plus the id engines use to address it in follow-up calls (Kiro's
 *  `completed_task_ids` / `remove_task_ids`). */
interface TodoEntry extends Todo {
  id: string;
}

const CONTENT_KEYS = ['content', 'text', 'title', 'subject', 'description', 'task', 'task_description', 'taskDescription'];

/** Tolerant parse of one todo item — accepts the field-name variants different
 *  engines emit (content/text/title/task_description, status/state/completed,
 *  activeForm/active_form). `index` supplies the 1-based id Kiro assigns when the
 *  item itself carries none. */
function parseTodo(raw: unknown, index: number): TodoEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, any>;
  const content = pickString(obj, CONTENT_KEYS);
  if (content == null) return null;
  const rawStatus = String(obj.status ?? obj.state ?? '')
    .toLowerCase()
    .replace(/[_\-\s]/g, '');
  let status: TodoStatus = 'pending';
  if (rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'complete') status = 'completed';
  else if (rawStatus === 'inprogress' || rawStatus === 'active' || rawStatus === 'running') status = 'in_progress';
  else if (obj.completed === true) status = 'completed';
  const activeForm = pickString(obj, ['activeForm', 'active_form', 'activeform']);
  const id = obj.id != null ? String(obj.id) : String(index + 1);
  return { id, content, status, activeForm };
}

function parseList(arr: unknown): TodoEntry[] | null {
  if (!Array.isArray(arr)) return null;
  const todos = arr.map((item, idx) => parseTodo(item, idx)).filter((t): t is TodoEntry => t !== null);
  return todos.length ? todos : null;
}

/** Next free id when appending to a Kiro-style list (ids are "1", "2", …). */
function nextId(list: TodoEntry[], offset: number): string {
  let max = 0;
  for (const t of list) {
    const n = Number(t.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + offset + 1);
}

function findTaskArray(node: unknown, depth: number): TodoEntry[] | null {
  if (depth > 6 || !node || typeof node !== 'object') return null;
  const obj = node as Record<string, any>;
  for (const key of ['tasks', 'todos']) {
    const list = parseList(obj[key]);
    if (list) return list;
  }
  for (const value of Array.isArray(obj) ? obj : Object.values(obj)) {
    const found = findTaskArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Full task list carried by a tool *result*, when the engine returns one.
 *  Kiro's `todo_list` answers with `{items:[{Json:{tasks:[…]}}]}` — an
 *  authoritative snapshot including completion flags, so it beats replaying the
 *  inputs. */
function snapshotFromResult(result: string | undefined): TodoEntry[] | null {
  if (!result || !result.trim().startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  return findTaskArray(parsed, 0);
}

const TODO_COMMANDS = new Set(['create', 'add', 'complete', 'remove', 'list']);

/** Does this tool block look like a todo-list update? The name is the primary
 *  signal, but engines don't always give one: Kiro's ACP stream labels a tool
 *  call with prose ("Creating task list: …"), so calls can arrive as an unnamed
 *  `tool`. Falling back to the argument shape keeps the pane working for those
 *  (and for sessions recorded before the name was resolved). */
function isTodoBlock(block: ChatBlock): block is ToolBlock {
  if (block.kind !== 'tool') return false;
  if (toolKind(block.name) === 'todo') return true;
  const input = (block.input ?? {}) as Record<string, any>;
  if (Array.isArray(input.todos)) return true;
  if (!TODO_COMMANDS.has(String(input.command ?? '').toLowerCase())) return false;
  return (
    Array.isArray(input.tasks) ||
    Array.isArray(input.new_tasks) ||
    Array.isArray(input.completed_task_ids) ||
    Array.isArray(input.remove_task_ids) ||
    typeof input.task_list_description === 'string'
  );
}

/** The agent's current todo list, derived from the conversation.
 *
 *  Two engine shapes are folded into one list:
 *  - Claude's `TodoWrite` carries the FULL list on every call, so each call is a
 *    snapshot that replaces the previous state.
 *  - Kiro's `todo_list` is incremental: `create` seeds the list, then `add`,
 *    `complete` (by id) and `remove` (by id) mutate it, so state has to be
 *    replayed across calls (or read from the snapshot the tool returns).
 *
 *  Returns null when the agent never set a list (or cleared it), so callers can
 *  render nothing. */
export function latestTodos(blocks: ChatBlock[] | undefined): Todo[] | null {
  if (!blocks) return null;
  let list: TodoEntry[] = [];
  let seen = false;

  for (const b of blocks) {
    if (!isTodoBlock(b)) continue;
    const input = (b.input ?? {}) as Record<string, any>;
    const command = String(input.command ?? '').toLowerCase();

    // Snapshots (Claude's input, or the list Kiro echoes back) win outright.
    const snapshot = parseList(input.todos) ?? (b.isError ? null : snapshotFromResult(b.result));
    if (snapshot) {
      list = snapshot;
      seen = true;
      continue;
    }

    const created = command === 'create' ? parseList(input.tasks) : null;
    if (created) {
      list = created;
      seen = true;
      continue;
    }
    const added = parseList(input.new_tasks) ?? (command === 'add' ? parseList(input.tasks) : null);
    if (added) {
      list = [...list, ...added.map((t, idx) => ({ ...t, id: nextId(list, idx) }))];
      seen = true;
      continue;
    }
    if (Array.isArray(input.completed_task_ids) && input.completed_task_ids.length) {
      const done = new Set(input.completed_task_ids.map(String));
      list = list.map((t) => (done.has(t.id) ? { ...t, status: 'completed' as TodoStatus } : t));
      continue;
    }
    if (Array.isArray(input.remove_task_ids) && input.remove_task_ids.length) {
      const drop = new Set(input.remove_task_ids.map(String));
      list = list.filter((t) => !drop.has(t.id));
      continue;
    }
    // `create` with no parsable tasks means the agent cleared its list.
    if (command === 'create') {
      list = [];
      seen = true;
    }
  }

  if (!seen || list.length === 0) return null;
  return list.map(({ content, status, activeForm }) => ({ content, status, activeForm }));
}

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'in_progress') return <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-accent" />;
  if (status === 'completed') return <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-400/80" />;
  return <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-slate-600" />;
}

/** Persistent task list shown above the composer. Folds every todo-tool call in
 *  the session into the current list (snapshot or incremental, depending on the
 *  engine) and stays in view across turns. Renders nothing when the agent has no
 *  active list. */
export function TodoPane({ sessionId, layout = 'composer' }: { sessionId: string; layout?: 'composer' | 'rail' }) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const running = useStore((s) => s.views[sessionId]?.running ?? false);
  const derived = useMemo(() => latestTodos(blocks), [blocks]);
  const [open, setOpen] = useState(true);

  // Engines that track completion only (Kiro) never report an in-progress task.
  // While a turn runs, surface the next open one so the pane shows where the
  // agent is — the way Kiro's own CLI marks it "(NEXT)".
  const todos = useMemo(() => {
    if (!derived || !running || derived.some((t) => t.status === 'in_progress')) return derived;
    const next = derived.findIndex((t) => t.status === 'pending');
    if (next < 0) return derived;
    return derived.map((t, i) => (i === next ? { ...t, status: 'in_progress' as TodoStatus } : t));
  }, [derived, running]);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  const pct = Math.round((done / todos.length) * 100);

  return (
    <div className={cn(layout === 'composer' && 'px-4 md:px-6')}>
      <div
        className={cn(
          'animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/80 backdrop-blur-sm',
          layout === 'composer' && 'mx-auto mb-2 max-w-3xl',
        )}
      >
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
          <ul className={cn('px-1.5 py-1.5', layout === 'composer' && 'max-h-48 overflow-y-auto')}>
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
