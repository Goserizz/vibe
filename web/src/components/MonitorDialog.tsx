import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Monitor as MonitorRecord,
  MonitorActionMode,
  MonitorEvent,
  MonitorInput,
  MonitorProbeResult,
} from '@shared/protocol';
import {
  CheckCircle2,
  CircleAlert,
  CirclePause,
  Clock,
  Loader2,
  Monitor as MonitorIcon,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from '../lib/icons';
import { api } from '../lib/api';
import { cn } from '../lib/format';
import { useStore } from '../store/store';

type ProbeKind = 'command' | 'http';

interface FormState {
  name: string;
  sessionId: string;
  intervalMinutes: string;
  probeKind: ProbeKind;
  command: string;
  url: string;
  method: 'GET' | 'HEAD';
  bodyIncludes: string;
  actionMode: MonitorActionMode;
  instructions: string;
  maxWakeAttempts: string;
  remindMinutes: string;
  notifyOnRecovery: boolean;
}

function emptyForm(sessionId = ''): FormState {
  return {
    name: '',
    sessionId,
    intervalMinutes: '2',
    probeKind: 'command',
    command: '',
    url: '',
    method: 'GET',
    bodyIncludes: '',
    actionMode: 'wake-agent',
    instructions: '诊断异常并在当前会话权限范围内处理；处理后实际验证探针恢复健康。',
    maxWakeAttempts: '3',
    remindMinutes: '5',
    notifyOnRecovery: true,
  };
}

function formFromMonitor(monitor: MonitorRecord): FormState {
  return {
    name: monitor.name,
    sessionId: monitor.sessionId ?? '',
    intervalMinutes: String(monitor.intervalMs / 60_000),
    probeKind: monitor.probe.kind,
    command: monitor.probe.kind === 'command' ? monitor.probe.command : '',
    url: monitor.probe.kind === 'http' ? monitor.probe.url : '',
    method: monitor.probe.kind === 'http' ? monitor.probe.method : 'GET',
    bodyIncludes: monitor.probe.kind === 'http' ? monitor.probe.bodyIncludes ?? '' : '',
    actionMode: monitor.actionMode,
    instructions: monitor.instructions,
    maxWakeAttempts: String(monitor.maxWakeAttempts),
    remindMinutes: String(monitor.remindEveryMs / 60_000),
    notifyOnRecovery: monitor.notifyOnRecovery,
  };
}

function time(value?: number): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function intervalLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Number((ms / 60_000).toFixed(1))}m`;
  return `${Number((ms / 3_600_000).toFixed(1))}h`;
}

const fieldClass =
  'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-accent/50';
const labelClass = 'mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-500';

export function MonitorDialog({
  onClose,
  initialSessionId,
  initialMonitorId,
}: {
  onClose: () => void;
  initialSessionId?: string;
  initialMonitorId?: string;
}) {
  const sessions = useStore((state) => state.sessions);
  const activeId = useStore((state) => state.activeId);
  const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialMonitorId ?? null);
  const [formMonitorId, setFormMonitorId] = useState<string | null>(null);
  const [creating, setCreating] = useState(Boolean(initialSessionId && !initialMonitorId));
  const [form, setForm] = useState<FormState>(() => emptyForm(initialSessionId ?? activeId ?? ''));
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<MonitorProbeResult | null>(null);

  const selected = useMemo(
    () => monitors.find((monitor) => monitor.id === selectedId),
    [monitors, selectedId],
  );

  const load = useCallback(async () => {
    try {
      const next = await api.listMonitors();
      setMonitors(next);
      setSelectedId((current) => {
        if (creating) return current;
        if (current && next.some((monitor) => monitor.id === current)) return current;
        return next[0]?.id ?? null;
      });
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load monitors');
    } finally {
      setLoading(false);
    }
  }, [creating]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    const changed = () => void load();
    window.addEventListener('vibe-monitor-changed', changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener('vibe-monitor-changed', changed);
    };
  }, [load]);

  useEffect(() => {
    if (!selectedId || creating) {
      setEvents([]);
      return;
    }
    void api.listMonitorEvents(selectedId, 100).then(setEvents).catch(() => setEvents([]));
  }, [selectedId, creating, monitors]);

  useEffect(() => {
    if (!selected || creating) return;
    if (formMonitorId === selected.id) return;
    setForm(formFromMonitor(selected));
    setFormMonitorId(selected.id);
    setTestResult(null);
  }, [selected, creating, formMonitorId]);

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setFormMonitorId(null);
    setForm(emptyForm(initialSessionId ?? activeId ?? sessions[0]?.id ?? ''));
    setTestResult(null);
    setError('');
  };

  const selectMonitor = (monitor: MonitorRecord) => {
    setCreating(false);
    setSelectedId(monitor.id);
    setForm(formFromMonitor(monitor));
    setFormMonitorId(monitor.id);
    setTestResult(null);
    setError('');
  };

  const inputFromForm = (): MonitorInput | null => {
    const intervalMinutes = Number(form.intervalMinutes);
    const remindMinutes = Number(form.remindMinutes);
    const maxWakeAttempts = Number(form.maxWakeAttempts);
    if (!form.name.trim()) {
      setError('请输入监控名称');
      return null;
    }
    if (!form.sessionId) {
      setError('请选择用于接收通知或处理事件的会话');
      return null;
    }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 / 6) {
      setError('检查间隔不能少于 10 秒');
      return null;
    }
    if (!Number.isFinite(remindMinutes) || remindMinutes < 0.5) {
      setError('再次唤醒间隔不能少于 30 秒');
      return null;
    }
    if (remindMinutes < intervalMinutes) {
      setError('再次唤醒间隔不能短于检查间隔');
      return null;
    }
    if (!Number.isInteger(maxWakeAttempts) || maxWakeAttempts < 1) {
      setError('最大唤醒次数必须是正整数');
      return null;
    }
    const session = sessions.find((candidate) => candidate.id === form.sessionId);
    if (!session) {
      setError('所选会话已不存在');
      return null;
    }
    if (form.probeKind === 'command' && !form.command.trim()) {
      setError('请输入健康检查命令');
      return null;
    }
    if (form.probeKind === 'http' && !form.url.trim()) {
      setError('请输入检查 URL');
      return null;
    }
    setError('');
    return {
      name: form.name.trim(),
      sessionId: session.id,
      host: session.host === useStore.getState().localName ? undefined : session.host,
      cwd: session.cwd,
      intervalMs: Math.round(intervalMinutes * 60_000),
      probe: form.probeKind === 'command'
        ? { kind: 'command', command: form.command.trim(), timeoutMs: 30_000 }
        : {
            kind: 'http',
            url: form.url.trim(),
            method: form.method,
            timeoutMs: 15_000,
            expectedStatusMin: 200,
            expectedStatusMax: 399,
            bodyIncludes: form.bodyIncludes.trim() || undefined,
          },
      actionMode: form.actionMode,
      instructions: form.instructions.trim(),
      maxWakeAttempts,
      remindEveryMs: Math.round(remindMinutes * 60_000),
      notifyOnRecovery: form.notifyOnRecovery,
    };
  };

  const test = async () => {
    const input = inputFromForm();
    if (!input) return;
    setWorking('test');
    setTestResult(null);
    try {
      setTestResult(await api.testMonitor(input));
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Test failed');
    } finally {
      setWorking(null);
    }
  };

  const save = async () => {
    const input = inputFromForm();
    if (!input) return;
    setWorking('save');
    try {
      const saved = creating || !selected
        ? await api.createMonitor(input)
        : await api.updateMonitor(selected.id, input);
      setCreating(false);
      setSelectedId(saved.id);
      setFormMonitorId(saved.id);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Save failed');
    } finally {
      setWorking(null);
    }
  };

  const toggle = async () => {
    if (!selected) return;
    const enabling = !selected.enabled;
    const input = enabling ? inputFromForm() : null;
    if (enabling && !input) return;
    setWorking('toggle');
    try {
      if (enabling && input) await api.updateMonitor(selected.id, input);
      const updated = await api.setMonitorEnabled(selected.id, enabling);
      setMonitors((current) => current.map((monitor) => monitor.id === updated.id ? updated : monitor));
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'State change failed');
    } finally {
      setWorking(null);
    }
  };

  const runNow = async () => {
    if (!selected) return;
    setWorking('run');
    try {
      const run = await api.runMonitor(selected.id);
      setTestResult(run.result);
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Run failed');
    } finally {
      setWorking(null);
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm(`删除监控“${selected.name}”？历史事件也会一并删除。`)) return;
    setWorking('delete');
    try {
      await api.deleteMonitor(selected.id);
      setSelectedId(null);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Delete failed');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="new-session-panel flex h-[min(820px,calc(100dvh-1.5rem))] w-full max-w-5xl overflow-hidden rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="flex w-64 shrink-0 flex-col border-r border-white/5 max-md:w-44">
          <div className="flex h-14 items-center justify-between border-b border-white/5 px-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <MonitorIcon className="h-4 w-4 text-accent" />
              Monitoring
            </div>
            <button onClick={startCreate} className="rounded-lg p-1.5 text-slate-400 hover:bg-ink-700 hover:text-slate-100" title="New monitor">
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-slate-500" /></div>
            ) : monitors.length === 0 ? (
              <button onClick={startCreate} className="w-full rounded-lg border border-dashed border-ink-700 px-3 py-8 text-xs text-slate-500 hover:border-accent/30 hover:text-slate-300">
                暂无监控<br />点击创建
              </button>
            ) : (
              <ul className="space-y-1">
                {monitors.map((monitor) => (
                  <li key={monitor.id}>
                    <button
                      onClick={() => selectMonitor(monitor)}
                      className={cn(
                        'w-full rounded-lg px-3 py-2 text-left transition',
                        selectedId === monitor.id && !creating ? 'bg-accent/10 ring-1 ring-accent/25' : 'hover:bg-ink-800',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          monitor.status === 'healthy' ? 'bg-emerald-400'
                            : monitor.status === 'firing' || monitor.status === 'error' ? 'bg-rose-400'
                              : monitor.status === 'checking' ? 'animate-pulse bg-amber-400' : 'bg-slate-600',
                        )} />
                        <span className="truncate text-[13px] text-slate-200">{monitor.name}</span>
                      </span>
                      <span className="mt-1 block pl-4 text-[10px] text-slate-600">
                        {monitor.enabled ? monitor.status : monitor.status === 'draft' ? 'draft' : 'paused'} · {intervalLabel(monitor.intervalMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/5 px-5">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                {creating ? '新建监控草稿' : selected?.name ?? '选择一个监控'}
              </h2>
              {selected && !creating && <p className="text-[10px] text-slate-600">{selected.id}</p>}
            </div>
            <button onClick={onClose} className="rounded p-1 text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
          </div>

          {(creating || selected) ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="space-y-4">
                  <div>
                    <label className={labelClass}>名称</label>
                    <input className={fieldClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="ki3 Airflow 失败处理" />
                  </div>
                  <div>
                    <label className={labelClass}>接收通知和处理事件的会话</label>
                    <select className={fieldClass} value={form.sessionId} onChange={(event) => setForm({ ...form, sessionId: event.target.value })}>
                      <option value="">请选择会话</option>
                      {sessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.host}</option>)}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-600">监控绑定 Vibe 会话；以后切换 agent 仍然有效。</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>每隔几分钟检查</label>
                      <input className={fieldClass} type="number" min="0.1667" step="0.5" value={form.intervalMinutes} onChange={(event) => setForm({ ...form, intervalMinutes: event.target.value })} />
                    </div>
                    <div>
                      <label className={labelClass}>探针类型</label>
                      <select className={fieldClass} value={form.probeKind} onChange={(event) => setForm({ ...form, probeKind: event.target.value as ProbeKind })}>
                        <option value="command">Command</option>
                        <option value="http">HTTP</option>
                      </select>
                    </div>
                  </div>
                  {form.probeKind === 'command' ? (
                    <div>
                      <label className={labelClass}>健康检查命令</label>
                      <textarea className={`${fieldClass} min-h-28 font-mono`} value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder={'# exit 0 = healthy; non-zero = unhealthy\npython scripts/check_airflow.py'} />
                      <p className="mt-1 text-[11px] text-amber-400/70">命令会周期执行，请只放只读检查；不要在这里填写密钥。</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-[90px_1fr] gap-3">
                        <select className={fieldClass} value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value as 'GET' | 'HEAD' })}>
                          <option>GET</option><option>HEAD</option>
                        </select>
                        <input className={fieldClass} value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://service.example/health" />
                      </div>
                      <div>
                        <label className={labelClass}>响应正文必须包含（可选）</label>
                        <input className={fieldClass} value={form.bodyIncludes} onChange={(event) => setForm({ ...form, bodyIncludes: event.target.value })} placeholder="ok" />
                      </div>
                    </div>
                  )}
                </section>

                <section className="space-y-4">
                  <div>
                    <label className={labelClass}>异常发生后</label>
                    <select className={fieldClass} value={form.actionMode} onChange={(event) => setForm({ ...form, actionMode: event.target.value as MonitorActionMode })}>
                      <option value="wake-agent">唤醒绑定会话的 agent 处理</option>
                      <option value="notify">只在会话中通知</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>处理说明 / Runbook</label>
                    <textarea className={`${fieldClass} min-h-32`} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} placeholder="说明允许执行的操作以及恢复成功的判断标准" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>最多唤醒次数</label>
                      <input className={fieldClass} type="number" min="1" max="20" value={form.maxWakeAttempts} onChange={(event) => setForm({ ...form, maxWakeAttempts: event.target.value })} />
                    </div>
                    <div>
                      <label className={labelClass}>未恢复再次唤醒（分钟）</label>
                      <input className={fieldClass} type="number" min="0.5" step="0.5" value={form.remindMinutes} onChange={(event) => setForm({ ...form, remindMinutes: event.target.value })} />
                    </div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-400">
                    <input type="checkbox" checked={form.notifyOnRecovery} onChange={(event) => setForm({ ...form, notifyOnRecovery: event.target.checked })} className="accent-[rgb(var(--accent))]" />
                    恢复健康时在会话中通知
                  </label>

                  {selected && !creating && (
                    <div className="rounded-xl border border-white/5 bg-ink-900/60 p-3 text-[11px] text-slate-500">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        <span>状态</span><span className="text-slate-300">{selected.status}</span>
                        <span>上次检查</span><span className="text-slate-300">{time(selected.lastCheckAt)}</span>
                        <span>下次检查</span><span className="text-slate-300">{time(selected.nextCheckAt)}</span>
                        <span>连续失败</span><span className="text-slate-300">{selected.consecutiveFailures}</span>
                      </div>
                      {selected.lastSummary && <p className="mt-2 break-words border-t border-white/5 pt-2 text-slate-400">{selected.lastSummary}</p>}
                    </div>
                  )}

                  {testResult && (
                    <div className={cn('rounded-xl border p-3 text-[12px]', testResult.healthy ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300' : 'border-rose-500/25 bg-rose-500/5 text-rose-300')}>
                      <div className="flex items-center gap-2 font-medium">
                        {testResult.healthy ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
                        {testResult.summary}
                      </div>
                      <div className="mt-1 text-[10px] opacity-70">{testResult.durationMs}ms</div>
                      {testResult.detail && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/15 p-2 text-[10px]">{testResult.detail}</pre>}
                    </div>
                  )}
                </section>
              </div>

              {selected && !creating && events.length > 0 && (
                <section className="mt-5 border-t border-white/5 pt-4">
                  <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">事件时间线</h3>
                  <div className="space-y-2">
                    {events.map((event) => (
                      <div key={event.id} className="rounded-lg border border-white/5 bg-ink-900/40 px-3 py-2 text-[11px]">
                        <div className="flex items-center justify-between gap-3">
                          <span className={cn('font-medium', event.status === 'resolved' ? 'text-emerald-400' : event.status === 'escalated' ? 'text-amber-400' : 'text-rose-400')}>{event.status}</span>
                          <span className="text-slate-600">{time(event.firstSeenAt)}</span>
                        </div>
                        <p className="mt-1 break-words text-slate-400">{event.summary}</p>
                        <p className="mt-1 text-slate-600">agent 唤醒 {event.attemptCount} 次{event.resolvedAt ? ` · 恢复于 ${time(event.resolvedAt)}` : ''}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {error && <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-300">{error}</div>}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-500">
              <MonitorIcon className="h-8 w-8" />
              <p className="text-sm">选择一个监控，或创建新草稿</p>
              <button onClick={startCreate} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent-soft">新建监控</button>
            </div>
          )}

          {(creating || selected) && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/5 px-5 py-3">
              <div className="flex items-center gap-2">
                {selected && !creating && (
                  <button onClick={() => void remove()} disabled={!!working} className="rounded-lg p-2 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50" title="Delete">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                {selected?.enabled && !creating && (
                  <button onClick={() => void runNow()} disabled={!!working} className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-2 text-xs text-slate-300 hover:bg-ink-800 disabled:opacity-50">
                    {working === 'run' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}立即检查
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => void test()} disabled={!!working} className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-2 text-xs text-slate-300 hover:bg-ink-800 disabled:opacity-50">
                  {working === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}测试
                </button>
                <button onClick={() => void save()} disabled={!!working} className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-medium text-accent-soft hover:bg-accent/20 disabled:opacity-50">
                  {working === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{creating ? '保存草稿' : '保存'}
                </button>
                {selected && !creating && (
                  <button onClick={() => void toggle()} disabled={!!working} className={cn('flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50', selected.enabled ? 'border border-amber-500/25 bg-amber-500/10 text-amber-300' : 'bg-accent text-white')}>
                    {working === 'toggle' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : selected.enabled ? <CirclePause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {selected.enabled ? '暂停' : '启用'}
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
