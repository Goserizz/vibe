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

export const PROTOCOL_VERSION = 2;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type Role = 'user' | 'assistant';

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

/** Reasoning/thinking effort applied to a turn. Claude tops out at `max`; Codex's
 *  newer models (gpt-5.6-*) also accept `ultra` (per their cached levels). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** Which CLI engine drives a session. */
export type AgentKind = 'claude' | 'cursor' | 'codex' | 'kimi' | 'kiro';

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

/** Status of a single task in an agent's todo list. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** A single task in an agent's todo list. Claude's `TodoWrite` carries the full
 *  list on every call (a snapshot, not incremental), so the most recent todo-kind
 *  tool block is the source of truth for the current state. */
export interface Todo {
  /** Imperative label (e.g. "Fix the login bug"). */
  content: string;
  status: TodoStatus;
  /** Present-tense label some agents include (Claude's `activeForm`), shown while
   *  the task is in progress. */
  activeForm?: string;
}

// ---------------------------------------------------------------------------
// Sessions & projects
// ---------------------------------------------------------------------------

export interface SessionMeta {
  /** Stable app-level id. For sessions discovered from `~/.claude` this is the
   *  Claude session id itself. */
  id: string;
  /** Native engine session id used to resume the conversation (Claude session
   *  id, Cursor chat id, Codex thread id, Kimi session id, or Kiro session id). */
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
  /** True while one or more Background tasks are still active, independently
   *  of whether the foreground model turn is currently producing a reply. */
  backgroundTasksRunning: boolean;
  running: boolean;
  /** 'vibe' = managed in Vibe; otherwise discovered from that CLI. */
  source: 'vibe' | 'claude' | 'cursor' | 'codex' | 'kimi' | 'kiro';
  /** Which machine the project lives on (local machine name, or an SSH host). */
  host: string;
  /** True when the cwd is an auto-created throwaway folder under the fixed
   *  workdirs base. These never surface in the "common directories" list. */
  ephemeral?: boolean;
  /** User-favorited/pinned session. Pinned sessions sort to the top of the
   *  sidebar ahead of recency. Stored as an id set on the server, so it applies
   *  to discovered (non-adopted) sessions too. */
  pinned?: boolean;
}

/** Sidebar display order: favorited (pinned) sessions first, then most-recently-
 *  updated. The single comparator shared by the server (list output + cache) and
 *  the web client (live session_meta re-sort) so the two always agree on order. */
export function compareSessions(a: SessionMeta, b: SessionMeta): number {
  const pa = a.pinned ? 1 : 0;
  const pb = b.pinned ? 1 : 0;
  if (pa !== pb) return pb - pa;
  return b.updatedAt - a.updatedAt;
}

/** A remote machine reachable over SSH whose Claude sessions Vibe surfaces. */
export interface RemoteHost {
  /** Display name + stable id (unique). */
  name: string;
  /** SSH target: an `~/.ssh/config` alias or `user@host[:port]`. */
  ssh: string;
  /** Optional HTTP(S) proxy the remote agent (claude / cursor-agent / codex /
   *  kimi / kiro-cli) routes its API traffic through when launched on this host.
   *  Injected as HTTP_PROXY / HTTPS_PROXY (both cases) into the remote process
   *  env. This is the default for every agent; a value in `proxyByAgent`
   *  overrides it. */
  proxy?: string;
  /** Per-agent proxy overrides — an entry here beats `proxy` for that agent's API
   *  traffic. Empty/absent entries fall back to `proxy`. Lets one host route, say,
   *  Cursor and Claude through different proxies. */
  proxyByAgent?: Partial<Record<AgentKind, string>>;
}

/** Transport for an MCP server managed by Vibe. */
export type McpTransport = 'stdio' | 'sse' | 'http';

/**
 * A Model Context Protocol server definition. Stdio servers run a command;
 * sse/http servers point at a URL. The command/path/env are interpreted on the
 * host the session runs on — i.e. on the remote machine for SSH sessions — so a
 * server enabled for a remote host must reference executables that exist there.
 */
export interface McpServerDef {
  /** Unique name; also the namespace the agent exposes the server's tools under. */
  name: string;
  transport: McpTransport;
  /** stdio: the executable to launch. */
  command?: string;
  /** stdio: argv passed to the command. */
  args?: string[];
  /** stdio: extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** sse | http: the server endpoint. */
  url?: string;
  /** sse | http: request headers. */
  headers?: Record<string, string>;
  /** http | sse only. `oauth` = Vibe runs the standard MCP-OAuth flow (RFC 9728
   *  → RFC 8414 → RFC 7591 DCR → PKCE), stores + refreshes tokens, and injects
   *  `Authorization: Bearer` for every turn. Default/`none` = use static headers. */
  auth?: 'none' | 'oauth';
}

/** Connection status for an OAuth-managed MCP server. */
export interface McpOAuthStatus {
  connected: boolean;
  /** Epoch ms when the access token expires (if connected). */
  expiresAt?: number;
}

/**
 * Full MCP configuration surfaced to the UI: the global registry of server
 * definitions plus the per-scope enable lists. A scope is either `'local'`
 * (sessions running on this machine) or a remote host name.
 */
export interface McpConfigSnapshot {
  servers: McpServerDef[];
  /** Scope -> enabled server names. The `'local'` scope covers non-remote sessions. */
  enabled: Record<string, string[]>;
  /** OAuth connection status, keyed by server name (oauth-managed servers only). */
  oauth: Record<string, McpOAuthStatus>;
}

/**
 * A saved New-session engine configuration. Host-agnostic: the four fields a
 * user tends to re-pick each time. Selecting a preset in the New Session dialog
 * fills these in; the dialog's host-aware fallbacks reconcile anything that
 * isn't valid for the chosen machine (e.g. a Codex model absent on a remote box).
 */
export interface SessionPreset {
  /** Unique display name; also the key. */
  name: string;
  agent: AgentKind;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
}

/**
 * Where a skill lives. `personal` = user-authored under the agent's user skills
 * dir (editable); `system` = the agent's installed plugin/built-in skills
 * (read-only). All five supported agents (Claude, Cursor, Codex, Kimi, Kiro)
 * use the same Agent Skills standard (a `<name>/SKILL.md` with YAML
 * frontmatter), just at different directories.
 */
export type SkillScope = 'personal' | 'system';

/** Lightweight row in the Skills list. Frontmatter/body are fetched on open. */
export interface SkillEntry {
  /** Directory name — also the filesystem key for personal skills. */
  name: string;
  scope: SkillScope;
  /** Which agent this skill belongs to. */
  agent: AgentKind;
  /** Absolute path to SKILL.md for system skills (read-only). Undefined for
   *  personal skills, where the path is derived from the name. */
  source?: string;
}

/** Full skill content, returned when a user opens one. */
export interface SkillDetail {
  /** Directory name (filesystem key). */
  name: string;
  scope: SkillScope;
  agent: AgentKind;
  source?: string;
  /** Frontmatter `name` (may diverge from the directory name after an edit). */
  frontmatterName?: string;
  description: string;
  /** Optional `whenToUse` frontmatter key some skill authors set. */
  whenToUse?: string;
  /** Markdown body below the closing `---` fence. */
  body: string;
  /** True for system skills — not editable or deletable. */
  readOnly: boolean;
}

/**
 * Agent config files (e.g. Claude's `~/.claude/settings.json`, Codex's
 * `~/.codex/config.toml`). Surfaced as raw text — JSON or TOML — so formatting
 * and comments are preserved on edit. The client only ever sends the opaque
 * `id`; the server resolves it to a path from a fixed per-agent allowlist.
 */
export interface ConfigFileEntry {
  /** Opaque key from the server's allowlist (e.g. `settings`, `config`). */
  id: string;
  agent: AgentKind;
  /** Display label (e.g. `settings.json`, `config.toml`). */
  label: string;
  /** `~`-prefixed path shown to the user (remote-form, never a client input). */
  relPath: string;
  /** Whether the file currently exists on disk. */
  exists: boolean;
  /** Size in bytes (0 when missing). */
  size: number;
}

/** Full config file content, returned when a user opens one for editing. */
export interface ConfigFileDetail {
  id: string;
  agent: AgentKind;
  label: string;
  relPath: string;
  /** Raw file text (empty string when the file doesn't exist yet). */
  content: string;
  exists: boolean;
  /** Always false for now (these are user-owned files); kept for symmetry. */
  readOnly: boolean;
}

/** Install + version info for one agent CLI on a host. */
export interface AgentInstallInfo {
  installed: boolean;
  /** Parsed version string when the CLI reported one (e.g. `2.1.191`). */
  version?: string;
}

/** Per-agent install state discovered on a host. */
export type HostAgentsStatus = Record<AgentKind, AgentInstallInfo>;

export interface HostStatus {
  name: string;
  ssh: string;
  /** Whether the last reachability check succeeded. */
  online: boolean;
  /** Whether `claude` is installed on the host (kept for older clients). */
  claude: boolean;
  /** Per-agent install + version probe. */
  agents?: HostAgentsStatus;
  error?: string;
}

/** Latest published versions for each agent CLI (server-side cache). */
export type AgentLatestVersions = Partial<Record<AgentKind, string>>;

/** Result of updating (or installing) an agent CLI on a host. */
export interface AgentUpdateResult {
  ok: boolean;
  agent: AgentKind;
  /** Version after the update, when we could re-probe it. */
  version?: string;
  error?: string;
  /** Truncated command output for debugging. */
  log?: string;
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
  /** Plan markdown for ExitPlanMode review. Claude ≥2.1 injects the plan text
   *  into the tool input (input.plan), which the server copies here. Older CLIs
   *  omit it and the server falls back to reading ~/.claude/plans (local only).
   *  Undefined for every other tool. */
  plan?: string;
}

export interface PermissionDecision {
  allow: boolean;
  /** Remember the allow rule for the rest of this session. */
  remember?: boolean;
  updatedInput?: unknown;
}

// ---------------------------------------------------------------------------
// Vibot — the separate built-in assistant (its own subsystem & WS namespace)
// ---------------------------------------------------------------------------

/**
 * Vibot's own LLM API configuration, independent of the coding-agent CLIs.
 * Stored server-side at ~/.vibe/vibot.json (mode 0600). The API key is never
 * returned in full to the client — {@link VibotConfigClient} carries
 * `hasApiKey` instead. Vibot speaks an OpenAI-compatible Chat Completions API
 * (streaming + tool calls), which covers GLM, DeepSeek, Kimi/Moonshot, OpenAI,
 * OpenRouter, and local servers via a single {baseUrl, apiKey, model} triple.
 */
export interface VibotConfig {
  /** Base URL of an OpenAI-compatible endpoint, no `/chat/completions`. */
  baseUrl: string;
  /** API key (secret). Empty string ⇒ unconfigured. */
  apiKey: string;
  /** Model id as the provider expects it (e.g. `glm-4.6`, `deepseek-chat`). */
  model: string;
  /** Editable system prompt; defaults to the built-in Vibot prompt. */
  systemPrompt: string;
  temperature?: number;
}

/** Safe-to-send projection of {@link VibotConfig}: the key never leaves the
 *  server; the client only learns whether one is set. */
export interface VibotConfigClient {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  hasApiKey: boolean;
}

/** A Vibot conversation row for the sidebar. Lives only in the Vibot store —
 *  never mixed into the coding `SessionMeta` list. */
export interface VibotConvMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  running: boolean;
}

/** A durable note Vibot chose to remember. */
export interface VibotMemory {
  id: string;
  /** Short slug; also the user-facing name. */
  name: string;
  description: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Agent background tasks
// ---------------------------------------------------------------------------

/** Lifecycle shared by Claude tasks, Kimi background tools, and Codex
 *  background terminals. Terminal states intentionally use one vocabulary even
 *  though the three engines spell them differently. */
export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';

export type BackgroundTaskKind = 'command' | 'subagent' | 'other';

/** A task which can outlive the agent turn that created it. Task ids are native
 *  engine ids, scoped to a Vibe session. */
export interface BackgroundTask {
  id: string;
  agent: AgentKind;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  description: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  command?: string;
  /** Original prompt/instructions when the engine exposes them. */
  detail?: string;
  /** Working directory reported by command-style tasks. */
  cwd?: string;
  /** Most recent engine activity, for example Claude's current tool. */
  activity?: string;
  /** Engine-generated progress or completion summary. */
  summary?: string;
  /** A short, display-safe output/summary. Full logs remain in the engine's file. */
  output?: string;
  outputFile?: string;
  exitCode?: number;
  processId?: string;
  /** False when the engine exposes observation but no per-task stop primitive. */
  canStop: boolean;
  error?: string;
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
  | { k: 'task_upsert'; task: BackgroundTask }
  | { k: 'error'; text: string };

// ---------------------------------------------------------------------------
// WebSocket: client -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'subscribe'; sessionId: string; lastSeq: number }
  | { t: 'unsubscribe'; sessionId: string }
  | { t: 'send'; sessionId: string; clientMsgId: string; text: string }
  | { t: 'abort'; sessionId: string }
  | { t: 'task_stop'; sessionId: string; taskId: string }
  | { t: 'permission'; sessionId: string; requestId: string; decision: PermissionDecision }
  | { t: 'vibot_subscribe'; convId: string; lastSeq: number }
  | { t: 'vibot_unsubscribe'; convId: string }
  | { t: 'vibot_send'; convId: string; clientMsgId: string; text: string }
  | { t: 'vibot_abort'; convId: string }
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
      tasks: BackgroundTask[];
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
  // -- Vibot (separate interface; reuses LiveEvent so BlockView renders it) --
  | { t: 'vibot_event'; convId: string; seq: number; ev: LiveEvent }
  | {
      t: 'vibot_subscribed';
      convId: string;
      /** Current server seq for this conversation. */
      seq: number;
      running: boolean;
      /** When true the client must discard live state and reload history. */
      reset: boolean;
    }
  | { t: 'vibot_conv_meta'; conv: VibotConvMeta }
  | { t: 'vibot_conv_removed'; convId: string }
  | { t: 'vibot_conv_list'; convs: VibotConvMeta[] }
  | { t: 'pong' }
  | { t: 'error'; message: string; sessionId?: string };
