import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { log } from '../log.js';
import { StreamNormalizer } from './normalize.js';
import { sshConnectPrefix } from '../remote/ssh.js';
import type { EffortLevel, PermissionDecision, PermissionMode, PermissionRequest } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from './types.js';

export interface RunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Reasoning effort for the turn. */
  effort: EffortLevel;
  /** Claude session id to resume; omit for a fresh session. */
  resume?: string;
  /** Tools the user has chosen to always allow this session. */
  allowedTools: string[];
  /** When set, the turn runs on a remote host over SSH via the tunnel wrapper
   *  (still through the Agent SDK, so interactive prompts work remotely).
   *  `cwd` is the remote path. */
  remote?: { sshTarget: string; cwd: string };
}

/** The SSH-tunnel wrapper the Agent SDK invokes as `claude` for remote turns. */
const SSH_WRAP = path.resolve(import.meta.dirname, 'claude-ssh-wrap.sh');
let ensuredWrapExec = false;
/** Ensure the wrapper is executable — a checkout can drop the +x bit (mirrors the
 *  node-pty spawn-helper chmod). Runs at most once. */
function ensureWrapExec(): void {
  if (ensuredWrapExec) return;
  ensuredWrapExec = true;
  try {
    fs.accessSync(SSH_WRAP, fs.constants.X_OK);
  } catch {
    try { fs.chmodSync(SSH_WRAP, 0o755); } catch { /* best effort */ }
  }
}

/** Lines the remote login+interactive shell emits over a non-pty SSH session —
 *  pure noise that would bury the real error. */
const REMOTE_STDERR_NOISE = /cannot set terminal process group|no job control in this shell|connection to .* closed/i;

/** Read the plan Claude just wrote, so ExitPlanMode can show it for review.
 *  The ExitPlanMode tool input carries only `allowedPrompts` — the plan text
 *  lives in a file under `~/.claude/plans` that the model writes immediately
 *  before calling the tool. So the most-recently-modified plan file within a
 *  short recency window is the current plan. Returns undefined if no recent
 *  plan file can be found or read. */
function readCurrentPlan(): string | undefined {
  const dir = path.join(os.homedir(), '.claude', 'plans');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const now = Date.now();
  const RECENT_MS = 5 * 60_000;
  let best: { name: string; mtime: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile() || now - st.mtimeMs > RECENT_MS) continue;
    if (!best || st.mtimeMs > best.mtime) best = { name, mtime: st.mtimeMs };
  }
  if (!best) return undefined;
  try {
    return fs.readFileSync(path.join(dir, best.name), 'utf8');
  } catch {
    return undefined;
  }
}

/** Append the remote SSH stderr (its tail, shell noise stripped) to the SDK's
 *  generic "Claude Code process exited with code N" error so the user sees the
 *  actual cause (auth, missing cwd, old claude, …). The wrapper writes stderr to
 *  VIBE_ERR_LOG only on remote turns; locally this is a no-op. */
function withRemoteDetail(message: string, errLog?: string): string {
  if (!errLog) return message;
  try {
    const detail = fs
      .readFileSync(errLog, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !REMOTE_STDERR_NOISE.test(l))
      .slice(-12)
      .join('\n');
    return detail ? `${message}\n\n${detail}` : message;
  } catch {
    return message;
  }
}

/**
 * Drive one Claude turn on the local machine through the Agent SDK, normalizing
 * its stream into `LiveEvent`s and gating tool use through interactive prompts.
 */
export function startRun(opts: RunOptions, cb: RunCallbacks): RunHandle {
  const allowed = new Set(opts.allowedTools);
  const abortController = new AbortController();
  /** Side-channel file the SSH wrapper writes remote stderr into (remote turns
   *  only); read in the catch to enrich the error, removed in the finally. */
  let remoteErrLog: string | undefined;

  const sdkOptions: Record<string, unknown> = {
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    env: { ...process.env },
    includePartialMessages: true,
    // Use the full Claude Code tool + prompt preset so CLAUDE.md, MCP, etc. all work.
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    abortController,
  };
  if (opts.permissionMode && opts.permissionMode !== 'default') {
    sdkOptions.permissionMode = opts.permissionMode;
  }
  if (opts.resume) sdkOptions.resume = opts.resume;
  // Prefer the user's real claude binary over the SDK's bundled one (avoids
  // architecture mismatches and reuses their auth/proxy config).
  if (config.claudeExecutable) sdkOptions.pathToClaudeCodeExecutable = config.claudeExecutable;

  // Remote (SSH) turn: drive the remote claude through the tunnel wrapper so the
  // SDK's control protocol (interactive prompts) runs remotely. The SDK passes
  // `cwd` only as the spawn working dir, so use a valid local path here and
  // forward the real remote cwd via env (the wrapper `cd`s into it).
  if (opts.remote) {
    ensureWrapExec();
    const { bin, opts: sshOpts } = sshConnectPrefix();
    sdkOptions.pathToClaudeCodeExecutable = SSH_WRAP;
    sdkOptions.cwd = os.tmpdir();
    const env = { ...(sdkOptions.env as Record<string, string | undefined>) };
    env.VIBE_SSH_TARGET = opts.remote.sshTarget;
    env.VIBE_REMOTE_CWD = opts.remote.cwd;
    env.VIBE_SSH_BIN = bin;
    env.VIBE_SSH_OPTS = sshOpts.join(' ');
    // Stash remote stderr here on failure (see withRemoteDetail). Per-run unique
    // path so concurrent remote turns never collide.
    remoteErrLog = path.join(os.tmpdir(), `vibe-ssh-err-${crypto.randomUUID()}`);
    env.VIBE_ERR_LOG = remoteErrLog;
    sdkOptions.env = env;
  }

  // Permission gate. Pre-approved tools short-circuit; everything else asks the user.
  sdkOptions.canUseTool = async (toolName: string, input: unknown) => {
    // AskUserQuestion must always route through the interactive prompt so the
    // user's selections are collected; pre-approving it would skip the picker
    // and the tool would receive an empty-answers result. ExitPlanMode must
    // always prompt too — it's the plan-review gate, and the plan text is
    // surfaced separately via request.plan (pre-approving would skip the review).
    const alwaysPrompt = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
    if (!alwaysPrompt && allowed.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const request: PermissionRequest = { requestId: crypto.randomUUID(), toolName, input, ts: Date.now() };
    // ExitPlanMode's input has no plan text — it lives in a file on the host
    // running claude. For local turns that's this machine; for remote turns the
    // file is on the SSH host and unreadable here, so we leave it undefined and
    // the prompt falls back to a generic message.
    if (toolName === 'ExitPlanMode' && !opts.remote) {
      const plan = readCurrentPlan();
      if (plan) request.plan = plan;
    }
    const decision = await cb.requestPermission(request);
    if (decision.allow) {
      if (decision.remember) allowed.add(toolName);
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }
    return { behavior: 'deny', message: 'Denied by user' };
  };

  let queryInstance: AsyncGenerator<any> & { interrupt?: () => Promise<void> };

  const done = (async () => {
    const normalizer = new StreamNormalizer(cb);
    try {
      queryInstance = query({ prompt: opts.prompt, options: sdkOptions as any }) as any;
      for await (const message of queryInstance) {
        normalizer.push(message);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        log.debug('run aborted');
        return;
      }
      const text = err instanceof Error ? err.message : String(err);
      log.error('claude run error:', text);
      cb.onEvent({ k: 'error', text: withRemoteDetail(text, remoteErrLog) });
    } finally {
      if (remoteErrLog) {
        try { fs.rmSync(remoteErrLog, { force: true }); } catch { /* best effort */ }
      }
    }
  })();

  return {
    abort: () => {
      abortController.abort();
      void queryInstance?.interrupt?.().catch(() => {});
    },
    done,
  };
}

export type { RunCallbacks, RunHandle, PermissionDecision };
