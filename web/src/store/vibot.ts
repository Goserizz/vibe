import { create } from 'zustand';
import type {
  ClientMessage,
  ServerEvent,
  VibotAskRequest,
  VibotConfigClient,
  VibotConvMeta,
  VibotMemory,
} from '@shared/protocol';
import { api, ApiError } from '../lib/api';
import { emptyView, reduceView, viewFromBlocks, type SessionView } from './blocks';
// The single WebSocket is owned by the coding store; reach it via this accessor
// (avoids a second socket). This creates a store↔vibot import cycle that is
// safe because neither module uses the other's binding at load time.
import { getSocket } from './store';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

type VibotClientMessage = Extract<ClientMessage, { t: `vibot_${string}` }>;

/** Outbound vibot frames waiting for the shared socket to become OPEN. */
let pendingVibot: VibotClientMessage[] = [];

function sendRaw(msg: VibotClientMessage): boolean {
  return getSocket()?.send(msg) ?? false;
}

/** Drop older vibot_subscribe frames for the same convId (keep newest only). */
function coalesceSubscribes(queue: VibotClientMessage[]): VibotClientMessage[] {
  const latestSub = new Map<string, number>();
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];
    if (m.t === 'vibot_subscribe') latestSub.set(m.convId, i);
  }
  return queue.filter((m, i) => m.t !== 'vibot_subscribe' || latestSub.get(m.convId) === i);
}

function enqueueVibot(msg: VibotClientMessage): void {
  pendingVibot.push(msg);
  pendingVibot = coalesceSubscribes(pendingVibot);
}

/** Refresh subscribe lastSeq from the live view so a queued frame stays current. */
function materialize(msg: VibotClientMessage): VibotClientMessage {
  if (msg.t !== 'vibot_subscribe') return msg;
  const lastSeq = useVibotStore.getState().views[msg.convId]?.lastSeq ?? msg.lastSeq;
  return { t: 'vibot_subscribe', convId: msg.convId, lastSeq };
}

/** Drain the pending queue in order. Re-queues the remainder if send fails mid-flush. */
export function flushVibotPending(): void {
  if (pendingVibot.length === 0) return;
  const queue = coalesceSubscribes(pendingVibot);
  pendingVibot = [];
  for (let i = 0; i < queue.length; i++) {
    const msg = materialize(queue[i]);
    if (!sendRaw(msg)) {
      pendingVibot = coalesceSubscribes([msg, ...queue.slice(i + 1)]);
      return;
    }
  }
}

/**
 * Send a vibot client frame, or queue it until the shared socket is OPEN.
 * Subscribe frames for the same conversation collapse to the newest one;
 * lastSeq is refreshed from the store at flush time.
 */
function sendVibotFrame(msg: VibotClientMessage): void {
  if (pendingVibot.length === 0 && sendRaw(msg)) return;
  // Socket down, or backlog exists — never leapfrog queued frames.
  if (pendingVibot.length > 0) {
    flushVibotPending();
    if (pendingVibot.length === 0 && sendRaw(msg)) return;
  }
  enqueueVibot(msg);
}

function removeAsk(
  asks: Record<string, VibotAskRequest[]>,
  convId: string,
  callId: string,
): Record<string, VibotAskRequest[]> {
  const list = asks[convId];
  if (!list?.length) return asks;
  const next = list.filter((a) => a.callId !== callId);
  if (next.length === list.length) return asks;
  const out = { ...asks };
  if (next.length) out[convId] = next;
  else delete out[convId];
  return out;
}

/**
 * Separate store for the Vibot assistant interface. It never touches the coding
 * `sessions`/`views` in `store.ts`: Vibot conversations live in their own
 * `convs` list and `views` map, fed by the `vibot_*` WS frames the socket splits
 * out in lib/ws.ts. The socket itself is owned by the coding store; we reach it
 * through the `getSocket()` accessor.
 */
interface VibotState {
  loaded: boolean;
  convs: VibotConvMeta[];
  activeConvId: string | null;
  views: Record<string, SessionView>;
  /** Pending ask-user dialogs keyed by conversation. */
  asks: Record<string, VibotAskRequest[]>;
  config: VibotConfigClient | null;
  memories: VibotMemory[];
  toast: string | null;

  init: () => Promise<void>;
  handleBatch: (events: ServerEvent[]) => void;
  onReconnect: () => void;
  loadConfig: () => Promise<void>;
  saveConfig: (input: { baseUrl?: string; apiKey?: string; model?: string; systemPrompt?: string; temperature?: number; reasoning_effort?: string | null }) => Promise<boolean>;
  loadMemories: () => Promise<void>;
  newConversation: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  unlinkSession: (convId: string, sessionId: string) => Promise<boolean>;
  sendMessage: (text: string, images?: string[]) => void;
  abort: () => void;
  answerAsk: (convId: string, callId: string, answers: Record<string, string | string[]>) => void;
  setToast: (msg: string | null) => void;
}

function sortConvs(convs: VibotConvMeta[]): VibotConvMeta[] {
  return [...convs].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const useVibotStore = create<VibotState>((set, get) => ({
  loaded: false,
  convs: [],
  activeConvId: null,
  views: {},
  asks: {},
  config: null,
  memories: [],
  toast: null,

  async init() {
    if (get().loaded) return;
    const [config, convs, memories] = await Promise.all([
      api.getVibotConfig().catch(() => null),
      api.listVibotConversations().catch(() => []),
      api.listVibotMemories().catch(() => []),
    ]);
    set({ loaded: true, config, convs: sortConvs(convs), memories });
  },

  handleBatch(events) {
    const state = get();
    const views = { ...state.views };
    let asks = state.asks;
    let asksDirty = false;
    let convs = state.convs;
    let convsDirty = false;
    const setRunning: Record<string, boolean> = {};
    const resetIds: string[] = [];

    for (const msg of events) {
      switch (msg.t) {
        case 'vibot_event': {
          const view = views[msg.convId] ?? emptyView();
          views[msg.convId] = reduceView(view, [{ seq: msg.seq, ev: msg.ev }]);
          break;
        }
        case 'vibot_subscribed': {
          setRunning[msg.convId] = msg.running;
          if (msg.reset) resetIds.push(msg.convId);
          // Replace pending asks for this conv with the server's authoritative list.
          const pending = msg.pendingAsks ?? [];
          if (pending.length) {
            asks = { ...asks, [msg.convId]: pending };
          } else if (asks[msg.convId]) {
            const next = { ...asks };
            delete next[msg.convId];
            asks = next;
          }
          asksDirty = true;
          break;
        }
        case 'vibot_ask': {
          const list = asks[msg.convId] ?? [];
          if (list.some((a) => a.callId === msg.request.callId)) break;
          asks = { ...asks, [msg.convId]: [...list, msg.request] };
          asksDirty = true;
          break;
        }
        case 'vibot_ask_resolved': {
          asks = removeAsk(asks, msg.convId, msg.callId);
          asksDirty = true;
          break;
        }
        case 'vibot_conv_meta': {
          const others = convs.filter((c) => c.id !== msg.conv.id);
          convs = sortConvs([msg.conv, ...others]);
          convsDirty = true;
          break;
        }
        case 'vibot_conv_removed':
          convs = convs.filter((c) => c.id !== msg.convId);
          convsDirty = true;
          if (asks[msg.convId]) {
            const next = { ...asks };
            delete next[msg.convId];
            asks = next;
            asksDirty = true;
          }
          break;
        case 'vibot_conv_list':
          convs = sortConvs(msg.convs);
          convsDirty = true;
          break;
        case 'error':
          set({ toast: msg.message });
          break;
      }
    }

    set((s) => {
      for (const id of Object.keys(setRunning)) {
        const v = views[id] ?? emptyView();
        views[id] = { ...v, running: setRunning[id] };
      }
      return {
        views,
        convs: convsDirty ? convs : s.convs,
        asks: asksDirty ? asks : s.asks,
      };
    });

    for (const id of resetIds) void reloadAndResubscribe(id);
  },

  onReconnect() {
    // Socket is OPEN: resubscribe the active chat first (idempotent), then
    // flush any vibot_send / vibot_abort that waited while we were down.
    void get().init().then(async () => {
      const id = get().activeConvId;
      if (id) await get().openConversation(id);
      flushVibotPending();
    });
  },

  async loadConfig() {
    try {
      set({ config: await api.getVibotConfig() });
    } catch {
      /* ignore */
    }
  },

  async saveConfig(input) {
    try {
      const config = await api.saveVibotConfig(input);
      set({ config });
      return true;
    } catch (err) {
      set({ toast: err instanceof ApiError ? err.message : 'Failed to save Vibot config' });
      return false;
    }
  },

  async loadMemories() {
    try {
      set({ memories: await api.listVibotMemories() });
    } catch {
      /* ignore */
    }
  },

  async newConversation() {
    try {
      const conv = await api.createVibotConversation();
      set((s) => ({ convs: sortConvs([conv, ...s.convs.filter((c) => c.id !== conv.id)]) }));
      await get().openConversation(conv.id);
    } catch (err) {
      set({ toast: err instanceof ApiError ? err.message : 'Failed to create conversation' });
    }
  },

  async openConversation(id) {
    const prev = get().activeConvId;
    if (prev && prev !== id) {
      sendVibotFrame({ t: 'vibot_unsubscribe', convId: prev });
    }
    set({ activeConvId: id });

    const existing = get().views[id];
    if (!existing?.loaded) {
      try {
        const { blocks, seq } = await api.getVibotMessages(id);
        const running = get().convs.find((c) => c.id === id)?.running ?? false;
        set((s) => ({ views: { ...s.views, [id]: viewFromBlocks(blocks, seq, running) } }));
        sendVibotFrame({ t: 'vibot_subscribe', convId: id, lastSeq: seq });
        return;
      } catch {
        set({ toast: 'Failed to load conversation' });
        return;
      }
    }
    sendVibotFrame({ t: 'vibot_subscribe', convId: id, lastSeq: existing.lastSeq });
  },

  async renameConversation(id, title) {
    try {
      const conv = await api.renameVibotConversation(id, title);
      set((s) => ({ convs: sortConvs(s.convs.map((c) => (c.id === id ? conv : c))) }));
    } catch {
      set({ toast: 'Rename failed' });
    }
  },

  async deleteConversation(id) {
    try {
      await api.deleteVibotConversation(id);
    } catch {
      /* server may already be gone */
    }
    set((s) => {
      const convs = s.convs.filter((c) => c.id !== id);
      const views = { ...s.views };
      delete views[id];
      const asks = { ...s.asks };
      delete asks[id];
      const activeConvId = s.activeConvId === id ? (convs[0]?.id ?? null) : s.activeConvId;
      return { convs, views, asks, activeConvId };
    });
    const next = get().activeConvId;
    if (next) void get().openConversation(next);
  },

  async unlinkSession(convId, sessionId) {
    try {
      const conv = await api.unlinkVibotSession(convId, sessionId);
      set((s) => ({
        convs: sortConvs(s.convs.map((c) => (c.id === convId ? conv : c))),
      }));
      return true;
    } catch (err) {
      set({ toast: err instanceof ApiError ? err.message : 'Failed to unlink session' });
      return false;
    }
  },

  sendMessage(text, images) {
    const trimmed = text.trim();
    const imgs = images?.length ? images : undefined;
    const id = get().activeConvId;
    if ((!trimmed && !imgs?.length) || !id) return;
    const clientMsgId = uid();
    // Optimistic: show the user's message + running state immediately.
    set((s) => {
      const view = s.views[id] ?? emptyView();
      const seq = view.lastSeq;
      const next = reduceView(view, [
        {
          seq,
          ev: {
            k: 'block',
            block: {
              id: clientMsgId,
              kind: 'user',
              text: trimmed,
              ...(imgs ? { images: imgs } : {}),
              ts: Date.now(),
            },
          },
        },
        { seq, ev: { k: 'run_state', running: true } },
      ]);
      return { views: { ...s.views, [id]: next } };
    });
    sendVibotFrame({
      t: 'vibot_send',
      convId: id,
      clientMsgId,
      text: trimmed,
      ...(imgs ? { images: imgs } : {}),
    });
  },

  abort() {
    const id = get().activeConvId;
    if (id) sendVibotFrame({ t: 'vibot_abort', convId: id });
  },

  answerAsk(convId, callId, answers) {
    set((s) => ({ asks: removeAsk(s.asks, convId, callId) }));
    sendVibotFrame({ t: 'vibot_answer', convId, callId, answers });
  },

  setToast(msg) {
    set({ toast: msg });
  },
}));

/** Reload transcript then resubscribe (stale-replay recovery). */
async function reloadAndResubscribe(id: string): Promise<void> {
  try {
    const { blocks, seq } = await api.getVibotMessages(id);
    const running = useVibotStore.getState().convs.find((c) => c.id === id)?.running ?? false;
    useVibotStore.setState((s) => ({ views: { ...s.views, [id]: viewFromBlocks(blocks, seq, running) } }));
    sendVibotFrame({ t: 'vibot_subscribe', convId: id, lastSeq: seq });
  } catch {
    /* ignore */
  }
}

/** Entry point the coding store wires as the socket's `onVibotBatch` handler. */
export function vibotHandleBatch(events: ServerEvent[]): void {
  useVibotStore.getState().handleBatch(events);
}
