import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';
import { renderPrimer } from '../primer.js';
import { foreignKeyViolations, mutateSqliteFile, sqliteAvailable, type SqliteDb } from '../sqlite.js';
import { resolveDevinModelId } from '../../devin/models.js';
import { log } from '../../log.js';

/**
 * Devin 原生会话重建（fidelity: full）。
 *
 * 文件：`~/.local/share/devin/cli/sessions.db`（SQLite，WAL）
 * 续接：ACP `session/load {sessionId, cwd}`（见 `devin/acp.ts` 的 `openSession`）
 *
 * 库结构（对 v3000.6.11 实测逆向）：
 *   sessions(id, working_directory, backend_type, model, agent_mode, created_at,
 *            last_activity_at, title, main_chain_id, shell_last_seen_index,
 *            cogs_json, workspace_dirs, hidden, metadata)
 *   message_nodes(row_id, session_id, node_id, parent_node_id, chat_message,
 *                 created_at, metadata)
 *   tool_call_state(session_id, tool_call_id, tool_call_json, tool_call_update_json)
 *
 * `message_nodes` 是一片**森林**（每个节点指向父节点，一次会话可能有多条链：
 * 系统前缀重建、compact、rewind）。`sessions.main_chain_id` 指向当前主链的
 * **叶节点**，所以历史 = 从叶节点沿 parent 回溯到根，再反转。
 *
 * `chat_message` 是 JSON：`{message_id, role, content, tool_calls?, tool_call_id?,
 * metadata}`。role ∈ system|user|assistant|tool；assistant 节点带 `tool_calls`，
 * 与之配对的 tool 节点靠 `tool_call_id` 关联。
 *
 * 已实测验证：向该库写入合成会话后，`session/list` 能列出、`session/load` 能加载，
 * 且 Devin 能正确读出注入的历史与工具调用结果（问「我第一个问题是什么」能答对）。
 * 会话 id 不要求 Devin 的 adjective-noun slug 格式，任意唯一字符串均可 —— 这里用
 * `vibe-<hex>` 以便溯源。
 */

/** Devin 自己的 schema。用 IF NOT EXISTS 建表，这样即使目标机器从未跑过 devin
 *  （库文件不存在）也能写入，而不是退化成 partial。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  title TEXT,
  main_chain_id INTEGER,
  shell_last_seen_index INTEGER DEFAULT 0,
  cogs_json TEXT,
  workspace_dirs TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);
CREATE TABLE IF NOT EXISTS prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  is_shell INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  rendered_html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, sequence_number)
);
CREATE TABLE IF NOT EXISTS tool_call_state (
    session_id    TEXT    NOT NULL,
    tool_call_id  TEXT    NOT NULL,
    tool_call_json     TEXT,
    tool_call_update_json TEXT,
    PRIMARY KEY (session_id, tool_call_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_message_nodes_session ON message_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_hidden ON sessions(hidden);
`;

/** Devin writes `windsurf` here regardless of the model in use — it is the
 *  name of its inference backend, not a model family. */
const BACKEND_TYPE = 'windsurf';
/** Devin's own default; the switch carries no permission mode of its own. */
const AGENT_MODE = 'accept-edits';

interface Node {
  nodeId: number;
  parent: number | null;
  message: Record<string, unknown>;
  createdAt: number;
}

function fallback(ctx: BuildContext): BuildResult {
  return {
    nativeId: '',
    fidelity: 'partial',
    primer: renderPrimer(ctx.turns, ctx.carryThinking),
    files: [],
  };
}

function buildNodes(ctx: BuildContext): Node[] {
  const nodes: Node[] = [];
  let nextId = 0;
  let clock = Math.max(Math.floor(ctx.now / 1000), 1);
  const nextClock = (preferred: number): number => {
    const seconds = Math.floor(preferred / 1000);
    clock = seconds > clock ? seconds : clock + 1;
    return clock;
  };
  // Each node's parent is the previously appended node, producing the single
  // linear chain Devin reads as the main history.
  let parent: number | null = null;
  const push = (message: Record<string, unknown>, ts: number): void => {
    const nodeId = nextId++;
    nodes.push({ nodeId, parent, message, createdAt: nextClock(ts) });
    parent = nodeId;
  };

  const chatMessage = (
    role: string,
    content: string,
    extra: Record<string, unknown> = {},
    extensions?: Record<string, unknown>,
  ): Record<string, unknown> => ({
    message_id: crypto.randomUUID(),
    role,
    content,
    metadata: {
      num_tokens: null,
      is_user_input: role === 'user',
      request_id: null,
      metrics: null,
      finish_reason: role === 'assistant' ? 'stop' : null,
      created_at: new Date(ctx.now).toISOString(),
      telemetry: { source: role, operation: 'unknown' },
      ...(extensions ? { extensions } : {}),
    },
    ...extra,
  });

  for (const turn of ctx.turns) {
    const userText = renderTurnUserText(turn, ctx.carryThinking);
    if (userText.trim()) {
      push(chatMessage('user', userText), turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
    }

    for (const assistant of turn.assistants) {
      const text = renderAssistantText(assistant);
      if (assistant.tools.length) {
        push(
          chatMessage('assistant', text, {
            tool_calls: assistant.tools.map((tool, index) => ({
              id: tool.toolUseId,
              name: tool.name,
              arguments: normalizeToolInput(tool.input),
              index,
              kind: 'function',
            })),
          }),
          assistant.ts,
        );
        // Devin stores one `tool` node per result, linked back by tool_call_id
        // and placed directly after the assistant node that requested it. It
        // flags a failed call with `chisel/tool_result_meta.success = false`,
        // which is how `isError` survives the round-trip.
        for (const tool of assistant.tools) {
          push(
            chatMessage(
              'tool',
              tool.result ?? '',
              { tool_call_id: tool.toolUseId },
              { 'chisel/tool_result_meta': { success: !tool.isError, kind: 'other' } },
            ),
            assistant.ts,
          );
        }
        continue;
      }
      if (text.trim()) push(chatMessage('assistant', text), assistant.ts);
    }
  }
  return nodes;
}

export const devinAdapter: TargetAdapter = {
  agent: 'devin' as AgentKind,

  get fidelity() {
    return sqliteAvailable() ? 'full' : 'partial';
  },

  newNativeId(): string {
    // Devin accepts arbitrary unique ids (verified: a non-slug id both lists
    // and loads), so a UUID matches the rest of Vibe. Provenance is kept in
    // `sessions.metadata.vibeSessionId` instead of the id itself.
    return crypto.randomUUID();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    if (!sqliteAvailable()) return fallback(ctx);
    const nativeId = ctx.nativeId || this.newNativeId();
    // An empty history still gets a real (empty) native session — that is more
    // useful downstream than a primer carrying nothing.
    const nodes = buildNodes(ctx);

    const dbPath = joinPath(ctx.paths.devinHome, 'cli', 'sessions.db');
    const nowSeconds = Math.floor(ctx.now / 1000);
    const lastActivity = nodes.length ? nodes[nodes.length - 1]!.createdAt : nowSeconds;
    // A family uid is what Vibe stores; Devin's own column holds a variant.
    const model = resolveDevinModelId(ctx.model || 'auto') || 'auto';

    let written = false;
    try {
      written = await mutateSqliteFile(
        ctx.fs,
        dbPath,
        (db: SqliteDb) => {
          db.exec(SCHEMA);
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare(
              `insert into sessions
               (id, working_directory, backend_type, model, agent_mode, created_at,
                last_activity_at, title, main_chain_id, shell_last_seen_index,
                cogs_json, workspace_dirs, hidden, metadata)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              nativeId,
              ctx.cwd,
              BACKEND_TYPE,
              model,
              AGENT_MODE,
              nowSeconds,
              lastActivity,
              ctx.title || 'Vibe switched session',
              // Tip of the chain — Devin walks parents backwards from here. Null
              // for an empty session, which Devin treats as no history.
              nodes.length ? nodes[nodes.length - 1]!.nodeId : null,
              0,
              '[]',
              JSON.stringify([ctx.cwd]),
              0,
              JSON.stringify({ vibeSessionId: ctx.vibeSessionId }),
            );

          const insertNode = db.prepare(
            `insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
             values (?, ?, ?, ?, ?, ?)`,
          );
          const insertToolState = db.prepare(
            `insert or replace into tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json)
             values (?, ?, ?, ?)`,
          );
          // Collect failure flags first so `tool_call_state` (written alongside
          // each assistant node) can record the matching terminal status.
          const toolErrorFlags = new Map<string, boolean>();
          for (const node of nodes) {
            if (node.message.role !== 'tool') continue;
            const id = String(node.message.tool_call_id ?? '');
            if (!id) continue;
            const meta = node.message.metadata as { extensions?: Record<string, { success?: boolean }> } | undefined;
            toolErrorFlags.set(id, meta?.extensions?.['chisel/tool_result_meta']?.success === false);
          }

          for (const node of nodes) {
            insertNode.run(
              nativeId,
              node.nodeId,
              node.parent,
              JSON.stringify(node.message),
              node.createdAt,
              null,
            );
            const calls = node.message.tool_calls as
              | { id?: string; name?: string; arguments?: unknown }[]
              | undefined;
            for (const call of calls ?? []) {
              const id = String(call?.id ?? '');
              if (!id) continue;
              const failed = toolErrorFlags.get(id) === true;
              insertToolState.run(
                nativeId,
                id,
                JSON.stringify({ id, ...call, kind: 'other' }),
                JSON.stringify({ id, status: failed ? 'failed' : 'completed', kind: 'other' }),
              );
            }
          }

          const violations = foreignKeyViolations(db);
          if (violations.length) throw new Error(`devin foreign_key_check failed: ${JSON.stringify(violations).slice(0, 200)}`);
            db.exec('COMMIT');
          } catch (error) {
            try {
              db.exec('ROLLBACK');
            } catch {
              /* original error wins */
            }
            throw error;
          }
        },
        {
          // Devin 也把所有会话放在同一个 sessions.db。远端只合并本次
          // 会话所属的三张表，不再整库覆盖。
          remoteMerge: {
            tables: ['sessions', 'message_nodes', 'tool_call_state'],
            identity: { table: 'sessions', column: 'id', value: nativeId },
          },
        },
      );
    } catch (error) {
      // A malformed/unexpected schema must degrade, not fail the switch.
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(`Devin native SQLite write failed; falling back to primer: ${detail}`);
      return fallback(ctx);
    }
    if (!written) return fallback(ctx);
    return { nativeId, fidelity: 'full', files: [dbPath] };
  },
};
