import { lazy, Suspense, useEffect, useState } from 'react';
import { X, SquareTerminal, FolderOpen, Loader2 } from 'lucide-react';
import { useStore } from '../store/store';
import { cn } from '../lib/format';
import { TerminalPane } from './TerminalPane';

// CodeMirror is heavy — only load it when the Files tab is first opened.
const FilesPane = lazy(() => import('./FilesPane').then((m) => ({ default: m.FilesPane })));

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 460;
const maxWidth = () => Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - 360));

export function RightPanel({
  tab,
  onTab,
  onClose,
}: {
  tab: 'terminal' | 'files';
  onTab: (t: 'terminal' | 'files') => void;
  onClose: () => void;
}) {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));

  // Load the Files pane (and its CodeMirror chunk) on first visit, then keep it
  // mounted so editor state survives tab switches.
  const [filesEverOpened, setFilesEverOpened] = useState(tab === 'files');
  useEffect(() => {
    if (tab === 'files') setFilesEverOpened(true);
  }, [tab]);

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

  return (
    <aside
      style={{ ['--panel-w' as string]: `${width}px` } as React.CSSProperties}
      className="relative z-40 flex h-full w-full shrink-0 flex-col border-l border-white/5 bg-ink-950 max-md:fixed max-md:inset-0 md:w-[var(--panel-w)]"
    >
      {/* Drag handle to resize the panel (desktop only). */}
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        className="absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize transition-colors hover:bg-accent/30 md:block"
      />

      <div className="flex shrink-0 items-center gap-1 border-b border-white/5 px-2 py-2">
        <TabButton active={tab === 'terminal'} onClick={() => onTab('terminal')} icon={<SquareTerminal className="h-3.5 w-3.5" />} label="Terminal" />
        <TabButton active={tab === 'files'} onClick={() => onTab('files')} icon={<FolderOpen className="h-3.5 w-3.5" />} label="Files" />
        {session && <span className="ml-1 truncate text-[11px] text-slate-500">· {session.host}</span>}
        <button
          onClick={onClose}
          title="Close panel"
          className="ml-auto rounded-lg p-1.5 text-slate-500 transition hover:bg-ink-800 hover:text-slate-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Both panes stay mounted while the panel is open — only visibility
          toggles, so a live terminal and any in-progress edits survive tab
          switches. */}
      <div className={cn('min-h-0 flex-1 flex-col', tab === 'terminal' ? 'flex' : 'hidden')}>
        <TerminalPane active={tab === 'terminal'} />
      </div>
      <div className={cn('min-h-0 flex-1 flex-col', tab === 'files' ? 'flex' : 'hidden')}>
        {filesEverOpened && (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-[12px] text-slate-600">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading editor…
              </div>
            }
          >
            <FilesPane />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition',
        active ? 'bg-accent/15 text-accent-soft' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
