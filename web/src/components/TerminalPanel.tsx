import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { X, SquareTerminal } from 'lucide-react';
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

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 460;
const maxWidth = () => Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - 360));

// One persistent terminal per session. Switching sessions only toggles which
// container is shown — the PTY (server-side, tied to the WS) keeps running, so
// history and running processes survive. Instances are destroyed only when the
// panel closes (or the session is deleted).
interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  el: HTMLDivElement;
  dataDisp: { dispose: () => void };
  ro: ResizeObserver;
  resize: () => void;
}

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const activeId = useStore((s) => s.activeId);
  const sessions = useStore((s) => s.sessions);
  const session = sessions.find((x) => x.id === activeId);
  const theme = useStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement>(null);
  const instances = useRef<Map<string, TermInstance>>(new Map());

  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('vibe.termWidth'));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH;
  });
  useEffect(() => {
    try {
      localStorage.setItem('vibe.termWidth', String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_WIDTH, Math.min(maxWidth(), window.innerWidth - ev.clientX));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

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
  // session switches, so the server-side PTY is preserved.
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

  // Show the active session's terminal (creating it if needed) and hide the
  // rest. Re-fit on return from hidden — a display:none container has no size.
  useEffect(() => {
    if (!activeId) return;
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
  }, [activeId, ensureInstance]);

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
    <aside
      style={{ ['--term-w' as string]: `${width}px` } as React.CSSProperties}
      className="relative z-40 flex h-full w-full shrink-0 flex-col border-l border-white/5 bg-ink-950 max-md:fixed max-md:inset-0 md:w-[var(--term-w)]"
    >
      {/* Drag handle to resize the panel (desktop only). */}
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        className="absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize transition-colors hover:bg-accent/30 md:block"
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-2.5">
        <SquareTerminal className="h-4 w-4 text-accent" />
        <span className="text-[13px] font-medium text-slate-200">Terminal</span>
        {session && <span className="truncate text-[11px] text-slate-500">· {session.host}</span>}
        <button
          onClick={onClose}
          title="Close terminal"
          className="ml-auto rounded-lg p-1.5 text-slate-500 transition hover:bg-ink-800 hover:text-slate-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {activeId ? (
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          <div ref={hostRef} className="relative h-full w-full" />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-slate-600">
          Open a session to use its host's terminal.
        </div>
      )}
    </aside>
  );
}
