import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, sshExec } from '../remote/ssh.js';
import { createSwrCache } from '../util/swrCache.js';
import type { EffortLevel, PermissionMode } from '../../../shared/protocol.js';

export interface CodebuddyModel {
  value: string;
  label: string;
}

export interface CodebuddyPermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

/** Permission modes CodeBuddy exposes (`--permission-mode`; verified against
 *  `codebuddy --help` on 2.141.0 — all four Vibe modes map 1:1, and `default`
 *  still routes tool approvals through the stream-json control protocol). */
export const CODEBUDDY_PERMISSIONS: CodebuddyPermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Approve risky tools before they run' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Auto-accept file edits' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Skip permission prompts (careful)' },
];

/** Static fallback used when the CLI can't be probed. `auto` lets CodeBuddy
 *  pick per its own config; the ids below are the 2.141.0 catalog. */
const FALLBACK: CodebuddyModel[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'hy4-preview', label: 'HY4 Preview' },
  { value: 'hy3', label: 'HY3' },
  { value: 'glm-5.3', label: 'GLM-5.3' },
  { value: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'glm-5.1', label: 'GLM-5.1' },
  { value: 'glm-5v-turbo', label: 'GLM-5V Turbo' },
  { value: 'minimax-m3-pay', label: 'MiniMax M3' },
  { value: 'kimi-k3-2', label: 'Kimi K3.2' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

/** CodeBuddy's `--effort` ladder (verified on 2.141.0): minimal, low, medium,
 *  high, xhigh, max. Vibe's `ultra` (Codex-only) and the ZCode switches have no
 *  counterpart and are omitted. */
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Map a Vibe effort to the CLI `--effort` value; undefined = don't pass it. */
export function codebuddyEffortArg(effort: EffortLevel): string | undefined {
  if (EFFORTS.includes(effort)) return effort;
  if (effort === 'ultra') return 'max';
  return undefined;
}

/** Effort levels the UI should offer for CodeBuddy (the shared ladder minus
 *  `ultra`, which the CLI does not accept). */
export const CODEBUDDY_EFFORTS: EffortLevel[] = EFFORTS;

/**
 * Parse the model ids out of `codebuddy --help`'s `--model` line. The help text
 * embeds the CLI's current catalog — e.g. "Currently supported: (hy4-preview,
 * hy3, glm-5.3, …)" — so one cheap local run (or `--help` over SSH for a remote
 * host) keeps the picker in sync with the installed build.
 */
export function parseCodebuddyModels(help: string): CodebuddyModel[] {
  const m = help.match(/--model <model>.*?Currently supported:\s*\(([^)]*)\)/s);
  if (!m) return [];
  const label = (id: string): string => {
    const cleaned = id.replace(/-pay$/, '').split('-').map((p) => p.toUpperCase()).join(' ');
    return cleaned.charAt(0) + cleaned.slice(1).toLowerCase();
  };
  const models: CodebuddyModel[] = [{ value: 'auto', label: 'Auto' }];
  for (const raw of m[1].split(',')) {
    const value = raw.trim();
    if (!value || value === 'auto') continue;
    if (!models.some((x) => x.value === value)) models.push({ value, label: label(value) });
  }
  return models;
}

const TTL_MS = 5 * 60_000;
/** Cache key '' = local; otherwise the remote host name. */
const cache = createSwrCache<CodebuddyModel[]>({
  ttlMs: TTL_MS,
  fallback: FALLBACK,
  // Only `auto` ⇒ miss (CLI missing or help text changed shape).
  isEmpty: (m) => m.length <= 1,
  onError: (key, err) => log.debug('codebuddy models refresh failed', key || 'local', err),
});

function helpLocal(): Promise<CodebuddyModel[] | null> {
  const exe = config.codebuddyExecutable;
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(exe, ['--help'], { timeout: 15_000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        resolve(null);
        return;
      }
      const models = parseCodebuddyModels(`${stdout}`);
      resolve(models.length > 1 ? models : null);
    });
  });
}

async function helpRemote(hostName: string): Promise<CodebuddyModel[] | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return helpLocal();
  const inner = 'codebuddy --help 2>/dev/null';
  const remoteCmd = proxyEnvPrefix(proxyForAgent(host, 'codebuddy')) + loginShellCommand(inner);
  const res = await sshExec(host.ssh, remoteCmd, { timeoutMs: 20_000 });
  const models = parseCodebuddyModels(res.stdout);
  return models.length > 1 ? models : null;
}

/** Models the installed CodeBuddy CLI advertises. Never blocks. */
export function listCodebuddyModels(): CodebuddyModel[] {
  return cache.serve('', helpLocal);
}

/** Models as advertised by the CLI on a remote host. Never blocks on SSH. */
export async function listRemoteCodebuddyModels(hostName: string): Promise<CodebuddyModel[]> {
  if (!hostRegistry.get(hostName)) return listCodebuddyModels();
  return cache.serve(hostName, () => helpRemote(hostName));
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchCodebuddyModels(hostNames: string[] = []): void {
  cache.refresh('', helpLocal);
  for (const name of hostNames) cache.refresh(name, () => helpRemote(name));
}

/** Drop a host's (or local '') freshness — e.g. after an install/update. */
export function invalidateCodebuddyModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}
