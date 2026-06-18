import { ShieldQuestion, Check, CheckCheck, Ban } from 'lucide-react';
import { useStore } from '../store/store';
import { toolMeta } from './blocks';

export function PermissionPrompt({ sessionId }: { sessionId: string }) {
  const pending = useStore((s) => s.pending[sessionId]);
  const respond = useStore((s) => s.respondPermission);
  if (!pending || pending.length === 0) return null;

  // One at a time keeps the surface calm; the rest queue behind it.
  const req = pending[0];
  const meta = toolMeta(req.toolName, req.input);
  const Icon = meta.icon;

  return (
    <div className="px-4 pb-2 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="glass overflow-hidden rounded-2xl border-amber-400/20 animate-fade-in">
          <div className="flex items-center gap-2.5 border-b border-white/5 bg-amber-400/5 px-4 py-2.5">
            <ShieldQuestion className="h-4 w-4 text-amber-400" />
            <span className="text-[13px] font-medium text-slate-200">Permission required</span>
            {pending.length > 1 && (
              <span className="ml-auto text-[11px] text-slate-500">+{pending.length - 1} more</span>
            )}
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-[13px]">
              <Icon className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="font-medium text-slate-200">{meta.label}</span>
            </div>
            {meta.detail && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[#0b0e14] p-2.5 font-mono text-[12px] text-slate-400">
                {meta.detail}
              </pre>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => respond(req.requestId, { allow: true })}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-ink-950 transition hover:bg-accent-soft"
              >
                <Check className="h-3.5 w-3.5" />
                Allow
              </button>
              <button
                onClick={() => respond(req.requestId, { allow: true, remember: true })}
                className="flex items-center gap-1.5 rounded-lg border border-ink-600 px-3.5 py-2 text-[13px] text-slate-300 transition hover:border-accent/40 hover:text-accent-soft"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Always allow {req.toolName}
              </button>
              <button
                onClick={() => respond(req.requestId, { allow: false })}
                className="ml-auto flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] text-slate-400 transition hover:text-rose-400"
              >
                <Ban className="h-3.5 w-3.5" />
                Deny
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
