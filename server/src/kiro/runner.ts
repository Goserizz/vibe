import { log } from '../log.js';
import { KiroAcpClient } from './acp.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { EffortLevel, McpServerDef, PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface KiroRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  /** Native Kiro session id (UUID) to resume. */
  resume?: string;
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

interface Outcome {
  transient: boolean;
  durationMs: number;
  error?: string;
}

/** Drive a Kiro turn through ACP (streaming + interactive approvals). */
export function startKiroRun(opts: KiroRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let acpClient: KiroAcpClient | undefined;
  let aborted = false;
  let producedAny = false;
  let resume = opts.resume;
  const wrappedCb: RunCallbacks = {
    ...cb,
    onClaudeSessionId: (id) => {
      resume = id;
      cb.onClaudeSessionId(id);
    },
    onEvent: (event) => {
      if (isContentEvent(event)) producedAny = true;
      cb.onEvent(event);
    },
  };

  const done = (async () => {
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      acpClient = new KiroAcpClient({ ...opts, resume }, wrappedCb);
      const acpOutcome = await acpClient.run();
      const outcome: Outcome = {
        transient: Boolean(acpOutcome.error && mentionsTransient(acpOutcome.error)),
        durationMs: Date.now() - startedAt,
        error: acpOutcome.error,
      };
      if (aborted) {
        log.debug('kiro run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`kiro transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('kiro run aborted during backoff');
          return;
        }
        continue;
      }
      // Emit a result block so the UI matches other agents' turn end.
      wrappedCb.onEvent({
        k: 'block',
        block: {
          id: `kiro_result_${Date.now()}`,
          kind: 'result',
          durationMs: outcome.durationMs,
          isError: Boolean(outcome.error),
          subtype: outcome.error ? 'error' : 'success',
          ts: Date.now(),
        },
      });
      if (outcome.error) {
        log.error('kiro run error:', outcome.error);
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
