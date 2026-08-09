import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Menu as MenuIcon, Cpu, ShieldCheck, Gauge, FolderGit2, Plus, SquareTerminal, FolderOpen } from 'lucide-react';
import type { EffortLevel, PermissionMode } from '@shared/protocol';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { PermissionPrompt } from './PermissionPrompt';
import { latestTodos, TodoPane } from './TodoPane';
import { BackgroundTasksPane } from './BackgroundTasksPane';
import { ContextMeter } from './ContextMeter';
import { Menu } from './Menu';
import { Logo } from './Logo';
import {
  agentLabel,
  cn,
  effortLabel,
  effortLevelsForAgent,
  modelLabel,
  modelsForAgent,
  permissionModeLabel,
  permissionModesForAgent,
  shortenPath,
} from '../lib/format';
import { Glass } from './LiquidGlass';

interface ChatViewProps {
  onOpenSidebar: () => void;
  onNewSession: () => void;
  rightTab?: 'terminal' | 'files' | null;
  onToggleTerminal?: () => void;
  onToggleFiles?: () => void;
}

const TASK_RAIL_MIN_WIDTH = 260;
const TASK_RAIL_DEFAULT_WIDTH = 320;
const TASK_RAIL_MAX_WIDTH = 640;
const TASK_RAIL_CHAT_MIN_WIDTH = 360;
const TASK_RAIL_WIDTH_KEY = 'vibe.taskRailWidth';

export function ChatView({ onOpenSidebar, onNewSession, rightTab, onToggleTerminal, onToggleFiles }: ChatViewProps) {
  const activeId = useStore((s) => s.activeId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  // The composer stack floats over the message list, so the list needs bottom
  // padding equal to its height. It grows and shrinks (task pane expanded,
  // attachments, permission prompts), so measure instead of guessing.
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlayHeight, setOverlayHeight] = useState(0);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setOverlayHeight(el.offsetHeight));
    observer.observe(el);
    setOverlayHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, [activeId]);

  if (!activeId || !session) {
    return <EmptyState onOpenSidebar={onOpenSidebar} onNewSession={onNewSession} />;
  }

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-ink-950">
      <Header onOpenSidebar={onOpenSidebar} rightTab={rightTab} onToggleTerminal={onToggleTerminal} onToggleFiles={onToggleFiles} />
      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-w-0 flex-1 flex-col">
          <MessageList sessionId={activeId} bottomPad={overlayHeight} />
          {/* Composer (+ permission prompts) floats over the conversation. On
              compact viewports the task panes stay in this stack; wide desktop
              moves them into DesktopTaskRail instead. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <div ref={overlayRef} className="pointer-events-auto">
              <PermissionPrompt sessionId={activeId} />
              <div className="lg:hidden">
                <BackgroundTasksPane sessionId={activeId} />
                <TodoPane sessionId={activeId} />
              </div>
              <Composer sessionId={activeId} />
            </div>
          </div>
        </section>
        {!rightTab && <DesktopTaskRail sessionId={activeId} />}
      </div>
    </main>
  );
}

/** Wide-screen task column. It only claims horizontal space when this session
 *  actually has a todo/background-task list; narrower screens retain the
 *  composer-stack layout above. Terminal/Files temporarily take its place. */
function DesktopTaskRail({ sessionId }: { sessionId: string }) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const backgroundTasks = useStore((s) => s.tasks[sessionId]);
  const hasTodos = useMemo(() => Boolean(latestTodos(blocks)?.length), [blocks]);
  const railRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState(() => {
    let saved = Number.NaN;
    try {
      saved = Number(localStorage.getItem(TASK_RAIL_WIDTH_KEY));
    } catch {
      /* use the default when storage is unavailable */
    }
    return Number.isFinite(saved) && saved >= TASK_RAIL_MIN_WIDTH
      ? Math.min(saved, TASK_RAIL_MAX_WIDTH)
      : TASK_RAIL_DEFAULT_WIDTH;
  });

  const maxWidth = () => {
    const available = railRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    return Math.max(TASK_RAIL_MIN_WIDTH, Math.min(TASK_RAIL_MAX_WIDTH, available - TASK_RAIL_CHAT_MIN_WIDTH));
  };
  const clampWidth = (value: number) => Math.max(TASK_RAIL_MIN_WIDTH, Math.min(maxWidth(), value));

  useEffect(() => {
    try {
      localStorage.setItem(TASK_RAIL_WIDTH_KEY, String(width));
    } catch {
      /* ignore unavailable storage */
    }
  }, [width]);

  useEffect(() => {
    const clampToViewport = () => {
      const rail = railRef.current;
      // The same component stays mounted on compact viewports but is hidden by
      // CSS. Do not let a phone-sized viewport overwrite the saved desktop width.
      if (!rail || getComputedStyle(rail).display === 'none') return;
      const available = rail.parentElement?.clientWidth ?? window.innerWidth;
      const maximum = Math.max(
        TASK_RAIL_MIN_WIDTH,
        Math.min(TASK_RAIL_MAX_WIDTH, available - TASK_RAIL_CHAT_MIN_WIDTH),
      );
      setWidth((value) => Math.max(TASK_RAIL_MIN_WIDTH, Math.min(maximum, value)));
    };
    window.addEventListener('resize', clampToViewport);
    clampToViewport();
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const resizeBy = (delta: number) => setWidth((value) => clampWidth(value + delta));
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const right = rail.getBoundingClientRect().right;
    const onMove = (moveEvent: PointerEvent) => setWidth(clampWidth(right - moveEvent.clientX));
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    const finishDrag = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      if (dragCleanupRef.current === finishDrag) dragCleanupRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    dragCleanupRef.current = finishDrag;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  if (!hasTodos && !backgroundTasks?.length) return null;

  return (
    <aside
      ref={railRef}
      aria-label="Session tasks"
      style={{ width: `${width}px` }}
      className="relative hidden shrink-0 border-l border-white/5 bg-ink-900/25 pt-16 lg:flex lg:flex-col"
    >
      <div
        role="separator"
        aria-label="Resize task panel"
        aria-orientation="vertical"
        aria-valuemin={TASK_RAIL_MIN_WIDTH}
        aria-valuemax={Math.round(maxWidth())}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={() => setWidth(clampWidth(TASK_RAIL_DEFAULT_WIDTH))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            resizeBy(16);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            resizeBy(-16);
          } else if (event.key === 'Home') {
            event.preventDefault();
            setWidth(TASK_RAIL_MIN_WIDTH);
          }
        }}
        className="absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none transition-colors hover:bg-accent/30 focus:bg-accent/30 focus:outline-none lg:block"
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <BackgroundTasksPane sessionId={sessionId} layout="rail" />
        <TodoPane sessionId={sessionId} layout="rail" />
      </div>
    </aside>
  );
}

function Header({ onOpenSidebar, rightTab, onToggleTerminal, onToggleFiles }: { onOpenSidebar: () => void; rightTab?: 'terminal' | 'files' | null; onToggleTerminal?: () => void; onToggleFiles?: () => void }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;

  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <Glass className="app-titlebar flex items-center gap-3 border-b border-white/5 px-3 py-2.5 md:px-5" cornerRadius={0} thin>
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
                  : session.agent === 'kimi'
                    ? 'bg-sky-500/15 text-sky-300'
                    : session.agent === 'kiro'
                      ? 'bg-violet-500/15 text-violet-300'
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
      {session.agent !== 'cursor' && session.agent !== 'kimi' && <EffortControl />}
      <PermissionControl />
      <button
        type="button"
        onClick={onToggleTerminal}
        aria-label="Terminal"
        title="Terminal"
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition',
          rightTab === 'terminal'
            ? 'border-accent/50 bg-accent/15 text-accent-soft'
            : 'border-ink-700 text-slate-300 hover:border-ink-600',
        )}
      >
        <SquareTerminal className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onToggleFiles}
        aria-label="Files"
        title="Files"
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition',
          rightTab === 'files'
            ? 'border-accent/50 bg-accent/15 text-accent-soft'
            : 'border-ink-700 text-slate-300 hover:border-ink-600',
        )}
      >
        <FolderOpen className="h-4 w-4" />
      </button>
      </Glass>
    </header>
  );
}

function ModelControl() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kiroModels = useStore((s) => s.kiroModels);
  const loadCursorModels = useStore((s) => s.loadCursorModels);
  const loadCodexModels = useStore((s) => s.loadCodexModels);
  const loadKimiCapabilities = useStore((s) => s.loadKimiCapabilities);
  const loadKiroModels = useStore((s) => s.loadKiroModels);
  // Cursor's model list is large (search it); Codex/Claude are short. Headless
  // agents accept custom model ids or aliases, including Kimi/Kiro.
  const usePicker = session.agent !== 'claude';

  // Reload this agent's model list for the session's host: Cursor's egress/proxy
  // can hide region-gated ids; Codex caches per host (~/.codex/models_cache.json).
  useEffect(() => {
    const h = session.host || undefined;
    if (session.agent === 'cursor') void loadCursorModels(h);
    else if (session.agent === 'codex') void loadCodexModels(h);
    else if (session.agent === 'kimi') void loadKimiCapabilities(h);
    else if (session.agent === 'kiro') void loadKiroModels(h);
  }, [session.agent, session.host, loadCursorModels, loadCodexModels, loadKimiCapabilities, loadKiroModels]);

  return (
    <Menu
      align="right"
      triggerLabel={`Model: ${modelLabel(session.model, cursorModels, codexModels, kimiModels, kiroModels)}`}
      searchable={usePicker}
      allowCustom={usePicker}
      items={modelsForAgent(session.agent, cursorModels, codexModels, kimiModels, kiroModels).map((m) => ({ value: m.value, label: m.label, active: m.value === session.model }))}
      onSelect={(value) => void patchSession(session.id, { model: value })}
      trigger={
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-300 transition hover:border-ink-600">
          <Cpu className="h-4 w-4 text-slate-400" />
        </span>
      }
    />
  );
}

function EffortControl() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const codexModels = useStore((s) => s.codexModels);
  const codexModelOpt = codexModels.find((m) => m.value === session.model) ?? null;

  return (
    <Menu
      align="right"
      triggerLabel={`Effort: ${effortLabel(session.effort)}`}
      items={effortLevelsForAgent(session.agent, codexModelOpt).map((e) => ({ value: e.value, label: e.label, hint: e.hint, active: e.value === session.effort }))}
      onSelect={(value) => void patchSession(session.id, { effort: value as EffortLevel })}
      trigger={
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-300 transition hover:border-ink-600">
          <Gauge className="h-4 w-4 text-slate-400" />
        </span>
      }
    />
  );
}

function PermissionControl() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const kimiPermissionModes = useStore((s) => s.kimiPermissionModes);
  const kiroPermissionModes = useStore((s) => s.kiroPermissionModes);
  const mode = session.permissionMode;

  return (
    <Menu
      align="right"
      triggerLabel={`Permissions: ${permissionModeLabel(mode, session.agent, kimiPermissionModes, kiroPermissionModes)}`}
      items={permissionModesForAgent(session.agent, kimiPermissionModes, kiroPermissionModes).map((m) => ({ value: m.value, label: m.label, hint: m.hint, active: m.value === mode }))}
      onSelect={(value) => void patchSession(session.id, { permissionMode: value as PermissionMode })}
      trigger={
        <span
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition',
            mode === 'bypassPermissions'
              ? 'border-rose-500/30 text-rose-300'
              : 'border-ink-700 text-slate-300 hover:border-ink-600',
          )}
        >
          <ShieldCheck className={cn('h-4 w-4', mode === 'bypassPermissions' ? 'text-rose-300' : 'text-slate-400')} />
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
          Spin up an agent session in any directory and drive it from anywhere.
        </p>
        <button
          onClick={onNewSession}
          className="mt-5 flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg transition hover:bg-accent-soft"
        >
          <Plus className="h-4 w-4" />
          New session
        </button>
      </div>
    </main>
  );
}
