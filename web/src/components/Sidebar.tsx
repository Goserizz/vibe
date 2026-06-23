import { useState, type ReactNode } from 'react';
import { Plus, MessageSquareText, Trash2, Check, X, Pencil, LogOut, Server, Search } from 'lucide-react';
import type { SearchResult, SessionMeta } from '@shared/protocol';
import { useStore } from '../store/store';
import { Logo } from './Logo';
import { ConnectionBadge } from './ConnectionBadge';
import { HostsDialog } from './HostsDialog';
import { basename, cn, relativeTime } from '../lib/format';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
}

export function Sidebar({ open, onClose, onNewSession }: SidebarProps) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const hosts = useStore((s) => s.hosts);
  const signOut = useStore((s) => s.signOut);
  const searchQuery = useStore((s) => s.searchQuery);
  const searchResults = useStore((s) => s.searchResults);
  const searchLoading = useStore((s) => s.searchLoading);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const [hostsOpen, setHostsOpen] = useState(false);

  const searching = searchQuery.trim().length >= 2;

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'z-40 flex h-full w-72 shrink-0 flex-col border-r border-white/5 bg-ink-900',
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform',
          !open && 'max-md:-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <div className="flex items-center gap-2.5">
            <Logo className="h-6 w-6 text-accent" />
            <span className="text-[15px] font-semibold tracking-tight text-slate-100">Vibe</span>
          </div>
          <ConnectionBadge />
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={onNewSession}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 py-2.5 text-sm font-medium text-accent-soft transition hover:border-accent/50 hover:bg-accent/20"
          >
            <Plus className="h-4 w-4" />
            New session
          </button>
        </div>

        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search conversations"
              className="w-full rounded-lg border border-white/5 bg-ink-850 py-1.5 pl-8 pr-7 text-[13px] text-slate-200 placeholder:text-slate-600 outline-none transition focus:border-accent/40"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-600 transition hover:text-slate-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {searching ? (
            <SearchResults
              results={searchResults}
              loading={searchLoading}
              query={searchQuery.trim()}
              activeId={activeId}
              onClose={onClose}
            />
          ) : sessions.length === 0 ? (
            <div className="px-3 py-10 text-center text-xs text-slate-600">
              No sessions yet.
              <br />
              Start one to begin coding.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => (
                <SessionItem key={s.id} session={s} active={s.id === activeId} onClose={onClose} />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-1 border-t border-white/5 p-3">
          <button
            onClick={() => setHostsOpen(true)}
            className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-xs text-slate-500 transition hover:bg-ink-800 hover:text-slate-300"
          >
            <Server className="h-3.5 w-3.5" />
            Hosts
            {hosts.length > 0 && <span className="rounded bg-ink-700 px-1.5 text-[10px] text-slate-400">{hosts.length}</span>}
          </button>
          <button
            onClick={signOut}
            title="Sign out"
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-slate-500 transition hover:bg-ink-800 hover:text-slate-300"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>
      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
    </>
  );
}

/** Small host label so every session shows which machine it lives on. */
function HostChip({ host }: { host: string }) {
  const localName = useStore((s) => s.localName);
  const isRemote = host !== localName;
  return (
    <span className={cn('flex shrink-0 items-center gap-1', isRemote ? 'text-accent-soft/90' : 'text-slate-500')}>
      <span className={cn('h-1.5 w-1.5 rounded-full', isRemote ? 'bg-accent/80' : 'bg-slate-600')} />
      <span className="max-w-[96px] truncate">{host}</span>
    </span>
  );
}

/** Highlight every case-insensitive occurrence of `query` within `text`. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let idx = lower.indexOf(q, cursor);
  while (idx >= 0) {
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(
      <mark key={key++} className="rounded bg-accent/25 px-0.5 text-slate-100">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
    idx = lower.indexOf(q, cursor);
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

function SearchResults({
  results,
  loading,
  query,
  activeId,
  onClose,
}: {
  results: SearchResult[];
  loading: boolean;
  query: string;
  activeId: string | null;
  onClose: () => void;
}) {
  const openSession = useStore((s) => s.openSession);
  const setSearchQuery = useStore((s) => s.setSearchQuery);

  if (loading && results.length === 0) {
    return <div className="px-3 py-10 text-center text-xs text-slate-600">Searching…</div>;
  }
  if (results.length === 0) {
    return (
      <div className="px-3 py-10 text-center text-xs text-slate-600">
        No matches for “{query}”.
      </div>
    );
  }

  return (
    <ul className="space-y-0.5">
      {results.map((r) => {
        const active = r.sessionId === activeId;
        return (
          <li key={r.sessionId}>
            <div
              className={cn(
                'group relative cursor-pointer rounded-lg px-2.5 py-2 transition',
                active ? 'bg-ink-750' : 'hover:bg-ink-800',
              )}
              onClick={() => {
                void openSession(r.sessionId);
                setSearchQuery('');
                onClose();
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn('truncate text-[13px]', active ? 'text-slate-100' : 'text-slate-300')}>
                  {r.title}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-slate-600">
                <HostChip host={r.host} />
                <span className="truncate">{basename(r.cwd)}</span>
                <span>·</span>
                <span className="shrink-0">{relativeTime(r.updatedAt)}</span>
              </div>
              <div className="mt-1 space-y-1">
                {r.hits.slice(0, 2).map((h, i) => (
                  <div key={i} className="flex gap-1.5 text-[11px] leading-snug text-slate-500">
                    <span className="shrink-0 capitalize text-slate-600">{h.kind}</span>
                    <span className="min-w-0 break-words">
                      <Highlight text={h.snippet} query={query} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SessionItem({ session, active, onClose }: { session: SessionMeta; active: boolean; onClose: () => void }) {
  const openSession = useStore((s) => s.openSession);
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(session.title);

  const commitRename = () => {
    setEditing(false);
    const next = title.trim();
    if (next && next !== session.title) void renameSession(session.id, next);
    else setTitle(session.title);
  };

  return (
    <li>
      <div
        className={cn(
          'group relative flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 transition',
          active ? 'bg-ink-750' : 'hover:bg-ink-800',
        )}
        onClick={() => {
          if (editing) return;
          void openSession(session.id);
          onClose();
        }}
      >
        <div className="mt-0.5 shrink-0">
          {session.running ? (
            <span className="block h-4 w-4">
              <span className="block h-2 w-2 translate-x-1 translate-y-1 animate-pulse-dot rounded-full bg-accent" />
            </span>
          ) : (
            <MessageSquareText className={cn('h-4 w-4', active ? 'text-accent-soft' : 'text-slate-600')} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setTitle(session.title);
                  setEditing(false);
                }
              }}
              className="w-full rounded border border-accent/40 bg-ink-900 px-1.5 py-0.5 text-[13px] text-slate-100 outline-none"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <span className={cn('truncate text-[13px]', active ? 'text-slate-100' : 'text-slate-300')}>
                {session.title}
              </span>
              {session.agent === 'cursor' && (
                <span className="shrink-0 rounded bg-accent/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-accent-soft">
                  Cursor
                </span>
              )}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-slate-600">
            <HostChip host={session.host} />
            <span className="truncate">{basename(session.cwd)}</span>
            <span>·</span>
            <span className="shrink-0">{relativeTime(session.updatedAt)}</span>
          </div>
        </div>

        {!editing && (
          <div
            className={cn(
              'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-ink-750/90 px-0.5 opacity-0 transition group-hover:opacity-100',
              confirming && 'opacity-100',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {confirming ? (
              <>
                <button onClick={() => void deleteSession(session.id)} className="rounded p-1 text-rose-400 hover:bg-rose-500/15" title="Confirm delete">
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
    </li>
  );
}
