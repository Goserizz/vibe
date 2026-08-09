import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Plus, MessageSquareText, Terminal, Trash2, Check, X, Pencil, Menu as MenuIcon, Search, Settings, Star, Server, LogOut, Brain } from 'lucide-react';
import type { SearchResult, SessionMeta } from '@shared/protocol';
import { useStore } from '../store/store';
import { Logo } from './Logo';
import { ConnectionBadge } from './ConnectionBadge';
import { HostsDialog } from './HostsDialog';
import { SettingsDialog } from './SettingsDialog';
import { Menu } from './Menu';
import { agentLabel, basename, cn, modelLabel, relativeTime } from '../lib/format';
import { Glass } from './LiquidGlass';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onOpenVibot: () => void;
}

export function Sidebar({ open, onClose, onNewSession, onOpenVibot }: SidebarProps) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const signOut = useStore((s) => s.signOut);
  const searchQuery = useStore((s) => s.searchQuery);
  const searchResults = useStore((s) => s.searchResults);
  const searchLoading = useStore((s) => s.searchLoading);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const [hostsOpen, setHostsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);

  // Collapsing the search also clears the query so the list returns to normal.
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };
  const toggleSearch = () => {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  };

  // Servers / Settings / Sign out — everything that outgrew the top bar.
  const handleMenuSelect = (value: string) => {
    if (value === 'servers') setHostsOpen(true);
    else if (value === 'settings') setSettingsOpen(true);
    else if (value === 'signout') signOut();
  };

  // Click (or tap) anywhere outside the search field AND its toggle button
  // collapses it. Uses mousedown so the press that opened it can never close
  // it, and excludes the toggle button as a second safety.
  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (searchRef.current?.contains(t)) return;
      if (searchToggleRef.current?.contains(t)) return;
      closeSearch();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [searchOpen]);

  // The frosted header region grows when the search field is open.
  const headerH = searchOpen ? 108 : 56;

  const searching = searchQuery.trim().length >= 2;

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
        <div className="relative min-h-0 flex-1">
          {/* Session list — the only scroll element. It sits behind the frosted
              top bar (and the search field when open): padded down so the first
              row clears them, and items scroll up under the translucent blur. */}
          <div className={cn('absolute inset-0 overflow-y-auto px-2 pb-4', searchOpen ? 'pt-[108px]' : 'pt-[56px]')}>
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

          {/* Frosted gradient backing for the whole top region (top bar +
              New/Search). One backdrop-blur layer whose mask fades top→bottom,
              so the blur is strongest at the logo and softens toward the search
              box. Sits above the list, below the controls (pointer-events-none
              so it never blocks clicks). */}
          {/* Frosted gradient backing for the top region — 10 stacked
              backdrop-blur-[0.5px] layers anchored at top-0 with increasing
              height, so the logo (top) gets the most blur, fading down toward
              the search box. A separate ink-900 background-image tint on top
              darkens it (and masks the accent-colored app background). */}
          {Array.from({ length: 10 }, (_, i) => (
            <div
              key={i}
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-[1] backdrop-blur-[0.5px]"
              style={{ height: `${((i + 1) / 10) * headerH}px` }}
            />
          ))}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-[1]"
            style={{ height: headerH, backgroundImage: 'linear-gradient(to bottom, rgb(var(--ink-900) / 0.6), rgb(var(--ink-900) / 0.28))' }}
          />

          {/* Search — pinned just under the top bar; out of the scroll
              container so it does not rubber-band. No backdrop of its own:
              the gradient layer behind supplies the frost. */}
          {searchOpen && (
            <div ref={searchRef} className="absolute inset-x-0 top-[60px] z-10 px-3 pb-2 pt-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') closeSearch();
                  }}
                  placeholder="Search conversations"
                  className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-8 pr-7 text-[13px] text-slate-200 placeholder:text-slate-600 outline-none backdrop-blur-[2px] transition focus:border-accent/40 focus:bg-white/10"
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
          )}

          {/* Top bar (logo + actions) — pinned at the very top; the session
              list scrolls behind it. Does not bounce. Frost comes from the
              gradient layer behind. */}
          <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 pb-2.5 pt-3.5">
            <div className="flex items-center gap-2.5">
              <Logo className="h-6 w-6 text-accent" />
              <span className="text-[15px] font-semibold tracking-tight text-slate-100">Vibe</span>
              <ConnectionBadge />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={onNewSession}
                title="New session"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent-soft backdrop-blur-[2px] transition hover:border-accent/50 hover:bg-accent/20"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                ref={searchToggleRef}
                onClick={toggleSearch}
                title="Search"
                aria-pressed={searchOpen}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg border backdrop-blur-[2px] transition',
                  searchOpen
                    ? 'border-accent/50 bg-accent/20 text-accent-soft'
                    : 'border-ink-700 text-slate-400 hover:border-ink-600 hover:text-slate-200',
                )}
              >
                <Search className="h-4 w-4" />
              </button>
              <button
                onClick={onOpenVibot}
                title="Open Vibot — your Vibe assistant"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-400 backdrop-blur-[2px] transition hover:border-accent/50 hover:bg-accent/10 hover:text-accent-soft"
              >
                <Brain className="h-4 w-4" />
              </button>
              <Menu
                align="right"
                triggerLabel="Menu"
                items={[
                  { value: 'servers', label: 'Servers', icon: <Server className="h-4 w-4" /> },
                  { value: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
                  { value: 'signout', label: 'Sign out', icon: <LogOut className="h-4 w-4" /> },
                ]}
                onSelect={handleMenuSelect}
                trigger={
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-400 backdrop-blur-[2px] transition hover:border-ink-600 hover:text-slate-200">
                    <MenuIcon className="h-4 w-4" />
                  </span>
                }
              />
            </div>
          </div>
        </div>
        </Glass>
      </aside>
      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

/** Small host label so every session shows which machine it lives on. */
function HostChip({ host }: { host: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-slate-500">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
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
                active ? 'session-selected' : 'hover:bg-ink-800',
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
  const togglePin = useStore((s) => s.togglePin);
  const unread = useStore((s) => !!s.unread[session.id]);
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kiroModels = useStore((s) => s.kiroModels);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const agent = session.agent ?? 'claude';
  const model = modelLabel(session.model, cursorModels, codexModels, kimiModels, kiroModels);
  const tagText = `${agentLabel(agent)} · ${model}`;

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
          active ? 'session-selected' : 'hover:bg-ink-800',
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
          ) : unread ? (
            // Turn finished but not yet opened — a steady accent dot (no pulse)
            // signals "new reply", distinct from the pulsing dot of an active run.
            <span className="block h-4 w-4" title="New reply — click to view">
              <span className="block h-2 w-2 translate-x-1 translate-y-1 rounded-full bg-accent" />
            </span>
          ) : session.backgroundTasksRunning ? (
            <span className="block h-4 w-4" title="Reply viewed; background tasks still running">
              <Terminal
                className="h-4 w-4 text-amber-400"
                aria-label="Reply viewed; background tasks still running"
              />
            </span>
          ) : (
            <MessageSquareText className={cn('h-4 w-4', active ? 'text-accent-soft' : 'text-slate-600')} />
          )}
        </div>

        <div className="min-w-0 flex-1 pr-6">
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
              <span
                className={cn(
                  'truncate text-[13px]',
                  active ? 'text-slate-100' : unread ? 'font-medium text-slate-100' : 'text-slate-300',
                )}
              >
                {session.title}
              </span>
              <span
                title={tagText}
                className="max-w-[10.5rem] shrink-0 truncate rounded-md bg-ink-750 px-1.5 py-px text-[9px] font-medium tracking-wide text-slate-400 ring-1 ring-inset ring-accent/30"
              >
                {tagText}
              </span>
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
              'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md px-0.5 group-hover:bg-ink-750/90',
              confirming && 'bg-ink-750/90',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Rename / delete — collapsed (display:none) at rest so the pill
                shrinks to just the star; revealed on hover or while confirming. */}
            <div className={cn('items-center gap-0.5', confirming ? 'flex' : 'hidden group-hover:flex')}>
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
            {/* Favorite — rightmost, so it docks to the far-right edge. Filled
                accent + always visible when pinned; outline + hover-only otherwise. */}
            <button
              onClick={() => void togglePin(session.id)}
              title={session.pinned ? 'Remove favorite' : 'Favorite'}
              className={cn(
                'rounded p-1 hover:bg-ink-700',
                session.pinned
                  ? 'pointer-events-auto text-accent opacity-100'
                  : 'pointer-events-none text-slate-400 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 hover:text-slate-200',
              )}
            >
              <Star className="h-3.5 w-3.5" fill={session.pinned ? 'currentColor' : 'none'} />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
