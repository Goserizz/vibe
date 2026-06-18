import { useStore } from '../store/store';
import { cn, formatTokens } from '../lib/format';

export function ContextMeter({ sessionId }: { sessionId: string }) {
  const usage = useStore((s) => s.usage[sessionId]);
  if (!usage || usage.contextUsed <= 0) return null;
  const pct = Math.min(100, (usage.contextUsed / usage.contextWindow) * 100);
  return (
    <div className="hidden items-center gap-2 sm:flex" title={`${usage.contextUsed.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
        <div
          className={cn('h-full rounded-full transition-all', pct > 85 ? 'bg-rose-400' : pct > 60 ? 'bg-amber-400' : 'bg-accent')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-slate-500">{formatTokens(usage.contextUsed)}</span>
    </div>
  );
}
