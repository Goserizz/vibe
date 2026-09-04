import { useEffect, useState, type KeyboardEvent } from 'react';
import {
  X,
  Server,
  Trash2,
  Plus,
  Loader2,
  Check,
  AlertCircle,
  RefreshCw,
  Globe,
  ArrowUpCircle,
  Download,
  Monitor,
  Plug,
  ChevronDown,
  ChevronRight,
} from '../lib/icons';
import type { AgentKind, AgentLatestVersions, HostStatus, RemoteHost } from '@shared/protocol';
import { useStore } from '../store/store';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/format';
import { McpEnableList } from './McpControls';
import { AgentLoginControls, CodebuddyLoginControls, LOGIN_AGENTS } from './AgentSignIn';

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  kimi: 'Kimi',
  kiro: 'Kiro',
  grok: 'Grok',
  zcode: 'ZCode',
  codebuddy: 'CodeBuddy',
  opencode: 'opencode',
  devin: 'Devin',
};

const AGENT_ORDER: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy', 'opencode', 'devin'];

/** Seed per-agent proxy local-state from a host's stored overrides (trimmed). */
function agentProxyState(m?: Partial<Record<AgentKind, string>>): Record<AgentKind, string> {
  const out = {} as Record<AgentKind, string>;
  for (const a of AGENT_ORDER) out[a] = m?.[a]?.trim() ?? '';
  return out;
}

/** Normalize the in-progress per-agent map for saving: drop empty values so the
 *  server only stores agents with an explicit override (others fall back to the
 *  default proxy). */
function normalizeProxyMap(byAgent: Record<AgentKind, string>): Partial<Record<AgentKind, string>> {
  const out: Partial<Record<AgentKind, string>> = {};
  for (const a of AGENT_ORDER) {
    const v = byAgent[a].trim();
    if (v) out[a] = v;
  }
  return out;
}

export function HostsDialog({ onClose }: { onClose: () => void }) {
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);
  const isAdmin = useStore((s) => s.isAdmin);
  const addHost = useStore((s) => s.addHost);
  const updateHost = useStore((s) => s.updateHost);
  const removeHost = useStore((s) => s.removeHost);

  const [name, setName] = useState('');
  const [ssh, setSsh] = useState('');
  const [proxy, setProxy] = useState('');
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<Record<string, HostStatus | 'checking'>>({});
  const [latest, setLatest] = useState<AgentLatestVersions>({});
  const [updating, setUpdating] = useState<Record<string, AgentKind | undefined>>({});
  const [updatingAll, setUpdatingAll] = useState(false);
  const [expandedHost, setExpandedHost] = useState<string | null>(null);

  const toggleHost = (hostName: string) => setExpandedHost((v) => (v === hostName ? null : hostName));

  const check = async (host: string): Promise<HostStatus> => {
    setStatus((s) => ({ ...s, [host]: 'checking' }));
    try {
      const res = await api.checkHost(host);
      setStatus((s) => ({ ...s, [host]: res }));
      return res;
    } catch {
      const failed: HostStatus = { name: host, ssh: '', online: false, claude: false, error: 'check failed' };
      setStatus((s) => ({ ...s, [host]: failed }));
      return failed;
    }
  };

  useEffect(() => {
    if (isAdmin) void check(localName);
    hosts.forEach((h) => void check(h.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts.length, localName, isAdmin]);

  useEffect(() => {
    void api
      .latestAgentVersions()
      .then(setLatest)
      .catch(() => {
        /* ignore — UI still shows installed versions */
      });
  }, []);

  const submit = async () => {
    if (!name.trim() || !ssh.trim()) return;
    if (name.trim() === localName || name.trim() === 'local') {
      useStore.getState().setToast(`"${localName}" is reserved for this machine`);
      return;
    }
    setAdding(true);
    const ok = await addHost({ name: name.trim(), ssh: ssh.trim(), proxy: proxy.trim() || undefined });
    setAdding(false);
    if (ok) {
      void check(name.trim());
      setName('');
      setSsh('');
      setProxy('');
    }
  };

  const setToast = useStore((s) => s.setToast);
  const busy = updatingAll || Object.values(updating).some(Boolean);

  const updateAgent = async (hostName: string, agent: AgentKind): Promise<boolean> => {
    setUpdating((u) => ({ ...u, [hostName]: agent }));
    try {
      await api.updateHostAgent(hostName, agent);
      await check(hostName);
      try {
        setLatest(await api.latestAgentVersions());
      } catch {
        /* ignore */
      }
      return true;
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : `Failed to update ${AGENT_LABELS[agent]}`);
      return false;
    } finally {
      setUpdating((u) => ({ ...u, [hostName]: undefined }));
    }
  };

  /** Agents that need an upgrade on an online host (installed + outdated / unknown latest). */
  const jobsForHost = (st: HostStatus, versions: AgentLatestVersions): AgentKind[] => {
    if (!st.online) return [];
    return AGENT_ORDER.filter((kind) => {
      const info = st.agents?.[kind];
      if (!info?.installed) return false;
      const latestVer = versions[kind];
      if (!info.version || !latestVer) return true;
      return info.version !== latestVer;
    });
  };

  const updateAll = async () => {
    if (busy) return;
    setUpdatingAll(true);
    try {
      let versions = latest;
      try {
        versions = await api.latestAgentVersions();
        setLatest(versions);
      } catch {
        /* keep cached latest */
      }

      const names = [...(isAdmin ? [localName] : []), ...hosts.map((h) => h.name)];
      const checks = await Promise.all(names.map((n) => check(n)));
      const jobs: { host: string; agent: AgentKind }[] = [];
      checks.forEach((st, i) => {
        for (const agent of jobsForHost(st, versions)) {
          jobs.push({ host: names[i], agent });
        }
      });

      if (jobs.length === 0) {
        setToast('All agents are up to date');
        return;
      }

      let okCount = 0;
      const failures: string[] = [];
      for (let i = 0; i < jobs.length; i++) {
        const { host, agent } = jobs[i];
        setToast(`Updating ${AGENT_LABELS[agent]} on ${host} (${i + 1}/${jobs.length})…`);
        const ok = await updateAgent(host, agent);
        if (ok) okCount++;
        else failures.push(`${host}/${AGENT_LABELS[agent]}`);
      }
      if (failures.length === 0) {
        setToast(`Updated ${okCount} agent${okCount === 1 ? '' : 's'}`);
      } else {
        setToast(`Updated ${okCount}/${jobs.length}; failed: ${failures.join(', ')}`);
      }
    } finally {
      setUpdatingAll(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4"
      style={{ background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      onClick={onClose}
    >
      <div className="new-session-panel w-full max-w-xl rounded-2xl">
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="dialog-titlebar flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-slate-100">Hosts</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void updateAll()}
                disabled={busy}
                title="Update every outdated agent on this machine and all SSH hosts"
                className="flex h-7 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[11px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
              >
                {updatingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
                Update all
              </button>
              <button onClick={onClose} className="rounded p-1 text-slate-500 hover:text-slate-300">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            <p className="text-xs leading-relaxed text-slate-500">
              {isAdmin ? (
                <>
                  This machine (<span className="text-slate-300">{localName}</span>) is always listed first. Add remote
                  machines over SSH (an <code className="text-slate-400">~/.ssh/config</code> alias or{' '}
                  <code className="text-slate-400">user@host</code>). Key-based auth / ssh-agent is required. Set a{' '}
                  <span className="text-slate-400">proxy</span> per host, and override it per agent (Claude / Cursor /
                  Codex / Kimi) so each routes its API traffic independently. Check and update agent versions, and sign
                  Cursor / Codex into their accounts (Vibe fetches the login link for you), below.
                </>
              ) : (
                <>
                  Add the remote machines you manage over SSH (an <code className="text-slate-400">~/.ssh/config</code>{' '}
                  alias or <code className="text-slate-400">user@host</code>). Key-based auth / ssh-agent is required.
                  Set a <span className="text-slate-400">proxy</span> per host, and override it per agent so each routes
                  its API traffic independently. Check and update agent versions, and sign Cursor / Codex into their
                  accounts (Vibe fetches the login link for you), below.
                </>
              )}
            </p>

            <div className="space-y-1.5">
              {isAdmin && (
                <HostRow
                  host={{ name: localName, ssh: 'local' }}
                  local
                  status={status[localName]}
                  latest={latest}
                  updating={updating[localName]}
                  disabled={busy}
                  expanded={expandedHost === localName}
                  onToggleExpand={() => toggleHost(localName)}
                  onCheck={() => void check(localName)}
                  onUpdateAgent={(agent) => void updateAgent(localName, agent)}
                />
              )}
              {hosts.map((h) => (
                <HostRow
                  key={h.name}
                  host={h}
                  status={status[h.name]}
                  latest={latest}
                  updating={updating[h.name]}
                  disabled={busy}
                  expanded={expandedHost === h.name}
                  onToggleExpand={() => toggleHost(h.name)}
                  onCheck={() => void check(h.name)}
                  onRemove={() => void removeHost(h.name)}
                  onSaveProxy={(patch) => updateHost(h.name, patch)}
                  onUpdateAgent={(agent) => void updateAgent(h.name, agent)}
                />
              ))}
            </div>

            <div className="space-y-2 border-t border-white/5 pt-4">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  className="h-10 min-w-0 rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60"
                />
                <input
                  value={ssh}
                  onChange={(e) => setSsh(e.target.value)}
                  placeholder="user@host or ssh alias"
                  className="h-10 min-w-0 rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 font-mono text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60"
                />
              </div>
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 shrink-0 text-slate-600" />
                <input
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  placeholder="Proxy (optional, e.g. http://host:port)"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 font-mono text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60"
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => void submit()}
                  disabled={adding || !name.trim() || !ssh.trim()}
                  className="flex h-10 min-w-[84px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg transition hover:bg-accent-soft disabled:opacity-40"
                >
                  {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HostRow({
  host,
  local,
  status,
  latest,
  updating,
  disabled,
  expanded,
  onToggleExpand,
  onCheck,
  onRemove,
  onSaveProxy,
  onUpdateAgent,
}: {
  host: RemoteHost;
  local?: boolean;
  status?: HostStatus | 'checking';
  latest: AgentLatestVersions;
  updating?: AgentKind;
  disabled?: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onCheck: () => void;
  onRemove?: () => void;
  onSaveProxy?: (patch: { proxy?: string; proxyByAgent?: Partial<Record<AgentKind, string>> }) => Promise<boolean>;
  onUpdateAgent: (agent: AgentKind) => void;
}) {
  const [def, setDef] = useState(host.proxy ?? '');
  const [byAgent, setByAgent] = useState<Record<AgentKind, string>>(() => agentProxyState(host.proxyByAgent));
  const [saving, setSaving] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  useEffect(() => {
    setDef(host.proxy ?? '');
    setByAgent(agentProxyState(host.proxyByAgent));
  }, [host.proxy, host.proxyByAgent]);

  const saveDefault = async () => {
    if (!onSaveProxy) return;
    const trimmed = def.trim();
    if (trimmed === (host.proxy ?? '').trim()) return;
    setSaving(true);
    await onSaveProxy({ proxy: trimmed });
    setSaving(false);
  };

  /** Save one agent's override. Sends the full normalized map (replace semantics):
   *  agents left blank here are dropped, so they fall back to the default. */
  const saveAgent = async (kind: AgentKind) => {
    if (!onSaveProxy) return;
    if (byAgent[kind].trim() === (host.proxyByAgent?.[kind] ?? '').trim()) return;
    setSaving(true);
    await onSaveProxy({ proxyByAgent: normalizeProxyMap(byAgent) });
    setSaving(false);
  };

  const proxyKeys = (revert: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      revert();
      (e.target as HTMLInputElement).blur();
    }
  };

  const online = status && status !== 'checking' ? status.online : undefined;
  const agents = status && status !== 'checking' ? status.agents : undefined;
  const mcpCount = useStore((s) => s.mcp.enabled[host.name]?.length ?? 0);

  return (
    <div className="rounded-lg border border-white/5 bg-ink-900/20 px-3 py-2 backdrop-blur-md">
      <div
        className="flex cursor-pointer items-center gap-2.5"
        onClick={onToggleExpand}
        title={expanded ? 'Collapse' : 'Show agents'}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-600 transition-transform', expanded && 'rotate-90')}
        />
        <StatusDot status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-[13px] text-slate-200">
            {local && <Monitor className="h-3.5 w-3.5 shrink-0 text-accent/80" />}
            {host.name}
            {local && <span className="text-[10px] font-normal text-slate-500">this machine</span>}
          </div>
          <div className="truncate font-mono text-[11px] text-slate-500">
            {local ? 'local' : host.ssh}
            {status && status !== 'checking' && !status.online && status.error ? ` — ${status.error}` : ''}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCheck();
          }}
          title="Re-check"
          className="rounded p-1.5 text-slate-500 hover:bg-ink-700 hover:text-slate-300"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {!local && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!expanded) {
                setMcpOpen(true);
                onToggleExpand();
              } else {
                setMcpOpen((v) => !v);
              }
            }}
            title="MCP servers"
            className={cn(
              'flex items-center gap-1 rounded p-1.5 transition hover:bg-ink-700',
              mcpOpen || mcpCount ? 'text-accent' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            <Plug className="h-3.5 w-3.5" />
            {mcpCount > 0 && <span className="text-[10px] font-medium">{mcpCount}</span>}
          </button>
        )}
        {!local && onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Remove"
            className="rounded p-1.5 text-slate-500 hover:bg-ink-700 hover:text-rose-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {expanded && status === 'checking' && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking agents…
        </div>
      )}

      {expanded && online && (
        <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
          {AGENT_ORDER.map((kind) => {
            const info = agents?.[kind];
            const latestVer = latest[kind];
            const installed = info?.installed ?? false;
            const current = info?.version;
            const outdated = installed && !!current && !!latestVer && current !== latestVer;
            const upToDate = installed && !!current && !!latestVer && current === latestVer;
            const busy = updating === kind;
            return (
              <div key={kind} className="flex items-center gap-2 text-[11px]">
                <span className="w-14 shrink-0 text-slate-400">{AGENT_LABELS[kind]}</span>
                {!installed ? (
                  <span className="min-w-0 flex-1 truncate text-slate-600">not installed</span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-slate-400">
                    <span className="text-slate-300">{current ?? '?'}</span>
                    {latestVer ? (
                      <span className={outdated ? 'text-amber-400/90' : 'text-slate-600'}>
                        {' '}
                        → {latestVer}
                        {upToDate ? ' ✓' : ''}
                      </span>
                    ) : null}
                  </span>
                )}
                {busy ? (
                  <span className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[10px] text-slate-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {!installed ? 'Installing…' : 'Updating…'}
                  </span>
                ) : !installed ? (
                  <button
                    type="button"
                    disabled={disabled || updating != null}
                    onClick={() => onUpdateAgent(kind)}
                    title={`Install ${AGENT_LABELS[kind]}`}
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
                  >
                    <Download className="h-3 w-3" />
                    Install
                  </button>
                ) : upToDate ? (
                  <span className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[10px] text-emerald-500/80" title="Already on the latest version">
                    <Check className="h-3 w-3" />
                    Latest
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={disabled || updating != null}
                    onClick={() => onUpdateAgent(kind)}
                    title={outdated ? `Update ${AGENT_LABELS[kind]} to ${latestVer}` : `Update ${AGENT_LABELS[kind]}`}
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
                  >
                    <ArrowUpCircle className="h-3 w-3" />
                    Update
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {expanded && online && (
        <div className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Agent sign-in</div>
          {LOGIN_AGENTS.map((a) =>
            agents?.[a]?.installed === false ? null : (
              <AgentLoginControls key={a} agent={a} host={local ? undefined : host.name} />
            ),
          )}
          {agents?.codebuddy?.installed !== false && (
            <CodebuddyLoginControls host={local ? undefined : host.name} />
          )}
        </div>
      )}

      {expanded && !local && onSaveProxy && (
        <div className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
          <div className="flex items-center gap-2">
            <Globe className={`h-3.5 w-3.5 shrink-0 ${def.trim() ? 'text-accent/70' : 'text-slate-600'}`} />
            <input
              value={def}
              onChange={(e) => setDef(e.target.value)}
              onBlur={() => void saveDefault()}
              onKeyDown={proxyKeys(() => setDef(host.proxy ?? ''))}
              placeholder="default proxy (optional)"
              className="h-8 min-w-0 flex-1 rounded-md border border-ink-700/60 bg-ink-900/35 px-2.5 py-1.5 font-mono text-[11px] text-slate-300 outline-none backdrop-blur-md focus:border-accent/60"
            />
            {saving && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />}
          </div>
          <div className="space-y-1 pl-[22px]">
            {AGENT_ORDER.map((kind) => {
              const value = byAgent[kind];
              const usingDefault = !value.trim() && def.trim();
              return (
                <div key={kind} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                    {AGENT_LABELS[kind]}
                  </span>
                  <input
                    value={value}
                    onChange={(e) => setByAgent((m) => ({ ...m, [kind]: e.target.value }))}
                    onBlur={() => void saveAgent(kind)}
                    onKeyDown={proxyKeys(() =>
                      setByAgent((m) => ({ ...m, [kind]: host.proxyByAgent?.[kind]?.trim() ?? '' })),
                    )}
                    placeholder={usingDefault ? 'uses default' : 'override (optional)'}
                    className="h-7 min-w-0 flex-1 rounded-md border border-ink-700/40 bg-ink-900/35 px-2 py-1 font-mono text-[11px] text-slate-300 outline-none backdrop-blur-md focus:border-accent/60"
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {expanded && !local && mcpOpen && (
        <div className="mt-2 border-t border-white/5 pt-2">
          <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            {mcpOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            MCP servers on {host.name}
          </div>
          <McpEnableList scope={host.name} emptyHint="No MCP servers defined yet — add some in Settings." />
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status?: HostStatus | 'checking' }) {
  if (status === 'checking') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />;
  if (!status) return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-slate-600" />;
  if (!status.online) return <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />;
  const anyAgent =
    status.agents?.claude.installed ||
    status.agents?.cursor.installed ||
    status.agents?.codex.installed ||
    status.agents?.kimi.installed ||
    status.agents?.kiro.installed ||
    status.agents?.grok.installed ||
    status.agents?.zcode.installed ||
    status.agents?.codebuddy.installed ||
    status.agents?.opencode.installed ||
    status.agents?.devin.installed ||
    status.claude;
  if (anyAgent) return <Check className="h-4 w-4 shrink-0 text-emerald-400" />;
  return <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />;
}
