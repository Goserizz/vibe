import { Menu as MenuIcon, ChevronDown, Cpu, ShieldCheck, Gauge, FolderGit2, Plus, SquareTerminal, FolderOpen } from 'lucide-react';
import type { EffortLevel, PermissionMode } from '@shared/protocol';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { PermissionPrompt } from './PermissionPrompt';
import { ContextMeter } from './ContextMeter';
import { Menu } from './Menu';
import { Logo } from './Logo';
import {
  agentLabel,
  cn,
  EFFORT_LEVELS,
  effortLabel,
  modelLabel,
  modelsForAgent,
  permissionModeLabel,
  permissionModesForAgent,
  shortenPath,
} from '../lib/format';

interface ChatViewProps {
  onOpenSidebar: () => void;
  onNewSession: () => void;
  rightTab?: 'terminal' | 'files' | null;
  onToggleTerminal?: () => void;
  onToggleFiles?: () => void;
}

export function ChatView({ onOpenSidebar, onNewSession, rightTab, onToggleTerminal, onToggleFiles }: ChatViewProps) {
  const activeId = useStore((s) => s.activeId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));

  if (!activeId || !session) {
    return <EmptyState onOpenSidebar={onOpenSidebar} onNewSession={onNewSession} />;
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
      <Header onOpenSidebar={onOpenSidebar} rightTab={rightTab} onToggleTerminal={onToggleTerminal} onToggleFiles={onToggleFiles} />
      <MessageList sessionId={activeId} />
      <PermissionPrompt sessionId={activeId} />
      <Composer sessionId={activeId} />
    </main>
  );
}

function Header({ onOpenSidebar, rightTab, onToggleTerminal, onToggleFiles }: { onOpenSidebar: () => void; rightTab?: 'terminal' | 'files' | null; onToggleTerminal?: () => void; onToggleFiles?: () => void }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-white/5 bg-ink-900/40 px-3 py-2.5 backdrop-blur-md md:px-5">
      <button onClick={onOpenSidebar} className="rounded-lg p-1.5 text-slate-400 hover:bg-ink-800 md:hidden">
        <MenuIcon className="h-5 w-5" />
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-slate-100">{session.title}</div>
        <div className="flex items-center gap-1.5 truncate text-[11px] text-slate-500">
          <span
            className={cn(
              'shrink-0 rounded px-1 py-px text-[10px] font-medium',
              session.agent === 'cursor'
                ? 'bg-accent/15 text-accent-soft'
                : session.agent === 'codex'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-ink-700 text-slate-300',
            )}
          >
            {agentLabel(session.agent)}
          </span>
          <span className="shrink-0 font-medium text-slate-400">{session.host}</span>
          <span>·</span>
          <FolderGit2 className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{shortenPath(session.cwd, 3)}</span>
        </div>
      </div>

      <ContextMeter sessionId={session.id} />
      <ModelControl />
      {session.agent === 'claude' && <EffortControl />}
      <PermissionControl />
      <button
        onClick={onToggleTerminal}
        title="Terminal"
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
          rightTab === 'terminal'
            ? 'border-accent/50 bg-accent/15 text-accent-soft'
            : 'border-ink-700 text-slate-300 hover:border-ink-600',
        )}
      >
        <SquareTerminal className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Terminal</span>
      </button>
      <button
        onClick={onToggleFiles}
        title="Files"
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
          rightTab === 'files'
            ? 'border-accent/50 bg-accent/15 text-accent-soft'
            : 'border-ink-700 text-slate-300 hover:border-ink-600',
        )}
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Files</span>
      </button>
    </header>
  );
}

function ModelControl() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cursorModels = useStore((s) => s.cursorModels);
  // Cursor's model list is large (search it); Codex/Claude are short. Allow a
  // custom typed value for Cursor and Codex (both accept arbitrary model ids).
  const usePicker = session.agent !== 'claude';

  return (
    <Menu
      align="right"
      searchable={usePicker}
      allowCustom={usePicker}
      items={modelsForAgent(session.agent, cursorModels).map((m) => ({ value: m.value, label: m.label, active: m.value === session.model }))}
      onSelect={(value) => void patchSession(session.id, { model: value })}
      trigger={
        <span className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:border-ink-600">
          <Cpu className="h-3.5 w-3.5 text-slate-500" />
          {modelLabel(session.model, cursorModels)}
          <ChevronDown className="h-3 w-3 text-slate-500" />
        </span>
      }
    />
  );
}

function EffortControl() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;

  return (
    <Menu
      align="right"
      items={EFFORT_LEVELS.map((e) => ({ value: e.value, label: e.label, hint: e.hint, active: e.value === session.effort }))}
      onSelect={(value) => void patchSession(session.id, { effort: value as EffortLevel })}
      trigger={
        <span className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:border-ink-600">
          <Gauge className="h-3.5 w-3.5 text-slate-500" />
          {effortLabel(session.effort)}
          <ChevronDown className="h-3 w-3 text-slate-500" />
        </span>
      }
    />
  );
}

function PermissionControl() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const mode = session.permissionMode;

  return (
    <Menu
      align="right"
      items={permissionModesForAgent(session.agent).map((m) => ({ value: m.value, label: m.label, hint: m.hint, active: m.value === mode }))}
      onSelect={(value) => void patchSession(session.id, { permissionMode: value as PermissionMode })}
      trigger={
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
            mode === 'bypassPermissions'
              ? 'border-rose-500/30 text-rose-300'
              : 'border-ink-700 text-slate-300 hover:border-ink-600',
          )}
        >
          <ShieldCheck className="h-3.5 w-3.5 text-slate-500" />
          {permissionModeLabel(mode)}
          <ChevronDown className="h-3 w-3 text-slate-500" />
        </span>
      }
    />
  );
}

/** Patch model/effort/permission and reflect it locally via the store's session list. */
async function patchSession(id: string, patch: { model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }) {
  try {
    const session = await api.updateSession(id, patch);
    useStore.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? session : x)) }));
  } catch {
    useStore.getState().setToast('Failed to update session');
  }
}

function EmptyState({ onOpenSidebar, onNewSession }: ChatViewProps) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-ink-950 px-6">
      <button onClick={onOpenSidebar} className="absolute left-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-ink-800 md:hidden">
        <MenuIcon className="h-5 w-5" />
      </button>
      <div className="flex flex-col items-center text-center">
        <Logo className="mb-5 h-12 w-12 text-accent/80" />
        <h2 className="text-lg font-semibold text-slate-200">Start vibe coding</h2>
        <p className="mt-1.5 max-w-xs text-sm text-slate-500">
          Spin up a session in any directory on this machine and drive Claude Code from anywhere.
        </p>
        <button
          onClick={onNewSession}
          className="mt-5 flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-soft"
        >
          <Plus className="h-4 w-4" />
          New session
        </button>
      </div>
    </main>
  );
}
