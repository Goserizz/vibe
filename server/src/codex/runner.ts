import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { CodexStreamNormalizer } from './normalize.js';
import { sshConnectPrefix, shQuote, loginShellCommand } from '../remote/ssh.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface CodexRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Codex thread id to resume; omit for a fresh session. */
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

/** Map a Vibe permission mode to a Codex sandbox/approval flag set. Headless codex
 *  has no per-tool prompts; the sandbox level is the only lever. `--full-auto`
 *  keeps it sandboxed (workspace-write, auto); bypass drops the sandbox entirely. */
function sandboxArgs(mode: PermissionMode): string[] {
  if (mode === 'plan') return ['-s', 'read-only'];
  if (mode === 'bypassPermissions') return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['--full-auto'];
}

/** Build the codex invocation (shared by local spawn and remote ssh). The prompt
 *  is fed via stdin (positional `-` tells codex to read it there). We deliberately
 *  do NOT pass `-C/--cd`: `codex exec resume` rejects it (only fresh `exec` takes
 *  it). Instead the working dir is set via the process cwd (local spawn) or a
 *  `cd` prefix (remote ssh). */
function buildSpawn(opts: CodexRunOptions): { bin?: string; args: string[]; remote: boolean } {
  const cwd = opts.remote ? opts.remote.cwd : opts.cwd;
  const base = ['--json', '--skip-git-repo-check', ...sandboxArgs(opts.permissionMode)];
  if (opts.model) base.push('-m', opts.model);

  const args = opts.resume ? ['exec', 'resume', opts.resume, ...base, '-'] : ['exec', ...base, '-'];

  if (opts.remote) {
    // `cd` into the workspace on the remote host before launching codex.
    const inner = `cd ${shQuote(cwd)} && codex ${args.map(shQuote).join(' ')}`;
    const remoteCmd = loginShellCommand(inner);
    const { bin, opts: sshOpts } = sshConnectPrefix();
    return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
  }
  return { bin: config.codexExecutable, args, remote: false };
}

interface Outcome {
  transient: boolean;
  error?: string;
}

/** Run one codex invocation, streaming its stdout JSONL into the normalizer. */
function runOnce(opts: CodexRunOptions, normalizer: CodexStreamNormalizer, setChild: (c: ChildProcess) => void): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const { bin, args, remote } = buildSpawn(opts);
    if (!bin) {
      resolve({ transient: false, error: 'codex not found — install the Codex CLI or set CODEX_CLI_PATH' });
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
      // codex exits non-zero on a failed/aborted turn even after streaming the
      // events (e.g. a model-connection error); the normalizer already surfaced it
      // as a turn.failed/error, so only treat a non-zero exit with no content as a
      // (possibly transient) error worth surfacing.
      if (code === 0 || normalizer.sawTurnEnd) {
        resolve({ transient: false });
        return;
      }
      resolve({ transient: sawTransient, error: cleanStderr(stderr) || `codex exited with code ${code}` });
    });

    // Feed the prompt over stdin (ssh forwards it to the remote agent).
    child.stdin.on('error', () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/**
 * Drive one Codex CLI turn (local spawn or remote over SSH), normalizing its
 * `--json` stream into `LiveEvent`s. Codex headless mode has no interactive
 * per-tool permission prompts, so `requestPermission` is never invoked.
 */
export function startCodexRun(opts: CodexRunOptions, cb: RunCallbacks): RunHandle {
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
      const normalizer = new CodexStreamNormalizer(wrappedCb);
      const outcome = await runOnce(opts, normalizer, (c) => (child = c));
      if (aborted) {
        log.debug('codex run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`codex transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('codex run aborted during backoff');
          return;
        }
        continue;
      }
      if (outcome.error) {
        log.error('codex run error:', outcome.error);
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
