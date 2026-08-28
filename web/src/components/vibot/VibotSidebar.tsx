import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Brain,
  Settings,
  BookMarked,
  ArrowLeft,
  Trash2,
  Pencil,
  Check,
  X,
} from '../../lib/icons';
import type { VibotConvMeta, VibotLinkedSession } from '@shared/protocol';
import { useVibotStore } from '../../store/vibot';
import { useStore } from '../../store/store';
import { Glass } from '../LiquidGlass';
import { SessionStatusIcon } from '../SessionStatusIcon';
import { agentLabel, cn, relativeTime } from '../../lib/format';

interface Props {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenMemories: () => void;
  onBack: () => void;
  /** Stay in Vibot and show this coding session in the main pane. */
  onPreviewSession: (sessionId: string) => void;
  /** Currently previewed coding session (highlight in the child list). */
  previewSessionId: string | null;
  /** Increments on every preview open so owning rows can re-expand. */
  previewExpandToken: number;
  /** Dismiss the coding-session embed (e.g. when selecting a Vibot chat row). */
  onDismissPreview: () => void;
}

export function VibotSidebar({
  open,
  onClose,
  onNewChat,
  onOpenSettings,
  onOpenMemories,
  onBack,
  onPreviewSession,
  previewSessionId,
  previewExpandToken,
  onDismissPreview,
}: Props) {
  const convs = useVibotStore((s) => s.convs);
  const activeConvId = useVibotStore((s) => s.activeConvId);
  // TUI chrome swaps SVG icons for glyphs (❯, +, …); Vibot follows suit for its
  // sidebar buttons, starting with the memories one (#).
  const cli = useStore((s) => s.viewMode) === 'cli';

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'z-40 h-full w-72 shrink-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform',
          !open && 'max-md:-translate-x-full',
        )}
      >
        <Glass className="flex h-full w-full flex-col border-r border-white/5" cornerRadius={0}>
          {/* Top bar */}
          <div className="flex shrink-0 items-center justify-between px-3 pb-2.5 pt-3.5">
            <div className="flex items-center gap-2.5">
              <button
                onClick={onBack}
                title="Back to coding"
                className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-ink-800 hover:text-slate-200"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <Brain className="h-5 w-5 text-accent" />
              <span className="text-[15px] font-semibold tracking-tight text-slate-100">Vibot</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={onNewChat}
                title="New chat"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent-soft transition hover:border-accent/50 hover:bg-accent/20"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                onClick={onOpenMemories}
                title="Memories"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-400 transition hover:border-ink-600 hover:text-slate-200"
              >
                {cli ? <span className="font-mono text-[14px] leading-none">#</span> : <BookMarked className="h-4 w-4" />}
              </button>
              <button
                onClick={onOpenSettings}
                title="Settings"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-400 transition hover:border-ink-600 hover:text-slate-200"
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Conversation list */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {convs.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-slate-600">
                No chats yet.
                <br />
                Start one to ask Vibot anything.
              </div>
            ) : (
              <ul className="space-y-0.5">
                {convs.map((c) => (
                  <ConvItem
                    key={c.id}
                    conv={c}
                    active={c.id === activeConvId}
                    onClose={onClose}
                    onPreviewSession={onPreviewSession}
                    previewSessionId={previewSessionId}
                    previewExpandToken={previewExpandToken}
                    onDismissPreview={onDismissPreview}
                  />
                ))}
              </ul>
            )}
          </div>
        </Glass>
      </aside>
    </>
  );
}

function ConvItem({
  conv,
  active,
  onClose,
  onPreviewSession,
  previewSessionId,
  previewExpandToken,
  onDismissPreview,
}: {
  conv: VibotConvMeta;
  active: boolean;
  onClose: () => void;
  onPreviewSession: (sessionId: string) => void;
  previewSessionId: string | null;
  previewExpandToken: number;
  onDismissPreview: () => void;
}) {
  const openConversation = useVibotStore((s) => s.openConversation);
  const renameConversation = useVibotStore((s) => s.renameConversation);
  const deleteConversation = useVibotStore((s) => s.deleteConversation);
  const codingSessions = useStore((s) => s.sessions);
  const unreadMap = useStore((s) => s.unread);
  const cli = useStore((s) => s.viewMode) === 'cli';
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState(conv.title);
  const sessions = conv.sessions ?? [];
  const hasChildren = sessions.length > 0;
  const prevSessionCount = useRef(sessions.length);

  // Auto-expand when a new coding session is linked while this row is mounted
  // (e.g. Vibot just called create_session). Existing children stay collapsed
  // until the user opens them.
  useEffect(() => {
    if (sessions.length > prevSessionCount.current) setExpanded(true);
    prevSessionCount.current = sessions.length;
  }, [sessions.length]);

  // Expand when a linked agent is opened in preview (rail / child click). Token
  // bumps on every open — including re-clicking the same session after collapse.
  // Only this owning row expands; other rows ignore the token.
  useEffect(() => {
    if (!previewSessionId || previewExpandToken <= 0) return;
    if ((conv.sessions ?? []).some((s) => s.id === previewSessionId)) setExpanded(true);
  }, [previewSessionId, previewExpandToken, conv.sessions]);

  const status = useMemo(() => {
    let childAgentRunning = false;
    let childBgTasks = false;
    let childUnread = false;
    for (const link of sessions) {
      const live = codingSessions.find((x) => x.id === link.id);
      if (live?.running) childAgentRunning = true;
      if (live?.backgroundTasksRunning) childBgTasks = true;
      if (unreadMap[link.id]) childUnread = true;
    }
    const childBusy = childAgentRunning || childBgTasks;
    return {
      // Vibot's own turn wins; child agent activity maps to the amber "bg work" glyph.
      running: !!conv.running,
      backgroundTasksRunning: !conv.running && childBusy,
      unread: !conv.running && !childBusy && childUnread,
    };
  }, [sessions, codingSessions, unreadMap, conv.running]);

  const commit = () => {
    setEditing(false);
    const next = title.trim();
    if (next && next !== conv.title) void renameConversation(conv.id, next);
    else setTitle(conv.title);
  };

  return (
    <li>
      <div
        className={cn(
          'group relative flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 transition',
          active ? 'session-selected' : 'hover:bg-ink-800',
        )}
        onClick={() => {
          if (editing) return;
          // Capture preview flag before dismiss — setState is async.
          const wasPreviewing = previewSessionId != null;
          if (wasPreviewing) onDismissPreview();
          void openConversation(conv.id);
          if (!wasPreviewing) {
            // Only toggle expand when already on this chat with no embed open.
            // Switching to another chat: leave expand as-is, but open the child
            // list if it has sessions and was collapsed (so linked agents show).
            if (active && hasChildren) setExpanded((v) => !v);
            else if (!active && hasChildren && !expanded) setExpanded(true);
          }
          onClose();
        }}
      >
        <div className="mt-0.5 flex w-4 shrink-0 items-center justify-center" aria-hidden>
          <SessionStatusIcon
            running={status.running}
            unread={status.unread}
            backgroundTasksRunning={status.backgroundTasksRunning}
            active={active}
            cli={cli}
          />
        </div>
        <div className="min-w-0 flex-1 pr-6">
          {editing ? (
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') {
                  setTitle(conv.title);
                  setEditing(false);
                }
              }}
              className="w-full rounded border border-accent/40 bg-ink-900 px-1.5 py-0.5 text-[13px] text-slate-100 outline-none"
            />
          ) : (
            <span className={cn('block truncate text-[13px]', active ? 'text-slate-100' : 'text-slate-300')}>{conv.title}</span>
          )}
          <div className="mt-0.5 truncate text-[11px] text-slate-600">
            {relativeTime(conv.updatedAt)}
            {hasChildren ? ` · ${sessions.length} session${sessions.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        {!editing && (
          <div
            className={cn(
              'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md px-0.5',
              confirming ? 'bg-ink-750/90' : 'hidden group-hover:flex group-hover:bg-ink-750/90',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {confirming ? (
              <>
                <button onClick={() => void deleteConversation(conv.id)} className="rounded p-1 text-rose-400 hover:bg-rose-500/15" title="Confirm delete">
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setConfirming(false)} className="rounded p-1 text-slate-400 hover:bg-ink-700">
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setEditing(true)} className="rounded p-1 text-slate-400 hover:bg-ink-700 hover:text-slate-200" title="Rename">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setConfirming(true)} className="rounded p-1 text-slate-400 hover:bg-ink-700 hover:text-rose-400" title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {expanded && hasChildren && (
        <ul className="mb-1 ml-3 space-y-0.5 border-l border-ink-700/80 pl-2">
          {sessions.map((s) => (
            <LinkedSessionItem
              key={s.id}
              convId={conv.id}
              session={s}
              previewing={s.id === previewSessionId}
              onPreview={onPreviewSession}
              onClose={onClose}
              onDismissPreview={onDismissPreview}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function LinkedSessionItem({
  convId,
  session,
  previewing,
  onPreview,
  onClose,
  onDismissPreview,
}: {
  convId: string;
  session: VibotLinkedSession;
  previewing: boolean;
  onPreview: (sessionId: string) => void;
  onClose: () => void;
  onDismissPreview: () => void;
}) {
  const live = useStore((s) => s.sessions.find((x) => x.id === session.id));
  const unread = useStore((s) => !!s.unread[session.id]);
  const cli = useStore((s) => s.viewMode) === 'cli';
  const unlinkSession = useVibotStore((s) => s.unlinkSession);
  const [confirming, setConfirming] = useState(false);
  const title = live?.title || session.title;
  const agent = live?.agent ?? session.agent;
  const host = live?.host ?? session.host;

  const doUnlink = async () => {
    const ok = await unlinkSession(convId, session.id);
    if (ok && previewing) onDismissPreview();
    setConfirming(false);
  };

  return (
    <li>
      <div
        className={cn(
          'group/link flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition',
          previewing ? 'bg-ink-800/80' : 'hover:bg-ink-800',
        )}
        title="Open in Vibot"
        onClick={() => {
          if (confirming) return;
          onPreview(session.id);
          onClose();
        }}
      >
        <div className="mt-0.5 flex w-4 shrink-0 items-center justify-center">
          <SessionStatusIcon
            running={live?.running ?? false}
            unread={unread}
            backgroundTasksRunning={live?.backgroundTasksRunning ?? false}
            active={previewing}
            cli={cli}
          />
        </div>
        <div className="min-w-0 flex-1">
          <span className={cn('block truncate text-[12px]', previewing ? 'text-slate-100' : 'text-slate-300')}>{title}</span>
          <div className="mt-0.5 truncate text-[10px] text-slate-600">
            {agentLabel(agent)} · {host}
          </div>
        </div>
        <div
          className={cn(
            'mt-0.5 flex shrink-0 items-center gap-0.5',
            confirming ? '' : 'opacity-0 transition group-hover/link:opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {confirming ? (
            <>
              <button
                type="button"
                onClick={() => void doUnlink()}
                className="rounded p-1 text-rose-400 hover:bg-rose-500/15"
                title="Confirm unlink (session stays in coding)"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="rounded p-1 text-slate-400 hover:bg-ink-700">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <button
              type="button"
              title="Remove from this chat"
              className="rounded p-1 text-slate-500 transition hover:bg-ink-700 hover:text-rose-400"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
