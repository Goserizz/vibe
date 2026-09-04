import type { VibotAskQuestion } from '../../../shared/protocol.js';

/** Answers keyed by question text (mirrors the coding-agent AskUserQuestion shape). */
export type AskAnswers = Record<string, string | string[]>;

/** Outcome of a pending ask — always settles; never rejects. */
export type AskOutcome =
  | { type: 'answered'; answers: AskAnswers }
  | { type: 'timeout' }
  | { type: 'cancelled' };

const TIMEOUT_MS = 10 * 60_000;

interface Pending {
  resolve: (outcome: AskOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  questions: VibotAskQuestion[];
}

const pending = new Map<string, Pending>();

function key(convId: string, callId: string): string {
  return `${convId}\0${callId}`;
}

function settle(k: string, outcome: AskOutcome): boolean {
  const entry = pending.get(k);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(k);
  entry.resolve(outcome);
  return true;
}

/**
 * Register a pending ask. Resolves with the user's answers, or `timeout` /
 * `cancelled`. Race-safe: only the first settle wins; the promise never rejects.
 */
export function register(
  convId: string,
  callId: string,
  questions: VibotAskQuestion[],
): Promise<AskOutcome> {
  const k = key(convId, callId);
  // Replace any stale entry for the same call (should not happen in practice).
  settle(k, { type: 'cancelled' });

  return new Promise<AskOutcome>((resolve) => {
    const timer = setTimeout(() => {
      settle(k, { type: 'timeout' });
    }, TIMEOUT_MS);
    pending.set(k, { resolve, timer, questions });
  });
}

/** Resolve with the user's answers. Returns false if unknown/expired. */
export function resolve(convId: string, callId: string, answers: AskAnswers): boolean {
  return settle(key(convId, callId), { type: 'answered', answers });
}

/** Mark a single ask as user-dismissed / cancelled. */
export function cancel(convId: string, callId: string): boolean {
  return settle(key(convId, callId), { type: 'cancelled' });
}

/** Cancel every pending ask for a conversation. Returns the cancelled callIds. */
export function cancelAll(convId: string): string[] {
  const prefix = `${convId}\0`;
  const callIds: string[] = [];
  for (const k of [...pending.keys()]) {
    if (!k.startsWith(prefix)) continue;
    const callId = k.slice(prefix.length);
    if (settle(k, { type: 'cancelled' })) callIds.push(callId);
  }
  return callIds;
}
