import { log } from '../log.js';
import { ZcodeAppServerClient, type ZcodeRunOptions } from './appServer.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';
import { applyZcodeMcp } from '../mcp/apply.js';
import { assertZcodeStartupConfig } from './configFile.js';
import { ensureZcodePersonalProviders } from './personalConfig.js';

export interface ZcodeRunnerDeps {
  prepareMcp?: typeof applyZcodeMcp;
  /** Project cli/config.json providers into v2/provider_config.json so
   *  app-server (which does not import the legacy file) can select a model. */
  ensurePersonalProviders?: typeof ensureZcodePersonalProviders;
  createClient?: (opts: ZcodeRunOptions, cb: RunCallbacks) => Pick<ZcodeAppServerClient, 'run' | 'abort' | 'stopTask' | 'queueMessage'>;
}

/** SSH link corruption (bad packets) that kills the transport mid-stream —
 *  retry is safe (session state persists remotely, client re-resumes).
 *  "transport stalled" is the silent variant: the link stays up (keepalives
 *  pass) but a setup request's reply is lost — the setup timeout rejects with
 *  it, and a backoff retry over a fresh connection clears it. */
const TRANSPORT_DEATH = /exited mid-turn|message authentication code incorrect|ssh_dispatch_run_fatal|transport stalled/i;
/** SQLite write-lock contention: concurrent zcode sessions on one host share a
 *  single db.sqlite; the loser's turn fails wholesale. The turn transaction
 *  rolled back on the host, so a retry (even after streamed partial output)
 *  re-runs cleanly — same contract as transport death. No cross-session
 *  mutex: turns stay concurrent and simply retry after a few seconds. */
const SQLITE_LOCK = /ERR_SQLITE_ERROR|database is locked|SQLite migration lock/i;

interface Outcome {
  transient: boolean;
  durationMs: number;
  error?: string;
}

/** Drive a ZCode turn through the app-server protocol (streaming + approvals). */
export function startZcodeRun(opts: ZcodeRunOptions, cb: RunCallbacks, deps: ZcodeRunnerDeps = {}): RunHandle {
  const abortController = new AbortController();
  let client: ReturnType<NonNullable<ZcodeRunnerDeps['createClient']>> | undefined;
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
    // ZCode reads MCP from its JSON config when app-server starts.
    const prepareStarted = Date.now();
    try {
      const state = await (deps.prepareMcp ?? applyZcodeMcp)(
        opts.mcpServers ?? [],
        opts.remote ? { sshTarget: opts.remote.sshTarget } : undefined,
        { cwd: opts.remote?.cwd ?? opts.cwd },
      );
      if (aborted) return;
      assertZcodeStartupConfig(state, resume);
      await (deps.ensurePersonalProviders ?? ensureZcodePersonalProviders)(
        opts.remote ? { sshTarget: opts.remote.sshTarget } : undefined,
      );
    } catch (error) {
      if (aborted) return;
      const text = error instanceof Error ? error.message : String(error);
      wrappedCb.onEvent({ k: 'block', block: { id: `zcode_result_${Date.now()}`, kind: 'result',
        durationMs: Date.now() - prepareStarted, isError: true, subtype: 'error', ts: Date.now() } });
      wrappedCb.onEvent({ k: 'error', text });
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      client = deps.createClient?.({ ...opts, resume }, wrappedCb) ?? new ZcodeAppServerClient({ ...opts, resume }, wrappedCb);
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
      // Transport death can strike mid-stream, after content already streamed —
      // still retryable (the resume picks up the remote session state), but
      // capped tighter than the generic case to avoid a resume storm. A SQLite
      // lock conflict behaves the same: the failed turn rolled back on the
      // host, so even a turn that streamed partial output re-runs cleanly.
      const transportDeath = Boolean(outcome.error && TRANSPORT_DEATH.test(outcome.error));
      const lockConflict = Boolean(outcome.error && SQLITE_LOCK.test(outcome.error));
      const retryAnyway = transportDeath || lockConflict;
      // Lock contention on a busy host can outlast a short window (a giant
      // turn may hold the writer for minutes), so give locks a much longer
      // ladder: 8 tries with the backoff capped at ~30s ≈ 3 minutes total.
      const cap = lockConflict ? 8 : retryAnyway ? 3 : MAX_RETRIES;
      if (outcome.transient && (!producedAny || retryAnyway) && attempt < cap) {
        const raw = backoffFor(attempt);
        const backoff = lockConflict ? Math.min(raw, 30_000) : raw;
        log.warn(`zcode transient error${retryAnyway ? ` (${transportDeath ? 'transport death' : 'db lock'})` : ''}, retry ${attempt + 1}/${cap} in ${backoff}ms`);
        if (retryAnyway && producedAny) {
          wrappedCb.onEvent({
            k: 'error',
            text: `⚠️ ${transportDeath ? 'SSH 链路中断' : '数据库锁冲突（同主机其它会话占用）'}，${Math.round(backoff / 1000)}s 后自动重试（第 ${attempt + 1}/${cap} 次）…`,
          });
        }
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
