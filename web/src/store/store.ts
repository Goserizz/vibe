import { create } from 'zustand';
import type {
  AgentKind,
  BackgroundTask,
  EffortLevel,
  McpConfigSnapshot,
  McpServerDef,
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
  TokenUsage,
} from '@shared/protocol';
import { compareSessions } from '@shared/protocol';
import { api, ApiError, setApiToken } from '../lib/api';
import type { ModelOption, PermissionOption } from '../lib/format';
import { VibeSocket, type ConnStatus } from '../lib/ws';
import { clearToken } from '../lib/token';
import { resolveFilePath } from '../lib/paths';
import { loadNotifySound, playNotifySound, saveNotifySound, type NotifySoundId } from '../lib/notifySound';
import {
  applyAccent,
  loadAccentPreference,
  saveAccentPreference,
  type AccentPreference,
} from '../lib/systemAccent';
import { emptyView, reduceView, viewFromBlocks, type SessionView } from './blocks';
import { useVibotStore, vibotHandleBatch } from './vibot';

let socket: VibeSocket | null = null;
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
const MODEL_REPULL_MS = 2_500;

// Sessions the user aborted this turn. Their end-of-turn chime is suppressed
// (they stopped it themselves, so no need to notify). Consumed by the next
// run_state for that session; cleared if a fresh turn starts instead.
const abortedSessions = new Set<string>();

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
  cursorModels: ModelOption[];
  codexModels: ModelOption[];
  kimiModels: ModelOption[];
  kimiPermissionModes: PermissionOption[];
  kiroModels: ModelOption[];
  kiroPermissionModes: PermissionOption[];
  theme: Theme;
  /** Sound played when a model turn finishes. Persisted in localStorage. */
  notifySound: NotifySoundId;
  /** Accent color: follow OS or a manual hex. Persisted in localStorage. */
  accent: AccentPreference;

  sessions: SessionMeta[];
  projects: ProjectDir[];
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
  usage: Record<string, TokenUsage | undefined>;
  pending: Record<string, PermissionRequest[]>;
  /** Native background tasks keyed by session. */
  tasks: Record<string, BackgroundTask[]>;
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
  loadProjects: () => Promise<void>;
  loadHosts: () => Promise<void>;
  /** Load Cursor models for the local CLI, or for a remote host (with its proxy). */
  loadCursorModels: (host?: string) => Promise<void>;
  /** Load Codex models from the local cache, or the remote host's cache. */
  loadCodexModels: (host?: string) => Promise<void>;
  /** Discover configured Kimi models and ACP permission modes on a host. */
  loadKimiCapabilities: (host?: string) => Promise<void>;
  /** Load Kiro models (and fixed permission modes) for local or remote CLI. */
  loadKiroModels: (host?: string) => Promise<void>;
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
  createSession: (input: { cwd?: string; autoCwd?: boolean; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; agent?: AgentKind; title?: string; host?: string }) => Promise<boolean>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  sendMessage: (text: string) => void;
  abort: () => void;
  stopTask: (taskId: string) => void;
  respondPermission: (requestId: string, decision: PermissionDecision) => void;
  setToast: (msg: string | null) => void;
  setRightTab: (id: string, tab: 'terminal' | 'files' | null) => void;
  setNotifySound: (id: NotifySoundId) => void;
  setAccent: (pref: AccentPreference) => void;
}

export const useStore = create<StoreState>((set, get) => {
  // -- socket event handling -------------------------------------------------

  function resubscribe(id: string): void {
    const view = get().views[id];
    socket?.send({ t: 'subscribe', sessionId: id, lastSeq: view?.lastSeq ?? 0 });
  }

  function handleStatus(status: ConnStatus, opts: { reconnected: boolean }): void {
    set({ status });
    if (status === 'open') {
      const { activeId } = get();
      if (activeId) resubscribe(activeId);
      if (opts.reconnected) {
        void get().refreshSessions();
        // The Vibot interface shares this socket; let it resubscribe too.
        void useVibotStore.getState().onReconnect();
      }
    }
  }

  function handleBatch(events: ServerEvent[]): void {
    const state = get();
    // Collected mutations applied in a single set() at the end (one render).
    const eventsBySession = new Map<string, { seq: number; ev: import('@shared/protocol').LiveEvent }[]>();
    const usagePatch: Record<string, TokenUsage> = {};
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
          if (msg.ev.k === 'token_usage') usagePatch[msg.sessionId] = msg.ev.usage;
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
              // Notify when a live turn ends (true → false). Skip the subscribe/
              // replay path (which only sets running via `subscribed`) and skip
              // turns the user aborted. `delete` returns true iff it was an abort.
              const wasRunning = liveRunning.get(msg.sessionId) ?? state.views[msg.sessionId]?.running;
              if (wasRunning && !abortedSessions.delete(msg.sessionId)) playDoneSound = true;
            }
            liveRunning.set(msg.sessionId, msg.ev.running);
          }
          push(msg.sessionId, msg.seq, msg.ev);
          break;
        case 'subscribed':
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
        case 'session_removed':
          sessions = sessions.filter((s) => s.id !== msg.sessionId);
          sessionsDirty = true;
          break;
        case 'hello':
          set({ serverVersion: msg.serverVersion });
          break;
        case 'error':
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
      const usage = Object.keys(usagePatch).length ? { ...s.usage, ...usagePatch } : s.usage;
      const pending = Object.keys(pendingPatch).length ? { ...s.pending, ...pendingPatch } : s.pending;
      const tasks = Object.keys(taskPatch).length ? { ...s.tasks, ...taskPatch } : s.tasks;
      const unread = finishedUnreadIds.length
        ? { ...s.unread, ...Object.fromEntries(finishedUnreadIds.map((id) => [id, true as const])) }
        : s.unread;
      return {
        views,
        usage,
        pending,
        tasks,
        unread,
        sessions: sessionsDirty ? sessions : s.sessions,
      };
    });

    if (playDoneSound) playNotifySound(get().notifySound);

    // Stale-replay recovery: reload transcript then resubscribe.
    for (const sid of resetIds) {
      void reloadAndResubscribe(sid);
    }
  }

  async function reloadAndResubscribe(id: string): Promise<void> {
    try {
      const { blocks, seq } = await api.getMessages(id);
      const running = get().sessions.find((s) => s.id === id)?.running ?? false;
      set((s) => ({ views: { ...s.views, [id]: viewFromBlocks(blocks, seq, running) } }));
      socket?.send({ t: 'subscribe', sessionId: id, lastSeq: seq });
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
    cursorModels: [],
    codexModels: [],
    kimiModels: [],
    kimiPermissionModes: [],
    kiroModels: [],
    kiroPermissionModes: [],
    theme: initialTheme(),
    notifySound: loadNotifySound(),
    accent: loadAccentPreference(),
    sessions: [],
    projects: [],
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
    usage: {},
    pending: {},
    tasks: {},
    unread: {},
    rightTabs: {},
    toast: null,
    filePreview: null,
    searchQuery: '',
    searchResults: [],
    searchLoading: false,

    async init(token: string) {
      setApiToken(token);
      try {
        const me = await api.me();
        set({ defaultModel: me.defaultModel, serverVersion: me.serverVersion });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          set({ phase: 'unauthorized' });
          return;
        }
        set({ toast: 'Failed to reach server' });
      }

      socket = new VibeSocket({ onBatch: handleBatch, onStatus: handleStatus, onVibotBatch: vibotHandleBatch });
      socket.connect(token);

      await Promise.all([
        get().refreshSessions(),
        get().loadProjects(),
        get().loadHosts(),
        get().loadMcp(),
        get().loadPresets(),
      ]);
      set({ phase: 'ready' });

      // Model lists never gate the splash — server serves cache/fallback instantly
      // and refreshes CLIs in the background; these fill the pickers when ready.
      void get().loadCursorModels();
      void get().loadCodexModels();
      void get().loadKimiCapabilities();
      void get().loadKiroModels();

      const { sessions, activeId } = get();
      if (!activeId && sessions.length > 0) void get().openSession(sessions[0].id);
    },

    signOut() {
      socket?.close();
      socket = null;
      clearToken();
      set({ phase: 'unauthorized', sessions: [], views: {}, tasks: {}, rightTabs: {}, unread: {}, activeId: null, filePreview: null, searchQuery: '', searchResults: [], searchLoading: false });
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
        set({ projects });
      } catch {
        /* ignore */
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
          const { blocks, seq } = await api.getMessages(id);
          const running = get().sessions.find((s) => s.id === id)?.running ?? false;
          set((s) => ({ views: { ...s.views, [id]: viewFromBlocks(blocks, seq, running) } }));
          socket?.send({ t: 'subscribe', sessionId: id, lastSeq: seq });
          return;
        } catch {
          set({ toast: 'Failed to load conversation' });
          return;
        }
      }
      resubscribe(id);
    },

    async createSession(input) {
      try {
        const session = await api.createSession(input);
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
        const activeId = s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId;
        return { sessions, views, tasks, rightTabs, unread, activeId };
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

    sendMessage(text) {
      const trimmed = text.trim();
      const id = get().activeId;
      if (!trimmed || !id) return;
      const clientMsgId = uid();
      // Optimistic: show the user's message and the running state immediately.
      set((s) => {
        const view = s.views[id] ?? emptyView();
        const seq = view.lastSeq;
        const next = reduceView(view, [
          { seq, ev: { k: 'block', block: { id: clientMsgId, kind: 'user', text: trimmed, ts: Date.now() } } },
          { seq, ev: { k: 'run_state', running: true } },
        ]);
        return { views: { ...s.views, [id]: next } };
      });
      socket?.send({ t: 'send', sessionId: id, clientMsgId, text: trimmed });
    },

    abort() {
      const id = get().activeId;
      if (id) {
        // The user stopped this turn themselves — suppress its completion chime.
        abortedSessions.add(id);
        socket?.send({ t: 'abort', sessionId: id });
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

    setAccent(pref) {
      saveAccentPreference(pref);
      applyAccent(pref);
      set({ accent: pref });
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
    // System accent can shift with appearance mode; custom prefs stay put.
    applyAccent();
  });
}
