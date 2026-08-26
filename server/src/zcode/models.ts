import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import { createSwrCache } from '../util/swrCache.js';

export interface ZcodeModelOption {
  value: string;
  label: string;
  /** ZCode thought levels this model advertises (from the live catalog probe);
   *  drives the effort picker per-model, like Codex's `efforts`. */
  efforts?: string[];
  /** The model's default thought level. */
  defaultEffort?: string;
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

/** Models configured in the local ~/.zcode/cli/config.json. Never blocks. */
export function listZcodeModels(): ZcodeModelOption[] {
  return attachCatalog(cache.serve('', fetchLocal));
}

/** Models configured on a remote host's ZCode. Never blocks on SSH. */
export function listRemoteZcodeModels(hostName: string): ZcodeModelOption[] {
  if (!hostRegistry.get(hostName)) return listZcodeModels();
  return attachCatalog(cache.serve(hostName, () => fetchRemote(hostName)));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchZcodeModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
  catalogCache.refresh('', fetchCatalog);
}

export function invalidateZcodeModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
  // The catalog changes only with the zcode version; an install/update is
  // exactly when it should be re-probed.
  catalogCache.invalidate('');
}

// ---------------------------------------------------------------------------
// Thought-level catalog
// ---------------------------------------------------------------------------

/** Per-model thought levels keyed by `providerID/modelID`. */
type ZcodeCatalog = Record<string, { efforts: string[]; defaultEffort?: string }>;

const catalogCache = createSwrCache<ZcodeCatalog>({
  ttlMs: 10 * 60_000,
  fallback: {},
  isEmpty: (c) => Object.keys(c).length === 0,
  onError: (key, err) => log.debug('zcode catalog probe failed', key || 'local', err),
});

/**
 * Probe the live model catalog: one short-lived app-server, session/create in a
 * throwaway workspace, read `settings.model.available[].reasoning` (probed on
 * 0.16.3: every model carries `levels: [{value,label}]` + `defaultLevel`, e.g.
 * GLM-5.3 low|high|max, GLM-5.2 max|high|nothink, GLM-5-Turbo enabled|disabled).
 */
async function fetchCatalog(): Promise<ZcodeCatalog | null> {
  if (!config.zcodeExecutable) return null;
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'vibe-zcode-catalog-'));
  let sessionId = '';
  try {
    const { withZcodeAppServer } = await import('./appServer.js');
    return await withZcodeAppServer<ZcodeCatalog | null>({ cwd: dir, timeoutMs: 30_000 }, async (request) => {
      const created = await request('session/create', {
        workspace: { workspaceKey: dir, workspacePath: dir },
      });
      sessionId = typeof created?.session?.sessionId === 'string' ? created.session.sessionId : '';
      const available: unknown[] = Array.isArray(created?.settings?.model?.available)
        ? created.settings.model.available
        : [];
      const catalog: ZcodeCatalog = {};
      for (const entry of available) {
        const ref = (entry as { ref?: { providerId?: unknown; modelId?: unknown } })?.ref;
        const providerId = typeof ref?.providerId === 'string' ? ref.providerId : '';
        const modelId = typeof ref?.modelId === 'string' ? ref.modelId : '';
        if (!providerId || !modelId) continue;
        const reasoning = (entry as { reasoning?: { enabled?: unknown; levels?: unknown; defaultLevel?: unknown } })
          ?.reasoning;
        if (!reasoning || reasoning.enabled !== true) continue;
        const levels: string[] = (Array.isArray(reasoning.levels) ? reasoning.levels : [])
          .map((l) => (typeof (l as { value?: unknown })?.value === 'string' ? (l as { value: string }).value : ''))
          .filter(Boolean);
        if (!levels.length) continue;
        catalog[`${providerId}/${modelId}`] = {
          efforts: levels,
          defaultEffort: typeof reasoning.defaultLevel === 'string' ? reasoning.defaultLevel : undefined,
        };
      }
      return Object.keys(catalog).length ? catalog : null;
    });
  } catch (error) {
    log.debug('zcode catalog probe error', error);
    return null;
  } finally {
    // The probe session lands in ZCode's SQLite session list otherwise.
    if (sessionId) {
      void import('./appServer.js').then(({ withZcodeAppServer }) =>
        withZcodeAppServer({ timeoutMs: 10_000 }, (request) =>
          request('session/close', { sessionId }).catch(() => undefined),
        ).catch(() => undefined),
      );
    }
    fs.rm(dir, { recursive: true, force: true }, () => undefined);
  }
}

/**
 * Attach thought levels to a config-derived model list. Remote hosts share the
 * local catalog: the push-install fleet keeps zcode versions in lockstep, and
 * the ladder is part of the CLI's built-in catalog, not the host config.
 */
function attachCatalog(models: ZcodeModelOption[]): ZcodeModelOption[] {
  const catalog = catalogCache.serve('', fetchCatalog);
  if (!Object.keys(catalog).length) return models;
  return models.map((m) => {
    const hit = catalog[m.value];
    return hit ? { ...m, efforts: hit.efforts, defaultEffort: hit.defaultEffort } : m;
  });
}
