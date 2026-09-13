import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Menu as MenuIcon, Cpu, ShieldCheck, Gauge, FolderGit2, Plus, SquareTerminal, FolderOpen, ArrowLeftRight, Sparkles } from '../lib/icons';
import type { AgentKind, EffortLevel, PermissionMode } from '@shared/protocol';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { AgentQuestions } from './AgentQuestions';
import { PermissionPrompt } from './PermissionPrompt';
import { latestTodos, TodoPane } from './TodoPane';
import { BackgroundTasksPane } from './BackgroundTasksPane';
import { MonitorPane, useSessionMonitors, type SessionMonitorState } from './MonitorPane';
import { TaskRail } from './TaskRail';
import { Menu } from './Menu';
import { SwitchAgentDialog } from './SwitchAgentDialog';
import { FusionModelPicker } from './FusionModelPicker';
import { Logo } from './Logo';
import {
  agentLabel,
  cn,
  effortLabel,
  effortLevelsForAgent,
  defaultFusionSpec,
  devinModelFamilyOf,
  fusionLabelOf,
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
  /** Replaces the mobile hamburger in the header (e.g. Vibot ← Back). */
  headerStart?: ReactNode;
  /** Extra controls after Terminal/Files (e.g. “Open in coding”). */
  headerEnd?: ReactNode;
}

export function ChatView({
  onOpenSidebar,
  onNewSession,
  rightTab,
  onToggleTerminal,
  onToggleFiles,
  headerStart,
  headerEnd,
}: ChatViewProps) {
  const activeId = useStore((s) => s.activeId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const viewMode = useStore((s) => s.viewMode);
  const monitorState = useSessionMonitors(activeId);
  // Chat overlays the composer and needs matching message padding; TUI keeps
  // it in normal flow, outside the message scrollbar. Measure both layouts so
  // auto-follow also handles tasks, attachments, and permission prompts resizing.
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
    <main className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-ink-950', viewMode === 'cli' && 'cli-surface')}>
      <Header
        onOpenSidebar={onOpenSidebar}
        rightTab={rightTab}
        onToggleTerminal={onToggleTerminal}
        onToggleFiles={onToggleFiles}
        headerStart={headerStart}
        headerEnd={headerEnd}
      />
      <div className="flex min-h-0 flex-1">
        <section data-conversation-surface className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList key={`${activeId}:${session.agent}:${session.claudeSessionId ?? ''}`} sessionId={activeId} bottomPad={overlayHeight} />
          {/* TUI reserves a separate, non-shrinking composer row. Only chat
              floats it over the conversation. Compact task panes stay in this
              stack; wide desktop moves them into TaskRail instead. */}
          <div data-conversation-composer className={cn('z-20', viewMode === 'cli'
            ? 'shrink-0 border-t border-ink-700 bg-ink-950'
            : 'pointer-events-none absolute inset-x-0 bottom-0')}>
            <div ref={overlayRef} className="pointer-events-auto">
              <PermissionPrompt sessionId={activeId} />
              <AgentQuestions key={activeId} sessionId={activeId} />
              <div data-outline-slot="composer" />
              <div className="lg:hidden">
                <BackgroundTasksPane sessionId={activeId} />
                <TodoPane sessionId={activeId} />
                <MonitorPane sessionId={activeId} state={monitorState} />
              </div>
              <Composer sessionId={activeId} />
            </div>
          </div>
        </section>
        {!rightTab && <ChatTaskRail sessionId={activeId} monitorState={monitorState} />}
      </div>
    </main>
  );
}

/** Only mounts TaskRail when this session has todos, background tasks, or monitors. */
function ChatTaskRail({ sessionId, monitorState }: { sessionId: string; monitorState: SessionMonitorState }) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const backgroundTasks = useStore((s) => s.tasks[sessionId]);
  const hasTodos = useMemo(() => Boolean(latestTodos(blocks)?.length), [blocks]);
  if (!hasTodos && !backgroundTasks?.length && !monitorState.monitors.length && !monitorState.loading && !monitorState.error) return null;
  return (
    <TaskRail aria-label="Session tasks">
      <div data-outline-slot="rail" />
      <BackgroundTasksPane sessionId={sessionId} layout="rail" />
      <TodoPane sessionId={sessionId} layout="rail" />
      <MonitorPane sessionId={sessionId} state={monitorState} layout="rail" />
    </TaskRail>
  );
}

function useMdUp() {
  const [md, setMd] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setMd(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return md;
}

function ControlChip({
  children,
  title,
  active,
  danger,
}: {
  children: ReactNode;
  title: string;
  active?: boolean;
  danger?: boolean;
}) {
  const cli = useStore((s) => s.viewMode) === 'cli';
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-w-0 shrink-0 items-center justify-center transition',
        cli
          ? 'h-6 max-w-[8rem] overflow-hidden border px-1.5 font-mono text-[10px]'
          : 'h-8 w-8 rounded-lg border',
        danger
          ? 'border-rose-500/30 text-rose-300'
          : active
            ? 'border-accent/50 bg-accent/15 text-accent-soft'
            : 'border-ink-700 text-slate-300 hover:border-ink-600',
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function Header({
  onOpenSidebar,
  rightTab,
  onToggleTerminal,
  onToggleFiles,
  headerStart,
  headerEnd,
}: {
  onOpenSidebar: () => void;
  rightTab?: 'terminal' | 'files' | null;
  onToggleTerminal?: () => void;
  onToggleFiles?: () => void;
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
}) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cli = useStore((s) => s.viewMode) === 'cli';
  const desktop = useMdUp();
  const align = desktop ? 'right' : 'left';

  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <Glass
        className="app-titlebar flex flex-col gap-2 border-b border-white/5 px-3 py-2.5 md:flex-row md:items-center md:gap-3 md:px-5"
        cornerRadius={0}
        thin
      >
      <div className="flex min-w-0 flex-1 items-center gap-3">
      {headerStart ?? (
        <button onClick={onOpenSidebar} className="rounded-lg p-1.5 text-slate-400 hover:bg-ink-800 md:hidden">
          <MenuIcon className="h-5 w-5" />
        </button>
      )}

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
                      : session.agent === 'grok'
                        ? 'bg-amber-500/15 text-amber-300'
                        : session.agent === 'zcode'
                          ? 'bg-rose-500/15 text-rose-300'
                          : session.agent === 'codebuddy'
                            ? 'bg-cyan-500/15 text-cyan-300'
                            : session.agent === 'opencode'
                              ? 'bg-teal-500/15 text-teal-300'
                              : session.agent === 'devin'
                                ? 'bg-indigo-500/15 text-indigo-300'
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
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pl-10 md:justify-end md:pl-0">
      <SwitchAgentControl sessionId={session.id} agent={session.agent} model={session.model} />
      <ModelControl align={align} />
      <FusionControl align={align} />
      {session.agent !== 'cursor' && session.agent !== 'kimi' && <EffortControl align={align} />}
      <PermissionControl align={align} />
      <button type="button" onClick={onToggleTerminal} aria-label="Terminal" title="Terminal">
        <ControlChip title="Terminal" active={rightTab === 'terminal'}>
          {cli ? 'term' : <SquareTerminal className="h-4 w-4" />}
        </ControlChip>
      </button>
      <button type="button" onClick={onToggleFiles} aria-label="Files" title="Files">
        <ControlChip title="Files" active={rightTab === 'files'}>
          {cli ? 'files' : <FolderOpen className="h-4 w-4" />}
        </ControlChip>
      </button>
      {headerEnd}
      </div>
      </Glass>
    </header>
  );
}

/** 「切换 Agent / 模型」入口：把当前会话换成另一个 agent，历史无损保留。 */
function SwitchAgentControl({ sessionId, agent, model }: { sessionId: string; agent: AgentKind; model: string }) {
  const cli = useStore((s) => s.viewMode) === 'cli';
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && (
        <SwitchAgentDialog sessionId={sessionId} currentAgent={agent} currentModel={model} onClose={() => setOpen(false)} />
      )}
      <button type="button" onClick={() => setOpen(true)} aria-label="切换 Agent" title="切换 Agent / 模型">
        <ControlChip title={`当前 ${agent} · 点击切换 Agent / 模型`}>
          {cli ? agent : <ArrowLeftRight className="h-4 w-4 text-slate-400" />}
        </ControlChip>
      </button>
    </>
  );
}

function ModelControl({ align }: { align: 'left' | 'right' }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cli = useStore((s) => s.viewMode) === 'cli';
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kiroModels = useStore((s) => s.kiroModels);
  const grokModels = useStore((s) => s.grokModels);
  const zcodeModels = useStore((s) => s.zcodeModels);
  const codebuddyModels = useStore((s) => s.codebuddyModels);
  const devinModels = useStore((s) => s.devinModels);
  const opencodeModels = useStore((s) => s.opencodeModels);
  const loadCursorModels = useStore((s) => s.loadCursorModels);
  const loadCodexModels = useStore((s) => s.loadCodexModels);
  const loadKimiCapabilities = useStore((s) => s.loadKimiCapabilities);
  const loadKiroModels = useStore((s) => s.loadKiroModels);
  const loadGrokModels = useStore((s) => s.loadGrokModels);
  const loadZcodeModels = useStore((s) => s.loadZcodeModels);
  const loadCodebuddyModels = useStore((s) => s.loadCodebuddyModels);
  const loadDevinModels = useStore((s) => s.loadDevinModels);
  const loadOpencodeModels = useStore((s) => s.loadOpencodeModels);
  const usePicker = session.agent !== 'claude';
  const label = modelLabel(session.model, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels, codebuddyModels, devinModels, opencodeModels);

  useEffect(() => {
    const h = session.host || undefined;
    if (session.agent === 'cursor') void loadCursorModels(h);
    else if (session.agent === 'codex') void loadCodexModels(h);
    else if (session.agent === 'kimi') void loadKimiCapabilities(h);
    else if (session.agent === 'kiro') void loadKiroModels(h);
    else if (session.agent === 'grok') void loadGrokModels(h);
    else if (session.agent === 'zcode') void loadZcodeModels(h);
    else if (session.agent === 'codebuddy') void loadCodebuddyModels(h);
    else if (session.agent === 'devin') void loadDevinModels(h);
    else if (session.agent === 'opencode') void loadOpencodeModels(h);
  }, [session.agent, session.host, loadCursorModels, loadCodexModels, loadKimiCapabilities, loadKiroModels, loadGrokModels, loadZcodeModels, loadCodebuddyModels, loadDevinModels, loadOpencodeModels]);

  return (
    <Menu
      align={align}
      triggerLabel={`Model: ${label}`}
      searchable={usePicker}
      allowCustom={usePicker}
      items={modelsForAgent(session.agent, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels, codebuddyModels, devinModels, opencodeModels).map((m) => ({
        value: m.value,
        label: m.label,
        active: m.value === (session.agent === 'devin' ? devinModelFamilyOf(session.model) : session.model),
      }))}
      onSelect={(value) => {
        let next = value;
        // Picking Fusion from the chip menu takes the default pair; fine-tune
        // the combination in the new-session/switch dialogs.
        if (value === 'fusion' && session.agent === 'devin') {
          const opt = modelsForAgent('devin', cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels, codebuddyModels, devinModels, opencodeModels).find((m) => m.value === 'fusion');
          if (opt?.fusion) next = defaultFusionSpec(opt.fusion);
        }
        void patchSession(session.id, { model: next });
      }}
      trigger={
        <ControlChip title={`Model: ${label}`}>
          {cli ? label : <Cpu className="h-4 w-4 text-slate-400" />}
        </ControlChip>
      }
    />
  );
}

/** Chip + popover to retune the devin fusion pair (strong + normal model)
 *  without leaving the conversation. Applies live via a session patch, so the
 *  next turn already runs the new combination. */
function FusionControl({ align }: { align: 'left' | 'right' }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cli = useStore((s) => s.viewMode) === 'cli';
  const devinModels = useStore((s) => s.devinModels);
  const option = useMemo(
    () => (session.agent === 'devin' ? devinModels.find((m) => m.value === 'fusion') : undefined),
    [session.agent, devinModels],
  );
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (popRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (session.agent !== 'devin' || !session.model.startsWith('fusion') || !option?.fusion) return null;
  const combo = fusionLabelOf(session.model, devinModels)?.split('· ')[1] ?? session.model;

  return (
    <>
      <button
        type="button"
        ref={rootRef}
        aria-label="Fusion combination"
        onClick={() => {
          const r = rootRef.current?.getBoundingClientRect();
          if (r) {
            setPos(
              align === 'right'
                ? { top: r.bottom + 6, right: window.innerWidth - r.right }
                : { top: r.bottom + 6, left: r.left },
            );
          }
          setOpen((v) => !v);
        }}
      >
        <ControlChip title={`Fusion 组合: ${combo}`} active={open}>
          {cli ? combo : <Sparkles className="h-4 w-4 text-slate-400" />}
        </ControlChip>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            style={pos}
            className="fixed z-50 w-[340px] rounded-xl border border-ink-600 bg-ink-850 p-3 shadow-2xl"
          >
            <FusionModelPicker
              option={option}
              value={session.model}
              onChange={(spec) => void patchSession(session.id, { model: spec })}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

function EffortControl({ align }: { align: 'left' | 'right' }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cli = useStore((s) => s.viewMode) === 'cli';
  const codexModels = useStore((s) => s.codexModels);
  const zcodeModels = useStore((s) => s.zcodeModels);
  const devinModels = useStore((s) => s.devinModels);
  const models =
    session.agent === 'zcode' ? zcodeModels : session.agent === 'devin' ? devinModels : codexModels;
  const modelOpt = models.find((m) => m.value === session.model) ?? null;
  const levels = effortLevelsForAgent(session.agent, modelOpt);
  const label = effortLabel(session.effort, session.agent);
  // A ZCode model without a thought-level ladder (e.g. `auto`) has nothing to pick.
  if (!levels.length) return null;

  return (
    <Menu
      align={align}
      triggerLabel={`Effort: ${label}`}
      items={levels.map((e) => ({ value: e.value, label: e.label, hint: e.hint, active: e.value === session.effort }))}
      onSelect={(value) => void patchSession(session.id, { effort: value as EffortLevel })}
      trigger={
        <ControlChip title={`Effort: ${label}`}>
          {cli ? label : <Gauge className="h-4 w-4 text-slate-400" />}
        </ControlChip>
      }
    />
  );
}

function PermissionControl({ align }: { align: 'left' | 'right' }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId))!;
  const cli = useStore((s) => s.viewMode) === 'cli';
  const kimiPermissionModes = useStore((s) => s.kimiPermissionModes);
  const kiroPermissionModes = useStore((s) => s.kiroPermissionModes);
  const mode = session.permissionMode;
  const label = permissionModeLabel(mode, session.agent, kimiPermissionModes, kiroPermissionModes);

  return (
    <Menu
      align={align}
      triggerLabel={`Permissions: ${label}`}
      items={permissionModesForAgent(session.agent, kimiPermissionModes, kiroPermissionModes).map((m) => ({ value: m.value, label: m.label, hint: m.hint, active: m.value === mode }))}
      onSelect={(value) => void patchSession(session.id, { permissionMode: value as PermissionMode })}
      trigger={
        <ControlChip title={`Permissions: ${label}`} danger={mode === 'bypassPermissions'}>
          {cli ? label : <ShieldCheck className={cn('h-4 w-4', mode === 'bypassPermissions' ? 'text-rose-300' : 'text-slate-400')} />}
        </ControlChip>
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
  const cli = useStore((s) => s.viewMode) === 'cli';
  return (
    <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-ink-950 px-6">
      <button onClick={onOpenSidebar} className="absolute left-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-ink-800 md:hidden">
        <MenuIcon className="h-5 w-5" />
      </button>
      <div className={cn('flex flex-col', cli ? 'max-w-md font-mono text-left' : 'items-center text-center')}>
        {!cli && <Logo className="mb-5 h-12 w-12 text-accent/80" />}
        <h2 className={cn(cli ? 'text-[13.5px] text-slate-200' : 'text-lg font-semibold text-slate-200')}>
          {cli ? '// start a session' : 'Start vibe coding'}
        </h2>
        <p className={cn('mt-1.5 max-w-xs text-slate-500', cli ? 'text-[12.5px]' : 'text-sm')}>
          {cli
            ? 'Pick a directory and an agent. Output renders as a terminal transcript.'
            : 'Spin up an agent session in any directory and drive it from anywhere.'}
        </p>
        <button
          onClick={onNewSession}
          className={cn(
            'mt-5 flex items-center gap-2 font-semibold text-accent-fg transition hover:bg-accent-soft',
            cli ? 'h-8 bg-accent px-3 font-mono text-[12px]' : 'rounded-xl bg-accent px-4 py-2.5 text-sm',
          )}
        >
          {cli ? '> new session' : <><Plus className="h-4 w-4" />New session</>}
        </button>
      </div>
    </main>
  );
}
