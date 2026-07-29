import { loginShellCommand, sshExec } from './ssh.js';
import { ephemeralWorkdirName } from '../projects.js';

/**
 * Create a throwaway working directory on a remote host (~/.vibe/workdirs/<name>)
 * over SSH and return its absolute path (resolved via the remote $HOME). Used when
 * a New session on a remote host skips picking a cwd.
 *
 * Rejects with an Error whose message mentions "timed out" on timeout, so HTTP
 * callers can map it to 504 vs other failures. Shared by the HTTP API and the
 * Telegram bot so both surfaces create remote workdirs identically.
 */
export async function createRemoteWorkdir(sshTarget: string): Promise<string> {
  const name = ephemeralWorkdirName();
  // `name` is [0-9a-f-]+, so it's shell-safe to interpolate unquoted. Let the
  // remote shell expand ~ for mkdir, then echo the absolute path via $HOME so we
  // can store it as the session cwd.
  const r = await sshExec(sshTarget, loginShellCommand(`mkdir -p ~/.vibe/workdirs/${name} && echo "$HOME/.vibe/workdirs/${name}"`), {
    timeoutMs: 15_000,
  });
  if (r.timedOut) throw new Error('remote workdir create timed out');
  if (r.code !== 0) throw new Error(`remote mkdir failed: ${(r.stderr.trim() || 'unknown error').slice(0, 400)}`);
  const abs = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (!abs) throw new Error('remote mkdir returned no path');
  return abs;
}
