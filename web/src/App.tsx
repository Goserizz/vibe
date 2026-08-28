import { useEffect, useState } from 'react';
import { useStore } from './store/store';
import { useVibotStore } from './store/vibot';
import { resolveToken } from './lib/token';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { NewSessionDialog } from './components/NewSessionDialog';
import { RightPanel } from './components/RightPanel';
import { FilePreview } from './components/FilePreview';
import { Toast } from './components/Toast';
import { Logo } from './components/Logo';
import { LoginGate } from './components/LoginGate';
import { VibotView } from './components/vibot/VibotView';

const MODE_KEY = 'vibe-mode';
function loadMode(): 'coding' | 'vibot' {
  try {
    return localStorage.getItem(MODE_KEY) === 'vibot' ? 'vibot' : 'coding';
  } catch {
    return 'coding';
  }
}

export default function App() {
  const phase = useStore((s) => s.phase);
  const init = useStore((s) => s.init);
  const [newOpen, setNewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mode, setMode] = useState<'coding' | 'vibot'>(loadMode);
  const activeId = useStore((s) => s.activeId);
  const isAdmin = useStore((s) => s.isAdmin);
  const activeTab = useStore((s) => (s.activeId ? s.rightTabs[s.activeId] ?? null : null));
  // The panel stays mounted while ANY session has it open (so a live terminal
  // in another session survives a switch); it's shown only for the active one.
  const anyOpen = useStore((s) => Object.values(s.rightTabs).some((t) => t === 'terminal' || t === 'files'));
  const setRightTab = useStore((s) => s.setRightTab);

  const switchMode = (m: 'coding' | 'vibot') => {
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  };

  /** Jump from a Vibot-linked coding session into the coding UI and open it. */
  const openCodingSession = (sessionId: string) => {
    switchMode('coding');
    void useStore.getState().openSession(sessionId);
  };

  useEffect(() => {
    const token = resolveToken();
    if (token) {
      void init(token);
      // Vibot shares the socket the coding store opens; its REST load needs the
      // token, which init sets synchronously before its first await.
      void useVibotStore.getState().init();
    } else {
      useStore.setState({ phase: 'unauthorized' });
    }
  }, [init]);

  // App shell follows the VisualViewport: keyboard open → shell shrinks to the
  // viewport (composer rises above the keyboard, page never scrolls); keyboard
  // closed → shell is 100vh (full screen). Fixed, so the document itself never
  // scrolls. The body's `app-bg` (attachment: scroll) paints the full screen
  // including the tab bar area, so the Liquid Glass bar shows the app through.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const keyboard = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      if (keyboard > 8) {
        root.style.setProperty('--shell-top', `${vv.offsetTop}px`);
        root.style.setProperty('--shell-height', `${vv.height}px`);
      } else {
        root.style.setProperty('--shell-top', '0px');
        root.style.setProperty('--shell-height', '100svh');
      }
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  if (phase === 'loading') return <SplashScreen />;
  if (phase === 'unauthorized') return <LoginGate />;

  // Vibot is a completely separate interface — its own sidebar, chat, and
  // settings, reached via the toggle in the coding sidebar. Admin-only: its
  // tools can drive any host, so non-admin accounts never enter this mode
  // (even via a stale localStorage preference).
  if (mode === 'vibot' && isAdmin) {
    return <VibotView onBack={() => switchMode('coding')} onOpenInCoding={openCodingSession} />;
  }

  return (
    <div className="app-shell flex w-full overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewSession={() => setNewOpen(true)}
        onOpenVibot={() => switchMode('vibot')}
      />
      <ChatView
        onOpenSidebar={() => setSidebarOpen(true)}
        onNewSession={() => setNewOpen(true)}
        rightTab={activeTab}
        onToggleTerminal={() => activeId && setRightTab(activeId, activeTab === 'terminal' ? null : 'terminal')}
        onToggleFiles={() => activeId && setRightTab(activeId, activeTab === 'files' ? null : 'files')}
      />
      {anyOpen && (
        <RightPanel
          tab={activeTab ?? 'terminal'}
          shown={!!activeTab}
          onTab={(t) => activeId && setRightTab(activeId, t)}
          onClose={() => activeId && setRightTab(activeId, null)}
        />
      )}
      {newOpen && <NewSessionDialog onClose={() => setNewOpen(false)} />}
      <FilePreview />
      <Toast />
    </div>
  );
}

function SplashScreen() {
  return (
    <div className="app-shell flex w-full items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Logo className="h-10 w-10 animate-pulse-dot text-accent" />
        <div className="text-sm text-slate-500">Connecting…</div>
      </div>
    </div>
  );
}

