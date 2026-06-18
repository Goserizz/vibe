import { useStore } from '../store/store';
import { cn } from '../lib/format';

const LABELS = {
  connecting: 'Connecting',
  open: 'Live',
  closed: 'Reconnecting',
} as const;

export function ConnectionBadge() {
  const status = useStore((s) => s.status);
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'open' && 'bg-emerald-400',
          status === 'connecting' && 'animate-pulse-dot bg-amber-400',
          status === 'closed' && 'animate-pulse-dot bg-rose-400',
        )}
      />
      {LABELS[status]}
    </div>
  );
}
