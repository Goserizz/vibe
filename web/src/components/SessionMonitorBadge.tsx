import { monitorBadgeInfo } from '@shared/monitorSummary';
import { Radar } from '../lib/icons';
import { cn } from '../lib/format';
import { useStore } from '../store/store';

/** Independent of foreground/unread/background status: monitoring must stay
 * visible even while the same conversation is producing a reply. */
export function SessionMonitorBadge({ sessionId }: { sessionId: string }) {
  const summary = useStore((s) => s.sessionMonitors[sessionId]);
  const info = monitorBadgeInfo(summary);
  if (!info || !summary) return null;
  return (
    <span
      role="img"
      aria-label={info.label}
      title={info.label}
      data-monitor-state={info.tone}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[14px] leading-none',
        info.tone === 'enabled' && 'text-emerald-600 dark:text-emerald-400',
        info.tone === 'attention' && 'text-amber-600 dark:text-amber-400',
        info.tone === 'paused' && 'text-slate-500',
      )}
    >
      <Radar className="h-3.5 w-3.5" aria-hidden="true" />
      {summary.total > 1 && <span aria-hidden="true" className="text-[10px] tabular-nums">{summary.total}</span>}
    </span>
  );
}
