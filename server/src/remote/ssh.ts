import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

function sshBin(): { bin: string; base: string[] } {
  // `sshCommand` is usually just "ssh" but can be overridden (custom options/testing).
  const [bin, ...base] = config.sshCommand.split(/\s+/).filter(Boolean);
  return { bin, base };
}

function sshArgv(target: string, remoteCmd: string): { bin: string; args: string[] } {
  const { bin, base } = sshBin();
  return { bin, args: [...base, ...COMMON_OPTS, target, remoteCmd] };
}

/** Argv for an interactive terminal: force a remote PTY (`-tt`). */
export function sshTerminalArgv(target: string, remoteCmd: string): { bin: string; args: string[] } {
  const { bin, base } = sshBin();
  return { bin, args: [...base, '-tt', ...CONNECT_OPTS, target, remoteCmd] };
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
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<SshResult> {
  const { bin, args } = sshArgv(target, remoteCmd);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 20_000);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e instanceof Error ? e.message : String(e)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Spawn a streaming SSH process (caller manages stdin/stdout/lifecycle). */
export function sshSpawn(target: string, remoteCmd: string): ChildProcessWithoutNullStreams {
  const { bin, args } = sshArgv(target, remoteCmd);
  return spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Quote a string for safe interpolation inside a remote POSIX shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a command so it runs through the user's login + interactive shell. This
 * is essential for finding `claude` (and the `node` it needs) on remote hosts:
 * non-interactive SSH doesn't source `~/.bashrc`/`~/.profile`, so tools managed
 * by nvm / fnm / volta / etc. aren't on PATH otherwise. stderr (job-control
 * warnings, banners) is irrelevant — we only parse stdout.
 */
export function loginShellCommand(inner: string): string {
  return `\${SHELL:-bash} -lic ${shQuote(inner)}`;
}

/** Check reachability + whether `claude` is installed on a host. */
export async function sshCheck(target: string): Promise<{ online: boolean; claude: boolean; error?: string }> {
  const probe = loginShellCommand('command -v claude >/dev/null 2>&1 && echo HAS_CLAUDE');
  const res = await sshExec(target, `echo VIBE_OK; ${probe} 2>/dev/null || true`, { timeoutMs: 15_000 });
  if (res.code !== 0 || !res.stdout.includes('VIBE_OK')) {
    const error = res.timedOut ? 'connection timed out' : (res.stderr.trim().split('\n').pop() || 'unreachable');
    return { online: false, claude: false, error };
  }
  return { online: true, claude: res.stdout.includes('HAS_CLAUDE') };
}
