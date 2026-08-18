import { useEffect, useState } from 'react';
import { X, RotateCcw, Brain } from '../../lib/icons';
import { useVibotStore } from '../../store/vibot';

/** Modal for Vibot's own LLM API config (OpenAI-compatible) + system prompt. */
export function VibotSettings({ onClose }: { onClose: () => void }) {
  const config = useVibotStore((s) => s.config);
  const saveConfig = useVibotStore((s) => s.saveConfig);
  const loadConfig = useVibotStore((s) => s.loadConfig);
  const setToast = useVibotStore((s) => s.setToast);

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState('0.3');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  // Seed the form whenever the persisted config arrives/changes.
  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.baseUrl);
    setApiKey('');
    setModel(config.model);
    setTemperature(typeof config.temperature === 'number' ? String(config.temperature) : '0.3');
    setSystemPrompt(config.systemPrompt);
  }, [config]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    const ok = await saveConfig(patch);
    setBusy(false);
    if (ok) setToast('Vibot settings saved');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tempNum = Number(temperature);
    await save({
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      temperature: Number.isFinite(tempNum) ? Math.max(0, Math.min(2, tempNum)) : undefined,
      systemPrompt,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    onClose();
  };

  const resetPrompt = async () => {
    setBusy(true);
    // Empty systemPrompt ⇒ server restores the built-in default.
    await saveConfig({ systemPrompt: '' });
    await loadConfig();
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="new-session-panel flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden"
      >
        <div className="dialog-titlebar flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-slate-100">Vibot settings</h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <p className="text-[12px] leading-relaxed text-slate-600">
            Vibot uses its own OpenAI-compatible Chat Completions API — separate from the coding agents. Point it at GLM,
            DeepSeek, Kimi, OpenAI, OpenRouter, or a local server.
          </p>

          <Field label="Base URL" hint="OpenAI-compatible endpoint, without /chat/completions">
            <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://open.bigmodel.cn/api/paas/v4" />
          </Field>

          <Field label="API key" hint={config?.hasApiKey ? 'A key is saved. Leave blank to keep it.' : 'Not set yet'}>
            <input className={inputCls} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config?.hasApiKey ? '••••••••' : 'sk-…'} autoComplete="off" />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Model">
                <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="glm-4.6" />
              </Field>
            </div>
            <Field label="Temperature">
              <input className={inputCls} value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="0.3" />
            </Field>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-400">System prompt</label>
              <button
                type="button"
                onClick={resetPrompt}
                disabled={busy}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-ink-800 hover:text-slate-300"
              >
                <RotateCcw className="h-3 w-3" /> Reset to default
              </button>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={12}
              className="scroll-region w-full resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-200 outline-none transition focus:border-accent/40"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/5 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-ink-700 px-3 py-2 text-[13px] text-slate-300 transition hover:bg-ink-800">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !baseUrl.trim() || !model.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-slate-200 outline-none transition focus:border-accent/40';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-slate-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}
