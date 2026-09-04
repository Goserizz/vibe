import { log } from '../log.js';
import { DevinAcpClient } from './acp.js';
import { resolveDevinVariant } from './models.js';
import { usageContextTokens } from '../claude/normalize.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { EffortLevel, McpServerDef, PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface DevinRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  /** Native Devin session id (e.g. `resilient-package`) to resume. */
  resume?: string;
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

interface Outcome {
  transient: boolean;
  durationMs: number;
  error?: string;
}

/** Drive a Devin turn through ACP (streaming + interactive approvals). */
export function startDevinRun(opts: DevinRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let acpClient: DevinAcpClient | undefined;
  let aborted = false;
  let producedAny = false;
  let resume = opts.resume;
  // Latest request's context size, from the prompt response's cumulative
  // usage — reported on the result block so the UI shows the token footprint.
  let contextUsed: number | undefined;

  // Devin takes a single model uid that already encodes the effort
  // (`claude-opus-5-high`), while Vibe lets the user pick family and effort
  // separately. Assemble once here so both reach the CLI as one value — the
  // variant's context window comes along for the result block's token line.
  const { uid: modelId, contextWindow } =
    opts.model && opts.model !== 'auto' ? resolveDevinVariant(opts.model, opts.effort) : { uid: undefined, contextWindow: undefined };

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
      acpClient = new DevinAcpClient({ ...opts, modelId, resume }, wrappedCb);
      const acpOutcome = await acpClient.run();
      const used = usageContextTokens(acpOutcome.usage);
      if (used) contextUsed = used;
      const outcome: Outcome = {
        transient: Boolean(acpOutcome.error && mentionsTransient(acpOutcome.error)),
        durationMs: Date.now() - startedAt,
        error: acpOutcome.error,
      };
      if (aborted) {
        log.debug('devin run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`devin transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('devin run aborted during backoff');
          return;
        }
        continue;
      }
      // Emit a result block so the UI matches other agents' turn end.
      wrappedCb.onEvent({
        k: 'block',
        block: {
          id: `devin_result_${Date.now()}`,
          kind: 'result',
          durationMs: outcome.durationMs,
          isError: Boolean(outcome.error),
          subtype: outcome.error ? 'error' : 'success',
          contextUsed,
          contextWindow,
          ts: Date.now(),
        },
      });
      if (outcome.error) {
        log.error('devin run error:', outcome.error);
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
