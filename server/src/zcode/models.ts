import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import { createSwrCache } from '../util/swrCache.js';

export interface ZcodeModelOption {
  value: string;
  label: string;
}

export interface ZcodePermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

const AUTO_MODEL: ZcodeModelOption = { value: 'auto', label: 'Auto' };

/** Permission modes ZCode exposes (session/setMode build|edit|plan|yolo). */
export const ZCODE_PERMISSIONS: ZcodePermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Approve risky tools before they run' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'acceptEdits', label: 'Edit', hint: 'Auto-approve edits and safe tools' },
  { value: 'bypassPermissions', label: 'Yolo', hint: 'Auto-approve tool calls (careful)' },
];

const FALLBACK: ZcodeModelOption[] = [
  AUTO_MODEL,
  { value: 'bigmodel/GLM-5.3', label: 'GLM-5.3' },
  { value: 'bigmodel/GLM-5.2', label: 'GLM-5.2' },
  { value: 'bigmodel/GLM-5-Turbo', label: 'GLM-5-Turbo' },
];

/** Shape of ~/.zcode/cli/config.json (only the parts Vibe reads). */
export interface ZcodeCliConfig {
  provider?: Record<
    string,
    {
      kind?: string;
      name?: string;
      options?: { baseURL?: string; apiKey?: string; apiKeyRequired?: boolean };
      models?: Record<string, { name?: string } | undefined>;
    }
  >;
  model?: { main?: string; lite?: string };
}

/** Read the local ~/.zcode/cli/config.json (null when missing or unparsable). */
export function readZcodeConfigSync(): ZcodeCliConfig | null {
  try {
    return JSON.parse(fs.readFileSync(config.zcodeConfigFile, 'utf8')) as ZcodeCliConfig;
  } catch {
    return null;
  }
}

const TTL_MS = 5 * 60_000;
const cache = createSwrCache<ZcodeModelOption[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  isEmpty: (m) => m.length === 0,
  onError: (key, err) => log.debug('zcode models refresh failed', key || 'local', err),
});

/**
 * Parse a ZCode config.json into model options. Values are `providerID/modelID`
 * (the format `model.main` uses and `session/setModel` expects after splitting).
 */
export function parseZcodeModels(raw: string): ZcodeModelOption[] {
  let cfg: ZcodeCliConfig;
  try {
    cfg = JSON.parse(raw) as ZcodeCliConfig;
  } catch {
    return [];
  }
  const models: ZcodeModelOption[] = [];
  const seen = new Set<string>();
  for (const [providerId, provider] of Object.entries(cfg.provider ?? {})) {
    for (const [modelId, def] of Object.entries(provider?.models ?? {})) {
      const value = `${providerId}/${modelId}`;
      if (seen.has(value)) continue;
      seen.add(value);
      const label = def?.name?.trim() || modelId;
      models.push({ value, label });
    }
  }
  const main = cfg.model?.main?.trim();
  if (main && seen.has(main)) {
    const idx = models.findIndex((m) => m.value === main);
    if (idx > 0) {
      const [entry] = models.splice(idx, 1);
      models.unshift(entry!);
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

async function fetchLocal(): Promise<ZcodeModelOption[] | null> {
  if (!config.zcodeExecutable) return null;
  try {
    const raw = fs.readFileSync(config.zcodeConfigFile, 'utf8');
    const models = parseZcodeModels(raw);
    if (models.length > 1) return models;
  } catch {
    /* config missing — fall through to fallback */
  }
  return null;
}

async function fetchRemote(hostName: string): Promise<ZcodeModelOption[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'zcode'));
  const cmd = proxyPrefix + loginShellCommand('cat "${ZCODE_HOME:-$HOME/.zcode}/cli/config.json" 2>/dev/null');
  const res = await sshExec(host.ssh, cmd, { timeoutMs: 15_000 });
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const models = parseZcodeModels(res.stdout);
  return models.length > 1 ? models : null;
}

export function invalidateZcodeModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}

/** Models configured in the local ~/.zcode/cli/config.json. Never blocks. */
export function listZcodeModels(): ZcodeModelOption[] {
  return cache.serve('', fetchLocal);
}

/** Models configured on a remote host's ZCode. Never blocks on SSH. */
export function listRemoteZcodeModels(hostName: string): Promise<ZcodeModelOption[]> {
  if (!hostRegistry.get(hostName)) return Promise.resolve(listZcodeModels());
  return Promise.resolve(cache.serve(hostName, () => fetchRemote(hostName)));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchZcodeModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
}
