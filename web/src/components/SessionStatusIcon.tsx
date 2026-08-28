import { MessageSquareText, Terminal } from '../lib/icons';
import { cn } from '../lib/format';

/** Status glyph used in the coding sidebar session list — shared so Vibot's
 *  linked-session rows stay visually identical (running / unread / bg tasks / idle). */
export function SessionStatusIcon({
  running,
  unread,
  backgroundTasksRunning,
  active,
  cli,
}: {
  running: boolean;
  unread: boolean;
  backgroundTasksRunning: boolean;
  active: boolean;
  cli: boolean;
}) {
  if (cli) {
    return (
      <span
        className={cn(
          'select-none text-[14px] leading-none',
          running && 'animate-pulse-dot text-accent',
          !running && unread && 'text-accent',
          !running && !unread && backgroundTasksRunning && 'text-amber-400',
          !running && !unread && !backgroundTasksRunning && (active ? 'text-accent-soft' : 'text-slate-600'),
        )}
        title={
          running
            ? undefined
            : unread
              ? 'New reply — click to view'
              : backgroundTasksRunning
                ? 'Reply viewed; background tasks still running'
                : undefined
        }
      >
        ■
      </span>
    );
  }
  if (running) {
    return (
      <span className="block h-4 w-4">
        <span className="block h-2 w-2 translate-x-1 translate-y-1 animate-pulse-dot rounded-full bg-accent" />
      </span>
    );
  }
  if (unread) {
    return (
      <span className="block h-4 w-4" title="New reply — click to view">
        <span className="block h-2 w-2 translate-x-1 translate-y-1 rounded-full bg-accent" />
      </span>
    );
  }
  if (backgroundTasksRunning) {
    return (
      <span className="block h-4 w-4" title="Reply viewed; background tasks still running">
        <Terminal
          className="h-4 w-4 text-amber-400"
          aria-label="Reply viewed; background tasks still running"
        />
      </span>
    );
  }
  return <MessageSquareText className={cn('h-4 w-4', active ? 'text-accent-soft' : 'text-slate-600')} />;
}
