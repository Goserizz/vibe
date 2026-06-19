import { create } from 'zustand';
import type {
  EffortLevel,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProjectDir,
  RemoteHost,
  SearchResult,
  ServerEvent,
  SessionMeta,
  TokenUsage,
} from '@shared/protocol';
import { api, ApiError, setApiToken } from '../lib/api';
import { VibeSocket, type ConnStatus } from '../lib/ws';
import { clearToken } from '../lib/token';
import { emptyView, reduceView, viewFromBlocks, type SessionView } from './blocks';

let socket: VibeSocket | null = null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

// Debounced full-text search: a timer per keystroke + a monotonic id so stale
// in-flight responses are discarded.
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchReqId = 0;

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
  theme: Theme;

  sessions: SessionMeta[];
  projects: ProjectDir[];
  hosts: RemoteHost[];
  localName: string;
  activeId: string | null;
  views: Record<string, SessionView>;
  usage: Record<string, TokenUsage | undefined>;
  pending: Record<string, PermissionRequest[]>;
  toast: string | null;

  searchQuery: string;
  searchResults: SearchResult[];
  searchLoading: boolean;
  setSearchQuery: (q: string) => void;

  init: (token: string) => Promise<void>;
  signOut: () => void;
  refreshSessions: () => Promise<void>;
  loadProjects: () => Promise<void>;
  loadHosts: () => Promise<void>;
  addHost: (host: RemoteHost) => Promise<boolean>;
  removeHost: (name: string) => Promise<void>;
  openSession: (id: string) => Promise<void>;
  createSession: (input: { cwd: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; title?: string; host?: string }) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (text: string) => void;
  abort: () => void;
  respondPermission: (requestId: string, decision: PermissionDecision) => void;
  setToast: (msg: string | null) => void;
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
      if (opts.reconnected) void get().refreshSessions();
    }
  }

  function handleBatch(events: ServerEvent[]): void {
    const state = get();
    // Collected mutations applied in a single set() at the end (one render).
    const eventsBySession = new Map<string, { seq: number; ev: import('@shared/protocol').LiveEvent }[]>();
    const usagePatch: Record<string, TokenUsage> = {};
    const pendingPatch: Record<string, PermissionRequest[]> = {};
    let sessions = state.sessions;
    let sessionsDirty = false;
    const resetIds: string[] = [];
    const setRunning: Record<string, boolean> = {};

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
          push(msg.sessionId, msg.seq, msg.ev);
          break;
        case 'subscribed':
          setRunning[msg.sessionId] = msg.running;
          pendingPatch[msg.sessionId] = msg.pendingPermissions;
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
          const others = sessions.filter((s) => s.id !== msg.session.id);
          sessions = [msg.session, ...others].sort((a, b) => b.updatedAt - a.updatedAt);
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
      return {
        views,
        usage,
        pending,
        sessions: sessionsDirty ? sessions : s.sessions,
      };
    });

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
    theme: initialTheme(),
    sessions: [],
    projects: [],
    hosts: [],
    localName: 'local',
    activeId: null,
    views: {},
    usage: {},
    pending: {},
    toast: null,
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

      socket = new VibeSocket({ onBatch: handleBatch, onStatus: handleStatus });
      socket.connect(token);

      await Promise.all([get().refreshSessions(), get().loadProjects(), get().loadHosts()]);
      set({ phase: 'ready' });

      const { sessions, activeId } = get();
      if (!activeId && sessions.length > 0) void get().openSession(sessions[0].id);
    },

    signOut() {
      socket?.close();
      socket = null;
      clearToken();
      set({ phase: 'unauthorized', sessions: [], views: {}, activeId: null, searchQuery: '', searchResults: [], searchLoading: false });
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

    async openSession(id: string) {
      const prev = get().activeId;
      if (prev && prev !== id) socket?.send({ t: 'unsubscribe', sessionId: prev });
      set({ activeId: id });

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
        set((s) => ({ sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)] }));
        await get().openSession(session.id);
      } catch (err) {
        set({ toast: err instanceof ApiError ? err.message : 'Failed to create session' });
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
        const activeId = s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId;
        return { sessions, views, activeId };
      });
      const next = get().activeId;
      if (next) void get().openSession(next);
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
      if (id) socket?.send({ t: 'abort', sessionId: id });
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
  });
}
