import { log } from '../log.js';
import { ZcodeAppServerClient, type ZcodeRunOptions } from './appServer.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

interface Outcome {
  transient: boolean;
  durationMs: number;
  error?: string;
}

/** Drive a ZCode turn through the app-server protocol (streaming + approvals). */
export function startZcodeRun(opts: ZcodeRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let client: ZcodeAppServerClient | undefined;
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
      client = new ZcodeAppServerClient({ ...opts, resume }, wrappedCb);
      const outcome: Outcome = { transient: false, durationMs: 0, error: undefined };
      let usage: Awaited<ReturnType<ZcodeAppServerClient['run']>>['usage'];
      let turnResults = 0;
      try {
        const result = await client.run();
        usage = result.usage;
        outcome.error = result.error;
        turnResults = result.turnResults ?? 0;
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error);
      }
      outcome.durationMs = Date.now() - startedAt;
      outcome.transient = Boolean(outcome.error && mentionsTransient(outcome.error));
      if (aborted) {
        log.debug('zcode run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`zcode transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('zcode run aborted during backoff');
          return;
        }
        continue;
      }
      // Turn-level footers already streamed during the run (one per completed
      // turn); this block only covers runs that ended before any turn did
      // (spawn/auth failures, early transport death).
      if (!turnResults) {
        wrappedCb.onEvent({
          k: 'block',
          block: {
            id: `zcode_result_${Date.now()}`,
            kind: 'result',
            durationMs: usage?.durationMs ?? outcome.durationMs,
            isError: Boolean(outcome.error),
            subtype: outcome.error ? 'error' : 'success',
            contextUsed: usage?.contextUsed,
            contextWindow: usage?.contextWindow,
            ts: Date.now(),
          },
        });
      }
      if (outcome.error) {
        log.error('zcode run error:', outcome.error);
        cb.onEvent({ k: 'error', text: outcome.error });
      }
      return;
    }
  })();

  return {
    abort: () => {
      aborted = true;
      abortController.abort();
      client?.abort();
    },
    // Cancels a background task while the transport is alive (it stays up
    // servicing tasks after the foreground turn ends).
    stopTask: (taskId: string) => client?.stopTask(taskId) ?? Promise.resolve(),
    // Steer a new user message through the still-live transport instead of
    // rejecting it while background tasks are being serviced.
    sendMessage: (text: string) => (client ? client.queueMessage(text) : false),
    done,
  };
}
