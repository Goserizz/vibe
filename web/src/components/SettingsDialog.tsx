import { X, Settings, Volume2, Play, Plug, Bookmark } from 'lucide-react';
import { useStore } from '../store/store';
import { NOTIFY_SOUNDS, playNotifySound, type NotifySoundId } from '../lib/notifySound';
import { cn } from '../lib/format';
import { McpServerRegistry, McpEnableList } from './McpControls';
import { PresetRegistry } from './PresetControls';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const notifySound = useStore((s) => s.notifySound);
  const setNotifySound = useStore((s) => s.setNotifySound);

  const select = (id: NotifySoundId) => {
    setNotifySound(id);
    if (id !== 'none') playNotifySound(id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4"
      style={{ background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      onClick={onClose}
    >
      <div className="new-session-panel w-full max-w-lg rounded-2xl">
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="dialog-titlebar flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Volume2 className="h-3.5 w-3.5 text-slate-400" />
                <h3 className="text-xs font-medium text-slate-400">Completion sound</h3>
              </div>
              <p className="mb-3 text-[12px] leading-relaxed text-slate-600">
                Play a short cue when the model finishes a turn.
              </p>
              <ul className="space-y-1">
                {NOTIFY_SOUNDS.map((sound) => {
                  const active = notifySound === sound.id;
                  return (
                    <li key={sound.id}>
                      <div
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-3 py-2.5 transition',
                          active
                            ? 'border-accent/40 bg-accent/10'
                            : 'border-transparent hover:bg-ink-800/80',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => select(sound.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block text-[13px] text-slate-200">{sound.label}</span>
                          <span className="block text-[11px] text-slate-500">{sound.hint}</span>
                        </button>
                        {sound.id !== 'none' && (
                          <button
                            type="button"
                            title="Preview"
                            aria-label={`Preview ${sound.label}`}
                            onClick={() => playNotifySound(sound.id)}
                            className="shrink-0 rounded-md p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
                          >
                            <Play className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            active ? 'bg-accent' : 'bg-transparent',
                          )}
                          aria-hidden
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <Plug className="h-3.5 w-3.5 text-slate-400" />
                <h3 className="text-xs font-medium text-slate-400">MCP servers</h3>
              </div>
              <p className="mb-3 text-[12px] leading-relaxed text-slate-600">
                Define Model Context Protocol servers once, then enable them per host. For remote hosts the command runs on
                that host, so reference executables that exist there.
              </p>
              <div className="space-y-3">
                <McpServerRegistry />
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Enabled on this machine
                  </div>
                  <McpEnableList scope="local" emptyHint="Enable servers here to use them in local sessions." />
                </div>
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <Bookmark className="h-3.5 w-3.5 text-slate-400" />
                <h3 className="text-xs font-medium text-slate-400">Session presets</h3>
              </div>
              <p className="mb-3 text-[12px] leading-relaxed text-slate-600">
                Save an agent + model + permission + reasoning-effort bundle, then apply it in one click from the New
                Session dialog. Presets are host-agnostic — invalid combos are reconciled when applied.
              </p>
              <PresetRegistry />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
