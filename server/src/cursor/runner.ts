import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { CursorStreamNormalizer } from './normalize.js';
import { sshConnectPrefix, shQuote, loginShellCommand } from '../remote/ssh.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface CursorRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Cursor chat id to resume; omit for a fresh chat. */
  resume?: string;
  /** When set, the turn runs on a remote host over SSH. `cwd` is the remote path. */
  remote?: { sshTarget: string; cwd: string };
}

/** Drop ssh/job-control noise so a real error message survives. */
function cleanStderr(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/Pseudo-terminal|tcgetattr|bind: |Permanently added|Warning: Permanently|Connection to .* closed/i.test(l))
    .join('\n')
    .slice(0, 1000);
}

/** Build the cursor-agent invocation (shared by local spawn and remote ssh). */
function buildSpawn(opts: CursorRunOptions): { bin?: string; args: string[]; remote: boolean } {
  const cwd = opts.remote ? opts.remote.cwd : opts.cwd;
  // `--trust` is required in headless/print mode or the agent blocks on a
  // workspace-trust prompt. Permission is mode-level only (no per-tool prompts
  // in headless): plan = read-only planning, everything else = run freely.
  const cliArgs = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust'];
  if (opts.permissionMode === 'plan') cliArgs.push('--mode', 'plan');
  else cliArgs.push('--force');
  if (opts.model) cliArgs.push('--model', opts.model);
  if (opts.resume) cliArgs.push('--resume', opts.resume);
  cliArgs.push('--workspace', cwd);
  // The prompt is fed via stdin (never argv) so it can't be mistaken for a flag
  // and never goes through shell quoting.

  if (opts.remote) {
    const inner = `cursor-agent ${cliArgs.map(shQuote).join(' ')}`;
    const remoteCmd = loginShellCommand(inner);
    const { bin, opts: sshOpts } = sshConnectPrefix();
    return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
  }
  return { bin: config.cursorExecutable, args: cliArgs, remote: false };
}

interface Outcome {
  transient: boolean;
  error?: string;
}

/** Run one cursor-agent invocation, streaming its stdout JSONL into the normalizer. */
function runOnce(opts: CursorRunOptions, normalizer: CursorStreamNormalizer, setChild: (c: ChildProcess) => void): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const { bin, args, remote } = buildSpawn(opts);
    if (!bin) {
      resolve({ transient: false, error: 'cursor-agent not found — install the Cursor CLI or set CURSOR_CLI_PATH' });
      return;
    }
    const child = spawn(bin, args, { cwd: remote ? undefined : opts.cwd, env: { ...process.env } });
    setChild(child);

    let stderr = '';
    let sawTransient = false;
    let buffer = '';
    const onLine = (line: string) => {
      if (!line.trim()) return;
      if (mentionsTransient(line)) sawTransient = true;
      try {
        normalizer.push(JSON.parse(line));
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (mentionsTransient(s)) sawTransient = true;
    });
    child.on('error', (e) => resolve({ transient: false, error: e instanceof Error ? e.message : String(e) }));
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer);
      if (code === 0) {
        resolve({ transient: false });
        return;
      }
      resolve({ transient: sawTransient, error: cleanStderr(stderr) || `cursor-agent exited with code ${code}` });
    });

    // Feed the prompt over stdin (ssh forwards it to the remote agent).
    child.stdin.on('error', () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/**
 * Drive one Cursor CLI turn (local spawn or remote over SSH), normalizing its
 * stream-json into `LiveEvent`s. Cursor headless mode has no interactive
 * per-tool permission prompts, so `requestPermission` is never invoked.
 */
export function startCursorRun(opts: CursorRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let child: ChildProcess | undefined;
  let aborted = false;

  // Only retry before any content streams — retrying mid-stream would duplicate
  // text already rendered.
  let producedAny = false;
  const wrappedCb: RunCallbacks = {
    ...cb,
    onEvent: (ev) => {
      if (isContentEvent(ev)) producedAny = true;
      cb.onEvent(ev);
    },
  };

  const done = (async () => {
    for (let attempt = 0; ; attempt++) {
      // Fresh normalizer per attempt so state from a failed run can't leak in.
      const normalizer = new CursorStreamNormalizer(wrappedCb);
      const outcome = await runOnce(opts, normalizer, (c) => (child = c));
      if (aborted) {
        log.debug('cursor run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`cursor transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('cursor run aborted during backoff');
          return;
        }
        continue;
      }
      if (outcome.error) {
        log.error('cursor run error:', outcome.error);
        cb.onEvent({ k: 'error', text: outcome.error });
      }
      return;
    }
  })();

  return {
    abort: () => {
      aborted = true;
      abortController.abort();
      child?.kill('SIGTERM');
    },
    done,
  };
}
