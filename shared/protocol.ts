/**
 * Vibe wire protocol — the single source of truth shared by the server and the
 * web client.
 *
 * Design goals (the whole point of this tool):
 *  - Smooth, low-latency streaming: assistant text arrives as small `delta`
 *    chunks that the client coalesces per animation frame.
 *  - Lossless reconnection: every state-mutating event carries a monotonic
 *    `seq`. On reconnect the client asks to replay everything after the last
 *    seq it saw, so nothing is lost and we never re-fetch the whole transcript.
 *  - One normalized block model so historical (transcript) and live (SDK)
 *    content render identically.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type Role = 'user' | 'assistant';

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

/** Reasoning/thinking effort Claude applies to a turn. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Which CLI engine drives a session: Claude Code, the Cursor agent, or Codex. */
export type AgentKind = 'claude' | 'cursor' | 'codex';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Running context-window occupancy reported by the model. */
  contextUsed: number;
  contextWindow: number;
}

// ---------------------------------------------------------------------------
// Normalized conversation blocks (what the client renders)
// ---------------------------------------------------------------------------

export type BlockKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'result' | 'error';
export type ToolStatus = 'running' | 'done' | 'error';

interface BaseBlock {
  id: string;
  kind: BlockKind;
  ts: number;
}

export interface UserBlock extends BaseBlock {
  kind: 'user';
  text: string;
}

export interface AssistantBlock extends BaseBlock {
  kind: 'assistant';
  text: string;
  streaming: boolean;
}

export interface ThinkingBlock extends BaseBlock {
  kind: 'thinking';
  text: string;
  streaming: boolean;
}

export interface ToolBlock extends BaseBlock {
  kind: 'tool';
  toolUseId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: string;
  isError?: boolean;
}

export interface ResultBlock extends BaseBlock {
  kind: 'result';
  usage?: TokenUsage;
  costUsd?: number;
  durationMs?: number;
  isError?: boolean;
  subtype?: string;
}

export interface ErrorBlock extends BaseBlock {
  kind: 'error';
  text: string;
}

export type ChatBlock =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | ResultBlock
  | ErrorBlock;

// ---------------------------------------------------------------------------
// Sessions & projects
// ---------------------------------------------------------------------------

export interface SessionMeta {
  /** Stable app-level id. For sessions discovered from `~/.claude` this is the
   *  Claude session id itself. */
  id: string;
  /** Native engine session id used to resume the conversation (Claude session
   *  id, Cursor chat id, or Codex thread id — all UUIDs). */
  claudeSessionId?: string;
  title: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  /** Which CLI engine drives this session (default 'claude'). */
  agent: AgentKind;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  running: boolean;
  /** 'vibe' = created/managed in Vibe; 'claude'/'cursor'/'codex' = discovered from that CLI. */
  source: 'vibe' | 'claude' | 'cursor' | 'codex';
  /** Which machine the project lives on (local machine name, or an SSH host). */
  host: string;
}

/** A remote machine reachable over SSH whose Claude sessions Vibe surfaces. */
export interface RemoteHost {
  /** Display name + stable id (unique). */
  name: string;
  /** SSH target: an `~/.ssh/config` alias or `user@host[:port]`. */
  ssh: string;
}

export interface HostStatus {
  name: string;
  ssh: string;
  /** Whether the last reachability check succeeded. */
  online: boolean;
  /** Whether `claude` is installed on the host. */
  claude: boolean;
  error?: string;
}

export interface ProjectDir {
  path: string;
  name: string;
  lastUsed?: number;
  sessionCount?: number;
}

/** An entry in a directory listing shown in the Files panel (file or subdir). */
export interface FileEntry {
  name: string;
  dir: boolean;
  size?: number;
}

/** A full-text match inside a conversation (user/assistant/thinking text). */
export interface SearchHit {
  kind: 'user' | 'assistant' | 'thinking';
  /** Short text window around the match (plain text; client highlights the query). */
  snippet: string;
}

/** A conversation that matched a full-text search, ready to render in a list. */
export interface SearchResult {
  /** App-level session id (openable via `openSession`). */
  sessionId: string;
  title: string;
  cwd: string;
  host: string;
  source: 'vibe' | 'claude';
  updatedAt: number;
  /** Up to a few matching snippets, best first. */
  hits: SearchHit[];
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  ts: number;
  /** Plan markdown for ExitPlanMode review. The tool's input only carries
   *  `allowedPrompts`; the plan text lives in a file the server reads and
   *  attaches here. Undefined for every other tool (and for remote turns). */
  plan?: string;
}

export interface PermissionDecision {
  allow: boolean;
  /** Remember the allow rule for the rest of this session. */
  remember?: boolean;
  updatedInput?: unknown;
}

// ---------------------------------------------------------------------------
// Live events (seq-tagged; these mutate block state and are replayable)
// ---------------------------------------------------------------------------

export type LiveEvent =
  | { k: 'block'; block: ChatBlock }
  | { k: 'delta'; id: string; field: 'text'; chunk: string }
  | { k: 'block_end'; id: string; text?: string }
  | { k: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { k: 'run_state'; running: boolean }
  | { k: 'token_usage'; usage: TokenUsage }
  | { k: 'error'; text: string };

// ---------------------------------------------------------------------------
// WebSocket: client -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'subscribe'; sessionId: string; lastSeq: number }
  | { t: 'unsubscribe'; sessionId: string }
  | { t: 'send'; sessionId: string; clientMsgId: string; text: string }
  | { t: 'abort'; sessionId: string }
  | { t: 'permission'; sessionId: string; requestId: string; decision: PermissionDecision }
  | { t: 'ping' };

// ---------------------------------------------------------------------------
// WebSocket: server -> client
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { t: 'hello'; protocolVersion: number; serverVersion: string }
  | {
      t: 'subscribed';
      sessionId: string;
      /** Current server seq for this session; subscribe from here next time. */
      seq: number;
      running: boolean;
      /** When true the client must discard live state and reload the transcript. */
      reset: boolean;
      pendingPermissions: PermissionRequest[];
    }
  | { t: 'event'; sessionId: string; seq: number; ev: LiveEvent }
  | { t: 'permission_request'; sessionId: string; request: PermissionRequest }
  | {
      t: 'permission_resolved';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'deny' | 'cancelled';
    }
  | { t: 'session_meta'; session: SessionMeta }
  | { t: 'session_removed'; sessionId: string }
  | { t: 'pong' }
  | { t: 'error'; message: string; sessionId?: string };
