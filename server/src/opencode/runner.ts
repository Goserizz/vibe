import { log } from '../log.js';
import { OpencodeAcpClient, type OpencodeAcpRunOptions } from './acp.js';
import { peekOpencodeContextWindow, warmOpencodeContextWindows } from './models.js';
import { hostRegistry } from '../remote/hosts.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { EffortLevel, McpServerDef, PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface OpencodeRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Reasoning effort → the session model's `variant`. */
  effort?: EffortLevel;
  /** Native opencode session id (`ses_…`) to resume. */
  resume?: string;
  /** Passed through ACP session/new or session/load. */
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

export const OPENCODE_STARTUP_TIMEOUT_MS = 45_000;
export const OPENCODE_FIRST_RESPONSE_TIMEOUT_MS = 180_000;

interface AttemptOutcome {
  transient: boolean;
  durationMs: number;
  error?: string;
  contextUsed?: number;
  contextWindow?: number;
  costUsd?: number;
}

/** Drive one opencode turn through `opencode acp` (token streaming + approvals). */
export function startOpencodeRun(opts: OpencodeRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let acpClient: OpencodeAcpClient | undefined;
  let aborted = false;
  let producedAny = false;
  let resume = opts.resume;

  const done = (async () => {
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      let startupTimer: NodeJS.Timeout | undefined;
      let firstResponseTimer: NodeJS.Timeout | undefined;
      let timeoutError: string | undefined;
      const clearTimers = (): void => {
        if (startupTimer) clearTimeout(startupTimer);
        if (firstResponseTimer) clearTimeout(firstResponseTimer);
        startupTimer = undefined;
        firstResponseTimer = undefined;
      };
      const wrappedCb: RunCallbacks = {
        ...cb,
        onClaudeSessionId: (id) => {
          resume = id;
          cb.onClaudeSessionId(id);
        },
        onEvent: (event) => {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = undefined;
          }
          if (isContentEvent(event)) {
            producedAny = true;
            if (firstResponseTimer) {
              clearTimeout(firstResponseTimer);
              firstResponseTimer = undefined;
            }
          }
          cb.onEvent(event);
        },
      };
      startupTimer = setTimeout(() => {
        timeoutError =
          `opencode produced no output within ${OPENCODE_STARTUP_TIMEOUT_MS}ms while resuming ${resume ?? 'a new session'}`;
        acpClient?.abort();
      }, OPENCODE_STARTUP_TIMEOUT_MS);
      startupTimer.unref?.();
      firstResponseTimer = setTimeout(() => {
        timeoutError =
          `opencode produced no response event within ${OPENCODE_FIRST_RESPONSE_TIMEOUT_MS}ms while resuming ${resume ?? 'a new session'}`;
        acpClient?.abort();
      }, OPENCODE_FIRST_RESPONSE_TIMEOUT_MS);
      firstResponseTimer.unref?.();

      const acpOpts: OpencodeAcpRunOptions = { ...opts, resume };
      // Warm the context-window table (verbose catalog) for the result
      // footnote; the lookup below is a sync cache peek and never blocks.
      const windowHost = opts.remote
        ? hostRegistry.list().find((h) => h.ssh === opts.remote!.sshTarget)?.name
        : undefined;
      warmOpencodeContextWindows(windowHost);
      acpClient = new OpencodeAcpClient(acpOpts, wrappedCb);
      const acpOutcome = await acpClient.run();
      clearTimers();
      const usage = acpOutcome.usage ?? undefined;
      const effectiveModel = opts.model && opts.model !== 'auto' ? opts.model : acpOutcome.model;
      const outcome: AttemptOutcome = {
        transient: Boolean(acpOutcome.error && mentionsTransient(acpOutcome.error)),
        durationMs: Date.now() - startedAt,
        error: timeoutError ?? acpOutcome.error,
        contextUsed:
          usage && (usage.inputTokens != null || usage.cachedReadTokens != null)
            ? (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0) || undefined
            : undefined,
        contextWindow: effectiveModel ? peekOpencodeContextWindow(effectiveModel, windowHost) : undefined,
        costUsd: usage?.cost,
      };
      if (aborted) {
        log.debug('opencode run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`opencode transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('opencode run aborted during backoff');
          return;
        }
        continue;
      }
      wrappedCb.onEvent({
        k: 'block',
        block: {
          id: `opencode_result_${Date.now()}`,
          kind: 'result',
          costUsd: outcome.costUsd,
          durationMs: outcome.durationMs,
          isError: Boolean(outcome.error),
          subtype: outcome.error ? 'error' : 'success',
          contextUsed: outcome.contextUsed,
          contextWindow: outcome.contextWindow,
          ts: Date.now(),
        },
      });
      if (outcome.error) {
        log.error('opencode run error:', outcome.error);
        cb.onEvent({ k: 'error', text: outcome.error });
      }
      return;
    }
  })();

  return {
    abort: () => {
      aborted = true;
      abortController.abort();
      acpClient?.abort();
    },
    done,
  };
}
