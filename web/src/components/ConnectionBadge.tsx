import { useStore } from '../store/store';
import { cn } from '../lib/format';

const LABELS = {
  connecting: 'Connecting',
  open: 'Live',
  closed: 'Reconnecting',
} as const;

/** Connection state as a plain dot — the word lives in the tooltip. */
export function ConnectionBadge() {
  const status = useStore((s) => s.status);
  return (
    <span
      title={LABELS[status]}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'open' && 'bg-emerald-400',
        status === 'connecting' && 'animate-pulse-dot bg-amber-400',
        status === 'closed' && 'animate-pulse-dot bg-rose-400',
      )}
    />
  );
}
