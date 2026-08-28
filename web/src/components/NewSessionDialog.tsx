import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { X, FolderGit2, Folder, Loader2, Check, AlertCircle, ChevronDown, BookmarkPlus } from '../lib/icons';
import type { AgentKind, EffortLevel, PermissionMode } from '@shared/protocol';
import { useStore } from '../store/store';
import { api } from '../lib/api';
import { basename, cn, AGENTS, agentLabel, defaultEffortForAgent, effortLabel, effortLevelsForAgent, modelLabel, modelsForAgent, permissionModesForAgent, shortenPath } from '../lib/format';
import { loadNewSessionPrefs, saveNewSessionPrefs } from '../lib/newSessionPrefs';

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);
  const isAdmin = useStore((s) => s.isAdmin);
  const defaultModel = useStore((s) => s.defaultModel);
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kimiPermissionModes = useStore((s) => s.kimiPermissionModes);
  const kiroModels = useStore((s) => s.kiroModels);
  const kiroPermissionModes = useStore((s) => s.kiroPermissionModes);
  const grokModels = useStore((s) => s.grokModels);
  const zcodeModels = useStore((s) => s.zcodeModels);
  const loadCursorModels = useStore((s) => s.loadCursorModels);
  const loadCodexModels = useStore((s) => s.loadCodexModels);
  const loadKimiCapabilities = useStore((s) => s.loadKimiCapabilities);
  const loadKiroModels = useStore((s) => s.loadKiroModels);
  const loadGrokModels = useStore((s) => s.loadGrokModels);
  const loadZcodeModels = useStore((s) => s.loadZcodeModels);
  const createSession = useStore((s) => s.createSession);
  const presets = useStore((s) => s.presets);
  const upsertPreset = useStore((s) => s.upsertPreset);
  const setToast = useStore((s) => s.setToast);

  // Restore last create options (not cwd/title). Lazy so we only read storage once.
  const saved = useMemo(() => loadNewSessionPrefs(), []);

  // '' = local machine; otherwise a remote host name.
  const [host, setHost] = useState(saved?.host ?? '');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<AgentKind>(saved?.agent ?? 'claude');
  const [model, setModel] = useState(saved?.model ?? defaultModel);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    saved?.permissionMode ?? 'bypassPermissions',
  );
  const [effort, setEffort] = useState<EffortLevel>(saved?.effort ?? 'max');
  // "Save as preset" inline affordance state.
  const [naming, setNaming] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [query, setQuery] = useState('');
  const [pathState, setPathState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  // When true, skip the working-directory picker: the server creates a throwaway folder.
  const [autoCwd, setAutoCwd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [completions, setCompletions] = useState<{ name: string; full: string; dir: boolean }[]>([]);
  const [open, setOpen] = useState(false);
  const [cwdMenuOpen, setCwdMenuOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const reqIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const isRemote = host !== '';
  const modelOptions = useMemo(
    () => modelsForAgent(agent, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels),
    [agent, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels],
  );
  const modelOpt = useMemo(() => modelOptions.find((m) => m.value === model) ?? null, [modelOptions, model]);
  const effortLevels = useMemo(() => effortLevelsForAgent(agent, modelOpt), [agent, modelOpt]);
  // The local machine is admin-only; other accounts pick among their own hosts.
  const machineOptions = useMemo(
    () => [
      ...(isAdmin ? [{ value: '', label: localName, hint: 'Local machine' }] : []),
      ...hosts.map((h) => ({ value: h.name, label: h.name, hint: h.ssh })),
    ],
    [hosts, localName, isAdmin],
  );
  const permissionOptions = useMemo(
    () => permissionModesForAgent(agent, kimiPermissionModes, kiroPermissionModes),
    [agent, kimiPermissionModes, kiroPermissionModes],
  );

  // Drop a remembered remote host if it no longer exists in the hosts list.
  // Non-admin accounts have no local option — default to their first host.
  useEffect(() => {
    if (isAdmin) {
      if (host && !hosts.some((h) => h.name === host)) setHost('');
      return;
    }
    if (host && hosts.some((h) => h.name === host)) return;
    setHost(hosts[0]?.name ?? '');
  }, [host, hosts, isAdmin]);

  // Switching engine resets model + permission to that engine's sensible defaults.
  const onAgent = (a: AgentKind) => {
    setAgent(a);
    const custom = a !== 'claude';
    setModel(custom ? 'auto' : defaultModel);
    setPermissionMode(custom ? 'default' : 'bypassPermissions');
    setEffort(defaultEffortForAgent(a));
  };

  const onHost = (next: string) => {
    if (next === host) return;
    setHost(next);
    setCwd('');
    setQuery('');
    setPathState('idle');
  };

  // The preset dropdown is driven by the current 4-field combo: it shows a
  // preset name when the combo exactly matches one, "Custom" otherwise. So
  // applying a preset (or reconciling an invalid field away) is reflected
  // automatically — no manual bookkeeping.
  const presetName = useMemo(() => {
    const match = presets.find(
      (p) => p.agent === agent && p.model === model && p.permissionMode === permissionMode && p.effort === effort,
    );
    return match?.name ?? '';
  }, [presets, agent, model, permissionMode, effort]);

  // Apply a preset's four engine fields directly (bypass onAgent's resets).
  // The dialog's fallback effects reconcile anything invalid for this host.
  const applyPreset = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (!p) return;
    setAgent(p.agent);
    setModel(p.model);
    setPermissionMode(p.permissionMode);
    setEffort(p.effort);
  };

  const saveAsPreset = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setToast('Preset needs a name');
      return;
    }
    setSavingPreset(true);
    const ok = await upsertPreset({ name: trimmed, agent, model, permissionMode, effort });
    setSavingPreset(false);
    if (ok) {
      setToast(`Saved preset “${trimmed}”`);
      setNaming(false);
      setNameInput('');
    }
  };

  // Agent capabilities depend on the host (installed CLI + its config). Reload
  // them when the machine changes so the picker matches what a turn there can
  // use. On unmount, restore the active session's lists (dialog shares store).
  const activeHost = useStore((s) => s.sessions.find((x) => x.id === s.activeId)?.host);
  const activeHostRef = useRef(activeHost);
  activeHostRef.current = activeHost;
  useEffect(() => {
    // Non-admin accounts with no host yet: nothing to probe (local is
    // admin-only); their per-host lists load once a machine is picked.
    if (!isAdmin && !host) return;
    const h = host || undefined;
    void loadCursorModels(h);
    void loadCodexModels(h);
    void loadKimiCapabilities(h);
    void loadKiroModels(h);
    void loadGrokModels(h);
    void loadZcodeModels(h);
  }, [host, isAdmin, loadCursorModels, loadCodexModels, loadKimiCapabilities, loadKiroModels, loadGrokModels, loadZcodeModels]);
  useEffect(() => {
    return () => {
      const h = activeHostRef.current || undefined;
      void loadCursorModels(h);
      void loadCodexModels(h);
      void loadKimiCapabilities(h);
      void loadKiroModels(h);
      void loadGrokModels(h);
      void loadZcodeModels(h);
    };
  }, [loadCursorModels, loadCodexModels, loadKimiCapabilities, loadKiroModels, loadGrokModels, loadZcodeModels]);

  // If the current model disappeared after a host switch (or a remembered
  // model is no longer valid), fall back to a safe default.
  useEffect(() => {
    if (!modelOptions.length) return;
    if (modelOptions.some((m) => m.value === model)) return;
    setModel(agent === 'claude' ? defaultModel : 'auto');
  }, [agent, model, modelOptions, defaultModel]);

  // A remote/older Kimi build may expose fewer modes than the previous host.
  useEffect(() => {
    if (permissionOptions.some((p) => p.value === permissionMode)) return;
    setPermissionMode(permissionOptions[0]?.value ?? 'default');
  }, [permissionMode, permissionOptions]);

  // Drop an effort the current agent/model does not advertise (Codex and ZCode
  // are per-model; Grok has no max/ultra).
  useEffect(() => {
    if (!effortLevels.length) return;
    if (effortLevels.some((e) => e.value === effort)) return;
    if (agent === 'codex' || agent === 'zcode') {
      setEffort((modelOpt?.defaultEffort as EffortLevel) || (agent === 'codex' ? 'medium' : defaultEffortForAgent(agent)));
      return;
    }
    setEffort(defaultEffortForAgent(agent));
  }, [agent, effort, effortLevels, modelOpt]);

  // Local: Claude recent projects + local session cwds. Remote: that host's session cwds.
  const suggestions = useMemo(() => {
    const seen = new Map<string, { path: string; name: string }>();
    if (isRemote) {
      for (const s of sessions) {
        if (s.host === host && !s.ephemeral && !seen.has(s.cwd)) seen.set(s.cwd, { path: s.cwd, name: basename(s.cwd) });
      }
    } else {
      for (const p of projects) {
        if (!seen.has(p.path)) seen.set(p.path, { path: p.path, name: p.name });
      }
      for (const s of sessions) {
        if (!s.host && !s.ephemeral && !seen.has(s.cwd)) seen.set(s.cwd, { path: s.cwd, name: basename(s.cwd) });
      }
    }
    return [...seen.values()];
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
    setOpen(false);
    setCwdMenuOpen(false);
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
    if (e.nativeEvent.isComposing || !cwdMenuOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setCwdMenuOpen(false);
      return;
    }
    if (!open || completions.length === 0) return;
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
    // Guards mirror the Create button's disabled condition so Enter-driven
    // form submission can't bypass them or double-fire while awaiting.
    if (creating || (!isAdmin && !host)) return;
    const dir = cwd.trim() || query.trim();
    if (!autoCwd && !dir) return;
    setCreating(true);
    const base = { model, permissionMode, effort, agent, host: host || undefined };
    const ok = await createSession(
      autoCwd
        ? { ...base, autoCwd: true, title: title.trim() || undefined }
        : { ...base, cwd: dir, title: title.trim() || basename(dir) },
    );
    setCreating(false);
    if (!ok) return;
    saveNewSessionPrefs({ host, agent, model, permissionMode, effort });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4"
      style={{ background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      onClick={onClose}
    >
      <form
        className="new-session-panel w-full max-w-lg rounded-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-titlebar flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-100">New session</h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {(presets.length > 0 || naming) && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Preset</label>
              <div className="flex items-center gap-2">
                {naming ? (
                  <>
                    <input
                      autoFocus
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void saveAsPreset();
                        } else if (e.key === 'Escape') {
                          setNaming(false);
                        }
                      }}
                      placeholder="Preset name"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/35 px-3 text-[13px] text-slate-200 outline-none backdrop-blur-md transition focus:border-accent/60"
                    />
                    <button
                      type="button"
                      onClick={() => void saveAsPreset()}
                      disabled={savingPreset}
                      className="flex h-9 min-w-[64px] items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-soft disabled:opacity-40"
                    >
                      {savingPreset ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setNaming(false)}
                      className="flex h-9 items-center justify-center rounded-lg px-2 text-slate-500 transition hover:text-slate-300"
                      title="Cancel"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      value={presetName}
                      onChange={(e) => applyPreset(e.target.value)}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/35 px-3 text-[13px] text-slate-200 outline-none backdrop-blur-md transition focus:border-accent/60"
                    >
                      <option value="">Custom</option>
                      {presets.map((p) => (
                        <option key={p.name} value={p.name}>
                          {`${p.name} — ${agentLabel(p.agent)} · ${modelLabel(p.model, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels)} · ${effortLabel(p.effort, p.agent)}`}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        setNameInput('');
                        setNaming(true);
                      }}
                      title="Save current config as a preset"
                      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-ink-700 px-3 text-[12px] text-slate-400 transition hover:border-accent/50 hover:text-accent"
                    >
                      <BookmarkPlus className="h-3.5 w-3.5" />
                      Save as preset
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

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
                disabled={autoCwd}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCwd('');
                  setPathState('idle');
                  setCwdMenuOpen(true);
                }}
                onKeyDown={onInputKeyDown}
                onFocus={() => {
                  setCwdMenuOpen(true);
                  if (completions.length) setOpen(true);
                }}
                onClick={() => setCwdMenuOpen(true)}
                onBlur={(e) => {
                  setCwdMenuOpen(false);
                  setOpen(false);
                  void checkPath(e.target.value);
                }}
                placeholder={autoCwd ? 'Auto-created by Vibe' : isRemote ? '/remote/path/to/project' : '/path/to/project or ~/code/app'}
                className={cn(
                  'w-full rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2.5 pr-9 font-mono text-[13px] text-slate-200 outline-none backdrop-blur-md transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20',
                  autoCwd && 'opacity-40',
                )}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {pathState === 'checking' && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
                {pathState === 'ok' && <Check className="h-4 w-4 text-emerald-400" />}
                {pathState === 'bad' && <AlertCircle className="h-4 w-4 text-rose-400" />}
              </span>
              {cwdMenuOpen && open && completions.length > 0 && (
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
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={autoCwd}
                onChange={(e) => {
                  const v = e.target.checked;
                  setAutoCwd(v);
                  if (v) {
                    setQuery('');
                    setCwd('');
                    setPathState('idle');
                    setCwdMenuOpen(false);
                    setOpen(false);
                  }
                }}
                className="mt-0.5 h-3.5 w-3.5 accent-accent"
              />
              <span>
                <span className="text-slate-300">Auto-create a throwaway folder</span>
                <span className="mt-0.5 block text-[11px] text-slate-600">
                  Vibe generates a new folder under <span className="font-mono">~/.vibe/workdirs</span>
                  {isRemote ? ' on the remote host' : ''} — it won't appear in common directories.
                </span>
              </span>
            </label>
          </div>

          {cwdMenuOpen && !open && !autoCwd && filtered.length > 0 && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              className="max-h-44 overflow-y-auto rounded-lg border border-white/5 bg-ink-900/20 backdrop-blur-md"
            >
              {filtered.map((p) => (
                <button
                  key={p.path}
                  type="button"
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
          <button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2 text-sm text-slate-400 transition hover:text-slate-200">
            Cancel
          </button>
          <button
            type="submit"
            disabled={creating || (!isAdmin && !host) || (!autoCwd && !cwd.trim() && !query.trim())}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}
            Create
          </button>
        </div>
      </div>
      </form>
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
