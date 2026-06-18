import type { ClientMessage, ServerEvent } from '@shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';

interface SocketHandlers {
  onBatch: (events: ServerEvent[]) => void;
  onStatus: (status: ConnStatus, opts: { reconnected: boolean }) => void;
}

const MIN_BACKOFF = 300;
const MAX_BACKOFF = 5000;
const PING_INTERVAL = 25_000;

/**
 * Resilient WebSocket transport.
 *
 * Two things make it feel instant rather than janky:
 *  1. Incoming frames are coalesced and delivered once per animation frame, so
 *     a burst of streaming deltas becomes a single React update.
 *  2. Reconnects use exponential backoff and re-announce status so the store
 *     can replay from the last seq it saw — no lost or duplicated events.
 */
export class VibeSocket {
  private ws: WebSocket | null = null;
  private token = '';
  private handlers: SocketHandlers;
  private backoff = MIN_BACKOFF;
  private hasConnected = false;
  private closedByUser = false;

  private inbox: ServerEvent[] = [];
  private rafId = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers;
  }

  connect(token: string): void {
    this.token = token;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.handlers.onStatus('connecting', { reconnected: false });
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF;
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.handlers.onStatus('open', { reconnected });
      this.startPing();
    };

    ws.onmessage = (e) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') return;
      this.inbox.push(msg);
      this.scheduleFlush();
    };

    ws.onclose = () => {
      this.stopPing();
      this.handlers.onStatus('closed', { reconnected: false });
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow and drive reconnection.
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 1.7, MAX_BACKOFF);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  /** Coalesce frames: flush on the next animation frame, with a timer fallback
   *  so a backgrounded tab (where rAF is paused) still catches up promptly. */
  private scheduleFlush(): void {
    if (this.rafId || this.flushTimer) return;
    this.rafId = requestAnimationFrame(() => this.flush());
    this.flushTimer = setTimeout(() => this.flush(), 60);
  }

  private flush(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.rafId = 0;
    this.flushTimer = null;
    if (this.inbox.length === 0) return;
    const batch = this.inbox;
    this.inbox = [];
    this.handlers.onBatch(batch);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
