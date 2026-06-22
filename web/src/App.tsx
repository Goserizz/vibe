import { useEffect, useState } from 'react';
import { useStore } from './store/store';
import { resolveToken, setToken } from './lib/token';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { NewSessionDialog } from './components/NewSessionDialog';
import { RightPanel } from './components/RightPanel';
import { Toast } from './components/Toast';
import { Logo } from './components/Logo';

export default function App() {
  const phase = useStore((s) => s.phase);
  const init = useStore((s) => s.init);
  const [newOpen, setNewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'terminal' | 'files' | null>(null);

  useEffect(() => {
    const token = resolveToken();
    if (token) void init(token);
    else useStore.setState({ phase: 'unauthorized' });
  }, [init]);

  if (phase === 'loading') return <SplashScreen />;
  if (phase === 'unauthorized') return <TokenGate />;

  return (
    <div className="flex h-full w-full overflow-hidden bg-ink-950">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewSession={() => setNewOpen(true)}
      />
      <ChatView
        onOpenSidebar={() => setSidebarOpen(true)}
        onNewSession={() => setNewOpen(true)}
        rightTab={rightTab}
        onToggleTerminal={() => setRightTab((v) => (v === 'terminal' ? null : 'terminal'))}
        onToggleFiles={() => setRightTab((v) => (v === 'files' ? null : 'files'))}
      />
      {rightTab && <RightPanel tab={rightTab} onTab={(t) => setRightTab(t)} onClose={() => setRightTab(null)} />}
      {newOpen && <NewSessionDialog onClose={() => setNewOpen(false)} />}
      <Toast />
    </div>
  );
}

function SplashScreen() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950">
      <div className="flex flex-col items-center gap-4">
        <Logo className="h-10 w-10 animate-pulse-dot text-accent" />
        <div className="text-sm text-slate-500">Connecting…</div>
      </div>
    </div>
  );
}

function TokenGate() {
  const init = useStore((s) => s.init);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setToken(token);
    useStore.setState({ phase: 'loading' });
    await init(token);
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950 px-6">
      <form onSubmit={submit} className="glass w-full max-w-sm rounded-2xl p-7 shadow-2xl animate-fade-in">
        <div className="mb-5 flex items-center gap-3">
          <Logo className="h-8 w-8 text-accent" />
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Vibe</h1>
            <p className="text-xs text-slate-500">Remote vibe coding for Claude Code</p>
          </div>
        </div>
        <label className="mb-1.5 block text-xs font-medium text-slate-400">Access token</label>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the token from your terminal"
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-slate-200 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-600">
          The server prints a ready-to-use link with the token on startup.
        </p>
      </form>
    </div>
  );
}
