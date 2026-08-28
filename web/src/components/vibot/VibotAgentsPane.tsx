import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Trash2, Users, X } from '../../lib/icons';
import type { AgentKind, SessionMeta, VibotLinkedSession } from '@shared/protocol';
import { useStore } from '../../store/store';
import { useVibotStore } from '../../store/vibot';
import { SessionStatusIcon } from '../SessionStatusIcon';
import { agentLabel, cn } from '../../lib/format';

const EMPTY_LINKED: VibotLinkedSession[] = [];

interface AgentRow {
  id: string;
  title: string;
  agent: AgentKind;
  host: string;
  running: boolean;
  backgroundTasksRunning: boolean;
  unread: boolean;
  updatedAt: number;
  linkedAt: number;
}

function buildRows(
  linked: VibotLinkedSession[],
  sessions: SessionMeta[],
  unreadMap: Record<string, boolean>,
): AgentRow[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rows: AgentRow[] = [];
  for (const link of linked) {
    const live = byId.get(link.id);
    rows.push({
      id: link.id,
      title: live?.title || link.title,
      agent: live?.agent ?? link.agent,
      host: live?.host ?? link.host,
      running: live?.running ?? false,
      backgroundTasksRunning: live?.backgroundTasksRunning ?? false,
      unread: !!unreadMap[link.id],
      updatedAt: live?.updatedAt ?? link.linkedAt,
      linkedAt: link.linkedAt,
    });
  }
  rows.sort((a, b) => {
    const aa = a.running || a.backgroundTasksRunning ? 1 : 0;
    const ba = b.running || b.backgroundTasksRunning ? 1 : 0;
    if (aa !== ba) return ba - aa;
    return b.updatedAt - a.updatedAt;
  });
  return rows;
}

export function useVibotAgentRows(convId: string): { rows: AgentRow[]; activeCount: number } {
  const linked = useVibotStore((s) => s.convs.find((c) => c.id === convId)?.sessions ?? EMPTY_LINKED);
  const sessions = useStore((s) => s.sessions);
  const unread = useStore((s) => s.unread);
  const rows = useMemo(() => buildRows(linked, sessions, unread), [linked, sessions, unread]);
  const activeCount = rows.filter((r) => r.running || r.backgroundTasksRunning).length;
  return { rows, activeCount };
}

/**
 * Lists coding sessions this Vibot chat delegated. Shell/tokens match
 * BackgroundTasksPane; `composer` = mobile stack, `rail` = TaskRail child.
 */
export function VibotAgentsPane({
  convId,
  onOpenSession,
  layout = 'composer',
  /** Called after a successful unlink when the parent should dismiss embed preview. */
  onSessionUnlinked,
}: {
  convId: string;
  onOpenSession: (sessionId: string) => void;
  layout?: 'composer' | 'rail';
  onSessionUnlinked?: (sessionId: string) => void;
}) {
  const { rows, activeCount } = useVibotAgentRows(convId);
  const cli = useStore((s) => s.viewMode) === 'cli';
  const unlinkSession = useVibotStore((s) => s.unlinkSession);
  const [open, setOpen] = useState(activeCount > 0);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (activeCount > 0) setOpen(true);
    else setOpen(false);
  }, [activeCount]);

  if (!rows.length) return null;

  const doUnlink = async (sessionId: string) => {
    const ok = await unlinkSession(convId, sessionId);
    if (ok) onSessionUnlinked?.(sessionId);
    setConfirmId(null);
  };

  return (
    <div className={cn(layout === 'composer' && 'px-4 md:px-6')}>
      <div
        className={cn(
          'task-pane animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/80 backdrop-blur-sm',
          layout === 'composer' && 'mx-auto mb-2 max-w-3xl',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-ink-800/40"
        >
          <Users className="h-4 w-4 shrink-0 text-accent-soft" />
          <span className="text-[12.5px] font-medium text-slate-200">Background agents</span>
          <span className="rounded-full bg-white/5 px-1.5 py-px text-[10px] font-medium text-slate-400">
            {activeCount ? `${activeCount} running` : `${rows.length} finished`}
          </span>
          <ChevronRight className={cn('ml-auto h-3.5 w-3.5 text-slate-600 transition-transform', open && 'rotate-90')} />
        </button>
        {open && (
          <ul className={cn('border-t border-white/5 px-1.5 py-1', layout === 'composer' && 'max-h-[28rem] overflow-y-auto')}>
            {rows.map((row) => (
              <li key={row.id} className="group/agent rounded-lg px-2 py-1.5 transition hover:bg-white/[0.025]">
                <div className="flex w-full min-w-0 items-start gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (confirmId === row.id) return;
                      onOpenSession(row.id);
                    }}
                    title="Open agent session"
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  >
                    <SessionStatusIcon
                      running={row.running}
                      unread={row.unread}
                      backgroundTasksRunning={row.backgroundTasksRunning}
                      active={false}
                      cli={cli}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] text-slate-300" title={row.title}>
                        {row.title}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
                        <span>
                          {row.running
                            ? 'Running'
                            : row.backgroundTasksRunning
                              ? 'Background work'
                              : row.unread
                                ? 'New reply'
                                : 'Idle'}
                        </span>
                        <span>·</span>
                        <span className="truncate font-mono">
                          {agentLabel(row.agent)} · {row.host}
                        </span>
                      </div>
                    </div>
                    {confirmId !== row.id && <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-600" />}
                  </button>
                  <div className={cn('mt-0.5 flex shrink-0 items-center gap-0.5', confirmId === row.id ? '' : 'opacity-0 transition group-hover/agent:opacity-100')}>
                    {confirmId === row.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void doUnlink(row.id)}
                          className="rounded p-1 text-rose-400 hover:bg-rose-500/15"
                          title="Confirm unlink (session stays in coding)"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => setConfirmId(null)} className="rounded p-1 text-slate-400 hover:bg-ink-700">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        title="Remove from this chat"
                        className="rounded p-1 text-slate-500 transition hover:bg-ink-700 hover:text-rose-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmId(row.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
