import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Monitor as MonitorRecord, MonitorEvent, MonitorStatus } from '@shared/protocol';
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Loader2,
  Monitor as MonitorIcon,
  Play,
  RefreshCw,
  Settings,
} from '../lib/icons';
import { api } from '../lib/api';
import { cn } from '../lib/format';
import { useStore } from '../store/store';
import { MonitorDialog } from './MonitorDialog';

export interface SessionMonitorState {
  monitors: MonitorRecord[];
  events: MonitorEvent[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** One REST snapshot shared by the compact composer pane and desktop task rail.
 * WebSocket invalidations refresh immediately; the slow poll covers a browser
 * that slept through a frame or reconnected after an event. */
export function useSessionMonitors(sessionId: string | null): SessionMonitorState {
  const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!sessionId) {
      setMonitors([]);
      setEvents([]);
      setLoading(false);
      return;
    }
    try {
      const [allMonitors, allEvents] = await Promise.all([
        api.listMonitors(),
        api.listMonitorEvents(undefined, 200),
      ]);
      if (generation.current !== request) return;
      const matching = allMonitors.filter((monitor) => monitor.sessionId === sessionId);
      const ids = new Set(matching.map((monitor) => monitor.id));
      setMonitors(matching);
      setEvents(allEvents.filter((event) => ids.has(event.monitorId)));
    } catch {
      // Keep the last good snapshot. Individual actions surface their errors;
      // a transient refresh failure should not make the rail disappear.
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(Boolean(sessionId));
    setMonitors([]);
    setEvents([]);
    void refresh();
    const changed = () => void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener('vibe-monitor-changed', changed);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('vibe-monitor-changed', changed);
    };
  }, [refresh, sessionId]);

  return { monitors, events, loading, refresh };
}

function activeStatus(status: MonitorStatus): boolean {
  return status === 'checking' || status === 'healthy' || status === 'firing' || status === 'error';
}

function statusLabel(monitor: MonitorRecord): string {
  if (!monitor.enabled) return monitor.status === 'draft' ? 'Draft' : 'Paused';
  if (monitor.status === 'checking') return 'Checking';
  if (monitor.status === 'healthy') return 'Healthy';
  if (monitor.status === 'firing') return 'Firing';
  if (monitor.status === 'error') return 'Probe error';
  return monitor.status;
}

function StatusIcon({ monitor }: { monitor: MonitorRecord }) {
  if (monitor.enabled && monitor.status === 'checking') {
    return <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-accent" />;
  }
  if (monitor.enabled && monitor.status === 'healthy') {
    return <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  }
  if (monitor.enabled && (monitor.status === 'firing' || monitor.status === 'error')) {
    return <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-rose-400" />;
  }
  return <CirclePause className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" />;
}

function intervalLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Number((ms / 60_000).toFixed(1))}m`;
  return `${Number((ms / 3_600_000).toFixed(1))}h`;
}

function timestamp(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function MonitorRow({
  monitor,
  event,
  working,
  onRun,
  onToggle,
  onManage,
}: {
  monitor: MonitorRecord;
  event?: MonitorEvent;
  working: boolean;
  onRun: () => void;
  onToggle: () => void;
  onManage: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={cn('rounded-lg px-2 py-1.5 transition', expanded ? 'bg-white/[0.025]' : 'hover:bg-white/[0.025]')}>
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          aria-expanded={expanded}
        >
          <StatusIcon monitor={monitor} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] text-slate-300" title={monitor.name}>{monitor.name}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
              <span>{statusLabel(monitor)}</span>
              <span>·</span>
              <span>every {intervalLabel(monitor.intervalMs)}</span>
              {event && event.status !== 'resolved' && <span className="truncate text-rose-400/80">· {event.status}</span>}
            </div>
          </div>
          <ChevronRight className={cn('mt-1 h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform', expanded && 'rotate-90')} />
        </button>
        <button
          type="button"
          onClick={onRun}
          disabled={working || !monitor.enabled}
          title={monitor.enabled ? 'Run check now' : 'Start the monitor before running a real check'}
          className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-30"
        >
          {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={working}
          title={monitor.enabled ? 'Pause monitor' : 'Start monitor'}
          className={cn(
            'rounded-md p-1 transition disabled:opacity-30',
            monitor.enabled ? 'text-slate-500 hover:bg-amber-500/10 hover:text-amber-300' : 'text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-300',
          )}
        >
          {monitor.enabled ? <CirclePause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={onManage}
          title="Open monitor settings"
          className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
        >
          <Settings className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div className="ml-[1.4rem] mt-2 space-y-2 border-l border-white/5 pb-1 pl-2.5 text-[10.5px] text-slate-500">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div><dt className="text-[9px] uppercase tracking-wide text-slate-600">Probe</dt><dd className="mt-0.5 text-slate-400">{monitor.probe.kind}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-wide text-slate-600">Action</dt><dd className="mt-0.5 text-slate-400">{monitor.actionMode}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-wide text-slate-600">Last check</dt><dd className="mt-0.5 text-slate-400">{timestamp(monitor.lastCheckAt)}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-wide text-slate-600">Next check</dt><dd className="mt-0.5 text-slate-400">{timestamp(monitor.nextCheckAt)}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-wide text-slate-600">Failures</dt><dd className="mt-0.5 text-slate-400">{monitor.consecutiveFailures}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-wide text-slate-600">Wake attempts</dt><dd className="mt-0.5 text-slate-400">{event?.attemptCount ?? 0}/{monitor.maxWakeAttempts}</dd></div>
          </dl>
          {monitor.lastSummary && (
            <div>
              <div className="text-[9px] uppercase tracking-wide text-slate-600">Latest result</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-slate-400">{monitor.lastSummary}</div>
            </div>
          )}
          {event && event.status !== 'resolved' && (
            <div className="rounded-md bg-rose-500/[0.06] px-2 py-1.5 text-rose-300/80">
              <div className="text-[9px] uppercase tracking-wide text-rose-400/70">Open incident</div>
              <div className="mt-1 break-words">{event.summary}</div>
              <div className="mt-1 text-[9.5px] text-rose-300/50">First seen {timestamp(event.firstSeenAt)}</div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Session-scoped Monitor status, peer to TodoPane and BackgroundTasksPane. */
export function MonitorPane({
  sessionId,
  state,
  layout = 'composer',
}: {
  sessionId: string;
  state: SessionMonitorState;
  layout?: 'composer' | 'rail';
}) {
  const [open, setOpen] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const setToast = useStore((store) => store.setToast);
  const eventById = useMemo(
    () => new Map(state.events.map((event) => [event.id, event])),
    [state.events],
  );
  if (!state.monitors.length) return null;

  const enabled = state.monitors.filter((monitor) => monitor.enabled && activeStatus(monitor.status)).length;
  const alerts = state.monitors.filter((monitor) => monitor.status === 'firing' || monitor.status === 'error').length;

  const act = async (monitor: MonitorRecord, action: 'run' | 'toggle') => {
    setWorkingId(monitor.id);
    try {
      if (action === 'run') await api.runMonitor(monitor.id);
      else await api.setMonitorEnabled(monitor.id, !monitor.enabled);
      await state.refresh();
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Monitor action failed');
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <>
      {manageId && (
        <MonitorDialog
          initialMonitorId={manageId}
          onClose={() => setManageId(null)}
        />
      )}
      <div className={cn(layout === 'composer' && 'px-4 md:px-6')} data-session-id={sessionId}>
        <div className={cn(
          'task-pane animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/80 backdrop-blur-sm',
          layout === 'composer' && 'mx-auto mb-2 max-w-3xl',
        )}>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-ink-800/40"
          >
            <MonitorIcon className="h-4 w-4 shrink-0 text-accent-soft" />
            <span className="text-[12.5px] font-medium text-slate-200">Monitors</span>
            <span className={cn(
              'rounded-full px-1.5 py-px text-[10px] font-medium',
              alerts ? 'bg-rose-500/10 text-rose-300' : 'bg-white/5 text-slate-400',
            )}>
              {alerts ? `${alerts} alert${alerts === 1 ? '' : 's'}` : `${enabled} active`}
            </span>
            <ChevronRight className={cn('ml-auto h-3.5 w-3.5 text-slate-600 transition-transform', open && 'rotate-90')} />
          </button>
          {open && (
            <ul className={cn('border-t border-white/5 px-1.5 py-1', layout === 'composer' && 'max-h-[28rem] overflow-y-auto')}>
              {state.monitors.map((monitor) => (
                <MonitorRow
                  key={monitor.id}
                  monitor={monitor}
                  event={monitor.activeEventId ? eventById.get(monitor.activeEventId) : undefined}
                  working={workingId === monitor.id}
                  onRun={() => void act(monitor, 'run')}
                  onToggle={() => void act(monitor, 'toggle')}
                  onManage={() => setManageId(monitor.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
