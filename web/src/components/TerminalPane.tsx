import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../store/store';
import { resolveToken } from '../lib/token';
import type { ITheme } from '@xterm/xterm';

const DARK_THEME: ITheme = {
  background: '#0a0b0f',
  foreground: '#e2e8f0',
  cursor: '#7c9cff',
  cursorAccent: '#0a0b0f',
  selectionBackground: 'rgba(124,156,255,0.30)',
};
const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1e293b',
  cursor: '#3b5bdb',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(59,91,219,0.20)',
};

// One persistent terminal per session. Switching sessions (or tabs) only
// toggles which container is shown — the PTY (server-side, tied to the WS)
// keeps running, so history and running processes survive. Instances are
// destroyed only when the panel closes (or the session is deleted). This pane
// is kept mounted (just hidden) while the Files tab is active, so returning to
// the Terminal tab never drops a live shell.
interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  el: HTMLDivElement;
  dataDisp: { dispose: () => void };
  ro: ResizeObserver;
  resize: () => void;
}

export function TerminalPane({ active }: { active: boolean }) {
  const activeId = useStore((s) => s.activeId);
  const sessions = useStore((s) => s.sessions);
  const theme = useStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement>(null);
  const instances = useRef<Map<string, TermInstance>>(new Map());

  const destroyInstance = useCallback((id: string) => {
    const inst = instances.current.get(id);
    if (!inst) return;
    inst.ro.disconnect();
    inst.dataDisp.dispose();
    try {
      inst.ws.close();
    } catch {
      /* already gone */
    }
    inst.term.dispose();
    inst.el.remove();
    instances.current.delete(id);
  }, []);

  // Lazily create a terminal instance for a session. The WS stays open across
  // session/tab switches, so the server-side PTY is preserved.
  const ensureInstance = useCallback(
    (id: string): TermInstance | undefined => {
      const existing = instances.current.get(id);
      if (existing) {
        const host = hostRef.current;
        if (host && existing.el.parentNode !== host) host.appendChild(existing.el);
        return existing;
      }
      const host = hostRef.current;
      if (!host) return undefined;

      const el = document.createElement('div');
      el.className = 'absolute inset-0';
      el.style.display = 'none';
      host.appendChild(el);

      const term = new Terminal({
        fontSize: 12.5,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: theme === 'light' ? LIGHT_THEME : DARK_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try {
        fit.fit();
      } catch {
        /* container not measured yet */
      }

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const token = resolveToken() ?? '';
      const url = `${proto}://${window.location.host}/terminal?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(id)}&cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(url);

      const sendResize = () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onopen = () => {
        sendResize();
      };
      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.t === 'data') term.write(m.data);
        else if (m.t === 'exit') term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
        else if (m.t === 'error') term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
      };
      ws.onclose = () => {
        try {
          term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
        } catch {
          /* term already disposed (panel/session closed) */
        }
      };

      const dataDisp = term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', data: d }));
      });

      const resize = () => {
        try {
          fit.fit();
          sendResize();
        } catch {
          /* ignore */
        }
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);

      const inst: TermInstance = { term, fit, ws, el, dataDisp, ro, resize };
      instances.current.set(id, inst);
      return inst;
    },
    [theme],
  );

  // Show + create + fit the active session's terminal, but only while this tab
  // is active. Creating lazily (gated on `active`) avoids spawning a background
  // PTY when the panel opened straight on the Files tab. Re-runs on session
  // switch and on tab return — the rAF fit recovers from a display:none parent.
  useEffect(() => {
    if (!active || !activeId) return;
    const inst = ensureInstance(activeId);
    if (!inst) return;
    for (const [id, it] of instances.current) {
      it.el.style.display = id === activeId ? '' : 'none';
    }
    const raf = requestAnimationFrame(() => {
      inst.resize();
      inst.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId, active, ensureInstance]);

  // Live theme switch without dropping any running shell.
  useEffect(() => {
    const t = theme === 'light' ? LIGHT_THEME : DARK_THEME;
    for (const it of instances.current.values()) it.term.options.theme = t;
  }, [theme]);

  // Reap terminals whose session was deleted (otherwise they'd leak, unreachable).
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const id of [...instances.current.keys()]) {
      if (!ids.has(id)) destroyInstance(id);
    }
  }, [sessions, destroyInstance]);

  // Closing the panel destroys every terminal.
  useEffect(() => {
    return () => {
      for (const id of [...instances.current.keys()]) destroyInstance(id);
    };
  }, [destroyInstance]);

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {activeId ? (
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          <div ref={hostRef} className="relative h-full w-full" />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-slate-600">
          Open a session to use its host's terminal.
        </div>
      )}
    </div>
  );
}
