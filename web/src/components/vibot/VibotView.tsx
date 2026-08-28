import { useEffect, useState } from 'react';
import { Menu as MenuIcon } from '../../lib/icons';
import { useStore } from '../../store/store';
import { useVibotStore } from '../../store/vibot';
import { VibotSidebar } from './VibotSidebar';
import { VibotChat } from './VibotChat';
import { VibotSettings } from './VibotSettings';
import { VibotMemories } from './VibotMemories';
import { VibotSessionPreview } from './VibotSessionPreview';
import { RightPanel } from '../RightPanel';
import { FilePreview } from '../FilePreview';
import { Toast } from '../Toast';

/** The fully separate Vibot interface: its own sidebar (conversation list),
 *  chat surface, and settings. Linked coding sessions open as a full ChatView
 *  embed (same composer / permissions / todos / tasks as coding mode). */
export function VibotView({
  onBack,
  onOpenInCoding,
}: {
  onBack: () => void;
  /** Leave Vibot and open a coding session for full interaction. */
  onOpenInCoding: (sessionId: string) => void;
}) {
  const loaded = useVibotStore((s) => s.loaded);
  const init = useVibotStore((s) => s.init);
  const activeConvId = useVibotStore((s) => s.activeConvId);
  const convs = useVibotStore((s) => s.convs);
  const newConversation = useVibotStore((s) => s.newConversation);
  const openConversation = useVibotStore((s) => s.openConversation);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  /** Coding session shown as a full ChatView overlay over Vibot chat (null = chat). */
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);
  /** Bumps on every preview open (including re-clicking the same session) so the
   *  owning sidebar row can re-expand after a manual collapse. */
  const [previewExpandToken, setPreviewExpandToken] = useState(0);

  const rightTabs = useStore((s) => s.rightTabs);
  const activeTab = previewSessionId ? rightTabs[previewSessionId] ?? null : null;
  const setRightTab = useStore((s) => s.setRightTab);

  const openPreview = (sessionId: string) => {
    setPreviewSessionId(sessionId);
    setPreviewExpandToken((n) => n + 1);
    setSidebarOpen(false);
  };

  // Lazy-load Vibot data on first entry (REST + the already-wired vibot WS path).
  useEffect(() => {
    if (!loaded) void init();
  }, [loaded, init]);

  // Land on the most recent conversation if none is active yet.
  useEffect(() => {
    if (loaded && !activeConvId && convs.length > 0) void openConversation(convs[0].id);
  }, [loaded, activeConvId, convs, openConversation]);

  // Switching Vibot chats dismisses any session preview so the new chat shows.
  useEffect(() => {
    setPreviewSessionId(null);
  }, [activeConvId]);

  return (
    <div className="app-shell flex w-full overflow-hidden">
      <VibotSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={() => {
          void newConversation();
          setSidebarOpen(false);
          setPreviewSessionId(null);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMemories={() => setMemoriesOpen(true)}
        onBack={onBack}
        onPreviewSession={openPreview}
        previewSessionId={previewSessionId}
        previewExpandToken={previewExpandToken}
        onDismissPreview={() => setPreviewSessionId(null)}
      />

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Mobile hamburger only on Vibot chat — ChatView embed uses ← Back instead. */}
        {!previewSessionId && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute left-2 top-2 z-30 flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 text-slate-300 backdrop-blur-[2px] md:hidden"
          >
            <MenuIcon className="h-4 w-4" />
          </button>
        )}
        {previewSessionId ? (
          <VibotSessionPreview
            sessionId={previewSessionId}
            onBack={() => setPreviewSessionId(null)}
            onOpenInCoding={() => onOpenInCoding(previewSessionId)}
            onOpenSidebar={() => setSidebarOpen(true)}
            rightTab={activeTab}
            onToggleTerminal={() =>
              setRightTab(previewSessionId, activeTab === 'terminal' ? null : 'terminal')
            }
            onToggleFiles={() =>
              setRightTab(previewSessionId, activeTab === 'files' ? null : 'files')
            }
          />
        ) : (
          <VibotChat
            convId={activeConvId}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenSession={openPreview}
            onSessionUnlinked={(id) => {
              if (previewSessionId === id) setPreviewSessionId(null);
            }}
          />
        )}
      </div>

      {previewSessionId && activeTab && (
        <RightPanel
          tab={activeTab}
          shown
          onTab={(t) => setRightTab(previewSessionId, t)}
          onClose={() => setRightTab(previewSessionId, null)}
        />
      )}

      {settingsOpen && <VibotSettings onClose={() => setSettingsOpen(false)} />}
      {memoriesOpen && <VibotMemories onClose={() => setMemoriesOpen(false)} />}
      <FilePreview />
      <Toast />
    </div>
  );
}
