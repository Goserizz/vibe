import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';

export interface KimiModelOption {
  value: string;
  label: string;
}

export interface KimiPermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

export interface KimiCapabilities {
  models: KimiModelOption[];
  permissions: KimiPermissionOption[];
  /** True when this CLI advertises the ACP transport required for selectable modes. */
  acp: boolean;
}

const AUTO_MODEL: KimiModelOption = { value: 'auto', label: 'Auto' };
const PROMPT_PERMISSION: KimiPermissionOption = {
  value: 'default',
  label: 'Auto',
  hint: 'Kimi prompt mode auto-runs allowed tools',
};

const TTL_MS = 5 * 60_000;
const caches = new Map<string, { at: number; capabilities: KimiCapabilities }>();

function fallback(): KimiCapabilities {
  return { models: [AUTO_MODEL], permissions: [PROMPT_PERMISSION], acp: false };
}

/** Parse the credential-bearing `provider list --json` document without ever
 * returning/logging its provider table. Only configured model aliases escape. */
export function parseKimiModels(raw: string): KimiModelOption[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const table = parsed?.models;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return [];

  const models: KimiModelOption[] = [AUTO_MODEL];
  const seen = new Set<string>(['auto']);
  for (const [alias, value] of Object.entries(table)) {
    const model = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const id = alias.trim();
    if (!id || seen.has(id)) continue;
    const display =
      (typeof model.displayName === 'string' && model.displayName.trim()) ||
      (typeof model.display_name === 'string' && model.display_name.trim()) ||
      id;
    seen.add(id);
    models.push({ value: id, label: display });
  }
  return models;
}

/** Discover mode support from the installed CLI's own help. ACP is required:
 * `--prompt` hard-wires auto policy and rejects --plan/--auto/--yolo. */
export function parseKimiPermissions(help: string): { permissions: KimiPermissionOption[]; acp: boolean } {
  const acp = /^\s*acp(?:\s|$)/m.test(help);
  if (!acp) return { permissions: [PROMPT_PERMISSION], acp: false };

  const permissions: KimiPermissionOption[] = [
    { value: 'default', label: 'Default', hint: 'Manual approvals; tools execute normally' },
  ];
  if (/--plan(?:\s|,|$)/m.test(help)) {
    permissions.push({ value: 'plan', label: 'Plan', hint: 'Read-only planning; no tool execution' });
  }
  if (/--auto(?:\s|,|$)/m.test(help)) {
    permissions.push({ value: 'acceptEdits', label: 'Auto', hint: 'Auto-approve safe operations' });
  }
  if (/(?:--yolo|-y,\s*--yolo)(?:\s|,|$)/m.test(help)) {
    permissions.push({ value: 'bypassPermissions', label: 'YOLO', hint: 'Auto-approve everything (careful)' });
  }
  return { permissions, acp: true };
}

function execKimi(args: string[]): Promise<string> {
  const bin = config.kimiExecutable;
  if (!bin) return Promise.reject(new Error('kimi not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function remoteInvocation(args: string[]): string {
  const invoke = `"$kimi_bin" ${args.map(shQuote).join(' ')}`;
  return [
    'kimi_fallback="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin/kimi"',
    'if command -v kimi >/dev/null 2>&1; then kimi_bin="$(command -v kimi)"; '
      + 'elif [ -x "$kimi_fallback" ]; then kimi_bin="$kimi_fallback"; '
      + 'else echo "kimi not found" >&2; exit 127; fi',
    invoke,
  ].join('\n');
}

function mergeDiscovery(modelsRaw: string, help: string, previous?: KimiCapabilities): KimiCapabilities {
  const models = parseKimiModels(modelsRaw);
  const modeDiscovery = parseKimiPermissions(help);
  return {
    models: models.length ? models : previous?.models ?? [AUTO_MODEL],
    permissions: help ? modeDiscovery.permissions : previous?.permissions ?? [PROMPT_PERMISSION],
    acp: help ? modeDiscovery.acp : previous?.acp ?? false,
  };
}

/** Drop a host's (or local '') cached capabilities after upgrades/config changes. */
export function invalidateKimiCapabilitiesCache(hostName?: string): void {
  caches.delete(hostName ?? '');
}

/** Models and permission modes advertised by the local Kimi installation. */
export async function discoverKimiCapabilities(): Promise<KimiCapabilities> {
  const key = '';
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.capabilities;
  if (!config.kimiExecutable) return hit?.capabilities ?? fallback();

  const [modelsResult, helpResult] = await Promise.allSettled([
    execKimi(['provider', 'list', '--json']),
    execKimi(['--help']),
  ]);
  const capabilities = mergeDiscovery(
    modelsResult.status === 'fulfilled' ? modelsResult.value : '',
    helpResult.status === 'fulfilled' ? helpResult.value : '',
    hit?.capabilities,
  );
  if (modelsResult.status === 'rejected') log.debug('kimi model discovery failed', modelsResult.reason);
  if (helpResult.status === 'rejected') log.debug('kimi permission discovery failed', helpResult.reason);
  caches.set(key, { at: Date.now(), capabilities });
  return capabilities;
}

/** Discover capabilities from the Kimi installation on an SSH host. */
export async function discoverRemoteKimiCapabilities(hostName: string): Promise<KimiCapabilities> {
  const host = hostRegistry.get(hostName);
  if (!host) return discoverKimiCapabilities();
  const key = host.name;
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.capabilities;

  // Route discovery through Kimi's per-agent proxy (if set) — the same egress a
  // Kimi turn uses, so configured aliases match what a turn can actually reach.
  const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'kimi'));
  const [modelsResult, helpResult] = await Promise.allSettled([
    sshExec(host.ssh, proxyPrefix + loginShellCommand(remoteInvocation(['provider', 'list', '--json'])), { timeoutMs: 20_000 }),
    sshExec(host.ssh, proxyPrefix + loginShellCommand(remoteInvocation(['--help'])), { timeoutMs: 20_000 }),
  ]);
  const modelsRaw = modelsResult.status === 'fulfilled' && modelsResult.value.code === 0 ? modelsResult.value.stdout : '';
  const help = helpResult.status === 'fulfilled' && helpResult.value.code === 0 ? helpResult.value.stdout : '';
  const capabilities = mergeDiscovery(modelsRaw, help, hit?.capabilities);

  if (!modelsRaw) {
    const detail = modelsResult.status === 'fulfilled' ? cleanRemoteStderr(modelsResult.value.stderr) : String(modelsResult.reason);
    log.debug('remote kimi model discovery failed', host.name, detail.slice(0, 200));
  }
  if (!help) {
    const detail = helpResult.status === 'fulfilled' ? cleanRemoteStderr(helpResult.value.stderr) : String(helpResult.reason);
    log.debug('remote kimi permission discovery failed', host.name, detail.slice(0, 200));
  }
  caches.set(key, { at: Date.now(), capabilities });
  return capabilities;
}
