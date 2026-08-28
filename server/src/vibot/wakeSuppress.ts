/**
 * Shared latch: a Vibot-managed coding session just finished a foreground turn
 * and Vibot owns the follow-up. ZCode's task poller reads this so it does not
 * start a duplicate wake turn for the same completion.
 */

const DEFAULT_MS = 15_000;

const untilBySession = new Map<string, number>();
const promptBySession = new Map<string, string>();

export function markDelegateWake(sessionId: string, prompt: string, ms = DEFAULT_MS): void {
  untilBySession.set(sessionId, Date.now() + ms);
  promptBySession.set(sessionId, prompt);
}

/** Extend an existing suppress window (e.g. when a queued silent turn finally starts). */
export function refreshDelegateWake(sessionId: string, ms = DEFAULT_MS): void {
  if (!sessionId) return;
  const prompt = promptBySession.get(sessionId);
  if (prompt == null && !untilBySession.has(sessionId)) return;
  untilBySession.set(sessionId, Date.now() + ms);
}

export function isDelegateWakeActive(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  const until = untilBySession.get(sessionId);
  if (until == null) return false;
  if (Date.now() > until) {
    untilBySession.delete(sessionId);
    promptBySession.delete(sessionId);
    return false;
  }
  return true;
}

export function peekDelegateWakePrompt(sessionId: string | undefined | null): string | undefined {
  if (!isDelegateWakeActive(sessionId) || !sessionId) return undefined;
  return promptBySession.get(sessionId);
}
