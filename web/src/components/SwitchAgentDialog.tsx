import { useEffect, useMemo, useState } from 'react';
import { X, ArrowLeftRight, Loader2, AlertCircle } from '../lib/icons';
import { useStore } from '../store/store';
import { api } from '../lib/api';
import { AGENTS, agentLabel, cn, modelsForAgent } from '../lib/format';
import type { AgentKind, SwitchFidelity } from '@shared/protocol';

/**
 * 「切换 Agent / 模型」对话框。
 *
 * 把已有会话切换成另一个 agent：历史对话无损保留，切换后新 agent 用原生 resume
 * 机制接手（能用原生的就用原生，不能的降级为首轮上下文注入，这里会明确提示）。
 */

interface Props {
  sessionId: string;
  /** 会话当前的 agent —— 作为「当前」项禁用掉。 */
  currentAgent: AgentKind;
  currentModel: string;
  onClose: () => void;
}

export function SwitchAgentDialog({ sessionId, currentAgent, currentModel, onClose }: Props) {
  const switchSessionAgent = useStore((s) => s.switchSessionAgent);
  const cursorModels = useStore((s) => s.cursorModels);
  const codexModels = useStore((s) => s.codexModels);
  const kimiModels = useStore((s) => s.kimiModels);
  const kiroModels = useStore((s) => s.kiroModels);
  const grokModels = useStore((s) => s.grokModels);
  const zcodeModels = useStore((s) => s.zcodeModels);
  const codebuddyModels = useStore((s) => s.codebuddyModels);
  const devinModels = useStore((s) => s.devinModels);
  const opencodeModels = useStore((s) => s.opencodeModels);

  const [target, setTarget] = useState<AgentKind | null>(null);
  const [model, setModel] = useState<string>('');
  const [carryThinking, setCarryThinking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 每个目标 agent 的保真等级，由服务端给出（目标 agent 的存储决定）。 */
  const [fidelity, setFidelity] = useState<Partial<Record<AgentKind, SwitchFidelity>>>({});

  useEffect(() => {
    let alive = true;
    void api
      .switchFidelity()
      .then((r) => {
        if (alive) setFidelity(r.byTarget);
      })
      .catch(() => {
        // 拿不到就按「未知」处理 —— 不阻塞切换，只是少了提示。
      });
    return () => {
      alive = false;
    };
  }, []);

  const models = useMemo(
    () =>
      target
        ? modelsForAgent(target, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels, codebuddyModels, devinModels, opencodeModels)
        : [],
    [target, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels, codebuddyModels, devinModels, opencodeModels],
  );

  // 选中目标后，默认模型沿用当前会话的（若该 agent 没有这个模型则回落到第一项）。
  const pick = (agent: AgentKind): void => {
    setTarget(agent);
    setError(null);
    const list = modelsForAgent(agent, cursorModels, codexModels, kimiModels, kiroModels, grokModels, zcodeModels, codebuddyModels, devinModels, opencodeModels);
    const keep = list.some((m) => m.value === currentModel) ? currentModel : '';
    setModel(keep);
  };

  const targetFidelity = target ? fidelity[target] : undefined;

  const submit = async (): Promise<void> => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    const result = await switchSessionAgent(sessionId, {
      agent: target,
      ...(model ? { model } : {}),
      carryThinking,
    });
    setBusy(false);
    if (result) onClose();
    else setError('切换失败，请查看服务端日志。');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <div className="flex items-center gap-2 text-slate-200">
            <ArrowLeftRight className="h-4 w-4" />
            <span className="text-sm font-medium">切换 Agent / 模型</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-ink-700 hover:text-slate-200" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <p className="text-[12px] leading-relaxed text-slate-400">
            历史对话无损迁移，新 agent 原生接手。
          </p>

          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">目标 Agent</div>
            <div className="grid grid-cols-2 gap-1.5">
              {AGENTS.map((a) => {
                const isCurrent = a.value === currentAgent;
                const level = fidelity[a.value];
                return (
                  <button
                    key={a.value}
                    disabled={isCurrent || busy}
                    onClick={() => pick(a.value)}
                    title={isCurrent ? '当前就是这个 agent' : undefined}
                    className={cn(
                      'flex items-center justify-between rounded-lg border px-2.5 py-2 text-left text-[12px] transition',
                      isCurrent
                        ? 'cursor-not-allowed border-ink-700 bg-ink-800 text-slate-600'
                        : target === a.value
                          ? 'border-accent/60 bg-accent/10 text-slate-100'
                          : 'border-ink-700 text-slate-300 hover:border-accent/40 hover:bg-ink-800',
                    )}
                  >
                    <span>{a.label}</span>
                    {isCurrent ? (
                      <span className="text-[10px] text-slate-500">当前</span>
                    ) : level === 'partial' ? (
                      <span className="text-[10px] text-amber-400/80" title="历史将作为首轮上下文注入">
                        部分
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {target && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">模型</div>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-2 text-[12px] text-slate-200 outline-none focus:border-accent/50"
              >
                <option value="">（由 {agentLabel(target)} 自行选择）</option>
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {target && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
              <input
                type="checkbox"
                checked={carryThinking}
                disabled={busy}
                onChange={(e) => setCarryThinking(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-accent"
              />
              <span className="text-[11px] leading-relaxed text-slate-300">
                携带前会话思考<span className="text-slate-500">（仅作标注的参考文本）</span>
              </span>
            </label>
          )}

          {target && targetFidelity === 'partial' && (
            <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <p className="text-[11px] leading-relaxed text-amber-200/90">
                {agentLabel(target)} 原生会话写入当前不可用：历史会作为
                <strong>首轮上下文</strong>注入 —— 内容完整，但是转述记录而非原话。
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-700 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[12px] text-slate-400 hover:bg-ink-700 hover:text-slate-200"
          >
            取消
          </button>
          <button
            disabled={!target || busy}
            onClick={() => void submit()}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition',
              !target || busy
                ? 'cursor-not-allowed bg-ink-700 text-slate-500'
                : 'bg-accent text-ink-900 hover:brightness-110',
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? '切换中…' : '确认切换'}
          </button>
        </div>
      </div>
    </div>
  );
}
