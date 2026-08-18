import { log } from '../log.js';
import { GrokAcpClient } from './acp.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { EffortLevel, McpServerDef, PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface GrokRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  /** Native Grok session id (UUID) to resume. */
  resume?: string;
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

interface Outcome {
  transient: boolean;
  durationMs: number;
  error?: string;
}

/** Drive a Grok turn through ACP (streaming + interactive approvals). */
export function startGrokRun(opts: GrokRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let acpClient: GrokAcpClient | undefined;
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
      acpClient = new GrokAcpClient({ ...opts, resume }, wrappedCb);
      const acpOutcome = await acpClient.run();
      const outcome: Outcome = {
        transient: Boolean(acpOutcome.error && mentionsTransient(acpOutcome.error)),
        durationMs: Date.now() - startedAt,
        error: acpOutcome.error,
      };
      if (aborted) {
        log.debug('grok run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`grok transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('grok run aborted during backoff');
          return;
        }
        continue;
      }
      wrappedCb.onEvent({
        k: 'block',
        block: {
          id: `grok_result_${Date.now()}`,
          kind: 'result',
          durationMs: outcome.durationMs,
          isError: Boolean(outcome.error),
          subtype: outcome.error ? 'error' : 'success',
          ts: Date.now(),
        },
      });
      if (outcome.error) {
        log.error('grok run error:', outcome.error);
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
