import type { BackgroundTask, LiveEvent, PermissionDecision, PermissionRequest } from '../../../shared/protocol.js';

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
}

export interface RunHandle {
  /** Stop only the active foreground reply. A task-aware transport must remain
   *  alive so background work can still settle and trigger a follow-up turn. */
  abort: () => void;
  /** Queue another user message on a still-live agent transport. Returns false
   *  when that transport is already closing and the caller should retry on a
   *  fresh run. */
  sendMessage?: (text: string) => boolean;
  /** Stop one native background task when the engine supports it. */
  stopTask?: (taskId: string) => Promise<void>;
  done: Promise<void>;
}
