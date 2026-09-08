import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, Check, X, Sparkles, Package, Eye, Globe, RefreshCw } from '../lib/icons';
import type { AgentKind, GlobalSkillSummary, SkillDetail, SkillEntry, SkillScope } from '@shared/protocol';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { Markdown } from './Markdown';
import { AGENTS } from '../lib/format';
import { cn } from '../lib/format';

const inputCls =
  'h-9 min-w-0 w-full rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';
const selectCls =
  'h-9 min-w-0 w-full appearance-none rounded-lg border border-ink-700 bg-ink-900/35 px-3 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';
const bodyCls =
  'min-w-0 w-full min-h-[200px] rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[12.5px] leading-relaxed font-mono text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';

/** User-level skills directory per agent (for display in the edit hint). */
const SKILL_DIR: Record<AgentKind, string> = {
  claude: '~/.claude/skills',
  cursor: '~/.cursor/skills',
  codex: '~/.codex/skills',
  kimi: '~/.kimi-code/skills',
  kiro: '~/.kiro/skills',
  grok: '~/.grok/skills',
  // ZCode reads user skills from the shared agents dir (`zcode skills list`).
  zcode: '~/.agents/skills',
  codebuddy: '~/.codebuddy/skills',
  opencode: '~/.config/opencode/skills',
  devin: '~/.config/devin/skills',
};

/** Add/edit form for a personal skill. `def` undefined = create.
 *  Writes the same content to every selected target agent's skills dir, so one
 *  skill can be deployed to several agents at once (all share the SKILL.md format). */
export function SkillForm({
  def,
  agent,
  host,
  onDone,
  globalMode = false,
  globalId,
  initialAgents,
}: {
  def?: SkillDetail;
  agent: AgentKind;
  host?: string;
  onDone: () => void;
  globalMode?: boolean;
  globalId?: string;
  initialAgents?: AgentKind[];
}) {
  const saveSkillMulti = useStore((s) => s.saveSkillMulti);
  const setToast = useStore((s) => s.setToast);

  const editing = !!def;
  const [name, setName] = useState(def?.name ?? '');
  const [description, setDescription] = useState(def?.description ?? '');
  const [whenToUse, setWhenToUse] = useState(def?.whenToUse ?? '');
  const [body, setBody] = useState(def?.body ?? '');
  // Create defaults to all agents; edit defaults to just the one being edited
  // (check others to sync the change to them too).
  const [targets, setTargets] = useState<Set<AgentKind>>(
    () => new Set(initialAgents ?? (def ? [agent] : AGENTS.map((a) => a.value))),
  );
  const [saving, setSaving] = useState(false);
  const [replaceConflicts, setReplaceConflicts] = useState(false);

  const toggle = (a: AgentKind) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setToast('Skill needs a name');
      return;
    }
    if (!description.trim()) {
      setToast('Skill needs a description');
      return;
    }
    if (targets.size === 0) {
      setToast('Select at least one agent');
      return;
    }
    setSaving(true);
    if (globalMode) {
      try {
        await api.saveGlobalSkill({ name: trimmedName, description: description.trim(), whenToUse: whenToUse.trim() || undefined,
          body, agents: [...targets], replaceConflicts }, globalId);
        setToast('Global skill saved; deployment continues in the background.');
        onDone();
      } catch (error) {
        setToast(error instanceof Error ? error.message : 'Failed to save global skill');
      } finally { setSaving(false); }
      return;
    }
    const ok = await saveSkillMulti({
      agents: [...targets],
      name: trimmedName,
      description: description.trim(),
      whenToUse: whenToUse.trim() || undefined,
      body,
      host,
    });
    setSaving(false);
    if (ok) onDone();
  };

  return (
    <div className="space-y-2 rounded-lg border border-white/5 bg-ink-900/30 p-3">
      {globalMode && <p className="text-[12px] text-accent-soft">Deploy to all hosts in your account, including new hosts added later. Offline hosts retry automatically.</p>}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. release-notes)"
        disabled={editing}
        className={cn(inputCls, editing && 'cursor-not-allowed opacity-60')}
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (what this skill does)"
        className={inputCls}
      />
      <input
        value={whenToUse}
        onChange={(e) => setWhenToUse(e.target.value)}
        placeholder="whenToUse (optional — when the model should invoke it)"
        className={inputCls}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={'# Instructions\n\nMarkdown body of the skill — the model reads this when it invokes the skill.'}
        spellCheck={false}
        className={bodyCls}
      />
      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {editing ? 'Sync to agents' : 'Write to agents'}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {AGENTS.map((a) => {
            const on = targets.has(a.value);
            const disabled = !globalMode && editing && a.value === agent;
            return (
              <button
                type="button"
                key={a.value}
                aria-pressed={on}
                disabled={disabled}
                title={disabled ? 'Editing this skill' : undefined}
                onClick={() => toggle(a.value)}
                className={cn(
                  'rounded-md border px-2 py-1 text-[11px] font-medium transition',
                  on ? 'border-accent/50 bg-accent/15 text-accent-soft' : 'border-ink-700 text-slate-400 hover:border-ink-600 hover:text-slate-200',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                {a.label}
              </button>
            );
          })}
        </div>
        {editing && !globalMode && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
            Checking another agent writes this content there too — overwriting a same-named skill if one exists. The
            directory name (<span className="font-mono">{def?.name}/SKILL.md</span>) stays fixed.
          </p>
        )}
      </div>
      {globalMode && (
        <label className="flex items-start gap-2 text-[12px] text-slate-400">
          <input type="checkbox" checked={replaceConflicts} onChange={(e) => setReplaceConflicts(e.target.checked)} className="mt-0.5" />
          Replace conflicting same-name skills for this version (back up first). Leave unchecked to protect existing or manually edited files.
        </label>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onDone}
          className="flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] text-slate-400 transition hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="flex h-8 min-w-[72px] items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-soft disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
    </div>
  );
}

/** Read-only view for a system skill (frontmatter fields + rendered body). */
function SkillView({ detail, onClose }: { detail: SkillDetail; onClose: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-white/5 bg-ink-900/30 p-3">
      <div className="flex items-center justify-between">
        <span className="truncate text-[13px] text-slate-200">{detail.frontmatterName || detail.name}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-1 text-[12px]">
        <p className="text-slate-500">
          <span className="text-slate-600">description:</span> <span className="text-slate-300">{detail.description}</span>
        </p>
        {detail.whenToUse && (
          <p className="text-slate-500">
            <span className="text-slate-600">whenToUse:</span> <span className="text-slate-300">{detail.whenToUse}</span>
          </p>
        )}
        <p className="truncate font-mono text-[10.5px] text-slate-600">{detail.source}</p>
      </div>
      <div className="max-h-[280px] overflow-y-auto rounded-md border border-white/5 bg-ink-900/20 p-2.5 text-[12.5px] text-slate-300">
        <Markdown>{detail.body}</Markdown>
      </div>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: SkillScope }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        scope === 'personal' ? 'bg-accent/15 text-accent-soft' : 'bg-ink-700/60 text-slate-500',
      )}
    >
      {scope === 'personal' ? 'personal' : 'system'}
    </span>
  );
}

/** Full skills panel: agent + host pickers, list of personal (editable) and system (read-only) skills. */
function HostSkillRegistry({ onPromote }: { onPromote: (skill: SkillDetail) => void }) {
  const skills = useStore((s) => s.skills);
  const skillsAgent = useStore((s) => s.skillsAgent);
  const skillsHost = useStore((s) => s.skillsHost);
  const loadSkills = useStore((s) => s.loadSkills);
  const readSkillDetail = useStore((s) => s.readSkillDetail);
  const deleteSkill = useStore((s) => s.deleteSkillAction);
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);

  const [agent, setAgent] = useState<AgentKind>('claude');
  const [host, setHost] = useState<string>(''); // '' = this machine
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDef, setEditDef] = useState<SkillDetail | null>(null);
  const [viewing, setViewing] = useState<SkillDetail | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const hostArg = host || undefined;

  useEffect(() => {
    void loadSkills(agent, hostArg);
    setAdding(false);
    setEditing(null);
    setEditDef(null);
    setViewing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, host]);

  const open = async (entry: SkillEntry) => {
    if (entry.scope === 'system') {
      setBusyName(entry.name);
      const detail = await readSkillDetail({ agent, host: hostArg, name: entry.name, scope: 'system', source: entry.source });
      setBusyName(null);
      if (detail) setViewing(detail);
      return;
    }
    setBusyName(entry.name);
    const detail = await readSkillDetail({ agent, host: hostArg, name: entry.name, scope: 'personal' });
    setBusyName(null);
    if (detail) {
      setEditDef(detail);
      setEditing(entry.name);
      setAdding(false);
      setViewing(null);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete skill "${name}"? This removes ${SKILL_DIR[agent]}/${name}/.`)) return;
    await deleteSkill(agent, hostArg, name);
    if (editing === name) {
      setEditing(null);
      setEditDef(null);
    }
  };

  const synced = skillsAgent === agent && (skillsHost ?? '') === host;

  const promote = async (entry: SkillEntry) => {
    setBusyName(entry.name);
    const detail = await readSkillDetail({ agent, host: hostArg, name: entry.name, scope: 'personal' });
    setBusyName(null);
    if (detail) onPromote(detail);
  };

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-slate-500">This host only. Use the globe button to turn an existing personal skill into a global skill.</p>
      <div className="grid grid-cols-2 gap-2">
        <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)} className={selectCls}>
          {AGENTS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <select value={host} onChange={(e) => setHost(e.target.value)} className={selectCls}>
          <option value="">{localName} (this machine)</option>
          {hosts.map((h) => (
            <option key={h.name} value={h.name}>
              {h.name}
            </option>
          ))}
        </select>
      </div>

      {!synced && <p className="text-[12px] text-slate-600">Loading skills…</p>}

      {synced && skills.length === 0 && !adding && (
        <p className="text-[12px] leading-relaxed text-slate-600">
          No skills found for {agent}. Add one below, or (for Claude/Cursor/Codex) install plugin/built-in skills to see
          them listed read-only.
        </p>
      )}

      {synced &&
        skills.map((entry) => {
          if (editing === entry.name && entry.scope === 'personal' && editDef) {
            return <SkillForm key={`${entry.scope}/${entry.name}`} def={editDef} agent={agent} host={hostArg} onDone={() => { setEditing(null); setEditDef(null); }} />;
          }
          if (viewing && entry.scope === 'system' && viewing.name === entry.name && viewing.source === entry.source) {
            return <SkillView key={`${entry.scope}/${entry.name}`} detail={viewing} onClose={() => setViewing(null)} />;
          }
          const isSystem = entry.scope === 'system';
          return (
            <div
              key={`${entry.scope}/${entry.name}`}
              className="flex items-center gap-2 rounded-lg border border-white/5 bg-ink-900/20 px-3 py-2"
            >
              {isSystem ? <Package className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent/70" />}
              <button type="button" onClick={() => void open(entry)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] text-slate-200">{entry.name}</span>
              </button>
              <ScopeBadge scope={entry.scope} />
              {busyName === entry.name ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />
              ) : isSystem ? (
                <button
                  type="button"
                  title="View"
                  onClick={() => void open(entry)}
                  className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              ) : (
                <>
                  <button type="button" title="Deploy to all hosts" onClick={() => void promote(entry)}
                    className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-accent">
                    <Globe className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Edit"
                    onClick={() => void open(entry)}
                    className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => void remove(entry.name)}
                    className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          );
        })}

      {adding ? (
        <SkillForm agent={agent} host={hostArg} onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setEditDef(null);
            setViewing(null);
            setAdding(true);
          }}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-700 text-[12px] text-slate-400 transition hover:border-accent/50 hover:text-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          Add skill on this host only
        </button>
      )}
    </div>
  );
}

function GlobalSkillRegistry({ seed, clearSeed }: { seed: SkillDetail | null; clearSeed: () => void }) {
  const [skills, setSkills] = useState<GlobalSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ id?: string; def?: SkillDetail; agents: AgentKind[] } | null>(null);
  const setToast = useStore((s) => s.setToast);
  const generation = useRef(0);
  const requestInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    const gen = ++generation.current;
    try {
      const next = await api.listGlobalSkills();
      if (generation.current === gen) { setSkills(next); setError(''); }
    } catch (err) {
      if (generation.current === gen) setError(err instanceof Error ? err.message : 'Failed to load global skills');
    } finally {
      requestInFlight.current = false;
      if (generation.current === gen) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 4000);
    return () => { generation.current++; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    if (seed) setEditor({ def: seed, agents: AGENTS.map((a) => a.value) });
  }, [seed]);
  const done = () => { setEditor(null); clearSeed(); void refresh(); };
  const edit = async (skill: GlobalSkillSummary) => {
    try {
      const detail = await api.readGlobalSkill(skill.id);
      setEditor({ id: detail.id, agents: detail.agents, def: { name: detail.name, agent: detail.agents[0]!, scope: 'personal',
        description: detail.description, whenToUse: detail.whenToUse, body: detail.body, readOnly: false } });
    } catch (err) { setToast(err instanceof Error ? err.message : 'Failed to read global skill'); }
  };
  const retry = async (id: string) => {
    try { await api.retryGlobalSkill(id); setToast('Deployment retry queued.'); void refresh(); }
    catch (err) { setToast(err instanceof Error ? err.message : 'Retry failed'); }
  };
  const stop = async (skill: GlobalSkillSummary) => {
    if (!window.confirm(`Stop global synchronization for "${skill.name}"? Already deployed files are retained. No future hosts will receive this skill.`)) return;
    try { await api.stopGlobalSkill(skill.id); done(); }
    catch (err) { setToast(err instanceof Error ? err.message : 'Failed to stop synchronization'); }
  };
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-slate-500">One definition, all your hosts. Includes this machine for administrators. Choose target agents when saving; newly added hosts and temporarily offline hosts are handled automatically.</p>
      {error && <p role="alert" className="text-[12px] text-rose-400">{error}</p>}
      {loading && <p className="text-[12px] text-slate-500">Loading global skills…</p>}
      {!loading && !error && !skills.length && !editor && <p className="text-[12px] text-slate-500">No global skills yet. Create one or promote a personal skill from “This host only”.</p>}
      {skills.map((skill) => {
        const count = (status: string) => skill.deployments.filter((d) => d.status === status).length;
        return (
          <div key={skill.id} className="space-y-2 rounded-lg border border-white/5 bg-ink-900/20 p-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">{skill.name}</span>
              <span className="text-[10px] text-slate-500">v{skill.revision}</span>
              <button type="button" title="Retry deployment" onClick={() => void retry(skill.id)} className="rounded p-1.5 text-slate-400 hover:bg-ink-700"><RefreshCw className="h-3.5 w-3.5" /></button>
              <button type="button" title="Edit global skill" onClick={() => void edit(skill)} className="rounded p-1.5 text-slate-400 hover:bg-ink-700"><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" title="Stop global synchronization (keep deployed copies)" onClick={() => void stop(skill)} className="rounded p-1.5 text-slate-500 hover:bg-ink-700 hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <p className="text-[12px] text-slate-400">{count('synced')}/{skill.deployments.length} deployed · {count('pending')} pending · {count('failed')} failed/offline · {count('conflict')} conflicts</p>
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer">Deployment details</summary>
              <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                {skill.deployments.map((d) => <div key={`${d.local ? 'local' : d.host}/${d.agent}`} className="flex gap-2" title={d.message}>
                  <span className="min-w-0 flex-1 truncate">{d.local ? 'This machine' : d.host} · {d.agent}</span>
                  <span className={cn(d.status === 'synced' ? 'text-emerald-500' : d.status === 'conflict' ? 'text-amber-500' : d.status === 'failed' ? 'text-rose-400' : '')}>{d.status}</span>
                </div>)}
              </div>
            </details>
          </div>
        );
      })}
      {editor ? <SkillForm key={editor.id ?? editor.def?.name ?? 'new'} def={editor.def} agent={editor.agents[0] ?? 'claude'}
        globalMode globalId={editor.id} initialAgents={editor.agents} onDone={done} /> : (
        <button type="button" onClick={() => setEditor({ agents: AGENTS.map((a) => a.value) })}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-accent/40 text-[12px] text-accent-soft hover:bg-accent/10">
          <Plus className="h-3.5 w-3.5" /> Add global skill
        </button>
      )}
    </div>
  );
}

/** New skills default to all-host deployment; host-local editing stays explicit. */
export function SkillRegistry() {
  const [scope, setScope] = useState<'global' | 'host'>('global');
  const [seed, setSeed] = useState<SkillDetail | null>(null);
  return <div className="space-y-3">
    <div className="flex gap-2">
      {(['global', 'host'] as const).map((value) => <button type="button" key={value} aria-pressed={scope === value}
        onClick={() => { setScope(value); setSeed(null); }} className={cn('rounded-md border px-3 py-1.5 text-[12px]', scope === value ? 'border-accent/40 bg-accent/10 text-accent-soft' : 'border-ink-700 text-slate-500')}>
        {value === 'global' ? 'Global · all hosts' : 'This host only'}
      </button>)}
    </div>
    {scope === 'global' ? <GlobalSkillRegistry seed={seed} clearSeed={() => setSeed(null)} /> : <HostSkillRegistry onPromote={(skill) => { setSeed(skill); setScope('global'); }} />}
  </div>;
}
