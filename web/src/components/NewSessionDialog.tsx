import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { X, FolderGit2, Folder, Loader2, Check, AlertCircle, ChevronDown } from 'lucide-react';
import type { AgentKind, EffortLevel, PermissionMode } from '@shared/protocol';
import { useStore } from '../store/store';
import { api } from '../lib/api';
import { basename, cn, AGENTS, effortLevelsForAgent, modelsForAgent, permissionModesForAgent, shortenPath } from '../lib/format';

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);
  const defaultModel = useStore((s) => s.defaultModel);
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const createSession = useStore((s) => s.createSession);

  // '' = local machine; otherwise a remote host name.
  const [host, setHost] = useState('');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [model, setModel] = useState(defaultModel);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [effort, setEffort] = useState<EffortLevel>('max');
  const [query, setQuery] = useState('');
  const [pathState, setPathState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  const [creating, setCreating] = useState(false);
  const [completions, setCompletions] = useState<{ name: string; full: string; dir: boolean }[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const reqIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const isRemote = host !== '';
  const effortLevels = effortLevelsForAgent(agent);
  const machineOptions = useMemo(
    () => [
      { value: '', label: localName, hint: 'Local machine' },
      ...hosts.map((h) => ({ value: h.name, label: h.name, hint: h.ssh })),
    ],
    [hosts, localName],
  );
  const modelOptions = useMemo(() => modelsForAgent(agent, cursorModels, codexModels), [agent, cursorModels, codexModels]);
  const permissionOptions = useMemo(() => permissionModesForAgent(agent), [agent]);

  // Switching engine resets model + permission to that engine's sensible defaults.
  const onAgent = (a: AgentKind) => {
    setAgent(a);
    const custom = a !== 'claude';
    setModel(custom ? 'auto' : defaultModel);
    setPermissionMode(custom ? 'default' : 'bypassPermissions');
    // Codex's model_reasoning_effort tops out at xhigh (its max); claude defaults to max.
    setEffort(a === 'codex' ? 'xhigh' : 'max');
  };

  const onHost = (next: string) => {
    if (next === host) return;
    setHost(next);
    setCwd('');
    setQuery('');
    setPathState('idle');
  };

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

  const pickCompletion = (full: string) => {
    // Append a trailing slash so the user can keep drilling; the effect below
    // lists the chosen directory's children next.
    setQuery(full.endsWith('/') ? full : `${full}/`);
    setCwd(full);
    setPathState('ok');
    setCompletions([]);
    setOpen(false);
    setActiveIdx(-1);
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || !open || completions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % completions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + completions.length) % completions.length);
    } else if (e.key === 'Enter') {
      const sel = completions[activeIdx];
      if (sel) {
        e.preventDefault();
        pickCompletion(sel.full);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Live filesystem completion: when the input looks like a path, list matching
  // sub-directories. Debounced + stale-response guarded so fast typing stays snappy.
  useEffect(() => {
    const looksPath = query.includes('/') || query.startsWith('~');
    if (!looksPath) {
      setCompletions([]);
      setOpen(false);
      return;
    }
    const id = ++reqIdRef.current;
    const handle = setTimeout(async () => {
      try {
        const r = await api.completeDir({ path: query, host: host || undefined });
        if (id !== reqIdRef.current) return;
        setCompletions(r.entries);
        setActiveIdx(r.entries.length ? 0 : -1);
        setOpen(r.entries.length > 0);
      } catch {
        if (id !== reqIdRef.current) return;
        setCompletions([]);
        setOpen(false);
      }
    }, 130);
    return () => clearTimeout(handle);
  }, [query, host]);

  // Keep the keyboard-highlighted item scrolled into view.
  useEffect(() => {
    if (!open || activeIdx < 0) return;
    listRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const submit = async () => {
    const dir = cwd.trim() || query.trim();
    if (!dir) return;
    setCreating(true);
    await createSession({ cwd: dir, model, permissionMode, effort, agent, title: title.trim() || basename(dir), host: host || undefined });
    setCreating(false);
    onClose();
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
          <h2 className="text-sm font-semibold text-slate-100">New session</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-3">
            <DropdownField label="Agent" value={agent} options={AGENTS} onChange={onAgent} />
            <DropdownField label="Machine" value={host} options={machineOptions} onChange={onHost} />
          </div>

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
                onKeyDown={onInputKeyDown}
                onFocus={() => {
                  if (completions.length) setOpen(true);
                }}
                onBlur={(e) => {
                  setOpen(false);
                  void checkPath(e.target.value);
                }}
                placeholder={isRemote ? '/remote/path/to/project' : '/path/to/project or ~/code/app'}
                className="w-full rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2.5 pr-9 font-mono text-[13px] text-slate-200 outline-none backdrop-blur-md transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {pathState === 'checking' && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
                {pathState === 'ok' && <Check className="h-4 w-4 text-emerald-400" />}
                {pathState === 'bad' && <AlertCircle className="h-4 w-4 text-rose-400" />}
              </span>
              {open && completions.length > 0 && (
                <div
                  ref={listRef}
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute left-0 right-0 top-full z-20 mt-1 max-h-52 overflow-y-auto rounded-lg border border-white/10 bg-ink-900/95 py-1 shadow-2xl backdrop-blur-md"
                >
                  {completions.map((c, i) => (
                    <button
                      key={c.full}
                      type="button"
                      data-idx={i}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => pickCompletion(c.full)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition',
                        i === activeIdx ? 'bg-accent/15 text-slate-100' : 'text-slate-300 hover:bg-ink-800/50',
                      )}
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      <span className="truncate font-mono text-[12.5px]">{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {pathState === 'bad' && <p className="mt-1 text-[11px] text-rose-400">Directory not found on the server.</p>}
          </div>

          {!open && filtered.length > 0 && (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-white/5 bg-ink-900/20 backdrop-blur-md">
              {filtered.map((p) => (
                <button
                  key={p.path}
                  onClick={() => pickProject(p.path)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-ink-800/45',
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
            <DropdownField
              label="Model"
              value={model}
              options={modelOptions}
              onChange={setModel}
            />
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[13px] text-slate-200 outline-none backdrop-blur-md transition focus:border-accent/60"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DropdownField
              label="Permissions"
              value={permissionMode}
              options={permissionOptions}
              onChange={(v) => setPermissionMode(v)}
            />
            {effortLevels.length > 0 && (
              <DropdownField
                label="Reasoning effort"
                value={effort}
                options={effortLevels}
                onChange={(v) => setEffort(v)}
              />
            )}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-white/5 px-5 py-3.5">
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
    </div>
  );
}

function DropdownField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  const selected = options.find((o) => o.value === value);

  return (
    <div className="min-w-0">
      <label className="mb-1.5 block truncate text-xs font-medium text-slate-400">{label}</label>
      <div className="relative">
        <select
          value={value}
          title={selected?.hint}
          onChange={(e) => onChange(e.target.value as T)}
          className="h-9 w-full appearance-none truncate rounded-lg border border-ink-700 bg-ink-900/35 px-3 pr-8 text-[13px] text-slate-200 outline-none backdrop-blur-md transition hover:border-ink-600 focus:border-accent/60"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
      </div>
    </div>
  );
}
