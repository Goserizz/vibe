import { useEffect, useState } from 'react';
import { X, Server, Trash2, Plus, Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react';
import type { HostStatus } from '@shared/protocol';
import { useStore } from '../store/store';
import { api } from '../lib/api';

export function HostsDialog({ onClose }: { onClose: () => void }) {
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);
  const addHost = useStore((s) => s.addHost);
  const removeHost = useStore((s) => s.removeHost);

  const [name, setName] = useState('');
  const [ssh, setSsh] = useState('');
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<Record<string, HostStatus | 'checking'>>({});

  const check = async (host: string) => {
    setStatus((s) => ({ ...s, [host]: 'checking' }));
    try {
      const res = await api.checkHost(host);
      setStatus((s) => ({ ...s, [host]: res }));
    } catch {
      setStatus((s) => ({ ...s, [host]: { name: host, ssh: '', online: false, claude: false, error: 'check failed' } }));
    }
  };

  useEffect(() => {
    hosts.forEach((h) => void check(h.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts.length]);

  const submit = async () => {
    if (!name.trim() || !ssh.trim()) return;
    setAdding(true);
    const ok = await addHost({ name: name.trim(), ssh: ssh.trim() });
    setAdding(false);
    if (ok) {
      void check(name.trim());
      setName('');
      setSsh('');
    }
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
            <Server className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-slate-100">SSH hosts</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <p className="text-xs leading-relaxed text-slate-500">
            Add machines you reach over SSH (an <code className="text-slate-400">~/.ssh/config</code> alias or{' '}
            <code className="text-slate-400">user@host</code>). Their Claude Code sessions show up in the sidebar
            alongside <span className="text-slate-300">{localName}</span> (this machine). Key-based auth / ssh-agent is required.
          </p>

          <div className="space-y-1.5">
            {hosts.length === 0 && <div className="rounded-lg border border-white/5 px-3 py-4 text-center text-xs text-slate-600">No remote hosts yet.</div>}
            {hosts.map((h) => {
              const st = status[h.name];
              return (
                <div key={h.name} className="flex items-center gap-2.5 rounded-lg border border-white/5 bg-ink-900/20 px-3 py-2 backdrop-blur-md">
                  <StatusDot status={st} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-slate-200">{h.name}</div>
                    <div className="truncate font-mono text-[11px] text-slate-500">
                      {h.ssh}
                      {st && st !== 'checking' && !st.online && st.error ? ` — ${st.error}` : ''}
                      {st && st !== 'checking' && st.online && !st.claude ? ' — claude not found' : ''}
                    </div>
                  </div>
                  <button onClick={() => void check(h.name)} title="Re-check" className="rounded p-1.5 text-slate-500 hover:bg-ink-700 hover:text-slate-300">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => void removeHost(h.name)} title="Remove" className="rounded p-1.5 text-slate-500 hover:bg-ink-700 hover:text-rose-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2 border-t border-white/5 pt-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="h-10 min-w-0 rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60"
            />
            <input
              value={ssh}
              onChange={(e) => setSsh(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder="user@host or ssh alias"
              className="h-10 min-w-0 rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 font-mono text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60"
            />
            <button
              onClick={() => void submit()}
              disabled={adding || !name.trim() || !ssh.trim()}
              className="flex h-10 min-w-[84px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-soft disabled:opacity-40"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status?: HostStatus | 'checking' }) {
  if (status === 'checking') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />;
  if (!status) return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-slate-600" />;
  if (status.online && status.claude) return <Check className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (status.online) return <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />;
  return <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />;
}
