import { StreamNormalizer } from '../claude/normalize.js';
import { isClaudeSessionId } from '../sessions/discovery.js';
import type { RunOptions } from '../claude/runner.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';
import { loginShellCommand, shQuote, sshSpawn } from './ssh.js';

export interface RemoteRunOptions extends RunOptions {
  /** SSH target (alias or user@host) for the host this session lives on. */
  sshTarget: string;
}

// Harmless lines the login/interactive shell and SSH print to stderr; never
// part of a real error.
const NOISE = [
  /cannot set terminal process group/i,
  /no job control in this shell/i,
  /Permanently added .* to the list of known hosts/i,
  /post-quantum/i,
  /(store now|decrypt later|may be vulnerable|server may need to be upgraded|openssh\.com\/pq)/i,
  /Pseudo-terminal will not be allocated/i,
];

function cleanStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.some((re) => re.test(l)));
  return lines.slice(-4).join('\n');
}

/**
 * Drive one Claude turn on a remote host over SSH. Runs the user's `claude` CLI
 * in stream-json mode and feeds its output through the same normalizer the
 * local SDK path uses. The prompt is piped via stdin (no shell quoting of user
 * content); only the cwd/model are interpolated (and shell-quoted).
 *
 * Remote turns honor the session's permission mode; interactive per-tool
 * prompts are a local-only feature, so `requestPermission` is not used here.
 */
export function startRemoteRun(opts: RemoteRunOptions, cb: RunCallbacks): RunHandle {
  const normalizer = new StreamNormalizer(cb);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', shQuote(opts.model),
    '--effort', opts.effort,
    '--setting-sources=project,user,local',
  ];
  if (opts.resume && isClaudeSessionId(opts.resume)) args.push('--resume', opts.resume);
  if (opts.permissionMode && opts.permissionMode !== 'default') args.push('--permission-mode', opts.permissionMode);

  const remoteCmd = loginShellCommand(`cd ${shQuote(opts.cwd)} && exec claude ${args.join(' ')}`);
  const child = sshSpawn(opts.sshTarget, remoteCmd);

  let aborted = false;
  let buf = '';
  let stderr = '';

  const consume = (line: string) => {
    if (!line.trim()) return;
    try {
      normalizer.push(JSON.parse(line));
    } catch {
      // Non-JSON line (e.g. an SSH/login banner) — ignore.
    }
  };

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      consume(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr.on('data', (d) => (stderr += d.toString()));

  child.stdin.write(opts.prompt);
  child.stdin.end();

  const done = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      if (buf.trim()) consume(buf);
      if (!aborted && code !== 0) {
        cb.onEvent({ k: 'error', text: cleanStderr(stderr) || `remote claude exited with code ${code}` });
      }
      resolve();
    });
    child.on('error', (e) => {
      if (!aborted) cb.onEvent({ k: 'error', text: e instanceof Error ? e.message : String(e) });
      resolve();
    });
  });

  return {
    abort: () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500);
    },
    done,
  };
}
