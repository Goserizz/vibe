import type { FusionModelRef, ModelOption } from '../lib/format';
import { defaultFusionSpec, fusionSpecOf, parseFusionSelection } from '../lib/format';

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

const selectClass =
  'w-full rounded-lg border border-ink-700 bg-ink-900/35 px-2.5 py-2 text-[12px] text-slate-200 outline-none backdrop-blur-md transition focus:border-accent/60';

function RefSelect({
  refs,
  value,
  onChange,
}: {
  refs: FusionModelRef[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
      {refs.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

function EffortSelect({
  efforts,
  value,
  onChange,
}: {
  efforts: string[] | undefined;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  if (!efforts || efforts.length < 2) return null;
  return (
    <select
      value={value ?? efforts[0]}
      onChange={(e) => onChange(e.target.value)}
      className={selectClass}
    >
      {efforts.map((e) => (
        <option key={e} value={e}>
          {EFFORT_LABELS[e] ?? e}
        </option>
      ))}
    </select>
  );
}

/**
 * Sub-pickers for Devin's fusion models: which strong ("frontier intelligence")
 * and normal ("cost-efficient execution") model to fuse, each with its effort
 * tier when the catalog offers more than one. The composed `fusion:…` spec is
 * handed up as the session's model value.
 */
export function FusionModelPicker({
  option,
  value,
  onChange,
}: {
  option: ModelOption;
  value: string;
  onChange: (spec: string) => void;
}) {
  const fusion = option.fusion;
  if (!fusion) return null;
  const sel =
    parseFusionSelection(value) ??
    parseFusionSelection(defaultFusionSpec(fusion)) ?? {
      strong: fusion.strong[0]!.value,
      normal: fusion.normal[0]!.value,
    };

  const strongRef =
    fusion.strong.find((r) => r.value === sel.strong) ?? fusion.strong[0]!;
  const normalRef =
    fusion.normal.find((r) => r.value === sel.normal) ?? fusion.normal[0]!;

  const update = (patch: Partial<typeof sel>): void => {
    onChange(fusionSpecOf({ ...sel, ...patch }));
  };

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/25 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        Fusion 组合
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <div className="text-[11px] text-slate-500">强力模型（主力推理）</div>
          <RefSelect refs={fusion.strong} value={strongRef.value} onChange={(v) => update({ strong: v })} />
          <EffortSelect
            efforts={strongRef.efforts}
            value={sel.strongEffort ?? strongRef.efforts?.[0]}
            onChange={(v) => update({ strongEffort: v })}
          />
        </div>
        <div className="space-y-2">
          <div className="text-[11px] text-slate-500">普通模型（高效执行）</div>
          <RefSelect refs={fusion.normal} value={normalRef.value} onChange={(v) => update({ normal: v })} />
          <EffortSelect
            efforts={normalRef.efforts}
            value={sel.normalEffort ?? normalRef.efforts?.[0]}
            onChange={(v) => update({ normalEffort: v })}
          />
        </div>
      </div>
    </div>
  );
}
