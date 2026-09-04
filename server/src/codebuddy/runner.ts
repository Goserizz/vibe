import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { CodebuddyStreamNormalizer } from './normalize.js';
import { codebuddyAuthEnv, remoteCodebuddyAuthSource } from './auth.js';
import { codebuddyEffortArg } from './models.js';
import { codebuddyProjectKey, legacyCodebuddyProjectKey } from './projectKey.js';
import { toCliMcpConfig } from '../mcp/apply.js';
import {
  sshConnectPrefix,
  sshExec,
  shQuote,
  loginShellCommand,
  streamRemoteCommand,
  proxyEnvPrefix,
  cleanRemoteStderr,
} from '../remote/ssh.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { EffortLevel, McpServerDef, PermissionDecision, PermissionMode, PermissionRequest } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface CodebuddyRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Reasoning effort → CodeBuddy `--effort` (minimal..max ladder). */
  effort: EffortLevel;
  /** CodeBuddy session id to resume; omit for a fresh session. */
  resume?: string;
  /** Tools the user has chosen to always allow this session. */
  allowedTools: string[];
  /** MCP servers enabled for this session's host, handed to the CLI via a
   *  `--mcp-config` file (see deployMcpConfig). Additive: the CLI still loads
   *  the user's own config on top unless it passes `--strict-mcp-config`. */
  mcpServers?: McpServerDef[];
  /** Vibe session id — names the per-session MCP config file. */
  vibeSessionId?: string;
  /** When set, the turn runs on a remote host over SSH. `cwd` is the remote path. */
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

/** Injectable only so the process lifecycle/watchdogs can be exercised without
 * starting a real CLI in unit tests. Production callers use the defaults. */
export interface CodebuddyRunnerDeps {
  spawnProcess?: typeof spawn;
  sshExec?: typeof sshExec;
  codebuddyProjectsDir?: string;
  startupTimeoutMs?: number;
  firstResponseTimeoutMs?: number;
}

export const CODEBUDDY_STARTUP_TIMEOUT_MS = 45_000;
export const CODEBUDDY_FIRST_RESPONSE_TIMEOUT_MS = 180_000;

/** Map a Vibe permission mode to CLI flags. `bypassPermissions` maps to `-y`
 *  (CodeBuddy's own skip-permissions switch); every other mode keeps the
 *  stream-json control protocol live so risky tools still route through Vibe's
 *  interactive permission prompts. */
function permissionArgs(mode: PermissionMode): string[] {
  if (mode === 'bypassPermissions') return ['-y'];
  if (mode === 'default') return [];
  return ['--permission-mode', mode];
}

/** Build the codebuddy invocation (shared by the local spawn and remote ssh). */
function buildArgs(opts: CodebuddyRunOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...permissionArgs(opts.permissionMode),
  ];
  if (opts.model && opts.model !== 'auto') args.push('--model', opts.model);
  const effort = codebuddyEffortArg(opts.effort);
  if (effort) args.push('--effort', effort);
  if (opts.allowedTools.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.resume) args.push('-r', opts.resume);
  return args;
}

/** A user message line in CodeBuddy's stream-json input protocol. */
function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

/** A deployed per-session MCP config file: the CLI-facing path plus how to
 *  remove it once the turn's child is gone. */
interface McpConfigFile {
  /** Path as the CLI must see it (remote path for SSH turns). */
  cliPath: string;
  cleanup: () => void;
}

/**
 * Materialize the session's MCP servers as a `--mcp-config` file.
 *
 * Local: `~/.vibe/codebuddy-mcp/<sessionId>.json`. Remote: the same path on
 * the session's host, uploaded as base64 over the SSH channel — the config is
 * never inlined in a command line (env vars and headers carry secrets that
 * `ps` on the remote host would expose). This is a deliberate difference from
 * Claude's remote turns, which pass MCP through the Agent SDK's tunnel: here
 * the file AND the stdio servers it names resolve on the remote machine, so a
 * stdio `command` must exist there (http/sse servers are reachable from
 * wherever the CLI dials them). `${VAR}` inside env values is passed through
 * verbatim for the CLI to expand with its own semantics.
 *
 * Best-effort: a failure logs and the turn runs without Vibe-managed MCP
 * (the CLI still loads the user's own config), like the other agents' applies.
 */
async function deployMcpConfig(opts: CodebuddyRunOptions): Promise<McpConfigFile | undefined> {
  const defs = opts.mcpServers ?? [];
  if (!defs.length) return undefined;
  const file = `${opts.vibeSessionId ?? crypto.randomUUID()}.json`;
  let content: string;
  try {
    content = await toCliMcpConfig(defs);
  } catch (err) {
    log.warn('codebuddy mcp config build failed', err);
    return undefined;
  }

  if (!opts.remote) {
    const local = path.join(config.codebuddyMcpDir, file);
    try {
      fs.mkdirSync(config.codebuddyMcpDir, { recursive: true });
      fs.writeFileSync(local, content, { mode: 0o600 });
    } catch (err) {
      log.warn('codebuddy mcp config write failed', err);
      return undefined;
    }
    return {
      cliPath: local,
      cleanup: () => {
        try { fs.rmSync(local, { force: true }); } catch { /* best effort */ }
      },
    };
  }

  const remotePath = `~/.vibe/codebuddy-mcp/${file}`;
  try {
    const upload = await sshExec(
      opts.remote.sshTarget,
      `mkdir -p ~/.vibe/codebuddy-mcp && base64 -d > ${remotePath} && echo MCP_OK`,
      { input: Buffer.from(content, 'utf8').toString('base64'), timeoutMs: 15_000 },
    );
    if (upload.code !== 0 || !upload.stdout.includes('MCP_OK')) {
      throw new Error(cleanRemoteStderr(upload.stderr) || 'upload failed');
    }
  } catch (err) {
    log.warn('codebuddy remote mcp config upload failed', err);
    return undefined;
  }
  return {
    cliPath: remotePath,
    cleanup: () => {
      sshExec(opts.remote!.sshTarget, `rm -f ${remotePath}`, { timeoutMs: 10_000 })
        .catch((err) => log.debug('codebuddy remote mcp config cleanup failed', err));
    },
  };
}

/** A permission decision as a control_response line (shape verified against the
 *  CLI dist: `{subtype:'success', request_id, response:{allowed, reason?, updatedInput?}}`). */
function controlResponse(requestId: string, decision: PermissionDecision): string {
  const response = decision.allow
    ? { allowed: true, ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}) }
    : { allowed: false, reason: 'Denied by user' };
  return `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`;
}

interface Outcome {
  transient: boolean;
  error?: string;
}

/** Live steering for the RunHandle: writes onto the child's still-open stdin,
 *  and flips to ended once the turn has closed it. */
interface Steering {
  write: (line: string) => void;
  ended: () => boolean;
}

const checkedLegacyResumePaths = new Set<string>();

/**
 * Repair sessions written before the project-key fix. The old adapter retained
 * a trailing slash as a trailing `-`, while CodeBuddy trims it. Copy rather
 * than move: the converted artifact remains recoverable and an existing
 * canonical transcript is never overwritten.
 */
export async function repairLegacyCodebuddyResumePath(
  opts: CodebuddyRunOptions,
  deps: CodebuddyRunnerDeps = {},
): Promise<void> {
  if (!opts.resume) return;
  const legacyKey = legacyCodebuddyProjectKey(opts.cwd);
  const canonicalKey = codebuddyProjectKey(opts.cwd);
  if (legacyKey === canonicalKey) return;

  const scope = opts.remote?.sshTarget ?? 'local';
  const cacheKey = `${scope}\0${opts.resume}\0${canonicalKey}`;
  if (checkedLegacyResumePaths.has(cacheKey)) return;

  if (opts.remote) {
    const sourceRel = `.codebuddy/projects/${legacyKey}/${opts.resume}.jsonl`;
    const targetRel = `.codebuddy/projects/${canonicalKey}/${opts.resume}.jsonl`;
    const remoteCmd = [
      `src="$HOME"/${shQuote(sourceRel)}`,
      `dst="$HOME"/${shQuote(targetRel)}`,
      'if [ -f "$dst" ]; then :',
      'elif [ -f "$src" ]; then mkdir -p "${dst%/*}" && cp -p -- "$src" "$dst" && printf VIBE_CODEBUDDY_RESUME_REPAIRED',
      'fi',
    ].join('; ');
    const runSsh = deps.sshExec ?? sshExec;
    const result = await runSsh(opts.remote.sshTarget, remoteCmd, { timeoutMs: 15_000 });
    if (result.code !== 0) {
      throw new Error(cleanRemoteStderr(result.stderr) || `ssh exited with code ${String(result.code)}`);
    }
    if (result.stdout.includes('VIBE_CODEBUDDY_RESUME_REPAIRED')) {
      log.info(`repaired legacy CodeBuddy resume path session=${opts.resume} host=${opts.remote.sshTarget}`);
    }
  } else {
    const root = deps.codebuddyProjectsDir ?? config.codebuddyProjectsDir;
    const source = path.join(root, legacyKey, `${opts.resume}.jsonl`);
    const target = path.join(root, canonicalKey, `${opts.resume}.jsonl`);
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
        log.info(`repaired legacy CodeBuddy resume path session=${opts.resume} local`);
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
  }

  checkedLegacyResumePaths.add(cacheKey);
}

/**
 * Run one CodeBuddy invocation as a persistent child: the first prompt goes in
 * over stdin, which then stays open so (a) later user messages steer the same
 * session and (b) `can_use_tool` control requests can be answered. The child
 * exits when we close stdin after a result with no live background tasks.
 */
async function runOnce(
  opts: CodebuddyRunOptions,
  allowed: Set<string>,
  cb: RunCallbacks,
  normalizer: CodebuddyStreamNormalizer,
  setChild: (c: ChildProcess) => void,
  setSteering: (s: Steering) => void,
  deps: CodebuddyRunnerDeps,
): Promise<Outcome> {
  try {
    await repairLegacyCodebuddyResumePath(opts, deps);
  } catch (err) {
    return {
      transient: false,
      error: `codebuddy resume path repair failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // The MCP config file must exist before the child spawns (remote needs an
  // SSH round-trip first); it is removed once the child is gone.
  const mcp = await deployMcpConfig(opts);
  const args = buildArgs(opts);
  if (mcp) args.push('--mcp-config', mcp.cliPath);
  return new Promise<Outcome>((resolve) => {
    const spawnProcess = deps.spawnProcess ?? spawn;
    let bin: string;
    let child: ChildProcess;
    if (opts.remote) {
      // Source the pushed vibe-auth.env remotely, cd into the workspace, then
      // run the CLI with line-buffered stdout. The proxy prefix sits before the
      // login shell so it reaches the CLI regardless of the stdbuf wrapper.
      const inner = [
        remoteCodebuddyAuthSource(),
        `cd ${shQuote(opts.remote.cwd)} && codebuddy ${args.map(shQuote).join(' ')}`,
      ].join(' ');
      const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(streamRemoteCommand(inner));
      const { bin: sshBin, opts: sshOpts } = sshConnectPrefix();
      bin = sshBin;
      child = spawnProcess(sshBin, [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], {
        env: { ...process.env },
      });
    } else {
      if (!config.codebuddyExecutable) {
        mcp?.cleanup();
        resolve({
          transient: false,
          error: 'codebuddy not found — install the CodeBuddy CLI (npm i -g @tencent-ai/codebuddy-code) or set CODEBUDDY_CLI_PATH',
        });
        return;
      }
      bin = config.codebuddyExecutable;
      child = spawnProcess(bin, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...codebuddyAuthEnv() },
      });
    }
    setChild(child);

    let stderr = '';
    let sawTransient = false;
    let sawResult = false;
    let buffer = '';
    let ended = false;
    let settled = false;
    /** Live background tasks — when the result lands with none, the turn ends. */
    const activeTasks = new Set<string>();
    /** Kill scheduled after the turn ends. Unref'd so it never holds the process. */
    let endTimer: NodeJS.Timeout | undefined;
    let startupTimer: NodeJS.Timeout | undefined;
    let firstResponseTimer: NodeJS.Timeout | undefined;
    let timeoutError: string | undefined;

    const write = (line: string): void => {
      if (ended) return;
      child.stdin!.write(line);
    };
    const endInput = (): void => {
      if (ended) return;
      ended = true;
      child.stdin!.end();
    };
    const clearStartupTimer = (): void => {
      if (!startupTimer) return;
      clearTimeout(startupTimer);
      startupTimer = undefined;
    };
    const clearFirstResponseTimer = (): void => {
      if (!firstResponseTimer) return;
      clearTimeout(firstResponseTimer);
      firstResponseTimer = undefined;
    };
    const clearWatchdogs = (): void => {
      clearStartupTimer();
      clearFirstResponseTimer();
    };
    const stopForTimeout = (message: string): void => {
      if (timeoutError || settled) return;
      timeoutError = message;
      clearWatchdogs();
      endInput();
      try {
        child.kill('SIGTERM');
        endTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        endTimer.unref?.();
      } catch {
        /* close/error handler will report the timeout */
      }
    };

    const startupTimeoutMs = deps.startupTimeoutMs ?? CODEBUDDY_STARTUP_TIMEOUT_MS;
    if (Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0) {
      startupTimer = setTimeout(() => {
        stopForTimeout(
          `codebuddy produced no protocol output within ${startupTimeoutMs}ms while resuming ${opts.resume ?? 'a new session'}`,
        );
      }, startupTimeoutMs);
      if (!deps.spawnProcess) startupTimer.unref?.();
    }
    const firstResponseTimeoutMs = deps.firstResponseTimeoutMs ?? CODEBUDDY_FIRST_RESPONSE_TIMEOUT_MS;
    if (Number.isFinite(firstResponseTimeoutMs) && firstResponseTimeoutMs > 0) {
      firstResponseTimer = setTimeout(() => {
        stopForTimeout(
          `codebuddy produced no response event within ${firstResponseTimeoutMs}ms while resuming ${opts.resume ?? 'a new session'}`,
        );
      }, firstResponseTimeoutMs);
      if (!deps.spawnProcess) firstResponseTimer.unref?.();
    }
    /** Close stdin and make sure the child actually goes away. The CLI exits on
     *  EOF after a clean turn, but an interrupted one can idle forever (probed
     *  on 2.141.0) — so a short grace period precedes a hard kill. */
    const endTurn = (): void => {
      if (settled) return;
      settled = true;
      clearWatchdogs();
      endInput();
      endTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
        } catch {
          /* already gone */
        }
      }, 1_500);
      endTimer.unref?.();
    };

    /** Route one can_use_tool control request through Vibe's permission UI. */
    const handleControlRequest = (message: any): void => {
      const request = message.request ?? {};
      const requestId = String(message.request_id ?? '');
      if (request.subtype !== 'can_use_tool' || !requestId) {
        // Something the CLI asked that Vibe can't answer (elicitation, hooks…) —
        // reply with an error so the CLI isn't left waiting on its own timeout.
        write(`${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId || 'unknown', error: 'unhandled by vibe' },
        })}\n`);
        return;
      }
      const toolName = String(request.tool_name ?? 'tool');
      const input = request.input;
      // AskUserQuestion must always route through the interactive prompt —
      // pre-approving it would skip the picker and lose the user's answers.
      // ExitPlanMode must always prompt too — it's the plan-review gate, and
      // pre-approving would skip the review.
      const alwaysPrompt = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
      if (!alwaysPrompt && allowed.has(toolName)) {
        write(controlResponse(requestId, { allow: true }));
        return;
      }
      const req: PermissionRequest = {
        requestId: crypto.randomUUID(),
        toolName,
        input,
        ts: Date.now(),
      };
      // ExitPlanMode carries the plan markdown in its input (Claude-CLI style,
      // confirmed on captured codebuddy transcripts) — copy it over so the
      // plan-review UIs show the plan text instead of the generic message.
      if (toolName === 'ExitPlanMode') {
        const plan = (input as { plan?: unknown } | null)?.plan;
        if (typeof plan === 'string' && plan.trim()) req.plan = plan;
      }
      void cb.requestPermission(req).then((decision) => {
        if (decision.allow && decision.remember) allowed.add(toolName);
        write(controlResponse(requestId, decision));
      });
    };

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      if (mentionsTransient(line)) sawTransient = true;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return; // non-JSON noise on stdout — ignore
      }
      // A valid JSON protocol frame proves SSH + CLI startup completed. `init`
      // alone does not prove the model turn began, so the longer first-response
      // watchdog stays armed until an actual response/progress frame arrives.
      clearStartupTimer();
      if (
        message.type === 'assistant'
        || message.type === 'stream_event'
        || message.type === 'result'
        || message.type === 'control_request'
        || (message.type === 'system' && message.subtype && message.subtype !== 'init')
      ) {
        clearFirstResponseTimer();
      }
      // Engine output marks the foreground busy; the result event below
      // releases the composer again.
      if (message.type === 'assistant' || message.type === 'stream_event') cb.onTurnState?.(true);
      if (message.type === 'control_request') {
        handleControlRequest(message);
        return;
      }
      normalizer.push(message);
      if (message.type === 'system' && typeof message.subtype === 'string') {
        const id = String(message.task_id ?? '');
        if (message.subtype === 'task_started' && id) activeTasks.add(id);
        if (message.subtype === 'task_updated') {
          const status = message.patch?.status;
          if (status === 'completed' || status === 'failed' || status === 'killed') activeTasks.delete(id);
          else if (status === 'pending' || status === 'running' || status === 'paused') activeTasks.add(id);
        }
        if (message.subtype === 'task_notification' && id) activeTasks.delete(id);
      }
      if (message.type === 'result') {
        sawResult = true;
        cb.onTurnState?.(false);
        // Close only when the result sees no live task; otherwise the child
        // stays connected and the task's completion notification steers the
        // native follow-up turn on this same stdin.
        if (activeTasks.size === 0) endTurn();
      }
    };

    child.stdout!.on('data', (d) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr!.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (mentionsTransient(s)) sawTransient = true;
    });
    child.on('error', (e) => {
      if (endTimer) clearTimeout(endTimer);
      clearWatchdogs();
      endInput();
      mcp?.cleanup();
      resolve({
        transient: false,
        error: timeoutError ?? `failed to run ${bin}: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
    child.on('close', (code) => {
      if (endTimer) clearTimeout(endTimer);
      clearWatchdogs();
      mcp?.cleanup();
      if (buffer.trim()) onLine(buffer);
      // A non-zero exit after a full turn (e.g. an aborted model call, or the
      // grace kill after a completed result) already surfaced its result
      // through the stream — only treat a bare non-zero exit with no result as
      // a (possibly transient) failure.
      if (!timeoutError && (code === 0 || sawResult)) {
        resolve({ transient: false });
        return;
      }
      resolve({
        transient: sawTransient,
        error: timeoutError ?? (cleanRemoteStderr(stderr) || `codebuddy exited with code ${code}`),
      });
    });

    // The prompt rides the same stdin that stays open for follow-ups.
    child.stdin!.on('error', () => { /* EPIPE after abort — close handler reports */ });
    setSteering({ write, ended: () => ended });
    write(userMessage(opts.prompt));
  });
}

/**
 * Drive one CodeBuddy CLI turn (local spawn or remote over SSH), normalizing
 * its stream-json output into `LiveEvent`s and gating tool use through the
 * `can_use_tool` control protocol.
 */
export function startCodebuddyRun(
  opts: CodebuddyRunOptions,
  cb: RunCallbacks,
  deps: CodebuddyRunnerDeps = {},
): RunHandle {
  const abortController = new AbortController();
  const allowed = new Set(opts.allowedTools);
  let child: ChildProcess | undefined;
  let steering: Steering = { write: () => {}, ended: () => true };
  let aborted = false;

  // Only retry before any content streams — retrying mid-stream would
  // duplicate text already rendered.
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
      const normalizer = new CodebuddyStreamNormalizer(wrappedCb);
      const outcome = await runOnce(
        opts,
        allowed,
        wrappedCb,
        normalizer,
        (c) => (child = c),
        (s) => (steering = s),
        deps,
      );
      if (aborted) {
        log.debug('codebuddy run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`codebuddy transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('codebuddy run aborted during backoff');
          return;
        }
        continue;
      }
      if (outcome.error) {
        log.error('codebuddy run error:', outcome.error);
        cb.onEvent({ k: 'error', text: outcome.error });
      }
      return;
    }
  })();

  return {
    abort: () => {
      aborted = true;
      abortController.abort();
      if (!child) return;
      try {
        child.kill('SIGTERM');
        setTimeout(() => child!.kill('SIGKILL'), 2_000).unref?.();
      } catch {
        /* already gone */
      }
    },
    // Steer a new user message through the still-open stdin (same session).
    sendMessage: (text: string) => {
      if (!child || steering.ended() || child.exitCode !== null || child.killed) return false;
      steering.write(userMessage(text));
      return true;
    },
    done,
  };
}
