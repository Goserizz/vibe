import { useState } from 'react';
import { Plus, Brain, Settings, BookMarked, ArrowLeft, Trash2, Pencil, Check, X, MessageSquareText } from '../../lib/icons';
import type { VibotConvMeta } from '@shared/protocol';
import { useVibotStore } from '../../store/vibot';
import { Glass } from '../LiquidGlass';
import { cn, relativeTime } from '../../lib/format';

interface Props {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenMemories: () => void;
  onBack: () => void;
}

export function VibotSidebar({ open, onClose, onNewChat, onOpenSettings, onOpenMemories, onBack }: Props) {
  const convs = useVibotStore((s) => s.convs);
  const activeConvId = useVibotStore((s) => s.activeConvId);

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
                <BookMarked className="h-4 w-4" />
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
                  <ConvItem key={c.id} conv={c} active={c.id === activeConvId} onClose={onClose} />
                ))}
              </ul>
            )}
          </div>
        </Glass>
      </aside>
    </>
  );
}

function ConvItem({ conv, active, onClose }: { conv: VibotConvMeta; active: boolean; onClose: () => void }) {
  const openConversation = useVibotStore((s) => s.openConversation);
  const renameConversation = useVibotStore((s) => s.renameConversation);
  const deleteConversation = useVibotStore((s) => s.deleteConversation);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(conv.title);

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
          'group relative flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 transition',
          active ? 'session-selected' : 'hover:bg-ink-800',
        )}
        onClick={() => {
          if (editing) return;
          void openConversation(conv.id);
          onClose();
        }}
      >
        <div className="mt-0.5 shrink-0">
          {conv.running ? (
            <span className="block h-4 w-4">
              <span className="block h-2 w-2 translate-x-1 translate-y-1 animate-pulse-dot rounded-full bg-accent" />
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
          <div className="mt-0.5 truncate text-[11px] text-slate-600">{relativeTime(conv.updatedAt)}</div>
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
    </li>
  );
}
