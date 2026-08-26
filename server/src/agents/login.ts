import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { resolveCodexExecutable } from '../codex/resolve.js';
import { resolveCursorExecutable } from '../cursor/resolve.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import {
  sshExec,
  sshStreamArgv,
  loginShellCommand,
  streamRemoteCommand,
  proxyEnvPrefix,
  cleanRemoteStderr,
} from '../remote/ssh.js';
import type { AgentLoginAccount, AgentLoginStatus, LoginAgent } from '../../../shared/protocol.js';

/**
 * Link-based sign-in for the Cursor and Codex CLIs, on the local machine or any
 * configured remote host.
 *
 * Both CLIs can authenticate without a local browser: Cursor's
 * `cursor-agent login` (with NO_OPEN_BROWSER=1) prints a challenge link the
 * user opens anywhere, and Codex's `codex login --device-auth` prints a device
 * link plus a one-time code. In both cases the CLI then polls its server until
 * the user finishes in the browser and exits 0 on success — so Vibe spawns the
 * CLI, scrapes the link out of its output, shows it in the web UI, and lets the
 * exit code decide success. No PTY needed: both print the link over pipes.
 */

/** Codex device codes expire after 15 minutes; stop waiting shortly after. */
const FLOW_TIMEOUT_MS = 16 * 60_000;
/** How much stripped CLI output to keep for scanning / display. */
const OUTPUT_TAIL = 4_000;

export class AgentLoginError extends Error {}

/** ANSI escapes (colors, cursor moves) + OSC sequences, so link scraping and
 *  the debug tail see clean text. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_][0-9;?]*[@-~]/g, '');
}

const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g;
/** Codex device code shape, e.g. `Z1LP-I8HMI`. */
const DEVICE_CODE_RE = /\b([A-Z0-9]{3,10}-[A-Z0-9]{3,10})\b/;

interface ScanResult {
  url?: string;
  code?: string;
}

/** Pull the login link (and Codex's one-time code) out of accumulated CLI
 *  output. The URL appears on its own in both CLIs' output; the code sits on
 *  the line after a "one-time code" mention. */
function scanOutput(text: string): ScanResult {
  const out: ScanResult = {};
  const url = text.match(URL_RE);
  if (url) out.url = url[0];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/one-time code|enter (?:this|the) code/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const m = lines[j].match(DEVICE_CODE_RE);
      if (m) {
        out.code = m[1];
        return out;
      }
    }
  }
  return out;
}

interface ActiveFlow {
  status: AgentLoginStatus;
  child: ChildProcess;
  /** Strip-ANSI'd output, trimmed to the last OUTPUT_TAIL chars. */
  output: string;
  timer: NodeJS.Timeout;
  settled: boolean;
}

class AgentLoginManager {
  private flows = new Map<string, ActiveFlow>();

  /** Live status of a flow, or null when none is running (or has finished). */
  status(agent: LoginAgent, host: string): AgentLoginStatus | null {
    return this.flows.get(`${agent}@${host}`)?.status ?? null;
  }

  /** Abort a running flow. Killing the local ssh client also tears down the
   *  remote command (SIGHUP). */
  cancel(agent: LoginAgent, host: string): void {
    const key = `${agent}@${host}`;
    const flow = this.flows.get(key);
    if (!flow) return;
    this.flows.delete(key);
    clearTimeout(flow.timer);
    if (!flow.settled) {
      flow.status.phase = 'cancelled';
      this.kill(flow);
    }
  }

  /** Spawn the CLI's login command and return its initial (starting) status.
   *  Replaces any flow already running for the same agent + host. */
  start(agent: LoginAgent, hostName: string): AgentLoginStatus {
    const host = hostName.trim();
    const key = `${agent}@${host}`;
    this.cancel(agent, host);

    let bin: string;
    let args: string[];
    if (!host) {
      const exe = agent === 'cursor' ? resolveCursorExecutable() : resolveCodexExecutable();
      if (!exe) {
        throw new AgentLoginError(
          agent === 'cursor'
            ? 'cursor-agent CLI not found — install it first (https://cursor.com/downloads)'
            : 'codex CLI not found — install it first (https://developers.openai.com/codex/cli)',
        );
      }
      bin = exe;
      args = agent === 'cursor' ? ['login'] : ['login', '--device-auth'];
    } else {
      const hostRec = hostRegistry.get(host);
      if (!hostRec) throw new AgentLoginError(`unknown host "${host}"`);
      const inner = agent === 'cursor' ? 'cursor-agent login' : 'codex login --device-auth';
      // Env prefix (browser suppression + per-host proxy) sits before the login
      // shell so it reaches the CLI regardless of how stdbuf wraps it.
      const remoteCmd =
        `NO_OPEN_BROWSER=1 ` +
        proxyEnvPrefix(proxyForAgent(hostRec, agent)) +
        loginShellCommand(streamRemoteCommand(inner));
      const argv = sshStreamArgv(hostRec.ssh, remoteCmd);
      bin = argv.bin;
      args = argv.args;
    }

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_OPEN_BROWSER: '1' },
    });

    const flow: ActiveFlow = {
      status: { agent, host, phase: 'starting' },
      child,
      output: '',
      settled: false,
      timer: setTimeout(() => {
        flow.status.phase = 'error';
        flow.status.error = 'login timed out — start again';
        this.finish(flow);
      }, FLOW_TIMEOUT_MS),
    };
    this.flows.set(key, flow);

    const onChunk = (d: Buffer): void => {
      if (flow.settled) return;
      flow.output = (flow.output + stripAnsi(d.toString('utf8'))).slice(-OUTPUT_TAIL);
      const found = scanOutput(flow.output);
      if (found.url && flow.status.phase === 'starting') {
        flow.status.phase = 'link';
        flow.status.url = found.url;
      }
      if (found.code && !flow.status.code) flow.status.code = found.code;
      flow.status.output = flow.output.slice(-2_000).trim() || undefined;
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      if (flow.settled) return;
      flow.status.phase = 'error';
      flow.status.error = `failed to run ${bin}: ${err.message}`;
      this.finish(flow);
    });
    child.on('close', (code) => {
      if (flow.settled) return;
      if (code === 0) {
        flow.status.phase = 'success';
        invalidateAgentLoginAccount(agent, host);
      } else {
        flow.status.phase = 'error';
        flow.status.error =
          cleanRemoteStderr(flow.output).split('\n').filter(Boolean).slice(-3).join('\n') ||
          `login exited with code ${code}`;
      }
      this.finish(flow);
    });
    return flow.status;
  }

  private finish(flow: ActiveFlow): void {
    flow.settled = true;
    clearTimeout(flow.timer);
    // The finished flow stays in the map so pollers can see success/error;
    // the next start() (or cancel()) drops it.
    log.debug('agent login finished', flow.status.agent, flow.status.host || 'local', flow.status.phase);
  }

  private kill(flow: ActiveFlow): void {
    flow.settled = true;
    try {
      flow.child.kill('SIGTERM');
      setTimeout(() => flow.child.kill('SIGKILL'), 2_000).unref?.();
    } catch {
      /* already gone */
    }
  }
}

export const agentLoginManager = new AgentLoginManager();

// ---- signed-in state --------------------------------------------------------

interface AccountCacheEntry {
  at: number;
  value: AgentLoginAccount;
}

const ACCOUNT_TTL_MS = 10_000;
const accountCache = new Map<string, AccountCacheEntry>();

function parseCodexStatus(raw: string): AgentLoginAccount {
  const text = stripAnsi(raw);
  if (/not logged in|working offline/i.test(text)) return { loggedIn: false };
  const email = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (email) return { loggedIn: true, account: email[0] };
  // Newer CLIs print just "Logged in using ChatGPT" with no account email.
  if (/logged in using chatgpt/i.test(text)) return { loggedIn: true, account: 'ChatGPT' };
  if (/api key/i.test(text)) return { loggedIn: true, account: 'API key' };
  if (/logged in/i.test(text)) return { loggedIn: true };
  return { loggedIn: false };
}

/** Parse ~/.codex/auth.json — the file the CLI itself trusts. Returns null when
 *  it is missing/unreadable, so the caller can fall back to `codex login status`. */
function parseCodexAuthJson(raw: string): AgentLoginAccount | null {
  try {
    const d = JSON.parse(raw);
    const idToken = typeof d?.tokens?.id_token === 'string' ? d.tokens.id_token : '';
    if (idToken) {
      // The id_token is a JWT; its payload carries the account email. No
      // signature verification needed — this is the file codex itself wrote.
      const payload = idToken.split('.')[1];
      if (payload) {
        try {
          const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
          return { loggedIn: true, account: typeof claims.email === 'string' ? claims.email : undefined };
        } catch {
          /* malformed payload — still logged in */
        }
      }
      return { loggedIn: true };
    }
    if (d?.auth_mode === 'api_key' || (typeof d?.OPENAI_API_KEY === 'string' && d.OPENAI_API_KEY)) {
      return { loggedIn: true, account: 'API key' };
    }
    return null;
  } catch {
    return null;
  }
}

/** `codex login status` on this machine (fallback when auth.json is unreadable). */
function codexStatusLocal(exe: string): Promise<AgentLoginAccount> {
  return new Promise((resolve) => {
    execFile(exe, ['login', 'status'], { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve(err && !stdout ? { loggedIn: false } : parseCodexStatus(`${stdout}\n${stderr}`));
    });
  });
}

function parseCursorAuth(raw: string): AgentLoginAccount {
  try {
    const auth = JSON.parse(raw)?.authInfo;
    const account = typeof auth?.email === 'string' ? auth.email : typeof auth?.displayName === 'string' ? auth.displayName : undefined;
    return account ? { loggedIn: true, account } : { loggedIn: false };
  } catch {
    return { loggedIn: false };
  }
}

/** Whether the agent CLI on a host is signed in, and as whom. Cheap results
 *  are memoized for a few seconds so opening the panel doesn't hammer SSH. */
export async function agentLoginAccount(agent: LoginAgent, hostName: string): Promise<AgentLoginAccount> {
  const host = hostName.trim();
  const key = `${agent}@${host}`;
  const hit = accountCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.value;

  let value: AgentLoginAccount;
  if (agent === 'codex') {
    // ~/.codex/auth.json is what the CLI itself trusts; reading it directly is
    // faster than a subprocess and carries the account email in its id_token
    // JWT (the status command prints only "Logged in using ChatGPT").
    const readAuthJson = !host
      ? (() => {
          try {
            return fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8');
          } catch {
            return '';
          }
        })()
      : await (async () => {
          const hostRec = hostRegistry.get(host);
          if (!hostRec) throw new AgentLoginError(`unknown host "${host}"`);
          const res = await sshExec(hostRec.ssh, loginShellCommand('cat "$HOME/.codex/auth.json" 2>/dev/null'), {
            timeoutMs: 20_000,
          });
          return res.stdout;
        })();
    const parsed = parseCodexAuthJson(readAuthJson);
    if (parsed) {
      value = parsed;
    } else if (!host) {
      const exe = resolveCodexExecutable();
      value = exe ? await codexStatusLocal(exe) : { loggedIn: false };
    } else {
      const hostRec = hostRegistry.get(host)!;
      const res = await sshExec(hostRec.ssh, loginShellCommand('codex login status'), { timeoutMs: 20_000 });
      value = parseCodexStatus(`${res.stdout}\n${res.stderr}`);
    }
  } else {
    if (!host) {
      try {
        value = parseCursorAuth(fs.readFileSync(path.join(os.homedir(), '.cursor', 'cli-config.json'), 'utf8'));
      } catch {
        value = { loggedIn: false };
      }
    } else {
      const hostRec = hostRegistry.get(host);
      if (!hostRec) throw new AgentLoginError(`unknown host "${host}"`);
      const res = await sshExec(hostRec.ssh, loginShellCommand('cat "$HOME/.cursor/cli-config.json" 2>/dev/null'), {
        timeoutMs: 20_000,
      });
      value = parseCursorAuth(res.stdout);
    }
  }

  accountCache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop the memoized signed-in state (e.g. right after a successful login). */
export function invalidateAgentLoginAccount(agent: LoginAgent, hostName: string): void {
  accountCache.delete(`${agent}@${hostName.trim()}`);
}
