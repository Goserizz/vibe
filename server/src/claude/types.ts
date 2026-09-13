import type { AgentQuestionItem, BackgroundTask, LiveEvent, PermissionDecision, PermissionRequest } from '../../../shared/protocol.js';

export interface RunCallbacks {
  onEvent: (ev: LiveEvent) => void;
  onClaudeSessionId: (id: string) => void;
  /** Resolves when the user (or auto-policy) decides on a tool permission. */
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Upsert one native background task in the session task registry. */
  onTask?: (task: BackgroundTask) => void;
  /** Foreground model turn state. The transport may remain alive after this
   *  becomes false while native background tasks continue running. */
  onTurnState?: (running: boolean) => void;
  /** A new live async question; never reconstructed from historical messages. */
  onAsyncQuestion?: (question: { id: string; questions: AgentQuestionItem[] }) => void;
}

export interface RunHandle {
  /** Stop only the active foreground reply. A task-aware transport must remain
   *  alive so background work can still settle and trigger a follow-up turn. */
  abort: () => void;
  /** Queue another user message on a still-live agent transport. Returns false
   *  when that transport is already closing and the caller should retry on a
   *  fresh run. */
  sendMessage?: (text: string) => boolean;
  /** True only after native ACK; false means definitely not accepted. A throw
   * means delivery may be ambiguous and must not be retried automatically. */
  steerMessage?: (text: string, clientMessageId: string) => Promise<boolean>;
  /** Stop one native background task when the engine supports it. */
  stopTask?: (taskId: string) => Promise<void>;
  done: Promise<void>;
}
