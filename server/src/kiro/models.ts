import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import { createSwrCache } from '../util/swrCache.js';

export interface KiroModelOption {
  value: string;
  label: string;
}

export interface KiroPermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

const AUTO_MODEL: KiroModelOption = { value: 'auto', label: 'Auto' };

/** Permission modes Kiro ACP exposes via spawn flags + session/set_mode. */
export const KIRO_PERMISSIONS: KiroPermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before tool use' },
  { value: 'plan', label: 'Plan', hint: 'Kiro planner agent' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Trust filesystem read/write tools' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Trust all tools (careful)' },
];

const FALLBACK: KiroModelOption[] = [AUTO_MODEL];

const TTL_MS = 5 * 60_000;
const cache = createSwrCache<KiroModelOption[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  isEmpty: (m) => m.length === 0,
  onError: (key, err) => log.debug('kiro models refresh failed', key || 'local', err),
});

/** Parse `kiro-cli chat --list-models --format json`. */
export function parseKiroModels(raw: string): KiroModelOption[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.models) ? parsed.models : [];
  const models: KiroModelOption[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = String(item?.model_id ?? item?.modelId ?? item?.model_name ?? '').trim();
    if (!id || seen.has(id)) continue;
    const name = String(item?.model_name ?? item?.name ?? id).trim() || id;
    seen.add(id);
    models.push({ value: id, label: name });
  }
  // Ensure Auto is always first when present (or inject it).
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

function execKiro(args: string[]): Promise<string> {
  const bin = config.kiroExecutable;
  if (!bin) return Promise.reject(new Error('kiro-cli not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function remoteInvocation(args: string[]): string {
  const invoke = `"$kiro_bin" ${args.map(shQuote).join(' ')}`;
  return [
    'kiro_fallback="$HOME/.local/bin/kiro-cli"',
    'if command -v kiro-cli >/dev/null 2>&1; then kiro_bin="$(command -v kiro-cli)"; '
      + 'elif [ -x "$kiro_fallback" ]; then kiro_bin="$kiro_fallback"; '
      + 'else echo "kiro-cli not found" >&2; exit 127; fi',
    invoke,
  ].join('\n');
}

async function fetchLocal(): Promise<KiroModelOption[] | null> {
  if (!config.kiroExecutable) return null;
  const out = await execKiro(['chat', '--list-models', '--format', 'json']);
  return parseKiroModels(out);
}

async function fetchRemote(hostName: string): Promise<KiroModelOption[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'kiro'));
  const res = await sshExec(
    host.ssh,
    proxyPrefix + loginShellCommand(remoteInvocation(['chat', '--list-models', '--format', 'json'])),
    { timeoutMs: 25_000 },
  );
  const models = parseKiroModels(res.stdout);
  if (!models.length) {
    log.debug('remote kiro models empty', host.name, cleanRemoteStderr(res.stderr).slice(0, 200));
    return null;
  }
  return models;
}

export function invalidateKiroModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}

/** Models advertised by the local Kiro CLI. Never blocks on the CLI. */
export async function listKiroModels(): Promise<KiroModelOption[]> {
  return cache.serve('', fetchLocal);
}

/** Models from a remote host's Kiro CLI. Never blocks on SSH. */
export async function listRemoteKiroModels(hostName: string): Promise<KiroModelOption[]> {
  if (!hostRegistry.get(hostName)) return listKiroModels();
  return cache.serve(hostName, () => fetchRemote(hostName));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchKiroModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
}
