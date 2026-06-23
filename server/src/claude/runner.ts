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

/**
 * Drive one Claude turn on the local machine through the Agent SDK, normalizing
 * its stream into `LiveEvent`s and gating tool use through interactive prompts.
 */
export function startRun(opts: RunOptions, cb: RunCallbacks): RunHandle {
  const allowed = new Set(opts.allowedTools);
  const abortController = new AbortController();

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
    sdkOptions.env = env;
  }

  // Permission gate. Pre-approved tools short-circuit; everything else asks the user.
  sdkOptions.canUseTool = async (toolName: string, input: unknown) => {
    // AskUserQuestion must always route through the interactive prompt so the
    // user's selections are collected; pre-approving it would skip the picker
    // and the tool would receive an empty-answers result.
    if (toolName !== 'AskUserQuestion' && allowed.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const request: PermissionRequest = { requestId: crypto.randomUUID(), toolName, input, ts: Date.now() };
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
      cb.onEvent({ k: 'error', text });
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
