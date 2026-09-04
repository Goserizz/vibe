import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry } from '../remote/hosts.js';
import { loginShellCommand, sshExec } from '../remote/ssh.js';
import {
  cleanCodebuddyProbeOutput,
  codebuddyLoginEvidence,
  probeCodebuddyTurn,
  type CodebuddyLoginEvidence,
} from './codebuddyProbe.js';

/**
 * CodeBuddy sign-in state + credential management (the "login" feature).
 *
 * CodeBuddy's only interactive login is `/login` inside its TUI, which cannot
 * be driven headless. The CLI does, however, accept CODEBUDDY_API_KEY /
 * CODEBUDDY_AUTH_TOKEN environment variables — so Vibe's login is credential
 * injection: the user pastes an API key or token in the web UI, Vibe verifies
 * it with a one-line probe turn, then persists it to ~/.codebuddy/vibe-auth.env
 * (0600) and injects it into every turn it launches (see codebuddy/auth.ts).
 * A TUI login on the machine works too — Vibe detects it from the CLI's
 * local_storage and reports "signed in" without touching it.
 */

export class CodebuddyAuthError extends Error {}

/** Remote path of the credential file (`~` expands in the login shell). */
const REMOTE_AUTH_PATH = '~/.codebuddy/vibe-auth.env';

// ---- signed-in state --------------------------------------------------------

interface AccountValue {
  loggedIn: boolean;
  account?: string;
}
interface AccountCacheEntry {
  at: number;
  value: AccountValue;
}

const ACCOUNT_TTL_MS = 30_000;
const accountCache = new Map<string, AccountCacheEntry>();

/** Build the signed-in state from local evidence + a live probe. */
async function computeAccount(evidence: CodebuddyLoginEvidence): Promise<AccountValue> {
  // 1. Vibe-managed credentials (trusted — they were probe-verified at save time).
  if (evidence.credentialAccount) return { loggedIn: true, account: evidence.credentialAccount };
  // 2. A TUI login in the CLI's own storage.
  if (evidence.storageAccount) return { loggedIn: true, account: evidence.storageAccount };
  // 3. Nothing on disk — a live one-turn probe decides (and proves the key the
  //    CLI would actually use works end-to-end).
  const probe = await probeCodebuddyTurn(evidence.host, evidence.env);
  return probe.ok ? { loggedIn: true, account: probe.account } : { loggedIn: false };
}

/**
 * Whether CodeBuddy on a host is signed in, and as whom. Cheap results are
 * memoized briefly so opening the Hosts panel doesn't spawn probes repeatedly.
 */
export async function codebuddyAccount(hostName: string): Promise<AccountValue> {
  const host = hostName.trim();
  const hit = accountCache.get(host);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.value;

  const evidence = await codebuddyLoginEvidence(host);
  const value = await computeAccount(evidence);
  accountCache.set(host, { at: Date.now(), value });
  return value;
}

/** Drop the memoized state (after saving/clearing credentials). */
export function invalidateCodebuddyAccount(hostName = ''): void {
  accountCache.delete(hostName.trim());
}

// ---- credential save / clear -------------------------------------------------

/** Serialize credentials to env-file lines (KEY=VALUE, comments allowed). */
function serialize(creds: { apiKey?: string; authToken?: string }): string {
  const lines = ['# Managed by Vibe — injected into every CodeBuddy turn.'];
  if (creds.apiKey) lines.push(`CODEBUDDY_API_KEY=${creds.apiKey}`);
  if (creds.authToken) lines.push(`CODEBUDDY_AUTH_TOKEN=${creds.authToken}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Validate and persist pasted credentials on this machine (or a remote host):
 * probe with the env override first, then write ~/.codebuddy/vibe-auth.env
 * (0600). Existing credentials are replaced.
 */
export async function saveCodebuddyCredentials(
  hostName: string,
  creds: { apiKey?: string; authToken?: string },
): Promise<void> {
  const host = hostName.trim();
  if (!creds.apiKey && !creds.authToken) {
    throw new CodebuddyAuthError('provide an API key or an auth token');
  }
  const env: Record<string, string> = {};
  if (creds.apiKey) env.CODEBUDDY_API_KEY = creds.apiKey;
  if (creds.authToken) env.CODEBUDDY_AUTH_TOKEN = creds.authToken;
  const probe = await probeCodebuddyTurn(host, env);
  if (!probe.ok) {
    throw new CodebuddyAuthError(
      probe.error
        ? `credentials rejected by CodeBuddy: ${probe.error}`
        : 'credentials rejected by CodeBuddy (probe failed)',
    );
  }

  const content = serialize(creds);
  if (!host) {
    fs.mkdirSync(path.dirname(config.codebuddyAuthEnvFile), { recursive: true });
    fs.writeFileSync(config.codebuddyAuthEnvFile, content, { mode: 0o600 });
    try { fs.chmodSync(config.codebuddyAuthEnvFile, 0o600); } catch { /* best effort */ }
  } else {
    const hostRec = hostRegistry.get(host);
    if (!hostRec) throw new CodebuddyAuthError(`unknown host "${host}"`);
    await sshExec(hostRec.ssh, loginShellCommand('mkdir -p ~/.codebuddy && chmod 700 ~/.codebuddy'), { timeoutMs: 15_000 });
    const wrote = await sshExec(
      hostRec.ssh,
      loginShellCommand(`cat > ${REMOTE_AUTH_PATH} && chmod 600 ${REMOTE_AUTH_PATH}`),
      { input: content, timeoutMs: 15_000 },
    );
    if (wrote.code !== 0) {
      throw new CodebuddyAuthError(cleanCodebuddyProbeOutput(wrote.stderr) || 'failed to write remote credentials');
    }
  }
  invalidateCodebuddyAccount(host);
  log.info(`codebuddy credentials saved${host ? ` on ${host}` : ' locally'}`);
}

/**
 * Remove the stored credentials (logout). Returns true when a credential file
 * existed. A TUI login, if any, is left untouched — use the CLI's `/logout`.
 */
export async function clearCodebuddyCredentials(hostName: string): Promise<boolean> {
  const host = hostName.trim();
  if (!host) {
    const existed = fs.existsSync(config.codebuddyAuthEnvFile);
    try { fs.rmSync(config.codebuddyAuthEnvFile, { force: true }); } catch { /* ignore */ }
    invalidateCodebuddyAccount(host);
    return existed;
  }
  const hostRec = hostRegistry.get(host);
  if (!hostRec) throw new CodebuddyAuthError(`unknown host "${host}"`);
  const res = await sshExec(
    hostRec.ssh,
    loginShellCommand(`if [ -f ${REMOTE_AUTH_PATH} ]; then rm -f ${REMOTE_AUTH_PATH}; echo EXISTED; else echo ABSENT; fi`),
    { timeoutMs: 15_000 },
  );
  invalidateCodebuddyAccount(host);
  return res.stdout.includes('EXISTED');
}
