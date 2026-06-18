import type { LiveEvent, PermissionDecision, PermissionRequest } from '../../../shared/protocol.js';

export interface RunCallbacks {
  onEvent: (ev: LiveEvent) => void;
  onClaudeSessionId: (id: string) => void;
  /** Resolves when the user (or auto-policy) decides on a tool permission. */
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface RunHandle {
  abort: () => void;
  done: Promise<void>;
}
