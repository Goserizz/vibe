import { spawn } from 'node:child_process';
import { hostRegistry } from '../remote/hosts.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import { config } from '../config.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024; // 10 KiB

export interface RunCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  host: string;
  cwd?: string;
  denied?: boolean;
  reason?: string;
}

/** Destructive patterns Vibot must never execute (server-enforced). */
const DENY_RULES: { re: RegExp; reason: string }[] = [
  {
    re: /\brm\s+(?:-[a-zA-Z]*\s+)*-(?:[a-zA-Z]*f[a-zA-Z]*|rf|fr)\b[^|&;\n]*?(?:\/\s*\*|\/\s*$)/i,
    reason: 'refusing recursive force-remove of filesystem root (rm -rf / or /*)',
  },
  {
    re: /\brm\s+(?:-[a-zA-Z]*\s+)*-(?:[a-zA-Z]*f[a-zA-Z]*|rf|fr)\b[^|&;\n]*?\s\/\s*(?:$|[;&|])/,
    reason: 'refusing recursive force-remove of filesystem root (rm -rf /)',
  },
  {
    re: /\bmkfs(?:\.\w+)?\b/i,
    reason: 'refusing filesystem format (mkfs)',
  },
  {
    re: /\bdd\b[^|&;\n]*\bof\s*=\s*\/dev\//i,
    reason: 'refusing raw disk write (dd of=/dev/…)',
  },
  {
    re: /\b(?:shutdown|reboot|poweroff|halt)\b/i,
    reason: 'refusing system power command (shutdown/reboot/poweroff/halt)',
  },
  {
    // Classic bash fork bomb: :(){ :|:& };:
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    reason: 'refusing fork bomb',
  },
];

/** Exported for tests / reporting. */
export function listDenyReasons(): string[] {
  return DENY_RULES.map((r) => r.reason);
}

export function checkCommandDenied(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return 'empty command';
  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) return rule.reason;
  }
  return null;
}

function clampTimeout(ms: unknown): number {
  const n = Math.floor(Number(ms));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

function truncateOutput(s: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= MAX_OUTPUT_BYTES) return { text: s, truncated: false };
  // Slice by bytes without splitting a multi-byte char mid-way.
  let end = MAX_OUTPUT_BYTES;
  while (end > 0 && (s.charCodeAt(end) & 0xc0) === 0x80) end--;
  return {
    text: `${s.slice(0, end)}\n…(truncated at ${MAX_OUTPUT_BYTES} bytes)`,
    truncated: true,
  };
}

function mergeStreams(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}[stderr]\n${stderr}`;
}

/** Kill a process and its descendants (process-group leader when detached). */
function killTree(pid: number | undefined): void {
  if (pid == null || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function runLocal(command: string, cwd: string | undefined, timeoutMs: number): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    // detached → new process group so timeout can kill the whole tree.
    const child = spawn('bash', ['-c', command], {
      cwd: cwd || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: process.env,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
    const finish = (code: number | null, extraErr = ''): void => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({
        code,
        stdout,
        stderr: extraErr ? `${stderr}${extraErr}` : stderr,
        timedOut,
      });
    };
    child.on('error', (e) => finish(-1, e instanceof Error ? e.message : String(e)));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Execute a simple shell command locally or on a registered remote host.
 * Enforces denylist + timeout; truncates combined stdout/stderr.
 */
export async function runCommand(input: {
  command: string;
  host?: string;
  cwd?: string;
  timeoutMs?: unknown;
}): Promise<RunCommandResult> {
  const command = String(input.command ?? '').trim();
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined;
  const timeoutMs = clampTimeout(input.timeoutMs);
  const hostName = typeof input.host === 'string' ? input.host.trim() : '';

  const denied = checkCommandDenied(command);
  if (denied) {
    return {
      exitCode: null,
      output: '',
      timedOut: false,
      truncated: false,
      host: hostName || config.localName,
      cwd,
      denied: true,
      reason: denied,
    };
  }
  if (!command) {
    return {
      exitCode: null,
      output: '',
      timedOut: false,
      truncated: false,
      host: hostName || config.localName,
      cwd,
      denied: true,
      reason: 'empty command',
    };
  }

  // Local when host omitted or equals the local machine name.
  const isLocal = !hostName || hostName === config.localName;
  if (isLocal) {
    const res = await runLocal(command, cwd, timeoutMs);
    const merged = mergeStreams(res.stdout, res.stderr);
    const { text, truncated } = truncateOutput(merged);
    return {
      exitCode: res.code,
      output: text,
      timedOut: res.timedOut,
      truncated,
      host: config.localName,
      cwd,
    };
  }

  const remote = hostRegistry.get(hostName);
  if (!remote) {
    return {
      exitCode: null,
      output: '',
      timedOut: false,
      truncated: false,
      host: hostName,
      cwd,
      denied: true,
      reason: `Unknown host "${hostName}". Call list_hosts for valid names.`,
    };
  }

  // No ControlMaster mux: killing the ssh client must tear down the remote
  // session so a timed-out command cannot keep running on the mux master.
  const remoteInner = cwd ? `cd ${shQuote(cwd)} && ${command}` : command;
  const res = await sshExec(remote.ssh, loginShellCommand(remoteInner), {
    timeoutMs,
    mux: false,
  });
  const merged = mergeStreams(res.stdout, res.stderr);
  const { text, truncated } = truncateOutput(merged);
  return {
    exitCode: res.code,
    output: text,
    timedOut: res.timedOut,
    truncated,
    host: hostName,
    cwd,
  };
}
