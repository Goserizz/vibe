import { useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, Check, X, Plug, LogIn, LogOut } from 'lucide-react';
import type { McpServerDef, McpTransport } from '@shared/protocol';
import { useStore } from '../store/store';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/format';

const TRANSPORTS: { id: McpTransport; label: string }[] = [
  { id: 'stdio', label: 'stdio' },
  { id: 'sse', label: 'sse' },
  { id: 'http', label: 'http' },
];

/** One KEY=VALUE (stdio env) or KEY:VALUE (sse/http headers) per line → record. */
function parsePairs(text: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const i = raw.search(sep);
    if (i <= 0) continue;
    const k = raw.slice(0, i).trim();
    const v = raw.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function pairsToText(rec: Record<string, string> | undefined, sep: string): string {
  if (!rec) return '';
  return Object.entries(rec).map(([k, v]) => `${k}${sep}${v}`).join('\n');
}

function summarize(def: McpServerDef): string {
  if (def.transport === 'stdio') {
    const cmd = [def.command ?? '', ...(def.args ?? [])].join(' ');
    return cmd;
  }
  return def.url ?? '';
}

/** Checkbox list of all registered servers, toggling membership for `scope`. */
export function McpEnableList({ scope, emptyHint }: { scope: string; emptyHint?: string }) {
  const servers = useStore((s) => s.mcp.servers);
  const enabled = useStore((s) => s.mcp.enabled[scope] ?? []);
  const setMcpEnabled = useStore((s) => s.setMcpEnabled);
  const enabledSet = new Set(enabled);

  const toggle = (name: string) => {
    const next = enabledSet.has(name) ? enabled.filter((n) => n !== name) : [...enabled, name];
    void setMcpEnabled(scope, next);
  };

  if (servers.length === 0) {
    return <p className="text-[11px] text-slate-600">{emptyHint ?? 'No MCP servers defined yet.'}</p>;
  }
  return (
    <ul className="space-y-1">
      {servers.map((s) => {
        const on = enabledSet.has(s.name);
        return (
          <li key={s.name}>
            <button
              type="button"
              onClick={() => toggle(s.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition',
                on ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-ink-800/80',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  on ? 'border-accent bg-accent text-accent-fg' : 'border-ink-600 text-transparent',
                )}
              >
                <Check className="h-3 w-3" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-slate-200">{s.name}</span>
                <span className="block truncate font-mono text-[10px] text-slate-500">{summarize(s)}</span>
              </span>
              <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">
                {s.transport}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Add/edit form for a single MCP server definition. */
export function McpServerForm({
  def,
  onDone,
}: {
  def?: McpServerDef;
  onDone: () => void;
}) {
  const upsert = useStore((s) => s.upsertMcpServer);
  const setToast = useStore((s) => s.setToast);

  const [name, setName] = useState(def?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(def?.transport ?? 'stdio');
  const [command, setCommand] = useState(def?.command ?? '');
  const [args, setArgs] = useState((def?.args ?? []).join('\n'));
  const [env, setEnv] = useState(pairsToText(def?.env, '='));
  const [url, setUrl] = useState(def?.url ?? '');
  const [headers, setHeaders] = useState(pairsToText(def?.headers, ':'));
  const [auth, setAuth] = useState<'none' | 'oauth'>(def?.auth === 'oauth' ? 'oauth' : 'none');
  const [saving, setSaving] = useState(false);

  const isStdio = transport === 'stdio';

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setToast('MCP server needs a name');
      return;
    }
    const server: McpServerDef = { name: trimmedName, transport };
    if (isStdio) {
      if (!command.trim()) {
        setToast('stdio server needs a command');
        return;
      }
      server.command = command.trim();
      const argList = args.split('\n').map((a) => a.trim()).filter(Boolean);
      if (argList.length) server.args = argList;
      const envRec = parsePairs(env, /=/);
      if (Object.keys(envRec).length) server.env = envRec;
    } else {
      if (!url.trim()) {
        setToast(`${transport} server needs a URL`);
        return;
      }
      server.url = url.trim();
      if (auth === 'oauth') {
        server.auth = 'oauth';
      } else {
        const hRec = parsePairs(headers, /:/);
        if (Object.keys(hRec).length) server.headers = hRec;
      }
    }
    setSaving(true);
    const ok = await upsert(server);
    setSaving(false);
    if (ok) onDone();
  };

  const inputCls =
    'h-9 min-w-0 w-full rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';
  const monoCls = cn(inputCls, 'font-mono text-[12px]');

  return (
    <div className="space-y-2 rounded-lg border border-white/5 bg-ink-900/30 p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)] gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. filesystem)" className={inputCls} />
        <select
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpTransport)}
          className={inputCls}
        >
          {TRANSPORTS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {isStdio ? (
        <>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx)" className={monoCls} />
          <textarea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={'one arg per line\n-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
            rows={3}
            className={cn(monoCls, 'h-auto py-2 leading-relaxed')}
          />
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            placeholder={'env, one KEY=VALUE per line (optional)'}
            rows={2}
            className={cn(monoCls, 'h-auto py-2 leading-relaxed')}
          />
        </>
      ) : (
        <>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.notion.com/mcp" className={monoCls} />
          <div className="flex items-center gap-1">
            {(['none', 'oauth'] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAuth(a)}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition',
                  auth === a ? 'border-accent/50 bg-accent/10 text-accent' : 'border-ink-700 text-slate-400 hover:text-slate-200',
                )}
              >
                {a === 'none' ? 'Static headers' : 'MCP-OAuth (sign in)'}
              </button>
            ))}
          </div>
          {auth === 'oauth' ? (
            <p className="rounded-md border border-ink-700/60 bg-ink-900/30 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500">
              Save first, then click <span className="text-slate-300">Connect</span> on the server to sign in via your browser. Vibe stores and
              refreshes the token and injects it for every turn.
            </p>
          ) : (
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={'headers, one KEY:VALUE per line (optional)\nAuthorization: Bearer …'}
              rows={2}
              className={cn(monoCls, 'h-auto py-2 leading-relaxed')}
            />
          )}
        </>
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

/** Connect / disconnect + status for one OAuth-managed server. */
function OAuthControls({ name }: { name: string }) {
  const status = useStore((s) => s.mcp.oauth[name]);
  const setToast = useStore((s) => s.setToast);
  const [busy, setBusy] = useState(false);

  const connected = !!status?.connected;
  const expired = connected && typeof status?.expiresAt === 'number' && status.expiresAt < Date.now();

  const connect = async () => {
    setBusy(true);
    try {
      const authUrl = await api.startMcpOAuth(name);
      window.open(authUrl, '_blank');
      // The provider redirects back to our callback; poll the snapshot until it
      // reports connected (or we give up).
      const startedAt = Date.now();
      const poll = async () => {
        await useStore.getState().loadMcp();
        const st = useStore.getState().mcp.oauth[name];
        if (st?.connected) {
          setBusy(false);
          return;
        }
        if (Date.now() - startedAt > 120_000) {
          setBusy(false);
          setToast('OAuth timed out — try Connect again');
          return;
        }
        setTimeout(() => void poll(), 2500);
      };
      setTimeout(() => void poll(), 3000);
    } catch (err) {
      setBusy(false);
      setToast(err instanceof ApiError ? err.message : 'OAuth start failed');
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnectMcpOAuth(name);
      await useStore.getState().loadMcp();
    } catch {
      setToast('Failed to disconnect');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
          connected && !expired ? 'bg-emerald-500/15 text-emerald-400' : expired ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-700/40 text-slate-400',
        )}
      >
        {connected ? (expired ? 'expired' : 'connected') : 'not connected'}
      </span>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={busy}
        title={connected ? 'Reconnect' : 'Connect (sign in)'}
        className="flex h-7 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[10px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}
        {connected ? 'Reconnect' : 'Connect'}
      </button>
      {connected && (
        <button
          type="button"
          onClick={() => void disconnect()}
          disabled={busy}
          title="Disconnect"
          className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-rose-400 disabled:opacity-40"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Full registry editor: list + add/edit/delete. Used in Settings. */
export function McpServerRegistry() {
  const servers = useStore((s) => s.mcp.servers);
  const remove = useStore((s) => s.deleteMcpServer);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {servers.length === 0 && !adding && (
        <p className="text-[12px] leading-relaxed text-slate-600">
          No MCP servers yet. Define a server once, then enable it per host below.
        </p>
      )}

      {servers.map((s) =>
        editing === s.name ? (
          <McpServerForm key={s.name} def={s} onDone={() => setEditing(null)} />
        ) : (
          <div key={s.name} className="flex items-center gap-2 rounded-lg border border-white/5 bg-ink-900/20 px-3 py-2">
            <Plug className="h-3.5 w-3.5 shrink-0 text-accent/70" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] text-slate-200">{s.name}</span>
                <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">
                  {s.transport}
                </span>
              </div>
              <div className="truncate font-mono text-[11px] text-slate-500">{summarize(s)}</div>
            </div>
            {s.auth === 'oauth' && <OAuthControls name={s.name} />}
            <button
              type="button"
              title="Edit"
              onClick={() => setEditing(s.name)}
              className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Delete"
              onClick={() => void remove(s.name)}
              className="rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-rose-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
      )}

      {adding ? (
        <McpServerForm onDone={() => setAdding(false)} />
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
          Add MCP server
        </button>
      )}
    </div>
  );
}
