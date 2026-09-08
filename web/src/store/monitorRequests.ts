export const MONITOR_REQUEST_TIMEOUT_MS = 20_000;

export interface MonitorRequestStatus {
  loading: boolean;
  error: string | null;
}

/** One read at a time, with one coalesced follow-up for in-flight invalidations.
 * A refresh never invalidates a successful response. Only reset (account/session
 * change or unmount) does. Callers wait for one read, not an unbounded stream of
 * queued invalidations. The deadline also settles transports that ignore abort.
 */
export function createMonitorRequestLoader<T>(
  fetchSnapshot: (signal: AbortSignal) => Promise<T>,
  commit: (snapshot: T) => void,
  report?: (status: MonitorRequestStatus) => void,
  timeoutMs = MONITOR_REQUEST_TIMEOUT_MS,
): { refresh: () => Promise<void>; reset: () => void } {
  let epoch = 0;
  let error: string | null = null;
  let current: { dirty: boolean; controller: AbortController; done: Promise<void> } | undefined;

  function refresh(): Promise<void> {
    if (current) {
      current.dirty = true;
      return current.done;
    }
    const version = epoch;
    const controller = new AbortController();
    let finish!: () => void;
    const task = { dirty: false, controller, done: new Promise<void>((resolve) => { finish = resolve; }) };
    current = task;
    report?.({ loading: true, error });

    void (async () => {
      let onAbort: () => void = () => {};
      const deadline = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeoutMs / 1_000}s. Please retry.`));
      }, timeoutMs);
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason ?? new Error('Request cancelled'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const snapshot = await Promise.race([fetchSnapshot(controller.signal), aborted]);
        if (epoch === version) {
          commit(snapshot);
          error = null;
          report?.({ loading: false, error });
        }
      } catch (reason) {
        if (epoch === version) {
          error = reason instanceof Error ? reason.message : 'Could not load monitor data. Please retry.';
          report?.({ loading: false, error });
        }
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener('abort', onAbort);
        if (current === task) {
          current = undefined;
          // Publish and settle this read even when more work is queued. In
          // particular, a slow response must not lose to every 15-second poll.
          finish();
          if (task.dirty && epoch === version) void refresh();
        } else {
          finish();
        }
      }
    })();
    return task.done;
  }

  return {
    refresh,
    reset() {
      epoch++;
      error = null;
      const previous = current;
      current = undefined;
      previous?.controller.abort(new Error('Request cancelled'));
    },
  };
}
