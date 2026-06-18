import { useEffect, useRef, useState } from 'react';
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

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const activeId = useStore((s) => s.activeId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const theme = useStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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

  // (Re)connect whenever the active session changes — the terminal follows the
  // session's host + cwd.
  useEffect(() => {
    const el = containerRef.current;
    if (!activeId || !el) return;

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
    termRef.current = term;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const token = resolveToken() ?? '';
    const url = `${proto}://${window.location.host}/terminal?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(activeId)}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(url);
    let closedByUs = false;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onopen = () => {
      sendResize();
      term.focus();
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
      if (!closedByUs) term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
    };

    const dataDisp = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', data: d }));
    });

    const onFit = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* ignore */
      }
    };
    const ro = new ResizeObserver(onFit);
    ro.observe(el);

    return () => {
      closedByUs = true;
      ro.disconnect();
      dataDisp.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
    };
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live theme switch without dropping the running shell.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME;
  }, [theme]);

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
          <div ref={containerRef} className="h-full w-full" />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-slate-600">
          Open a session to use its host's terminal.
        </div>
      )}
    </aside>
  );
}
