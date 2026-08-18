import { useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, Check, X, Bookmark } from '../lib/icons';
import type { AgentKind, EffortLevel, PermissionMode, SessionPreset } from '@shared/protocol';
import { useStore } from '../store/store';
import {
  AGENTS,
  defaultEffortForAgent,
  effortLabel,
  effortLevelsForAgent,
  modelsForAgent,
  modelLabel,
  permissionModeLabel,
  permissionModesForAgent,
} from '../lib/format';

const selectCls =
  'h-9 min-w-0 w-full appearance-none rounded-lg border border-ink-700 bg-ink-900/35 px-3 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';
const inputCls =
  'h-9 min-w-0 w-full rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';

/** Add/edit form for a single preset. */
export function PresetForm({ def, onDone }: { def?: SessionPreset; onDone: () => void }) {
  const defaultModel = useStore((s) => s.defaultModel);
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kimiPermissionModes = useStore((s) => s.kimiPermissionModes);
  const kiroModels = useStore((s) => s.kiroModels);
  const kiroPermissionModes = useStore((s) => s.kiroPermissionModes);
  const grokModels = useStore((s) => s.grokModels);
  const upsertPreset = useStore((s) => s.upsertPreset);
  const setToast = useStore((s) => s.setToast);

  const [name, setName] = useState(def?.name ?? '');
  const [agent, setAgent] = useState<AgentKind>(def?.agent ?? 'claude');
  const [model, setModel] = useState(def?.model ?? defaultModel);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(def?.permissionMode ?? 'bypassPermissions');
  const [effort, setEffort] = useState<EffortLevel>(def?.effort ?? 'max');
  const [saving, setSaving] = useState(false);

  const codexModelOpt = codexModels.find((m) => m.value === model) ?? null;
  const modelOptions = modelsForAgent(agent, cursorModels, codexModels, kimiModels, kiroModels, grokModels);
  const permissionOptions = permissionModesForAgent(agent, kimiPermissionModes, kiroPermissionModes);
  const effortLevels = effortLevelsForAgent(agent, codexModelOpt);

  // Switching engine resets model + permission + effort to that engine's
  // sensible defaults (mirrors the New Session dialog's onAgent handler).
  const onAgent = (a: AgentKind) => {
    setAgent(a);
    const custom = a !== 'claude';
    setModel(custom ? 'auto' : defaultModel);
    setPermissionMode(custom ? 'default' : 'bypassPermissions');
    setEffort(defaultEffortForAgent(a));
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setToast('Preset needs a name');
      return;
    }
    setSaving(true);
    const ok = await upsertPreset({ name: trimmedName, agent, model, permissionMode, effort });
    setSaving(false);
    if (ok) onDone();
  };

  return (
    <div className="space-y-2 rounded-lg border border-white/5 bg-ink-900/30 p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Claude YOLO)" className={inputCls} />

      <select value={agent} onChange={(e) => onAgent(e.target.value as AgentKind)} className={selectCls}>
        {AGENTS.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-2 gap-2">
        <select value={model} onChange={(e) => setModel(e.target.value)} className={selectCls}>
          {modelOptions.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)} className={selectCls}>
          {permissionOptions.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {effortLevels.length > 0 && (
        <select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)} className={selectCls}>
          {effortLevels.map((ef) => (
            <option key={ef.value} value={ef.value}>
              {ef.label}
            </option>
          ))}
        </select>
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

/** Full registry editor: list + add/edit/delete. Used in Settings. */
export function PresetRegistry() {
  const presets = useStore((s) => s.presets);
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kimiPermissionModes = useStore((s) => s.kimiPermissionModes);
  const kiroModels = useStore((s) => s.kiroModels);
  const kiroPermissionModes = useStore((s) => s.kiroPermissionModes);
  const grokModels = useStore((s) => s.grokModels);
  const zcodeModels = useStore((s) => s.zcodeModels);
  const remove = useStore((s) => s.deletePreset);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {presets.length === 0 && !adding && (
        <p className="text-[12px] leading-relaxed text-slate-600">
          No presets yet. Save an agent + model + permission + effort bundle, then pick it from the New Session dialog.
        </p>
      )}

      {presets.map((p) =>
        editing === p.name ? (
          <PresetForm key={p.name} def={p} onDone={() => setEditing(null)} />
        ) : (
          <div key={p.name} className="flex items-center gap-2 rounded-lg border border-white/5 bg-ink-900/20 px-3 py-2">
            <Bookmark className="h-3.5 w-3.5 shrink-0 text-accent/70" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-slate-200">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-slate-500">
                {`${p.agent} · ${modelLabel(p.model, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels)} · ${permissionModeLabel(
                  p.permissionMode,
                  p.agent,
                  kimiPermissionModes,
                  kiroPermissionModes,
                )} · ${effortLabel(p.effort, p.agent)}`}
              </div>
            </div>
            <button
              type="button"
              title="Edit"
              onClick={() => setEditing(p.name)}
              className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Delete"
              onClick={() => void remove(p.name)}
              className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-rose-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
      )}

      {adding ? (
        <PresetForm onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-700 text-[12px] text-slate-400 transition hover:border-accent/50 hover:text-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          Add preset
        </button>
      )}
    </div>
  );
}
