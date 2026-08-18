import { useMemo, useState, type ReactNode } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CircleStop,
  Copy,
  Loader2,
  OctagonX,
  Square,
  TerminalSquare,
  Users,
} from '../lib/icons';
import type { BackgroundTask, BackgroundTaskStatus } from '@shared/protocol';
import { useStore } from '../store/store';
import { cn } from '../lib/format';

const EMPTY_TASKS: BackgroundTask[] = [];

function active(status: BackgroundTaskStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

function statusLabel(status: BackgroundTaskStatus): string {
  if (status === 'pending') return 'Pending';
  if (status === 'running') return 'Running';
  if (status === 'paused') return 'Paused';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  return 'Stopped';
}

function StatusIcon({ status }: { status: BackgroundTaskStatus }) {
  if (status === 'running' || status === 'pending') return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />;
  if (status === 'paused') return <CirclePause className="h-3.5 w-3.5 shrink-0 text-amber-300" />;
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  if (status === 'failed') return <OctagonX className="h-3.5 w-3.5 shrink-0 text-rose-400" />;
  return <CircleStop className="h-3.5 w-3.5 shrink-0 text-slate-500" />;
}

function timestamp(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through for HTTP/non-secure contexts where Clipboard is blocked.
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function DetailValue({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-medium uppercase tracking-wide text-slate-600">{label}</dt>
      <dd className={cn('mt-0.5 break-words text-[10.5px] text-slate-400', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}

function TaskRow({ task, onStop, compact = false }: { task: BackgroundTask; onStop: () => void; compact?: boolean }) {
  const isActive = active(task.status);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyValue = [task.error, task.output].filter(Boolean).join('\n\n');

  const copyOutput = async () => {
    if (!copyValue || !await copyText(copyValue)) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <li className={cn('rounded-lg px-2 py-1.5 transition', expanded ? 'bg-white/[0.025]' : 'hover:bg-white/[0.025]')}>
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          <StatusIcon status={task.status} />
          {task.kind === 'subagent' ? (
            <Users className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" />
          ) : (
            <TerminalSquare className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] text-slate-300" title={task.description}>
              {task.description || task.command || task.id}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
              <span>{statusLabel(task.status)}</span>
              <span>·</span>
              <span className="truncate font-mono">{task.id}</span>
              {task.output && <span className="shrink-0 text-slate-400">· output</span>}
              {task.exitCode != null && <span className="shrink-0">· exit {task.exitCode}</span>}
            </div>
          </div>
          <ChevronRight className={cn('mt-1 h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform', expanded && 'rotate-90')} />
        </button>
        {isActive && (
          <button
            type="button"
            onClick={onStop}
            disabled={!task.canStop}
            title={task.canStop ? 'Stop task' : 'This agent cannot stop this task individually'}
            className="rounded-md p-1 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-[3.15rem] mt-2 space-y-2 border-l border-white/5 pl-2.5 pb-1">
          <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-2', !compact && 'sm:grid-cols-3')}>
            <DetailValue label="Agent">{task.agent}</DetailValue>
            <DetailValue label="Type">{task.kind}</DetailValue>
            <DetailValue label="Status">{statusLabel(task.status)}</DetailValue>
            <DetailValue label="Started">{timestamp(task.startedAt)}</DetailValue>
            <DetailValue label="Updated">{timestamp(task.updatedAt)}</DetailValue>
            {task.endedAt && <DetailValue label="Ended">{timestamp(task.endedAt)}</DetailValue>}
            {task.activity && <DetailValue label="Current activity">{task.activity}</DetailValue>}
            {task.processId && <DetailValue label="Process" mono>{task.processId}</DetailValue>}
            {task.exitCode != null && <DetailValue label="Exit code" mono>{task.exitCode}</DetailValue>}
          </dl>

          <div>
            <div className="text-[9px] font-medium uppercase tracking-wide text-slate-600">Task ID</div>
            <div className="mt-0.5 break-all font-mono text-[10.5px] text-slate-400">{task.id}</div>
          </div>

          {task.cwd && (
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wide text-slate-600">Working directory</div>
              <div className="mt-0.5 break-all font-mono text-[10.5px] text-slate-400">{task.cwd}</div>
            </div>
          )}

          {task.command && (
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wide text-slate-600">Command</div>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-slate-400">{task.command}</pre>
            </div>
          )}

          {task.detail && task.detail !== task.command && (
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wide text-slate-600">Instructions</div>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 px-2 py-1.5 text-[10.5px] leading-relaxed text-slate-400">{task.detail}</pre>
            </div>
          )}

          {task.summary && task.summary !== task.output && (
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wide text-slate-600">Summary</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-slate-400">{task.summary}</div>
            </div>
          )}

          {task.error && (
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wide text-rose-400/70">Error</div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-rose-500/[0.06] px-2 py-1.5 text-[10.5px] leading-relaxed text-rose-300/80">{task.error}</pre>
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <div className="text-[9px] font-medium uppercase tracking-wide text-slate-600">
                Captured output {isActive && <span className="normal-case text-accent-soft">· live</span>}
              </div>
              {copyValue && (
                <button
                  type="button"
                  onClick={copyOutput}
                  title="Copy task output"
                  className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
                >
                  {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
            {task.output ? (
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-slate-300">{task.output}</pre>
            ) : (
              <div className="mt-1 rounded-md bg-black/15 px-2 py-1.5 text-[10.5px] text-slate-600">
                {isActive ? 'No output captured yet. This view updates while the agent reports progress.' : 'No output was captured for this task.'}
              </div>
            )}
            {task.outputFile && (
              <div className="mt-1 break-all text-[9.5px] text-slate-600" title={task.outputFile}>
                Source: <span className="font-mono">{task.outputFile}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Native background work (distinct from the agent's planning/todo list). */
export function BackgroundTasksPane({ sessionId, layout = 'composer' }: { sessionId: string; layout?: 'composer' | 'rail' }) {
  // Zustand's snapshot must be referentially stable. An inline `?? []` creates
  // a fresh array on every read and can send React into an infinite render loop.
  const tasks = useStore((state) => state.tasks[sessionId] ?? EMPTY_TASKS);
  const stopTask = useStore((state) => state.stopTask);
  const [open, setOpen] = useState(true);
  const sorted = useMemo(
    () => [...tasks].sort((a, b) => Number(active(b.status)) - Number(active(a.status)) || b.updatedAt - a.updatedAt),
    [tasks],
  );
  if (!sorted.length) return null;

  const running = sorted.filter((task) => active(task.status)).length;
  return (
    <div className={cn(layout === 'composer' && 'px-4 md:px-6')}>
      <div
        className={cn(
          'animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/80 backdrop-blur-sm',
          layout === 'composer' && 'mx-auto mb-2 max-w-3xl',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-ink-800/40"
        >
          <TerminalSquare className="h-4 w-4 shrink-0 text-accent-soft" />
          <span className="text-[12.5px] font-medium text-slate-200">Background tasks</span>
          <span className="rounded-full bg-white/5 px-1.5 py-px text-[10px] font-medium text-slate-400">
            {running ? `${running} active` : `${sorted.length} finished`}
          </span>
          <ChevronRight className={cn('ml-auto h-3.5 w-3.5 text-slate-600 transition-transform', open && 'rotate-90')} />
        </button>
        {open && (
          <ul className={cn('border-t border-white/5 px-1.5 py-1', layout === 'composer' && 'max-h-[28rem] overflow-y-auto')}>
            {sorted.map((task) => <TaskRow key={task.id} task={task} compact={layout === 'rail'} onStop={() => stopTask(task.id)} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
