import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

/** Connection options: never block on prompts, fail fast, stay alive.
 *  LogLevel=ERROR silences client banners/warnings (e.g. OpenSSH 10's
 *  post-quantum key-exchange warning) while still surfacing real errors. */
const CONNECT_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'LogLevel=ERROR',
];
/** For one-shot exec: no PTY (`-T`). */
const COMMON_OPTS = ['-T', ...CONNECT_OPTS];

// SSH connection multiplexing: reuse a single authenticated TCP connection per
// host across calls. The first dial pays the full handshake (~2–6s on a remote
// host); every subsequent sshExec to the same target within the persist window
// is near-instant. This is what makes the 60s session-list background refresh
// cheap instead of re-handshaking every host on each tick.
const MUX_DIR = path.join(tmpdir(), 'vibe-ssh-mux');
let muxDirReady = false;

/** Per-target ControlMaster options. Deterministic socket path (sha1 of the
 *  target) so masters are reused across calls and even across restarts. Returns
 *  an empty list if the socket dir can't be created — ssh then just opens a
 *  fresh connection, so discovery degrades gracefully to today's behavior. */
function muxOpts(target: string): string[] {
  if (!muxDirReady) {
    try {
      mkdirSync(MUX_DIR, { recursive: true, mode: 0o700 });
      muxDirReady = true;
    } catch {
      return [];
    }
  }
  const h = createHash('sha1').update(target).digest('hex').slice(0, 16);
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${MUX_DIR}/mux-${h}`, '-o', 'ControlPersist=300'];
}

function sshBin(): { bin: string; base: string[] } {
  // `sshCommand` is usually just "ssh" but can be overridden (custom options/testing).
  const [bin, ...base] = config.sshCommand.split(/\s+/).filter(Boolean);
  return { bin, base };
}

/** The ssh binary + connection options derived from `config.sshCommand` + CONNECT_OPTS.
 *  Used by the Agent-SDK-over-SSH wrapper (claude/claude-ssh-wrap.sh) so remote turns
 *  dial the host with the same options as the rest of the remote layer. */
export function sshConnectPrefix(): { bin: string; opts: string[] } {
  const { bin, base } = sshBin();
  return { bin, opts: [...base, ...CONNECT_OPTS] };
}

function sshArgv(target: string, remoteCmd: string): { bin: string; args: string[] } {
  const { bin, base } = sshBin();
  return { bin, args: [...base, ...COMMON_OPTS, ...muxOpts(target), target, remoteCmd] };
}

/** Argv for a long-running remote command whose output is streamed and read
 *  incrementally by the caller (it spawns the process itself and watches
 *  stdout/stderr as data arrives). Same options as sshExec, just not wrapped
 *  in a collect-and-resolve promise. */
export function sshStreamArgv(target: string, remoteCmd: string): { bin: string; args: string[] } {
  return sshArgv(target, remoteCmd);
}

/** Argv for an interactive terminal: force a remote PTY (`-tt`). */
export function sshTerminalArgv(target: string, remoteCmd: string): { bin: string; args: string[] } {
  const { bin, base } = sshBin();
  return { bin, args: [...base, '-tt', ...CONNECT_OPTS, ...muxOpts(target), target, remoteCmd] };
}

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command on a remote host and collect its output. */
export function sshExec(
  target: string,
  remoteCmd: string,
  opts: { timeoutMs?: number; input?: string | Buffer } = {},
): Promise<SshResult> {
  const { bin, args } = sshArgv(target, remoteCmd);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // Collect output as Buffer chunks and concat once at the end. String += on
    // a multi-MB stream (large remote transcripts) is O(n²) from repeated
    // reallocation; Buffer push + concat keeps it linear.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 20_000);

    child.stdout.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    const finish = (code: number | null, extraErr = ''): void => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({ code, stdout, stderr: extraErr ? `${stderr}${extraErr}` : stderr, timedOut });
    };
    child.on('error', (e) => finish(-1, e instanceof Error ? e.message : String(e)));
    child.on('close', (code) => finish(code));

    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Quote a string for safe interpolation inside a remote POSIX shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shell prefix that exports `proxy` as HTTP(S)_PROXY in both cases, so a remote
 *  agent (claude / cursor-agent / codex / kimi / kiro-cli / grok — Node, Rust, …) routes its API traffic
 *  through it regardless of which variable the library reads. Meant to prepend
 *  to a remote command string (it ends in a trailing space). '' when no proxy.
 *
 *  The URL is evaluated on the *remote* host (e.g. `http://localhost:11111`
 *  means a proxy listening on that host, not on the Vibe server). */
export function proxyEnvPrefix(proxy?: string): string {
  const p = (proxy ?? '').trim();
  if (!p) return '';
  const q = shQuote(p);
  return `HTTP_PROXY=${q} HTTPS_PROXY=${q} http_proxy=${q} https_proxy=${q} `;
}

/** Lines a remote login+interactive shell emits over a non-pty SSH session —
 *  pure noise that would bury the real error (e.g. "Cannot use this model").
 *  `logout` is bash's interactive login-shell farewell on exit. */
export const REMOTE_STDERR_NOISE =
  /cannot set terminal process group|no job control in this shell|Pseudo-terminal|tcgetattr|bind: |Permanently added|Warning: Permanently|Connection to .* closed|^logout$|^exit$/i;

/** Drop ssh/login-shell noise from remote stderr so the real error survives. */
export function cleanRemoteStderr(s: string, maxLen = 1000): string {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !REMOTE_STDERR_NOISE.test(l))
    .join('\n')
    .slice(0, maxLen);
}

/**
 * Wrap a remote agent command so stdout stays line-buffered over `ssh -T`.
 * Without a PTY, many runtimes block-buffer pipes — thinking/tool JSONL then
 * arrives in one burst.
 *
 * Use `stdbuf -oL` only — do NOT wrap with `script`/PTY here: agents read the
 * prompt from stdin, and `script` often breaks stdin forwarding over SSH.
 */
export function streamRemoteCommand(inner: string): string {
  // `inner` is a full command with shell-safe quoting already applied.
  return (
    `if command -v stdbuf >/dev/null 2>&1; then stdbuf -oL -eL ${inner}; ` +
    `else ${inner}; fi`
  );
}

/**
 * Wrap a command so it runs through the user's login + interactive shell. This
 * is essential for finding `claude` (and the `node` it needs) on remote hosts:
 * non-interactive SSH doesn't source `~/.bashrc`/`~/.profile`, so tools managed
 * by nvm / fnm / volta / etc. aren't on PATH otherwise. stderr (job-control
 * warnings, banners) is irrelevant — we only parse stdout.
 */
export function loginShellCommand(inner: string): string {
  // Run through `bash` explicitly. SSH executes the remote command string under
  // the user's *login* shell, so a host whose login shell is non-POSIX (fish)
  // would otherwise parse `${SHELL:-bash}` itself and reject POSIX syntax
  // ("${ is not a valid variable in fish"). Invoking `bash` as a binary works
  // from any shell, and `-lic` loads the login+interactive rc files so version
  // managers (nvm/fnm/volta) put tools on PATH. bash ships on macOS and Linux.
  return `bash -lic ${shQuote(inner)}`;
}

/** Check reachability + whether `claude` is installed on a host.
 *  Prefer `sshProbeAgents` from `./agents.js` when you need per-agent versions. */
export async function sshCheck(target: string): Promise<{ online: boolean; claude: boolean; error?: string }> {
  const probe = loginShellCommand('command -v claude >/dev/null 2>&1 && echo HAS_CLAUDE');
  const res = await sshExec(target, `echo VIBE_OK; ${probe} 2>/dev/null || true`, { timeoutMs: 15_000 });
  if (res.code !== 0 || !res.stdout.includes('VIBE_OK')) {
    const error = res.timedOut ? 'connection timed out' : (res.stderr.trim().split('\n').pop() || 'unreachable');
    return { online: false, claude: false, error };
  }
  return { online: true, claude: res.stdout.includes('HAS_CLAUDE') };
}
