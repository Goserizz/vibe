import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { CursorStreamNormalizer } from './normalize.js';
import { CursorAcpClient } from './acp.js';
import { sshConnectPrefix, shQuote, loginShellCommand, proxyEnvPrefix, cleanRemoteStderr, streamRemoteCommand } from '../remote/ssh.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import { applyCursorMcp } from '../mcp/apply.js';
import type { McpServerDef, PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface CursorRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Cursor chat id to resume; omit for a fresh chat. */
  resume?: string;
  /** MCP servers enabled for this session's host; merged into ~/.cursor/mcp.json
   *  (on the host the session runs on) before the turn. */
  mcpServers?: McpServerDef[];
  /** When set, the turn runs on a remote host over SSH. `cwd` is the remote path. */
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

/** Build the legacy headless invocation (shared by local spawn and remote ssh). */
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
    // Line-buffer / PTY so stream-json thinking doesn't arrive in one SSH burst.
    const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(streamRemoteCommand(inner));
    const { bin, opts: sshOpts } = sshConnectPrefix();
    return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
  }
  return { bin: config.cursorExecutable, args: cliArgs, remote: false };
}

interface Outcome {
  transient: boolean;
  error?: string;
}

/** Legacy fallback for cursor-agent builds that predate the `acp` subcommand:
 *  one headless invocation, streaming its stdout JSONL into the normalizer. */
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
      resolve({ transient: sawTransient, error: cleanRemoteStderr(stderr) || `cursor-agent exited with code ${code}` });
    });

    // Feed the prompt over stdin (ssh forwards it to the remote agent).
    child.stdin.on('error', () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

function acpUnavailable(error: string): boolean {
  return /(?:unknown|unrecognized|invalid)\s+(?:command|subcommand).*\bacp\b|unknown command ['"]?acp/i.test(error);
}

/** Synthetic follow-up for a mid-stream auto-resume. ACP has no "continue the
 *  cancelled turn" primitive — after session/resume the turn only advances via
 *  session/prompt — so we nudge the model to pick up where the cancelled turn
 *  stopped instead of re-sending the original prompt, which would re-run (and
 *  duplicate in the UI) everything already streamed. */
const RESUME_PROMPT =
  'Your previous reply was cut off by a transient network error. Continue exactly where you left off; do not repeat content you already produced.';

/**
 * Drive one Cursor turn through ACP (`cursor-agent acp`) so interactive
 * approvals are real — plan review (cursor/create_plan → ExitPlanMode) and
 * ask-question surface in the Web/Telegram UI, and permissionMode `plan`
 * can actually gate tools. Old CLIs without the `acp` subcommand fall back
 * to headless print mode (no interactive prompts there).
 */
export function startCursorRun(opts: CursorRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let child: ChildProcess | undefined;
  let acpClient: CursorAcpClient | undefined;
  let aborted = false;
  let usingFallback = false;

  // Pre-content retries only fire while nothing has streamed (retrying then
  // would duplicate nothing). Once content has streamed, a transient transport
  // death (e.g. http/2 stream cancel) is instead auto-resumed once on the same
  // session with a "continue" nudge.
  let producedAny = false;
  let autoResumed = false;
  let resume = opts.resume;
  let prompt = opts.prompt;
  const wrappedCb: RunCallbacks = {
    ...cb,
    onClaudeSessionId: (id) => {
      resume = id;
      cb.onClaudeSessionId(id);
    },
    onEvent: (ev) => {
      if (isContentEvent(ev)) producedAny = true;
      cb.onEvent(ev);
    },
  };

  const done = (async () => {
    // Reconcile Vibe's MCP servers into ~/.cursor/mcp.json (local or remote)
    // before the first attempt. Both ACP and headless modes read that file.
    // Best-effort: a failure logs and continues so the turn still runs without
    // those servers.
    await applyCursorMcp(opts.mcpServers ?? [], opts.remote ? { sshTarget: opts.remote.sshTarget } : undefined);

    for (let attempt = 0; ; attempt++) {
      // Fresh normalizer per attempt so state from a failed run can't leak in.
      const normalizer = new CursorStreamNormalizer(wrappedCb);
      acpClient = new CursorAcpClient({ ...opts, prompt, resume }, wrappedCb);
      const acpOutcome = await acpClient.run();
      let outcome: Outcome = {
        transient: Boolean(acpOutcome.error && mentionsTransient(acpOutcome.error)),
        error: acpOutcome.error,
      };

      // A pre-ACP cursor-agent still runs headless with the same mode mapping
      // (plan → --mode plan, everything else → --force), minus the plan modal.
      if (outcome.error && acpUnavailable(outcome.error)) {
        log.debug('cursor acp unavailable; falling back to headless print mode');
        usingFallback = true;
        outcome = await runOnce({ ...opts, prompt, resume }, normalizer, (c) => (child = c));
        usingFallback = false;
      }
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
      if (outcome.transient && producedAny && !autoResumed) {
        // Mid-stream transport death (http/2 stream cancel etc.): the turn's
        // partial output is already rendered, so instead of failing the whole
        // turn, resume the same session once and ask the model to continue.
        autoResumed = true;
        log.warn('cursor transient error mid-stream, auto-resuming once:', outcome.error);
        wrappedCb.onEvent({
          k: 'block',
          block: {
            id: `cur_resume_${crypto.randomUUID()}`,
            kind: 'assistant',
            text: '（传输中断，正在自动续跑…）',
            streaming: false,
            ts: Date.now(),
          },
        });
        prompt = RESUME_PROMPT;
        const backoff = backoffFor(0);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('cursor run aborted during resume backoff');
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
      // Mark the run aborted and cut any in-flight backoff short in both modes,
      // so a pending retry/auto-resume never fires after the user aborted.
      aborted = true;
      abortController.abort();
      if (usingFallback) {
        // Headless mode is one process per reply — terminating it is the only
        // interrupt primitive there.
        child?.kill('SIGTERM');
        return;
      }
      acpClient?.abort();
    },
    done,
  };
}
