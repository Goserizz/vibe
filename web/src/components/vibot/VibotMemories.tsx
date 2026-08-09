import { useState } from 'react';
import { X, Brain, ChevronRight } from 'lucide-react';
import { useVibotStore } from '../../store/vibot';
import { cn } from '../../lib/format';

/** Read-only viewer for the notes Vibot has chosen to remember. Mutations go
 *  through Vibot's own tools (save_memory / delete_memory) — this is the
 *  "方便后续查看" affordance. */
export function VibotMemories({ onClose }: { onClose: () => void }) {
  const memories = useVibotStore((s) => s.memories);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="new-session-panel flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-titlebar flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-slate-100">Vibot memories</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {memories.length === 0 ? (
            <div className="px-3 py-10 text-center text-xs text-slate-600">
              Vibot hasn&apos;t saved any memories yet.
              <br />
              Ask it to remember something important.
            </div>
          ) : (
            <ul className="space-y-1">
              {memories.map((m) => {
                const isOpen = open === m.id;
                return (
                  <li key={m.id}>
                    <button
                      onClick={() => setOpen(isOpen ? null : m.id)}
                      className="w-full rounded-lg px-2.5 py-2 text-left transition hover:bg-ink-800"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[13px] text-slate-200">{m.name}</span>
                        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 text-slate-600 transition-transform', isOpen && 'rotate-90')} />
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{m.description}</div>
                    </button>
                    {isOpen && (
                      <pre className="scroll-region mx-2 mb-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-white/5 bg-ink-950 p-2.5 font-mono text-[12px] leading-relaxed text-slate-400">
                        {m.content}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
