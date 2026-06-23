/**
 * Shared retry policy for transient server errors — primarily the GLM proxy's
 * 529 "model overloaded", which the headless Claude paths (local Agent SDK and
 * remote `claude --print`) surface as a hard failure instead of retrying like
 * the interactive CLI does. Both runners consume these helpers so the two paths
 * share one definition of "transient" and one backoff curve.
 */

/** Max retries for transient server errors. */
export const MAX_RETRIES = 5;
/** Base backoff (ms) for the first retry; doubles each attempt. */
export const INITIAL_BACKOFF_MS = 2000;

/** True for errors worth retrying — e.g. the GLM proxy's "model overloaded" (529). */
export function isTransientError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /529|overloaded|访问量过大|过载|temporarily|try again/i.test(text);
}

/**
 * True if a raw output chunk (stdout/stderr) mentions a transient failure.
 * The remote CLI can emit the 529 text on stdout (a stream-json error result)
 * with an empty stderr, so we must scan the stream itself, not just the exit.
 */
export function mentionsTransient(text: string): boolean {
  return /529|overloaded|访问量过大|过载/i.test(text);
}

/** Backoff (ms) for attempt N (0-based): base * 2^N + small jitter. */
export function backoffFor(attempt: number): number {
  return INITIAL_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 500);
}

/**
 * True for a "real content" event — assistant text/thinking/tool, deltas, tool
 * results. Excludes `result`/`error` blocks so a 529 error-result the CLI emits
 * on stdout doesn't count as streamed output and block a retry.
 */
export function isContentEvent(ev: { k: string; block?: { kind?: string } }): boolean {
  if (ev.k === 'delta' || ev.k === 'tool_result') return true;
  if (ev.k === 'block') {
    const kind = ev.block?.kind;
    return kind === 'assistant' || kind === 'thinking' || kind === 'tool';
  }
  return false;
}

/** Resolves after `ms`, or rejects early if `signal` aborts. Used by the local SDK runner. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}
