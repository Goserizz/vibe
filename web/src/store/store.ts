import { create } from 'zustand';
import type {
  AgentKind,
  BackgroundTask,
  EffortLevel,
  McpConfigSnapshot,
  McpServerDef,
  Monitor,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProjectDir,
  RemoteHost,
  SearchResult,
  ServerEvent,
  SessionMeta,
  SessionPreset,
  SkillDetail,
  SkillEntry,
  SkillScope,
  ConfigFileDetail,
  ConfigFileEntry,
  SwitchFidelity,
  QueuedSessionRequest,
  SessionRequestQueueState,
  AgentQuestionState,
} from '@shared/protocol';
import { compareSessions } from '@shared/protocol';
import type { SessionMonitorSummary } from '@shared/monitorSummary';
import { createMonitorSummaryLoader } from './monitorSummaries';
import { api, ApiError, setApiToken } from '../lib/api';
import type { ModelOption, PermissionOption } from '../lib/format';
import { VibeSocket, type ConnStatus } from '../lib/ws';
import { clearToken } from '../lib/token';
import { resolveFilePath } from '../lib/paths';
import { loadNotifySound, playNotifySound, saveNotifySound, type NotifySoundId } from '../lib/notifySound';
import { applyViewModeClass, loadViewMode, saveViewMode, type ViewMode } from '../lib/viewMode';
import { loadContrast, saveContrast, type Contrast } from '../lib/contrast';
import {
  applyAccent,
  loadAccentPreference,
  saveAccentPreference,
  type AccentPreference,
} from '../lib/systemAccent';
import { emptyView, prependPage, reduceView, viewFromBlocks, type SessionView } from './blocks';
import { useVibotStore, vibotHandleBatch } from './vibot';

let socket: VibeSocket | null = null;

export interface PendingSessionSend extends QueuedSessionRequest {
  state: 'sending' | 'failed';
  error?: string;
}
/** The single VibeSocket, owned here, is shared by the separate Vibot store. */
export function getSocket(): VibeSocket | null {
  return socket;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

// Debounced full-text search: a timer per keystroke + a monotonic id so stale
// in-flight responses are discarded.
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchReqId = 0;

// Model discovery is stale-while-revalidate on the server: the first response
// may be a fallback while a background CLI/SSH refresh runs. Generations discard
// stale re-pulls when the user switches host quickly; a short follow-up fetch
// picks up the warmed cache.
let cursorModelsGen = 0;
let codexModelsGen = 0;
let kimiModelsGen = 0;
let kiroModelsGen = 0;
let grokModelsGen = 0;
let zcodeModelsGen = 0;
let codebuddyModelsGen = 0;
let devinModelsGen = 0;
let opencodeModelsGen = 0;
const MODEL_REPULL_MS = 2_500;

// Sessions the user aborted this turn. Their end-of-turn chime is suppressed
// (they stopped it themselves, so no need to notify). Consumed by the next
// run_state for that session; cleared if a fresh turn starts instead.
const abortedSessions = new Set<string>();

// Sessions with a subscribe in flight (subscribe sent, `subscribed` frame not
// yet back). Their run_state frames are replayed history — e.g. a turn that
// finished while we were unsubscribed already chimed via session_meta — so
// opening such a session must not ring again.
const replayingSubs = new Set<string>();

type Theme = 'dark' | 'light';

const LIGHT_MQ = '(prefers-color-scheme: light)';

function initialTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia(LIGHT_MQ).matches
    ? 'light'
    : 'dark';
}

interface StoreState {
  phase: 'loading' | 'unauthorized' | 'ready';
  status: ConnStatus;
  serverVersion: string;
  defaultModel: string;
  /** Account resolved from the login token ('admin' = the server superuser). */
  account: string;
  /** True for the admin token holder: sees every host/session, manages accounts. */
  isAdmin: boolean;
  cursorModels: ModelOption[];
  codexModels: ModelOption[];
  kimiModels: ModelOption[];
  kimiPermissionModes: PermissionOption[];
  kiroModels: ModelOption[];
  kiroPermissionModes: PermissionOption[];
  grokModels: ModelOption[];
  zcodeModels: ModelOption[];
  codebuddyModels: ModelOption[];
  /** Devin model families — effort is chosen separately and the server
   *  assembles the variant uid. */
  devinModels: ModelOption[];
  opencodeModels: ModelOption[];
  theme: Theme;
  /** Sound played when a model turn finishes. Persisted in localStorage. */
  notifySound: NotifySoundId;
  /** Conversation chrome: card UI vs CLI-style transcript. Persisted. */
  viewMode: ViewMode;
  /** Accent color: follow OS or a manual hex. Persisted in localStorage. */
  accent: AccentPreference;
  /** UI contrast: default glassy look or pure-white/black hairlines. Persisted. */
  contrast: Contrast;

  sessions: SessionMeta[];
  /** Account-scoped durable Monitor state, independent of live agent runtimes. */
  sessionMonitors: Record<string, SessionMonitorSummary>;
  /** The rail and sidebar derive from the same account-scoped list snapshot. */
  monitorRecords: Monitor[];
  monitorLoaded: boolean;
  monitorLoading: boolean;
  monitorError: string | null;
  projects: ProjectDir[];
  /** Custom display names for sidebar project groups (key `host::cwd` → name).
   *  The groups themselves derive from pinned sessions; only names persist. */
  projectNames: Record<string, string>;
  hosts: RemoteHost[];
  /** MCP server registry + per-scope enable lists. */
  mcp: McpConfigSnapshot;
  /** Saved New-session engine presets (agent + model + permission + effort). */
  presets: SessionPreset[];
  /** Agent skills for the currently-selected agent + host (personal + system).
   *  Loaded lazily when the Skills panel is opened. */
  skills: SkillEntry[];
  /** Agent whose skills are in `skills`. */
  skillsAgent: AgentKind | null;
  /** Host name whose skills are in `skills` (null = this machine). */
  skillsHost: string | null;
  /** Agent config files for the currently-selected agent + host. Loaded lazily
   *  when the Agent config files panel is opened. */
  agentConfigFiles: ConfigFileEntry[];
  /** Agent whose config files are in `agentConfigFiles`. */
  agentConfigAgent: AgentKind | null;
  /** Host name whose config files are in `agentConfigFiles` (null = this machine). */
  agentConfigHost: string | null;
  localName: string;
  activeId: string | null;
  views: Record<string, SessionView>;
  pending: Record<string, PermissionRequest[]>;
  /** Native background tasks keyed by session. */
  tasks: Record<string, BackgroundTask[]>;
  requestQueues: Record<string, SessionRequestQueueState>;
  requestOutbox: Record<string, PendingSessionSend[]>;
  agentQuestions: Record<string, AgentQuestionState>;
  agentQuestionsSupported: boolean;
  questionActions: Record<string, Record<string, { sending: boolean; error?: string }>>;
  /** Sessions whose last turn finished while they weren't the active one — i.e.
   *  "has a reply you haven't seen yet". Cleared by opening the session. Lives
   *  only in memory: it tracks live running→idle transitions, not history. */
  unread: Record<string, true>;
  // Per-session right-panel state: which tab (if any) each session has open.
  // Keyed by sessionId so opening/closing the Terminal or Files panel in one
  // session never affects another.
  rightTabs: Record<string, 'terminal' | 'files' | null>;
  toast: string | null;
  /** File-path preview opened from a clickable path in a reply. The path is
   *  already resolved against the active session's cwd; `host` is set only for
   *  remote sessions. */
  filePreview: { path: string; host?: string } | null;
  /** Open a path found in a reply (raw, as written) in the preview modal,
   *  resolving it against the active session's cwd/host. */
  openPathPreview: (rawPath: string) => void;
  closeFilePreview: () => void;

  searchQuery: string;
  searchResults: SearchResult[];
  searchLoading: boolean;
  setSearchQuery: (q: string) => void;

  init: (token: string) => Promise<void>;
  signOut: () => void;
  refreshSessions: () => Promise<void>;
  loadSessionMonitors: () => Promise<void>;
  loadProjects: () => Promise<void>;
  loadProjectNames: () => Promise<void>;
  /** Set (empty string resets to the default `host · basename` title). */
  renameProject: (host: string | undefined, cwd: string, name: string) => Promise<void>;
  loadHosts: () => Promise<void>;
  /** Load Cursor models for the local CLI, or for a remote host (with its proxy). */
  loadCursorModels: (host?: string) => Promise<void>;
  /** Load Codex models from the local cache, or the remote host's cache. */
  loadCodexModels: (host?: string) => Promise<void>;
  /** Discover configured Kimi models and ACP permission modes on a host. */
  loadKimiCapabilities: (host?: string) => Promise<void>;
  /** Load Kiro models (and fixed permission modes) for local or remote CLI. */
  loadKiroModels: (host?: string) => Promise<void>;
  /** Load Grok models for local or remote CLI. */
  loadGrokModels: (host?: string) => Promise<void>;
  /** Load ZCode models for local or remote CLI (from its config.json). */
  loadZcodeModels: (host?: string) => Promise<void>;
  /** Load CodeBuddy models for local or remote CLI (parsed from `--help`). */
  loadCodebuddyModels: (host?: string) => Promise<void>;
  /** Load Devin model families for local or remote CLI (`devin models list`). */
  loadDevinModels: (host?: string) => Promise<void>;
  /** Load opencode models for local or remote CLI (`opencode models`). */
  loadOpencodeModels: (host?: string) => Promise<void>;
  addHost: (host: RemoteHost) => Promise<boolean>;
  updateHost: (name: string, patch: { ssh?: string; proxy?: string; proxyByAgent?: Partial<Record<AgentKind, string>> }) => Promise<boolean>;
  removeHost: (name: string) => Promise<void>;
  /** Reload the MCP registry + enable lists from the server. */
  loadMcp: () => Promise<void>;
  /** Insert or update a server definition. */
  upsertMcpServer: (def: McpServerDef) => Promise<boolean>;
  deleteMcpServer: (name: string) => Promise<void>;
  /** Set the enabled server names for a scope ('local' or a host name). */
  setMcpEnabled: (scope: string, names: string[]) => Promise<void>;
  /** Reload saved New-session presets from the server. */
  loadPresets: () => Promise<void>;
  /** Insert or update a preset (keyed by name). */
  upsertPreset: (preset: SessionPreset) => Promise<boolean>;
  deletePreset: (name: string) => Promise<void>;
  /** Reload skills for an agent + host (undefined host = this machine). */
  loadSkills: (agent: AgentKind, host?: string) => Promise<void>;
  /** Read one skill's full content (frontmatter + body). */
  readSkillDetail: (args: { agent: AgentKind; host?: string; name: string; scope?: SkillScope; source?: string }) => Promise<SkillDetail | null>;
  /** Create/update a personal skill across one or more agents — same content
   *  written to each selected agent's skills dir. Returns true iff all succeeded. */
  saveSkillMulti: (input: { agents: AgentKind[]; name: string; description: string; whenToUse?: string; body: string; host?: string }) => Promise<boolean>;
  /** Delete a personal skill. */
  deleteSkillAction: (agent: AgentKind, host: string | undefined, name: string) => Promise<void>;
  /** Reload config files for an agent + host (undefined host = this machine). */
  loadAgentConfig: (agent: AgentKind, host?: string) => Promise<void>;
  /** Read one config file's raw content. */
  readAgentConfigDetail: (args: { agent: AgentKind; host?: string; id: string }) => Promise<ConfigFileDetail | null>;
  /** Create or overwrite a config file. Returns the updated detail, or null on failure. */
  saveAgentConfigFile: (args: { agent: AgentKind; host?: string; id: string; content: string }) => Promise<ConfigFileDetail | null>;
  openSession: (id: string) => Promise<void>;
  /** Fetch the next older history page for an open conversation. No-op when
   *  none is left or a request is already in flight. */
  loadOlder: (id: string, signal?: AbortSignal) => Promise<void>;
  createSession: (input: { cwd?: string; autoCwd?: boolean; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; agent?: AgentKind; title?: string; host?: string; pinned?: boolean }) => Promise<boolean>;
  renameSession: (id: string, title: string) => Promise<void>;
  /** 把会话切换成另一个 agent（历史无损保留）。返回保真等级，失败返回 null。 */
  switchSessionAgent: (
    id: string,
    input: { agent: AgentKind; model?: string; carryThinking?: boolean },
  ) => Promise<SwitchFidelity | null>;
  deleteSession: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  sendMessage: (text: string, sessionId?: string) => boolean;
  retryPendingRequest: (sessionId: string, clientMsgId: string) => void;
  removeQueuedRequest: (sessionId: string, clientMsgId: string) => void;
  controlRequestQueue: (sessionId: string, action: 'pause' | 'resume') => void;
  answerAgentQuestion: (sessionId: string, questionId: string, answers: string[], retry?: boolean) => void;
  dismissAgentQuestion: (sessionId: string, questionId: string) => void;
  refreshAgentQuestions: (sessionId: string) => void;
  abort: () => void;
  stopTask: (taskId: string) => void;
  respondPermission: (requestId: string, decision: PermissionDecision) => void;
  setToast: (msg: string | null) => void;
  setRightTab: (id: string, tab: 'terminal' | 'files' | null) => void;
  setNotifySound: (id: NotifySoundId) => void;
  setViewMode: (mode: ViewMode) => void;
  setAccent: (pref: AccentPreference) => void;
  setContrast: (contrast: Contrast) => void;
}

export const useStore = create<StoreState>((set, get) => {
  const monitorLoader = createMonitorSummaryLoader(
    api.listMonitors,
    (sessionMonitors, monitorRecords) => set({ sessionMonitors, monitorRecords, monitorLoaded: true }),
    ({ loading, error }) => set({ monitorLoading: loading, monitorError: error }),
  );
  let monitorRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let socketGeneration = 0;
  // -- socket event handling -------------------------------------------------

  /** Send subscribe and mark the session as replaying until `subscribed`
   *  arrives, so replayed run_state frames don't trigger the done chime. */
  function sendSubscribe(id: string, lastSeq: number): void {
    replayingSubs.add(id);
    socket?.send({ t: 'subscribe', sessionId: id, lastSeq });
  }

  function resubscribe(id: string): void {
    const view = get().views[id];
    sendSubscribe(id, view?.lastSeq ?? 0);
  }

  function handleStatus(status: ConnStatus, opts: { reconnected: boolean }): void {
    set({ status });
    if (status === 'open') {
      const { activeId } = get();
      if (activeId) resubscribe(activeId);
      // Only unacknowledged sends are retried. Server-side message-id dedupe
      // covers a connection lost after durable acceptance but before the ACK.
      for (const [sessionId, items] of Object.entries(get().requestOutbox)) {
        for (const item of items) if (item.state === 'sending') {
          socket?.send({ t: 'send', sessionId, clientMsgId: item.id, text: item.text });
        }
      }
      if (opts.reconnected) {
        void get().refreshSessions();
        void get().loadSessionMonitors();
      }
      // Every open (first connect + reconnect): Vibot must resubscribe. A
      // subscribe sent while the socket was still connecting was previously
      // dropped on the floor — wake notes then never arrived until refresh.
      void useVibotStore.getState().onReconnect();
    }
  }

  function handleBatch(events: ServerEvent[]): void {
    const state = get();
    // Collected mutations applied in a single set() at the end (one render).
    const eventsBySession = new Map<string, { seq: number; ev: import('@shared/protocol').LiveEvent }[]>();
    const pendingPatch: Record<string, PermissionRequest[]> = {};
    const taskPatch: Record<string, BackgroundTask[]> = {};
    let sessions = state.sessions;
    let sessionsDirty = false;
    const resetIds: string[] = [];
    const setRunning: Record<string, boolean> = {};
    // Track transitions inside this animation-frame batch too. A short native
    // background wake can start and finish between two wire polls, so its
    // run_state true/false frames may arrive together.
    const liveRunning = new Map<string, boolean>();
    let playDoneSound = false;
    const finishedUnreadIds: string[] = [];
    let monitorToast: string | undefined;
    let monitorsDirty = false;
    let requestQueues = state.requestQueues;
    let requestOutbox = state.requestOutbox;
    let agentQuestions = state.agentQuestions;
    let questionActions = state.questionActions;
    const acknowledge = (sessionId: string, id: string) => {
      const items = requestOutbox[sessionId];
      if (items?.some((item) => item.id === id)) {
        requestOutbox = { ...requestOutbox, [sessionId]: items.filter((item) => item.id !== id) };
      }
    };

    const push = (sid: string, seq: number, ev: import('@shared/protocol').LiveEvent) => {
      let arr = eventsBySession.get(sid);
      if (!arr) {
        arr = [];
        eventsBySession.set(sid, arr);
      }
      arr.push({ seq, ev });
    };

    for (const msg of events) {
      switch (msg.t) {
        case 'event':
          if (msg.ev.k === 'block' && msg.ev.block.kind === 'user') acknowledge(msg.sessionId, msg.ev.block.id);
          if (msg.ev.k === 'task_upsert') {
            const task = msg.ev.task;
            const current = taskPatch[msg.sessionId] ?? state.tasks[msg.sessionId] ?? [];
            taskPatch[msg.sessionId] = [
              task,
              ...current.filter((entry) => entry.id !== task.id),
            ].sort((a, b) => b.startedAt - a.startedAt);
          }
          if (msg.ev.k === 'run_state') {
            if (msg.ev.running) {
              // A fresh turn started — any stale abort flag is now irrelevant.
              abortedSessions.delete(msg.sessionId);
            } else {
              // Notify when a live turn ends (true → false). Skip replayed
              // frames while a subscribe is in flight (old news — session_meta
              // already chimed) and skip turns the user aborted. `delete`
              // returns true iff it was an abort.
              const wasRunning = liveRunning.get(msg.sessionId) ?? state.views[msg.sessionId]?.running;
              if (wasRunning && !replayingSubs.has(msg.sessionId) && !abortedSessions.delete(msg.sessionId)) {
                playDoneSound = true;
              }
            }
            liveRunning.set(msg.sessionId, msg.ev.running);
          }
          push(msg.sessionId, msg.seq, msg.ev);
          break;
        case 'subscribed':
          agentQuestions = { ...agentQuestions, [msg.sessionId]: msg.agentQuestions ?? { items: [] } };
          questionActions = { ...questionActions, [msg.sessionId]: {} };
          requestQueues = { ...requestQueues, [msg.sessionId]: msg.requestQueue ?? { items: [], paused: false } };
          for (const item of msg.requestQueue?.items ?? []) acknowledge(msg.sessionId, item.id);
          // Replay (if any) landed ahead of this frame — back to live events.
          replayingSubs.delete(msg.sessionId);
          setRunning[msg.sessionId] = msg.running;
          pendingPatch[msg.sessionId] = msg.pendingPermissions;
          taskPatch[msg.sessionId] = msg.tasks;
          if (msg.reset) resetIds.push(msg.sessionId);
          break;
        case 'permission_request': {
          const cur = pendingPatch[msg.sessionId] ?? state.pending[msg.sessionId] ?? [];
          pendingPatch[msg.sessionId] = [...cur.filter((p) => p.requestId !== msg.request.requestId), msg.request];
          break;
        }
        case 'permission_resolved': {
          const cur = pendingPatch[msg.sessionId] ?? state.pending[msg.sessionId] ?? [];
          pendingPatch[msg.sessionId] = cur.filter((p) => p.requestId !== msg.requestId);
          break;
        }
        case 'session_meta': {
          // The hub broadcasts session_meta (with `running`) to every client on
          // turn start/end, so this is how we learn a background session just
          // finished. running true→false on a non-active session ⇒ mark unread
          // and chime (the run_state chime only fires for the active session).
          const prev = sessions.find((s) => s.id === msg.session.id);
          if (prev?.running && !msg.session.running && msg.session.id !== state.activeId) {
            finishedUnreadIds.push(msg.session.id);
            playDoneSound = true;
          }
          const others = sessions.filter((s) => s.id !== msg.session.id);
          sessions = [msg.session, ...others].sort(compareSessions);
          sessionsDirty = true;
          break;
        }
        case 'send_ack':
          acknowledge(msg.sessionId, msg.clientMsgId);
          break;
        case 'request_queue':
          requestQueues = { ...requestQueues, [msg.sessionId]: msg.queue };
          for (const item of msg.queue.items) acknowledge(msg.sessionId, item.id);
          break;
        case 'agent_questions': {
          agentQuestions = { ...agentQuestions, [msg.sessionId]: msg.state };
          const ids = new Set(msg.state.items.map(item => item.id));
          questionActions = { ...questionActions, [msg.sessionId]: Object.fromEntries(
            Object.entries(questionActions[msg.sessionId] ?? {}).filter(([id]) => ids.has(id)),
          ) };
          break;
        }
        case 'agent_question_result':
          if (msg.ok && agentQuestions[msg.sessionId]) agentQuestions = { ...agentQuestions, [msg.sessionId]: {
            ...agentQuestions[msg.sessionId], items: agentQuestions[msg.sessionId]!.items.filter(item => item.id !== msg.questionId),
          } };
          questionActions = { ...questionActions, [msg.sessionId]: { ...(questionActions[msg.sessionId] ?? {}),
            [msg.questionId]: { sending: false, ...(msg.ok ? {} : { error: msg.message ?? 'Answer could not be sent' }) },
          } };
          if (msg.ok) set({ toast: msg.delivery === 'steered' ? 'Answer sent to the active Codex turn'
            : msg.delivery === 'queued' ? 'Answer added to Next requests; paused queues must be resumed'
              : 'Question dismissed; no answer was sent' });
          break;
        case 'monitor_changed':
          monitorsDirty = true;
          window.dispatchEvent(new CustomEvent('vibe-monitor-changed', { detail: { monitorId: msg.monitorId } }));
          break;
        case 'monitor_notice':
          monitorsDirty = true;
          window.dispatchEvent(new CustomEvent('vibe-monitor-changed', { detail: { monitorId: msg.monitorId } }));
          if (msg.sessionId !== state.activeId) {
            finishedUnreadIds.push(msg.sessionId);
            monitorToast = msg.text;
            playDoneSound = true;
          }
          break;
        case 'session_removed':
          agentQuestions = { ...agentQuestions }; delete agentQuestions[msg.sessionId];
          questionActions = { ...questionActions }; delete questionActions[msg.sessionId];
          requestQueues = { ...requestQueues };
          requestOutbox = { ...requestOutbox };
          delete requestQueues[msg.sessionId];
          delete requestOutbox[msg.sessionId];
          sessions = sessions.filter((s) => s.id !== msg.sessionId);
          sessionsDirty = true;
          break;
        case 'hello':
          set({ serverVersion: msg.serverVersion, agentQuestionsSupported: msg.agentQuestionsVersion === 1 });
          break;
        case 'error':
          if (msg.sessionId && msg.clientMsgId) {
            requestOutbox = { ...requestOutbox, [msg.sessionId]: (requestOutbox[msg.sessionId] ?? []).map((item) => (
              item.id === msg.clientMsgId ? { ...item, state: 'failed', error: msg.message } : item
            )) };
          }
          set({ toast: msg.message });
          break;
      }
    }

    set((s) => {
      const views = { ...s.views };
      for (const [sid, evs] of eventsBySession) {
        const view = views[sid] ?? emptyView();
        views[sid] = reduceView(view, evs);
      }
      for (const sid of Object.keys(setRunning)) {
        const view = views[sid] ?? emptyView();
        views[sid] = { ...view, running: setRunning[sid] };
      }
      const pending = Object.keys(pendingPatch).length ? { ...s.pending, ...pendingPatch } : s.pending;
      const tasks = Object.keys(taskPatch).length ? { ...s.tasks, ...taskPatch } : s.tasks;
      const unread = finishedUnreadIds.length
        ? { ...s.unread, ...Object.fromEntries(finishedUnreadIds.map((id) => [id, true as const])) }
        : s.unread;
      return {
        views,
        pending,
        tasks,
        requestQueues,
        requestOutbox,
        agentQuestions,
        questionActions,
        unread,
        ...(monitorToast ? { toast: monitorToast } : {}),
        sessions: sessionsDirty ? sessions : s.sessions,
      };
    });

    if (playDoneSound) playNotifySound(get().notifySound);
    if (monitorsDirty) void get().loadSessionMonitors();

    // Stale-replay recovery: reload transcript then resubscribe.
    for (const sid of resetIds) {
      void reloadAndResubscribe(sid);
    }
  }

  async function reloadAndResubscribe(id: string): Promise<void> {
    try {
      const page = await api.getMessages(id);
      const running = get().sessions.find((s) => s.id === id)?.running ?? false;
      set((s) => ({ views: { ...s.views, [id]: viewFromBlocks(page.blocks, page.seq, running, page) } }));
      sendSubscribe(id, page.seq);
    } catch {
      /* ignore */
    }
  }

  // -- public actions --------------------------------------------------------

  return {
    phase: 'loading',
    status: 'connecting',
    serverVersion: '',
    defaultModel: 'opus',
    account: '',
    isAdmin: false,
    cursorModels: [],
    codexModels: [],
    kimiModels: [],
    kimiPermissionModes: [],
    kiroModels: [],
    kiroPermissionModes: [],
    grokModels: [],
    zcodeModels: [],
    codebuddyModels: [],
    devinModels: [],
    opencodeModels: [],
    theme: initialTheme(),
    notifySound: loadNotifySound(),
    viewMode: loadViewMode(),
    accent: loadAccentPreference(),
    contrast: loadContrast(),
    sessions: [],
    sessionMonitors: {},
    monitorRecords: [],
    monitorLoaded: false,
    monitorLoading: false,
    monitorError: null,
    projects: [],
    projectNames: {},
    hosts: [],
    mcp: { servers: [], enabled: {}, oauth: {} },
    presets: [],
    skills: [],
    skillsAgent: null,
    skillsHost: null,
    agentConfigFiles: [],
    agentConfigAgent: null,
    agentConfigHost: null,
    localName: 'local',
    activeId: null,
    views: {},
    pending: {},
    tasks: {},
    requestQueues: {},
    requestOutbox: {},
    agentQuestions: {},
    questionActions: {},
    agentQuestionsSupported: false,
    unread: {},
    rightTabs: {},
    toast: null,
    filePreview: null,
    searchQuery: '',
    searchResults: [],
    searchLoading: false,

    async init(token: string) {
      const generation = ++socketGeneration;
      set({ agentQuestions: {}, questionActions: {}, agentQuestionsSupported: false });
      monitorLoader.reset();
      clearInterval(monitorRefreshTimer);
      set({ sessionMonitors: {}, monitorRecords: [], monitorLoaded: false, monitorLoading: false, monitorError: null, requestQueues: {}, requestOutbox: {} });
      setApiToken(token);
      try {
        const me = await api.me();
        if (generation !== socketGeneration) return;
        set({ defaultModel: me.defaultModel, serverVersion: me.serverVersion, account: me.account, isAdmin: me.isAdmin });
      } catch (err) {
        if (generation !== socketGeneration) return;
        if (err instanceof ApiError && err.status === 401) {
          set({ phase: 'unauthorized' });
          return;
        }
        set({ toast: 'Failed to reach server' });
      }

      socket?.close();
      socket = new VibeSocket({
        onBatch: events => { if (generation === socketGeneration) handleBatch(events); },
        onStatus: (status, options) => { if (generation === socketGeneration) handleStatus(status, options); },
        onVibotBatch: events => { if (generation === socketGeneration) vibotHandleBatch(events); },
      });
      socket.connect(token);
      // Badges should not hold up opening the app if the Monitor endpoint is slow.
      void get().loadSessionMonitors();

      const admin = get().isAdmin;
      await Promise.all([
        get().refreshSessions(),
        // Recent projects + local CLI probing are local-machine features.
        ...(admin ? [get().loadProjects()] : []),
        get().loadProjectNames(),
        get().loadHosts(),
        get().loadMcp(),
        get().loadPresets(),
      ]);
      set({ phase: 'ready' });
      // One low-frequency refresh for the whole list also covers an API error
      // or a browser that slept through a WS change; never one request per row.
      clearInterval(monitorRefreshTimer);
      monitorRefreshTimer = setInterval(() => { void get().loadSessionMonitors(); }, 30_000);

      // Model lists never gate the splash — server serves cache/fallback instantly
      // and refreshes CLIs in the background; these fill the pickers when ready.
      // Skipped for non-admin accounts (local machine is admin-only); their
      // pickers fill from the per-host loads in the New Session dialog.
      if (admin) {
        void get().loadCursorModels();
        void get().loadCodexModels();
        void get().loadKimiCapabilities();
        void get().loadKiroModels();
        void get().loadGrokModels();
        void get().loadZcodeModels();
        void get().loadCodebuddyModels();
        void get().loadDevinModels();
        void get().loadOpencodeModels();
      }

      const { sessions, activeId } = get();
      if (!activeId && sessions.length > 0) void get().openSession(sessions[0].id);
    },

    signOut() {
      socketGeneration++;
      set({ agentQuestions: {}, questionActions: {}, agentQuestionsSupported: false });
      monitorLoader.reset();
      clearInterval(monitorRefreshTimer);
      socket?.close();
      socket = null;
      clearToken();
      set({ requestQueues: {}, requestOutbox: {} });
      set({ phase: 'unauthorized', account: '', isAdmin: false, sessions: [], sessionMonitors: {}, monitorRecords: [], monitorLoaded: false, monitorLoading: false, monitorError: null, views: {}, tasks: {}, rightTabs: {}, unread: {}, activeId: null, filePreview: null, searchQuery: '', searchResults: [], searchLoading: false });
    },

    async loadSessionMonitors() {
      if (!get().account) return;
      await monitorLoader.refresh();
    },

    async refreshSessions() {
      try {
        const sessions = await api.listSessions();
        set({ sessions });
      } catch {
        /* ignore */
      }
    },

    async loadProjects() {
      try {
        const projects = await api.listProjects();
        set({ projects: Array.isArray(projects) ? projects : [] });
      } catch {
        /* ignore */
      }
    },

    async loadProjectNames() {
      try {
        set({ projectNames: await api.listProjectNames() });
      } catch {
        /* ignore — groups fall back to default titles */
      }
    },

    async renameProject(host, cwd, name) {
      const prev = get().projectNames;
      try {
        set({ projectNames: await api.renameProject(host, cwd, name) });
      } catch {
        set({ toast: 'Failed to rename project' });
        set({ projectNames: prev });
      }
    },

    async loadCursorModels(host?: string) {
      const gen = ++cursorModelsGen;
      try {
        const cursorModels = await api.listCursorModels(host);
        if (gen === cursorModelsGen) set({ cursorModels });
      } catch {
        /* ignore — the picker falls back to a small static list */
      }
      window.setTimeout(() => {
        if (gen !== cursorModelsGen) return;
        void api
          .listCursorModels(host)
          .then((cursorModels) => {
            if (gen === cursorModelsGen) set({ cursorModels });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadCodexModels(host?: string) {
      const gen = ++codexModelsGen;
      try {
        const codexModels = await api.listCodexModels(host);
        if (gen === codexModelsGen) set({ codexModels });
      } catch {
        /* ignore — the picker falls back to a small static list */
      }
      window.setTimeout(() => {
        if (gen !== codexModelsGen) return;
        void api
          .listCodexModels(host)
          .then((codexModels) => {
            if (gen === codexModelsGen) set({ codexModels });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadKimiCapabilities(host?: string) {
      const gen = ++kimiModelsGen;
      try {
        const { models, permissions } = await api.getKimiCapabilities(host);
        if (gen === kimiModelsGen) set({ kimiModels: models, kimiPermissionModes: permissions });
      } catch {
        /* ignore — selectors retain their conservative prompt-mode fallback */
      }
      window.setTimeout(() => {
        if (gen !== kimiModelsGen) return;
        void api
          .getKimiCapabilities(host)
          .then(({ models, permissions }) => {
            if (gen === kimiModelsGen) set({ kimiModels: models, kimiPermissionModes: permissions });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadKiroModels(host?: string) {
      const gen = ++kiroModelsGen;
      try {
        const { models, permissions } = await api.listKiroModels(host);
        if (gen === kiroModelsGen) set({ kiroModels: models, kiroPermissionModes: permissions });
      } catch {
        /* ignore — picker falls back to Auto + static permission modes */
      }
      window.setTimeout(() => {
        if (gen !== kiroModelsGen) return;
        void api
          .listKiroModels(host)
          .then(({ models, permissions }) => {
            if (gen === kiroModelsGen) set({ kiroModels: models, kiroPermissionModes: permissions });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadGrokModels(host?: string) {
      const gen = ++grokModelsGen;
      try {
        const { models } = await api.listGrokModels(host);
        if (gen === grokModelsGen) set({ grokModels: models });
      } catch {
        /* ignore — picker falls back to Auto + static Grok models */
      }
      window.setTimeout(() => {
        if (gen !== grokModelsGen) return;
        void api
          .listGrokModels(host)
          .then(({ models }) => {
            if (gen === grokModelsGen) set({ grokModels: models });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadZcodeModels(host?: string) {
      const gen = ++zcodeModelsGen;
      try {
        const { models } = await api.listZcodeModels(host);
        if (gen === zcodeModelsGen) set({ zcodeModels: models });
      } catch {
        /* ignore — picker falls back to Auto + static ZCode models */
      }
      window.setTimeout(() => {
        if (gen !== zcodeModelsGen) return;
        void api
          .listZcodeModels(host)
          .then(({ models }) => {
            if (gen === zcodeModelsGen) set({ zcodeModels: models });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadCodebuddyModels(host?: string) {
      const gen = ++codebuddyModelsGen;
      try {
        const { models } = await api.listCodebuddyModels(host);
        if (gen === codebuddyModelsGen) set({ codebuddyModels: models });
      } catch {
        /* ignore — picker falls back to Auto + static CodeBuddy models */
      }
      window.setTimeout(() => {
        if (gen !== codebuddyModelsGen) return;
        void api
          .listCodebuddyModels(host)
          .then(({ models }) => {
            if (gen === codebuddyModelsGen) set({ codebuddyModels: models });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadDevinModels(host?: string) {
      const gen = ++devinModelsGen;
      try {
        const { models } = await api.listDevinModels(host);
        if (gen === devinModelsGen) set({ devinModels: models });
      } catch {
        /* ignore — picker falls back to Auto + static Devin families */
      }
      window.setTimeout(() => {
        if (gen !== devinModelsGen) return;
        void api
          .listDevinModels(host)
          .then(({ models }) => {
            if (gen === devinModelsGen) set({ devinModels: models });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadOpencodeModels(host?: string) {
      const gen = ++opencodeModelsGen;
      try {
        const { models } = await api.listOpencodeModels(host);
        if (gen === opencodeModelsGen) set({ opencodeModels: models });
      } catch {
        /* ignore — picker falls back to Auto */
      }
      window.setTimeout(() => {
        if (gen !== opencodeModelsGen) return;
        void api
          .listOpencodeModels(host)
          .then(({ models }) => {
            if (gen === opencodeModelsGen) set({ opencodeModels: models });
          })
          .catch(() => {});
      }, MODEL_REPULL_MS);
    },

    async loadHosts() {
      try {
        const { hosts, localName } = await api.listHosts();
        set({ hosts, localName });
      } catch {
        /* ignore */
      }
    },

    async addHost(host) {
      try {
        await api.addHost(host);
        await get().loadHosts();
        void get().refreshSessions();
        return true;
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to add host' });
        return false;
      }
    },

    async updateHost(name, patch) {
      try {
        const host = await api.updateHost(name, patch);
        set((s) => ({ hosts: s.hosts.map((h) => (h.name === name ? host : h)) }));
        return true;
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to update host' });
        return false;
      }
    },

    async removeHost(name) {
      try {
        await api.removeHost(name);
        await get().loadHosts();
        // Drop that host's sessions from the list immediately.
        set((s) => ({ sessions: s.sessions.filter((x) => x.host !== name) }));
      } catch {
        set({ toast: 'Failed to remove host' });
      }
    },

    async loadMcp() {
      try {
        set({ mcp: await api.listMcp() });
      } catch {
        /* ignore */
      }
    },

    async upsertMcpServer(def) {
      try {
        const server = await api.upsertMcpServer(def);
        set((s) => ({ mcp: { ...s.mcp, servers: [...s.mcp.servers.filter((x) => x.name !== server.name), server].sort((a, b) => a.name.localeCompare(b.name)) } }));
        return true;
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to save MCP server' });
        return false;
      }
    },

    async deleteMcpServer(name) {
      try {
        await api.deleteMcpServer(name);
        // Remove it from every scope's enable list client-side too.
        set((s) => ({
          mcp: {
            ...s.mcp,
            servers: s.mcp.servers.filter((x) => x.name !== name),
            enabled: Object.fromEntries(Object.entries(s.mcp.enabled).map(([k, v]) => [k, v.filter((n) => n !== name)])),
          },
        }));
      } catch {
        set({ toast: 'Failed to delete MCP server' });
      }
    },

    async setMcpEnabled(scope, names) {
      // Optimistic update so toggles feel instant; the server reconciles.
      const prev = get().mcp.enabled;
      set((s) => ({ mcp: { ...s.mcp, enabled: { ...s.mcp.enabled, [scope]: names } } }));
      try {
        const enabled = await api.setMcpEnabled(scope, names);
        set((s) => ({ mcp: { ...s.mcp, enabled: { ...s.mcp.enabled, [scope]: enabled } } }));
      } catch (err) {
        set({ mcp: { ...get().mcp, enabled: prev } });
        set({ toast: err instanceof ApiError ? err.message : 'Failed to update MCP servers' });
      }
    },

    async loadPresets() {
      try {
        set({ presets: await api.listPresets() });
      } catch {
        /* ignore */
      }
    },

    async upsertPreset(preset) {
      try {
        const saved = await api.upsertPreset(preset);
        set((s) => ({ presets: [...s.presets.filter((p) => p.name !== saved.name), saved].sort((a, b) => a.name.localeCompare(b.name)) }));
        return true;
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to save preset' });
        return false;
      }
    },

    async deletePreset(name) {
      try {
        await api.deletePreset(name);
        set((s) => ({ presets: s.presets.filter((p) => p.name !== name) }));
      } catch {
        set({ toast: 'Failed to delete preset' });
      }
    },

    async loadSkills(agent, host) {
      try {
        set({ skills: await api.listSkills(agent, host), skillsAgent: agent, skillsHost: host ?? null });
      } catch {
        set({ toast: 'Failed to list skills' });
      }
    },

    async readSkillDetail(args) {
      try {
        return await api.readSkill(args);
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to read skill' });
        return null;
      }
    },

    async saveSkillMulti(input) {
      // Write the same content to each target agent's skills dir in parallel.
      const failed: AgentKind[] = [];
      await Promise.all(
        input.agents.map(async (agent) => {
          try {
            await api.saveSkill({ agent, name: input.name, description: input.description, whenToUse: input.whenToUse, body: input.body, host: input.host });
          } catch {
            failed.push(agent);
          }
        }),
      );
      // Refresh the currently-browsed agent's list if it was among the targets.
      const cur = get().skillsAgent;
      if (cur && input.agents.includes(cur)) {
        try {
          set({ skills: await api.listSkills(cur, get().skillsHost ?? undefined) });
        } catch {
          /* ignore */
        }
      }
      if (failed.length) set({ toast: `Failed for: ${failed.join(', ')}` });
      return failed.length === 0;
    },

    async deleteSkillAction(agent, host, name) {
      try {
        await api.deleteSkill({ agent, host, name });
        set((s) => ({ skills: s.skills.filter((x) => !(x.scope === 'personal' && x.name === name)) }));
      } catch {
        set({ toast: 'Failed to delete skill' });
      }
    },

    async loadAgentConfig(agent, host) {
      try {
        set({ agentConfigFiles: await api.listAgentConfig(agent, host), agentConfigAgent: agent, agentConfigHost: host ?? null });
      } catch {
        set({ toast: 'Failed to list config files' });
      }
    },

    async readAgentConfigDetail(args) {
      try {
        return await api.readAgentConfig(args);
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to read config file' });
        return null;
      }
    },

    async saveAgentConfigFile(input) {
      try {
        const file = await api.saveAgentConfig(input);
        // Refresh the list so exists/size reflect the write.
        set({ agentConfigFiles: await api.listAgentConfig(input.agent, input.host) });
        return file;
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to save config file' });
        return null;
      }
    },

    async openSession(id: string) {
      const prev = get().activeId;
      if (prev && prev !== id) socket?.send({ t: 'unsubscribe', sessionId: prev });
      // Opening a session counts as viewing it — clear its unread marker.
      set((s) => {
        if (!s.unread[id]) return { activeId: id };
        const unread = { ...s.unread };
        delete unread[id];
        return { activeId: id, unread };
      });

      const existing = get().views[id];
      if (!existing?.loaded) {
        try {
          const page = await api.getMessages(id);
          const running = get().sessions.find((s) => s.id === id)?.running ?? false;
          set((s) => ({ views: { ...s.views, [id]: viewFromBlocks(page.blocks, page.seq, running, page) } }));
          sendSubscribe(id, page.seq);
          return;
        } catch {
          set({ toast: 'Failed to load conversation' });
          return;
        }
      }
      resubscribe(id);
    },

    async loadOlder(id, signal) {
      const view = get().views[id];
      if (!view?.loaded || !view.hasMore || !view.cursor || view.loadingOlder) return;
      const generation = socketGeneration;
      const session = get().sessions.find(row => row.id === id);
      const stillSameSession = () => {
        const current = get().sessions.find(row => row.id === id);
        return generation === socketGeneration && current?.agent === session?.agent && current?.claudeSessionId === session?.claudeSessionId;
      };
      set((s) => ({ views: { ...s.views, [id]: { ...view, loadingOlder: true } } }));
      try {
        const page = await api.getMessages(id, { cursor: view.cursor, signal });
        if (!stillSameSession()) return;
        set((s) => {
          const cur = s.views[id];
          if (!cur) return {};
          return { views: { ...s.views, [id]: prependPage(cur, page.blocks, page) } };
        });
      } catch {
        if (!stillSameSession()) return;
        set((s) => {
          const cur = s.views[id];
          return cur ? { views: { ...s.views, [id]: { ...cur, loadingOlder: false } } } : {};
        });
      }
    },

    async createSession(input) {
      try {
        let session = await api.createSession(input);
        // Pin after creation (the create API has no pinned field); a failure
        // here must not lose the session, so fall through with the unpinned copy.
        if (input.pinned) {
          try {
            await api.setSessionPinned(session.id, true);
            session = { ...session, pinned: true };
          } catch { /* keep unpinned */ }
        }
        set((s) => ({ sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)].sort(compareSessions) }));
        await get().openSession(session.id);
        return true;
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to create session' });
        return false;
      }
    },

    async renameSession(id, title) {
      try {
        const session = await api.updateSession(id, { title });
        set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? session : x)) }));
      } catch {
        set({ toast: 'Rename failed' });
      }
    },

    async switchSessionAgent(id, input) {
      try {
        const result = await api.switchSessionAgent(id, input);
        // 会话的 agent/model 变了，用服务端返回的最新记录替换本地那条。
        set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? result.session : x)) }));
        // The server replaced the immutable per-agent runtime. Reload the
        // migrated transcript and subscribe at its handed-off sequence before
        // the composer is enabled again.
        await reloadAndResubscribe(id);
        // 刷新列表：新 agent 的原生会话需要重新发现，排序也会随之变化。
        await get().refreshSessions();
        return result.switch.fidelity;
      } catch (err) {
        set({ toast: err instanceof Error ? `切换失败：${err.message}` : '切换失败' });
        return null;
      }
    },

    async deleteSession(id) {
      try {
        await api.deleteSession(id);
      } catch {
        /* server may already be gone; fall through */
      }
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== id);
        const views = { ...s.views };
        delete views[id];
        const rightTabs = { ...s.rightTabs };
        delete rightTabs[id];
        const unread = { ...s.unread };
        delete unread[id];
        const tasks = { ...s.tasks };
        delete tasks[id];
        const requestQueues = { ...s.requestQueues };
        const requestOutbox = { ...s.requestOutbox };
        delete requestQueues[id];
        delete requestOutbox[id];
        const agentQuestions = { ...s.agentQuestions }; delete agentQuestions[id];
        const questionActions = { ...s.questionActions }; delete questionActions[id];
        const activeId = s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId;
        return { sessions, views, tasks, rightTabs, unread, activeId, requestQueues, requestOutbox, agentQuestions, questionActions };
      });
      const next = get().activeId;
      if (next) void get().openSession(next);
    },

    async togglePin(id) {
      const cur = get().sessions.find((s) => s.id === id)?.pinned ?? false;
      const next = !cur;
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: next } : x)).sort(compareSessions) }));
      try {
        await api.setSessionPinned(id, next);
      } catch (err) {
        // Revert on failure so the star reflects the server's truth.
        set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: cur } : x)).sort(compareSessions) }));
        set({ toast: err instanceof ApiError ? err.message : 'Failed to update favorite' });
      }
    },

    sendMessage(text, sessionId) {
      const trimmed = text.trim();
      const id = sessionId ?? get().activeId;
      if (!trimmed || !id) return false;
      if (get().status !== 'open') { set({ toast: 'Connection is not ready. Your message was not sent.' }); return false; }
      const clientMsgId = uid();
      // Pending text stays OUT of the transcript until the server starts it;
      // otherwise a queued user bubble would interrupt the current reply.
      set((s) => ({ requestOutbox: { ...s.requestOutbox, [id]: [
        ...(s.requestOutbox[id] ?? []), { id: clientMsgId, text: trimmed, queuedAt: Date.now(), state: 'sending' },
      ] } }));
      if (socket?.send({ t: 'send', sessionId: id, clientMsgId, text: trimmed })) return true;
      set((s) => ({ requestOutbox: { ...s.requestOutbox, [id]: (s.requestOutbox[id] ?? []).filter((item) => item.id !== clientMsgId) }, toast: 'Connection is not ready. Your message was not sent.' }));
      return false;
    },

    retryPendingRequest(sessionId, clientMsgId) {
      const item = get().requestOutbox[sessionId]?.find((entry) => entry.id === clientMsgId);
      if (!item) return;
      if (!socket?.send({ t: 'send', sessionId, clientMsgId, text: item.text })) {
        set({ toast: 'Connection is not ready. Please retry after reconnecting.' });
        return;
      }
      set((s) => ({ requestOutbox: { ...s.requestOutbox, [sessionId]: (s.requestOutbox[sessionId] ?? []).map((entry) => (
        entry.id === clientMsgId ? { ...entry, state: 'sending', error: undefined } : entry
      )) } }));
    },

    removeQueuedRequest(sessionId, clientMsgId) {
      const local = get().requestOutbox[sessionId]?.find((entry) => entry.id === clientMsgId);
      if (local?.state === 'failed') {
        set((s) => ({ requestOutbox: { ...s.requestOutbox, [sessionId]: (s.requestOutbox[sessionId] ?? []).filter((entry) => entry.id !== clientMsgId) } }));
        return;
      }
      if (!socket?.send({ t: 'queue_remove', sessionId, clientMsgId })) set({ toast: 'Reconnect before changing the queue.' });
    },

    controlRequestQueue(sessionId, action) {
      if (!socket?.send({ t: action === 'pause' ? 'queue_pause' : 'queue_resume', sessionId })) set({ toast: 'Reconnect before changing the queue.' });
    },

    answerAgentQuestion(sessionId, questionId, answers, retry = false) {
      if (!get().agentQuestionsSupported || get().status !== 'open') { set({ toast: 'Reconnect before answering this question.' }); return; }
      if (get().questionActions[sessionId]?.[questionId]?.sending) return;
      set((s) => ({ questionActions: { ...s.questionActions, [sessionId]: { ...(s.questionActions[sessionId] ?? {}), [questionId]: { sending: true } } } }));
      if (!socket?.send({ t: 'question_answer', sessionId, questionId, answers, retry })) {
        set((s) => ({ questionActions: { ...s.questionActions, [sessionId]: { ...(s.questionActions[sessionId] ?? {}), [questionId]: { sending: false, error: 'Disconnected; your answer was not sent.' } } } }));
      }
    },

    dismissAgentQuestion(sessionId, questionId) {
      if (!get().agentQuestionsSupported || get().status !== 'open') { set({ toast: 'Reconnect before dismissing this question.' }); return; }
      if (get().questionActions[sessionId]?.[questionId]?.sending) return;
      set((s) => ({ questionActions: { ...s.questionActions, [sessionId]: { ...(s.questionActions[sessionId] ?? {}), [questionId]: { sending: true } } } }));
      if (!socket?.send({ t: 'question_dismiss', sessionId, questionId })) {
        set((s) => ({ questionActions: { ...s.questionActions, [sessionId]: { ...(s.questionActions[sessionId] ?? {}), [questionId]: { sending: false, error: 'Disconnected; please retry.' } } } }));
      }
    },

    refreshAgentQuestions(sessionId) { if (get().status === 'open') resubscribe(sessionId); },

    abort() {
      const id = get().activeId;
      if (id) {
        // The user stopped this turn themselves — suppress its completion chime.
        if (socket?.send({ t: 'abort', sessionId: id })) abortedSessions.add(id);
        else set({ toast: 'Reconnect before stopping the response.' });
      }
    },

    stopTask(taskId) {
      const sessionId = get().activeId;
      if (!sessionId) return;
      socket?.send({ t: 'task_stop', sessionId, taskId });
    },

    respondPermission(requestId, decision) {
      const id = get().activeId;
      if (!id) return;
      socket?.send({ t: 'permission', sessionId: id, requestId, decision });
      set((s) => ({
        pending: { ...s.pending, [id]: (s.pending[id] ?? []).filter((p) => p.requestId !== requestId) },
      }));
    },

    setToast(msg) {
      set({ toast: msg });
    },

    openPathPreview(rawPath) {
      const { sessions, activeId, localName } = get();
      const session = sessions.find((s) => s.id === activeId);
      const cwd = session?.cwd ?? '';
      const host = session && session.host !== localName ? session.host : undefined;
      set({ filePreview: { path: resolveFilePath(rawPath, cwd), host } });
    },

    closeFilePreview() {
      set({ filePreview: null });
    },

    setRightTab(id, tab) {
      set((s) => ({ rightTabs: { ...s.rightTabs, [id]: tab } }));
    },

    setNotifySound(id) {
      saveNotifySound(id);
      set({ notifySound: id });
    },

    setViewMode(mode) {
      saveViewMode(mode);
      set({ viewMode: mode });
    },

    setAccent(pref) {
      saveAccentPreference(pref);
      applyAccent(pref);
      set({ accent: pref });
    },

    setContrast(contrast) {
      saveContrast(contrast);
      set({ contrast });
    },

    setSearchQuery(q) {
      set({ searchQuery: q });
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      const trimmed = q.trim();
      if (trimmed.length < 2) {
        set({ searchResults: [], searchLoading: false });
        return;
      }
      set({ searchLoading: true });
      const reqId = ++searchReqId;
      searchTimer = setTimeout(async () => {
        searchTimer = null;
        try {
          const results = await api.search(trimmed);
          if (reqId !== searchReqId) return; // a newer query superseded this one
          set({ searchResults: results, searchLoading: false });
        } catch {
          if (reqId !== searchReqId) return;
          set({ searchResults: [], searchLoading: false });
        }
      }, 300);
    },
  };
});

// Match the persisted CLI/chat chrome before the first paint of ChatView.
if (typeof document !== 'undefined') {
  applyViewModeClass(loadViewMode());
}

// Keep the theme in sync with the device's color-scheme preference. The inline
// script in index.html sets the initial class before paint; this updates it
// (and the store) live when the system theme changes.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia(LIGHT_MQ).addEventListener('change', (e) => {
    const next: Theme = e.matches ? 'light' : 'dark';
    const el = document.documentElement;
    el.classList.remove('dark', 'light');
    el.classList.add(next);
    useStore.setState({ theme: next });
    // The TUI ground follows the theme, so its status-bar color flips too.
    applyViewModeClass(useStore.getState().viewMode);
    // System accent can shift with appearance mode; custom prefs stay put.
    applyAccent();
  });
}
