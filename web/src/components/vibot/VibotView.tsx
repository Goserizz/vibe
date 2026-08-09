import { useEffect, useState } from 'react';
import { Menu as MenuIcon } from 'lucide-react';
import { useVibotStore } from '../../store/vibot';
import { VibotSidebar } from './VibotSidebar';
import { VibotChat } from './VibotChat';
import { VibotSettings } from './VibotSettings';
import { VibotMemories } from './VibotMemories';
import { Toast } from '../Toast';

/** The fully separate Vibot interface: its own sidebar (conversation list),
 *  chat surface, and settings — never mixed with coding sessions. Reached by
 *  the mode toggle in the coding sidebar; onBack returns to coding. */
export function VibotView({ onBack }: { onBack: () => void }) {
  const loaded = useVibotStore((s) => s.loaded);
  const init = useVibotStore((s) => s.init);
  const activeConvId = useVibotStore((s) => s.activeConvId);
  const convs = useVibotStore((s) => s.convs);
  const newConversation = useVibotStore((s) => s.newConversation);
  const openConversation = useVibotStore((s) => s.openConversation);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);

  // Lazy-load Vibot data on first entry (REST + the already-wired vibot WS path).
  useEffect(() => {
    if (!loaded) void init();
  }, [loaded, init]);

  // Land on the most recent conversation if none is active yet.
  useEffect(() => {
    if (loaded && !activeConvId && convs.length > 0) void openConversation(convs[0].id);
  }, [loaded, activeConvId, convs, openConversation]);

  return (
    <div className="app-shell flex w-full overflow-hidden">
      <VibotSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={() => {
          void newConversation();
          setSidebarOpen(false);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMemories={() => setMemoriesOpen(true)}
        onBack={onBack}
      />

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Mobile-only hamburger (the sidebar is a drawer on small screens). */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="absolute left-2 top-2 z-30 flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-300 backdrop-blur-[2px] md:hidden"
        >
          <MenuIcon className="h-4 w-4" />
        </button>
        <VibotChat convId={activeConvId} onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      {settingsOpen && <VibotSettings onClose={() => setSettingsOpen(false)} />}
      {memoriesOpen && <VibotMemories onClose={() => setMemoriesOpen(false)} />}
      <Toast />
    </div>
  );
}
