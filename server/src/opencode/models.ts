import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import { createSwrCache } from '../util/swrCache.js';

export interface OpencodeModelOption {
  value: string;
  label: string;
}

export interface OpencodePermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

const AUTO_MODEL: OpencodeModelOption = { value: 'auto', label: 'Auto' };

/**
 * Permission modes surfaced for opencode.
 *
 * Turns run over ACP (`opencode acp`), which reports risky tool calls through
 * `session/request_permission` — Vibe shows them as inline Allow / Always /
 * Deny prompts, exactly like the other ACP agents. Only Always-approve skips
 * the UI (every request is auto-allowed). Plan additionally switches the
 * session into opencode's plan mode, which disallows all edit tools.
 */
export const OPENCODE_PERMISSIONS: OpencodePermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before risky tools' },
  { value: 'plan', label: 'Plan', hint: 'Plan mode (edits disallowed) + prompts' },
  { value: 'acceptEdits', label: 'Auto', hint: 'opencode policy decides per tool' },
  { value: 'bypassPermissions', label: 'Always-approve', hint: 'Auto-approve tool calls (careful)' },
];

const FALLBACK: OpencodeModelOption[] = [AUTO_MODEL];

const TTL_MS = 5 * 60_000;
const cache = createSwrCache<OpencodeModelOption[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  isEmpty: (m) => m.length === 0,
  onError: (key, err) => log.debug('opencode models refresh failed', key || 'local', err),
});

/** `provider/model` → context window (`limit.context`), from `models --verbose`. */
const windowsCache = createSwrCache<Record<string, number>>({
  ttlMs: 30 * 60_000,
  fallback: {},
  isEmpty: (m) => Object.keys(m).length === 0,
  onError: (key, err) => log.debug('opencode model limits refresh failed', key || 'local', err),
});

function labelOf(id: string, name?: string): string {
  // Prefer the verbose display name ("OpenCode Zen/Big Pickle" → "Big
  // Pickle"); fall back to the bare model id (`opencode/gpt-5.4-mini` →
  // `gpt-5.4-mini`).
  const pretty = (name ?? '').trim().split('/').pop()!.trim();
  if (pretty) return pretty;
  return labelBare(id);
}

function labelBare(id: string): string {
  // `opencode/gpt-5.4-mini` → `gpt-5.4-mini`; keep the provider prefix when the
  // model id itself carries no provider (already bare).
  const slash = id.indexOf('/');
  const bare = slash >= 0 ? id.slice(slash + 1) : id;
  return bare || id;
}

function pushModel(models: OpencodeModelOption[], seen: Set<string>, id: string, name?: string): void {
  const value = id.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  models.push({ value, label: labelOf(value, name) });
}

/** Parse `opencode models [provider]` output (plain `provider/model` lines). */
export function parseOpencodeModels(raw: string): OpencodeModelOption[] {
  const models: OpencodeModelOption[] = [];
  const seen = new Set<string>();
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { models?: unknown }).models)
          ? (parsed as { models: unknown[] }).models
          : Array.isArray((parsed as { data?: unknown }).data)
            ? (parsed as { data: unknown[] }).data
            : [];
      for (const item of list) {
        if (typeof item === 'string') pushModel(models, seen, item);
        else if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const id = String(rec.id ?? rec.model ?? rec.value ?? '').trim();
          if (id) pushModel(models, seen, id);
        }
      }
    } catch {
      /* fall through to line parsing */
    }
  }
  if (!models.length) {
    for (const line of trimmed.split('\n')) {
      const text = line.trim().replace(/^[*•\-]\s*/, '');
      if (!text || /^usage:|^available models|^-+$/i.test(text)) continue;
      // Accept `provider/model` tokens (and bare `auto`, handled below).
      const token = text.match(/^([A-Za-z0-9][A-Za-z0-9._+~/-]*)/);
      if (token && token[1]!.includes('/')) pushModel(models, seen, token[1]!);
    }
  }
  if (!seen.has('auto')) models.unshift(AUTO_MODEL);
  else {
    const autoIdx = models.findIndex((m) => m.value === 'auto');
    if (autoIdx > 0) {
      const [auto] = models.splice(autoIdx, 1);
      models.unshift(auto!);
    }
  }
  return models;
}

function execOpencode(args: string[]): Promise<string> {
  const bin = config.opencodeExecutable;
  if (!bin) return Promise.reject(new Error('opencode not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout.trim()) reject(error);
      else resolve(stdout || stderr);
    });
  });
}

/**
 * Parse `opencode models --verbose`: `provider/model` id lines each followed
 * by a JSON block carrying `name` + `limit.context`. Returns the model list
 * plus a value→window map. Output without JSON blocks falls back to the
 * plain line parser (models only, no windows).
 */
export function parseOpencodeModelsVerbose(raw: string): { models: OpencodeModelOption[]; windows: Record<string, number> } {
  const models: OpencodeModelOption[] = [];
  const windows: Record<string, number> = {};
  const seen = new Set<string>();
  const lines = raw.split('\n');
  let pendingId: string | null = null;
  let depth = 0;
  let jsonBuf = '';
  const flushJson = (): void => {
    if (pendingId && jsonBuf.trim()) {
      try {
        const parsed = JSON.parse(jsonBuf) as {
          name?: unknown;
          limit?: { context?: unknown };
        };
        const win = parsed.limit && typeof parsed.limit.context === 'number' && Number.isFinite(parsed.limit.context)
          ? Math.floor(parsed.limit.context)
          : 0;
        if (win > 0) windows[pendingId] = win;
        const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined;
        pushModel(models, seen, pendingId, name);
      } catch {
        pushModel(models, seen, pendingId);
      }
    } else if (pendingId) {
      pushModel(models, seen, pendingId);
    }
    pendingId = null;
    jsonBuf = '';
    depth = 0;
  };
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      if (depth === 0) flushJson();
      continue;
    }
    if (depth > 0 || text.startsWith('{')) {
      for (const ch of text) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      jsonBuf += `${text}\n`;
      if (depth <= 0) flushJson();
      continue;
    }
    if (/^usage:|^available models|^-+$/i.test(text)) continue;
    const token = text.replace(/^[*•\-]\s*/, '').match(/^([A-Za-z0-9][A-Za-z0-9._+~/-]*)/);
    if (token && token[1]!.includes('/')) {
      if (depth === 0) flushJson();
      pendingId = token[1]!;
    }
  }
  flushJson();
  if (!models.length) return { models: parseOpencodeModels(raw), windows };
  if (!seen.has('auto')) models.unshift(AUTO_MODEL);
  return { models, windows };
}

/** Model display name for a verbose id (exported for tests). */
export function opencodeLabelOf(id: string): string {
  return labelOf(id);
}

function remoteInvocation(args: string[]): string {
  const invoke = `"$opencode_bin" ${args.map(shQuote).join(' ')}`;
  return [
    'opencode_fallback="$HOME/.opencode/bin/opencode"',
    'if command -v opencode >/dev/null 2>&1; then opencode_bin="$(command -v opencode)"; '
      + 'elif [ -x "$opencode_fallback" ]; then opencode_bin="$opencode_fallback"; '
      + 'else echo "opencode not found" >&2; exit 127; fi',
    invoke,
  ].join('\n');
}

async function fetchLocal(): Promise<OpencodeModelOption[] | null> {
  if (!config.opencodeExecutable) return null;
  try {
    const { models } = parseOpencodeModelsVerbose(await execOpencode(['models', '--verbose']));
    if (models.length > 1) return models;
  } catch {
    /* older builds may lack --verbose */
  }
  const out = await execOpencode(['models']);
  return parseOpencodeModels(out);
}

async function fetchRemote(hostName: string): Promise<OpencodeModelOption[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'opencode'));
  const runRemote = async (args: string[]): Promise<string> => {
    const res = await sshExec(host.ssh, proxyPrefix + loginShellCommand(remoteInvocation(args)), {
      timeoutMs: 30_000,
    });
    return res.stdout;
  };
  try {
    const { models } = parseOpencodeModelsVerbose(await runRemote(['models', '--verbose']));
    if (models.length > 1) return models;
  } catch {
    /* older builds may lack --verbose */
  }
  const models = parseOpencodeModels(await runRemote(['models']));
  if (!models.length) {
    log.debug('remote opencode models empty', host.name);
    return null;
  }
  return models;
}

async function fetchLocalWindows(): Promise<Record<string, number> | null> {
  if (!config.opencodeExecutable) return null;
  try {
    const { windows } = parseOpencodeModelsVerbose(await execOpencode(['models', '--verbose']));
    return Object.keys(windows).length ? windows : null;
  } catch {
    return null;
  }
}

async function fetchRemoteWindows(hostName: string): Promise<Record<string, number> | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocalWindows();
  try {
    const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'opencode'));
    const res = await sshExec(host.ssh, proxyPrefix + loginShellCommand(remoteInvocation(['models', '--verbose'])), {
      timeoutMs: 30_000,
    });
    const { windows } = parseOpencodeModelsVerbose(res.stdout);
    return Object.keys(windows).length ? windows : null;
  } catch {
    return null;
  }
}

/** Warm the context-window table in the background (SWR dedupes). */
export function warmOpencodeContextWindows(hostName?: string): void {
  const key = hostName ?? '';
  windowsCache.refresh(key, () => (hostName ? fetchRemoteWindows(hostName) : fetchLocalWindows()));
}

/** Pure map lookup behind {@link peekOpencodeContextWindow} (exported for tests). */
export function lookupOpencodeWindow(windows: Record<string, number>, model: string): number | undefined {
  const trimmed = (model || '').trim();
  if (!trimmed || trimmed === 'auto') return undefined;
  if (windows[trimmed] != null) return windows[trimmed];
  const slash = trimmed.indexOf('/');
  const bare = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  for (const [key, value] of Object.entries(windows)) {
    if (key === bare || key.endsWith(`/${bare}`)) return value;
  }
  return undefined;
}

/** Context window for a `provider/model` (or bare) id, when the verbose
 *  catalog has reported it. Sync — call after warming. */
export function peekOpencodeContextWindow(model: string, hostName?: string): number | undefined {
  const map = windowsCache.peek(hostName ?? '');
  if (!map) return undefined;
  return lookupOpencodeWindow(map, model);
}

export function invalidateOpencodeModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
  windowsCache.invalidate(hostName ?? '');
}

/** Models advertised by the local opencode CLI. Never blocks on the CLI. */
export async function listOpencodeModels(): Promise<OpencodeModelOption[]> {
  return cache.serve('', fetchLocal);
}

/** Models from a remote host's opencode CLI. Never blocks on SSH. */
export async function listRemoteOpencodeModels(hostName: string): Promise<OpencodeModelOption[]> {
  if (!hostRegistry.get(hostName)) return listOpencodeModels();
  return cache.serve(hostName, () => fetchRemote(hostName));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchOpencodeModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  windowsCache.refresh('', fetchLocalWindows);
  for (const name of hostNames) {
    cache.refresh(name, () => fetchRemote(name));
    windowsCache.refresh(name, () => fetchRemoteWindows(name));
  }
}
