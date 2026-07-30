import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, Check, X, Sparkles, Package, Eye } from 'lucide-react';
import type { AgentKind, SkillDetail, SkillEntry, SkillScope } from '@shared/protocol';
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
};

/** Add/edit form for a personal skill. `def` undefined = create.
 *  Writes the same content to every selected target agent's skills dir, so one
 *  skill can be deployed to several agents at once (all share the SKILL.md format). */
export function SkillForm({
  def,
  agent,
  host,
  onDone,
}: {
  def?: SkillDetail;
  agent: AgentKind;
  host?: string;
  onDone: () => void;
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
    () => new Set(def ? [agent] : AGENTS.map((a) => a.value)),
  );
  const [saving, setSaving] = useState(false);

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
            const disabled = editing && a.value === agent;
            return (
              <button
                type="button"
                key={a.value}
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
        {editing && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
            Checking another agent writes this content there too — overwriting a same-named skill if one exists. The
            directory name (<span className="font-mono">{def?.name}/SKILL.md</span>) stays fixed.
          </p>
        )}
      </div>
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
export function SkillRegistry() {
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

  return (
    <div className="space-y-2">
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
          Add skill
        </button>
      )}
    </div>
  );
}
