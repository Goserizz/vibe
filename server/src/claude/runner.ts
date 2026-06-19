import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { log } from '../log.js';
import { StreamNormalizer } from './normalize.js';
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
}

/**
 * Drive one Claude turn on the local machine through the Agent SDK, normalizing
 * its stream into `LiveEvent`s and gating tool use through interactive prompts.
 */
export function startRun(opts: RunOptions, cb: RunCallbacks): RunHandle {
  const allowed = new Set(opts.allowedTools);
  const abortController = new AbortController();
  const normalizer = new StreamNormalizer(cb);

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
