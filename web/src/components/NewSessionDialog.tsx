import { useMemo, useState } from 'react';
import { X, FolderGit2, Folder, Loader2, Check, AlertCircle } from 'lucide-react';
import type { EffortLevel, PermissionMode } from '@shared/protocol';
import { useStore } from '../store/store';
import { api } from '../lib/api';
import { basename, cn, EFFORT_LEVELS, MODELS, PERMISSION_MODES, shortenPath } from '../lib/format';

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);
  const defaultModel = useStore((s) => s.defaultModel);
  const createSession = useStore((s) => s.createSession);

  // '' = local machine; otherwise a remote host name.
  const [host, setHost] = useState('');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [model, setModel] = useState(defaultModel);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [effort, setEffort] = useState<EffortLevel>('max');
  const [query, setQuery] = useState('');
  const [pathState, setPathState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  const [creating, setCreating] = useState(false);

  const isRemote = host !== '';

  // Local: recently used local project dirs. Remote: cwds seen in that host's sessions.
  const suggestions = useMemo(() => {
    if (isRemote) {
      const seen = new Map<string, { path: string; name: string }>();
      for (const s of sessions) {
        if (s.host === host && !seen.has(s.cwd)) seen.set(s.cwd, { path: s.cwd, name: basename(s.cwd) });
      }
      return [...seen.values()];
    }
    return projects.map((p) => ({ path: p.path, name: p.name }));
  }, [isRemote, host, sessions, projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suggestions;
    return suggestions.filter((p) => p.path.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [suggestions, query]);

  const pickProject = (path: string) => {
    setCwd(path);
    setQuery(path);
    setPathState('ok');
    if (!title) setTitle(basename(path));
  };

  const checkPath = async (value: string) => {
    const v = value.trim();
    if (!v || isRemote) {
      // Remote paths can't be validated locally — trust them.
      setPathState(v && isRemote ? 'ok' : 'idle');
      if (v) setCwd(v);
      return;
    }
    setPathState('checking');
    const res = await api.validateDir(v);
    setPathState(res.ok ? 'ok' : 'bad');
    if (res.ok) {
      setCwd(res.path);
      if (!title) setTitle(basename(res.path));
    }
  };

  const submit = async () => {
    const dir = cwd.trim() || query.trim();
    if (!dir) return;
    setCreating(true);
    await createSession({ cwd: dir, model, permissionMode, effort, title: title.trim() || basename(dir), host: host || undefined });
    setCreating(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-100">New session</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {hosts.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Machine</label>
              <div className="flex flex-wrap gap-1.5">
                <HostOption label={localName} active={host === ''} onClick={() => { setHost(''); setPathState('idle'); }} />
                {hosts.map((h) => (
                  <HostOption key={h.name} label={h.name} remote active={host === h.name} onClick={() => { setHost(h.name); setCwd(''); setQuery(''); setPathState('idle'); }} />
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Working directory {isRemote && <span className="text-slate-600">on {host}</span>}
            </label>
            <div className="relative">
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCwd('');
                  setPathState('idle');
                }}
                onBlur={(e) => void checkPath(e.target.value)}
                placeholder={isRemote ? '/remote/path/to/project' : '/path/to/project or ~/code/app'}
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 pr-9 font-mono text-[13px] text-slate-200 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {pathState === 'checking' && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
                {pathState === 'ok' && <Check className="h-4 w-4 text-emerald-400" />}
                {pathState === 'bad' && <AlertCircle className="h-4 w-4 text-rose-400" />}
              </span>
            </div>
            {pathState === 'bad' && <p className="mt-1 text-[11px] text-rose-400">Directory not found on the server.</p>}
          </div>

          {filtered.length > 0 && (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-white/5 bg-ink-900/50">
              {filtered.map((p) => (
                <button
                  key={p.path}
                  onClick={() => pickProject(p.path)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-ink-800',
                    cwd === p.path && 'bg-accent/10',
                  )}
                >
                  <FolderGit2 className="h-4 w-4 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-slate-200">{p.name}</div>
                    <div className="truncate font-mono text-[11px] text-slate-600">{shortenPath(p.path, 4)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Model</label>
              <Segmented
                options={MODELS}
                value={model}
                onChange={setModel}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-slate-200 outline-none transition focus:border-accent/60"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Permissions</label>
            <div className="grid grid-cols-4 gap-1.5">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setPermissionMode(m.value)}
                  title={m.hint}
                  className={cn(
                    'rounded-lg border px-2 py-2 text-[12px] transition',
                    permissionMode === m.value
                      ? 'border-accent/50 bg-accent/15 text-accent-soft'
                      : 'border-ink-700 text-slate-400 hover:border-ink-600 hover:text-slate-200',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Reasoning effort</label>
            <div className="grid grid-cols-5 gap-1.5">
              {EFFORT_LEVELS.map((e) => (
                <button
                  key={e.value}
                  onClick={() => setEffort(e.value)}
                  title={e.hint}
                  className={cn(
                    'rounded-lg border px-2 py-2 text-[12px] transition',
                    effort === e.value
                      ? 'border-accent/50 bg-accent/15 text-accent-soft'
                      : 'border-ink-700 text-slate-400 hover:border-ink-600 hover:text-slate-200',
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/5 px-5 py-3.5">
          <button onClick={onClose} className="rounded-lg px-3.5 py-2 text-sm text-slate-400 transition hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={creating || (!cwd.trim() && !query.trim())}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function HostOption({ label, active, remote, onClick }: { label: string; active: boolean; remote?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
        active ? 'border-accent/50 bg-accent/15 text-accent-soft' : 'border-ink-700 text-slate-400 hover:border-ink-600 hover:text-slate-200',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', remote ? 'bg-accent/80' : 'bg-slate-500')} />
      {label}
    </button>
  );
}

function Segmented({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-900 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 rounded-md py-1.5 text-[12px] transition',
            value === o.value ? 'bg-ink-700 text-slate-100' : 'text-slate-500 hover:text-slate-300',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
