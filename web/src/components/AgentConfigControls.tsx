import { useEffect, useState } from 'react';
import { Loader2, X, Save, FileCog, TriangleAlert, FilePen } from '../lib/icons';
import type { AgentKind, ConfigFileDetail, ConfigFileEntry } from '@shared/protocol';
import { useStore } from '../store/store';
import { AGENTS } from '../lib/format';
import { cn } from '../lib/format';

const selectCls =
  'h-9 min-w-0 w-full appearance-none rounded-lg border border-ink-700 bg-ink-900/35 px-3 text-[13px] text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';
const bodyCls =
  'min-w-0 w-full min-h-[320px] rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2 text-[12.5px] leading-relaxed font-mono text-slate-200 outline-none backdrop-blur-md focus:border-accent/60';

function isJsonFile(label: string): boolean {
  return label.toLowerCase().endsWith('.json');
}

/** Live JSON-validity check for `.json` files. Non-blocking — saving is allowed
 *  even when invalid (the user may intentionally save a partial edit). */
function jsonStatus(text: string, label: string): { ok: boolean; msg: string } | null {
  if (!isJsonFile(label)) return null;
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, msg: 'empty' };
  try {
    JSON.parse(trimmed);
    return { ok: true, msg: 'valid JSON' };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

/** Inline editor for one config file (raw text — JSON or TOML). */
function ConfigEditor({
  def,
  agent,
  host,
  onDone,
}: {
  def: ConfigFileDetail;
  agent: AgentKind;
  host?: string;
  onDone: () => void;
}) {
  const saveAgentConfigFile = useStore((s) => s.saveAgentConfigFile);

  const [text, setText] = useState(def.content);
  const [saving, setSaving] = useState(false);
  const dirty = text !== def.content;
  const json = jsonStatus(text, def.label);

  const cancel = () => {
    if (dirty && !window.confirm('Discard your changes?')) return;
    onDone();
  };

  const submit = async () => {
    setSaving(true);
    const saved = await saveAgentConfigFile({ agent, host, id: def.id, content: text });
    setSaving(false);
    if (saved) onDone();
  };

  return (
    <div className="space-y-2 rounded-lg border border-white/5 bg-ink-900/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-slate-200">{def.label}</div>
          <div className="truncate font-mono text-[10.5px] text-slate-600">{def.relPath}</div>
        </div>
        {json && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
              json.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300',
            )}
            title={json.msg}
          >
            {json.ok ? 'valid JSON' : 'invalid JSON'}
          </span>
        )}
      </div>

      {!def.exists && (
        <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-amber-300/80">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          File doesn&apos;t exist yet — saving creates it.
        </p>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`# ${def.label}\n\nRaw contents of this config file.`}
        spellCheck={false}
        className={bodyCls}
      />

      {json && !json.ok && (
        <p className="truncate font-mono text-[10.5px] text-rose-400/80" title={json.msg}>
          {json.msg}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={cancel}
          className="flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] text-slate-400 transition hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !dirty}
          className="flex h-8 min-w-[72px] items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-soft disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Full agent-config panel: agent + host pickers, list of config files (raw-text editor on open). */
export function AgentConfigRegistry() {
  const files = useStore((s) => s.agentConfigFiles);
  const filesAgent = useStore((s) => s.agentConfigAgent);
  const filesHost = useStore((s) => s.agentConfigHost);
  const loadAgentConfig = useStore((s) => s.loadAgentConfig);
  const readAgentConfigDetail = useStore((s) => s.readAgentConfigDetail);
  const hosts = useStore((s) => s.hosts);
  const localName = useStore((s) => s.localName);

  const [agent, setAgent] = useState<AgentKind>('claude');
  const [host, setHost] = useState<string>(''); // '' = this machine
  const [editing, setEditing] = useState<ConfigFileDetail | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const hostArg = host || undefined;

  useEffect(() => {
    void loadAgentConfig(agent, hostArg);
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, host]);

  const open = async (entry: ConfigFileEntry) => {
    setBusyId(entry.id);
    const detail = await readAgentConfigDetail({ agent, host: hostArg, id: entry.id });
    setBusyId(null);
    if (detail) setEditing(detail);
  };

  const synced = filesAgent === agent && (filesHost ?? '') === host;

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

      {!synced && <p className="text-[12px] text-slate-600">Loading config files…</p>}

      {synced &&
        files.map((entry) => {
          if (editing && editing.id === entry.id) {
            return (
              <ConfigEditor
                key={entry.id}
                def={{ ...editing, exists: entry.exists || editing.exists }}
                agent={agent}
                host={hostArg}
                onDone={() => setEditing(null)}
              />
            );
          }
          return (
            <div
              key={entry.id}
              className="flex items-center gap-2 rounded-lg border border-white/5 bg-ink-900/20 px-3 py-2"
            >
              <FileCog className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <button type="button" onClick={() => void open(entry)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] text-slate-200">{entry.label}</span>
                <span className="block truncate font-mono text-[10.5px] text-slate-600">
                  {entry.relPath}
                  {entry.exists ? ` · ${formatSize(entry.size)}` : ' · missing'}
                </span>
              </button>
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  entry.exists ? 'bg-ink-700/60 text-slate-500' : 'bg-amber-500/15 text-amber-300/80',
                )}
              >
                {entry.exists ? 'exists' : 'missing'}
              </span>
              {busyId === entry.id ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />
              ) : (
                <button
                  type="button"
                  title="Edit"
                  onClick={() => void open(entry)}
                  className="shrink-0 rounded p-1.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
                >
                  <FilePen className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}

      {synced && files.length === 0 && (
        <p className="text-[12px] leading-relaxed text-slate-600">No managed config files for this agent.</p>
      )}
    </div>
  );
}
