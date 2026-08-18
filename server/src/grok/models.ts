import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import { createSwrCache } from '../util/swrCache.js';

export interface GrokModelOption {
  value: string;
  label: string;
}

export interface GrokPermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

const AUTO_MODEL: GrokModelOption = { value: 'auto', label: 'Auto' };

/** Permission modes Grok Build exposes (CLI flags + ACP `_meta.yoloMode`). */
export const GROK_PERMISSIONS: GrokPermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before tool use' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning; edit the plan file only' },
  { value: 'acceptEdits', label: 'Auto', hint: 'Classifier auto-approves safe tools' },
  { value: 'bypassPermissions', label: 'Always-approve', hint: 'Auto-approve tool calls (careful)' },
];

const FALLBACK: GrokModelOption[] = [
  AUTO_MODEL,
  { value: 'grok-build', label: 'Grok Build' },
  { value: 'grok-4.6', label: 'Grok 4.6' },
];

const TTL_MS = 5 * 60_000;
const cache = createSwrCache<GrokModelOption[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  isEmpty: (m) => m.length === 0,
  onError: (key, err) => log.debug('grok models refresh failed', key || 'local', err),
});

function labelOf(id: string, name?: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed && trimmed !== id) return trimmed;
  if (id === 'grok-build') return 'Grok Build';
  if (/^grok-/i.test(id)) {
    return id
      .split('-')
      .map((part) => (part.toLowerCase() === 'grok' ? 'Grok' : part))
      .join(' ');
  }
  return id;
}

function pushModel(models: GrokModelOption[], seen: Set<string>, id: string, name?: string): void {
  const value = id.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  models.push({ value, label: labelOf(value, name) });
}

/** Parse `grok models` / `grok models --json` output. */
export function parseGrokModels(raw: string): GrokModelOption[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const models: GrokModelOption[] = [];
  const seen = new Set<string>();

  const fromItem = (item: unknown) => {
    if (typeof item === 'string') {
      pushModel(models, seen, item);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const rec = item as Record<string, unknown>;
    const id = String(rec.id ?? rec.model_id ?? rec.modelId ?? rec.model ?? rec.value ?? rec.alias ?? '').trim();
    const name = String(rec.name ?? rec.display_name ?? rec.displayName ?? rec.title ?? '').trim();
    if (id) pushModel(models, seen, id, name || undefined);
  };

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (parsed) {
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.models)
          ? parsed.models
          : Array.isArray(parsed.data)
            ? parsed.data
            : Array.isArray(parsed.available_models)
              ? parsed.available_models
              : [];
      for (const item of list) fromItem(item);
      if (!Array.isArray(parsed) && parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
        for (const [alias, value] of Object.entries(parsed.models as Record<string, unknown>)) {
          const rec = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
          const id = String(rec.model ?? rec.id ?? alias).trim() || alias;
          const name = String(rec.name ?? rec.display_name ?? alias).trim();
          pushModel(models, seen, id, name);
        }
      }
    }
  }

  if (!models.length) {
    for (const line of trimmed.split('\n')) {
      const text = line.trim();
      if (!text || /^usage:|^available models|^-+$/i.test(text)) continue;
      const jsonish = text.match(/"id"\s*:\s*"([^"]+)"/);
      if (jsonish) {
        pushModel(models, seen, jsonish[1]!);
        continue;
      }
      const token = text.replace(/^[*•\-]\s*/, '').match(/^([A-Za-z0-9][A-Za-z0-9._+-]*)/);
      if (token && /^(grok|auto)/i.test(token[1]!)) pushModel(models, seen, token[1]!);
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

function execGrok(args: string[]): Promise<string> {
  const bin = config.grokExecutable;
  if (!bin) return Promise.reject(new Error('grok not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout.trim()) reject(error);
      else resolve(stdout || stderr);
    });
  });
}

function remoteInvocation(args: string[]): string {
  const invoke = `"$grok_bin" ${args.map(shQuote).join(' ')}`;
  return [
    'grok_fallback="$HOME/.local/bin/grok"',
    'if command -v grok >/dev/null 2>&1; then grok_bin="$(command -v grok)"; '
      + 'elif [ -x "$grok_fallback" ]; then grok_bin="$grok_fallback"; '
      + 'else echo "grok not found" >&2; exit 127; fi',
    invoke,
  ].join('\n');
}

async function fetchLocal(): Promise<GrokModelOption[] | null> {
  if (!config.grokExecutable) return null;
  try {
    const out = await execGrok(['--no-auto-update', 'models', '--json']);
    const models = parseGrokModels(out);
    if (models.length > 1) return models;
  } catch {
    /* older builds may lack --json */
  }
  const out = await execGrok(['--no-auto-update', 'models']);
  return parseGrokModels(out);
}

async function fetchRemote(hostName: string): Promise<GrokModelOption[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'grok'));
  const tryArgs = async (args: string[]): Promise<GrokModelOption[]> => {
    const res = await sshExec(
      host.ssh,
      proxyPrefix + loginShellCommand(remoteInvocation(args)),
      { timeoutMs: 25_000 },
    );
    return parseGrokModels(res.stdout);
  };
  let models = await tryArgs(['--no-auto-update', 'models', '--json']);
  if (models.length <= 1) models = await tryArgs(['--no-auto-update', 'models']);
  if (!models.length) {
    log.debug('remote grok models empty', host.name);
    return null;
  }
  return models;
}

export function invalidateGrokModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}

/** Models advertised by the local Grok CLI. Never blocks on the CLI. */
export async function listGrokModels(): Promise<GrokModelOption[]> {
  return cache.serve('', fetchLocal);
}

/** Models from a remote host's Grok CLI. Never blocks on SSH. */
export async function listRemoteGrokModels(hostName: string): Promise<GrokModelOption[]> {
  if (!hostRegistry.get(hostName)) return listGrokModels();
  return cache.serve(hostName, () => fetchRemote(hostName));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchGrokModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
}
