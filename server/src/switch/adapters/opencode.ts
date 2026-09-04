import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';
import { renderPrimer } from '../primer.js';
import { foreignKeyViolations, mutateSqliteFile, openSqliteReadonly, sqliteAvailable, type SqliteDb } from '../sqlite.js';
import { log } from '../../log.js';

/**
 * opencode 原生会话重建（fidelity: full）。
 *
 * 库：`<data-home>/opencode.db`（SQLite，WAL；data-home 为
 * `~/.local/share/opencode`，远端同理用该用户 HOME 推导）
 * 续接：`opencode run -s <ses_id> …`
 *
 * 库结构（对 opencode 1.18.27 实测逆向）：
 *   project(id, worktree, …, sandboxes) —— 会话都挂在唯一的 `global` 行
 *     （worktree `/`）下；
 *   session(id ses_…, project_id FK, directory, path, title, agent `build`,
 *     model JSON `{id,providerID,variant?}`, cost/tokens_*, times ms)；
 *   message(id msg_…, session_id FK, data JSON) —— user
 *     `{role:user, time, agent, model, summary}` / assistant
 *     `{parentID, role:assistant, mode, agent, path, tokens, time, finish}`；
 *   part(id prt_…, message_id FK, session_id, data JSON) —— `{type:text}` /
 *     `{type:reasoning}` / `{type:tool, tool, callID, state}` / step 标记。
 *
 * reasoning 只写有可读文本的（provider 加密推理没有明文，绝不伪造）；
 * 历史 thinking 走统一的用户侧迁移档案，不进 reasoning。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL,
  vcs TEXT,
  name TEXT,
  icon_url TEXT,
  icon_url_override TEXT,
  icon_color TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_initialized INTEGER,
  sandboxes TEXT NOT NULL,
  commands TEXT
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  path TEXT,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  share_url TEXT,
  summary_additions INTEGER,
  summary_deletions INTEGER,
  summary_files INTEGER,
  summary_diffs TEXT,
  metadata TEXT,
  cost REAL DEFAULT 0 NOT NULL,
  tokens_input INTEGER DEFAULT 0 NOT NULL,
  tokens_output INTEGER DEFAULT 0 NOT NULL,
  tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
  tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
  revert TEXT,
  permission TEXT,
  agent TEXT,
  model TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_compacting INTEGER,
  time_archived INTEGER,
  CONSTRAINT fk_session_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  CONSTRAINT fk_message_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  CONSTRAINT fk_part_message_id_message_id_fk FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_opencode_message_session ON message(session_id);
CREATE INDEX IF NOT EXISTS idx_opencode_part_session ON part(session_id);
CREATE INDEX IF NOT EXISTS idx_opencode_part_message ON part(message_id);
CREATE INDEX IF NOT EXISTS idx_opencode_session_updated ON session(time_updated DESC);
`;

const AGENT = 'build';
const PROJECT_ID = 'global';

function randId(prefix: string, length: number): string {
  // opencode's own ids are alphanumerics (`ses_`+22, `msg_`/`prt_`+24, `call_`
  // +40ish). Stay in that alphabet — the loader's message pagination chokes
  // on other shapes (verified against 1.18.27 with a short-id scratch row).
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let suffix = '';
  for (let i = 0; i < length; i++) suffix += alphabet[bytes[i]! % alphabet.length];
  return `${prefix}_${suffix}`;
}

function newSessionId(): string {
  return randId('ses', 22);
}

function safeCallId(value: string): string {
  // Keep the source tool id verbatim (other adapters do the same) so an
  // A→opencode→A round-trip compares exact; only synthesize when empty.
  const trimmed = (value || '').trim();
  return trimmed || randId('call', 32);
}

/** `directory` 去掉开头的 `/` —— 即原生 `path` 列的形状（`/root` → `root`）。 */
function nativePath(cwd: string): string {
  return cwd.replace(/^\/+/, '') || '/';
}

let cachedVersion: string | undefined;
function opencodeVersion(): Promise<string> {
  if (cachedVersion) return Promise.resolve(cachedVersion);
  const bin = process.env.OPENCODE_CLI_PATH;
  const probe = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 8_000 }, (error, stdout) => {
        if (error) resolve('');
        else resolve(String(stdout ?? '').trim().split('\n')[0] ?? '');
      });
    });
  return (async () => {
    const fromExplicit = bin ? await probe(bin, ['--version']) : '';
    const fromPath = fromExplicit || (await probe('opencode', ['--version']));
    const m = fromPath.match(/\d+\.\d+\.\d+/);
    cachedVersion = m ? m[0]! : '1.0.0';
    return cachedVersion;
  })();
}

/** Stored model triple for one switch: the session-level JSON plus the
 *  message-level provider/id pair. */
interface StoredModel {
  session: string | null;
  providerID: string;
  modelID: string;
}

/**
 * Resolve what the adapter persists as the session's model.
 *
 * A concrete target (`provider/id`) is written verbatim. `auto`/empty borrows
 * the library's most-recently-used concrete model: opencode's loader crashes
 * on empty stored models (`Model not found: opencode/.` on 1.18.27), while
 * Vibe's own turns pass no `-m` and let opencode fill its default in anyway —
 * so the stored value is only a resume-compatible placeholder. Local
 * libraries are readable at build time; remote ones aren't (the merge runs on
 * the host), so remote auto-switches rely on the merge-time backfill from the
 * host's own library instead. NULL when nothing resolvable exists.
 */
function resolveStoredModel(ctx: BuildContext, dbPath: string): StoredModel {
  const trimmed = (ctx.model || '').trim();
  if (trimmed && trimmed !== 'auto') {
    const parts = modelParts(trimmed);
    return {
      session: JSON.stringify({ id: parts.modelID, providerID: parts.providerID }),
      ...parts,
    };
  }
  if (typeof ctx.fs.runCommand === 'function') return { session: null, providerID: 'opencode', modelID: '' };
  try {
    const db = openSqliteReadonly(dbPath);
    if (db) {
      try {
        const row = db
          .prepare(
            `select model from session where model is not null and trim(model) != '' and trim(model) != '{}'
             order by time_updated desc limit 1`,
          )
          .get() as { model?: unknown } | undefined;
        const raw = typeof row?.model === 'string' ? row.model : '';
        if (raw.trim()) {
          try {
            const parsed = JSON.parse(raw) as { id?: unknown; providerID?: unknown };
            const id = typeof parsed.id === 'string' ? parsed.id : '';
            const provider = typeof parsed.providerID === 'string' && parsed.providerID ? parsed.providerID : 'opencode';
            if (id) return { session: raw, providerID: provider, modelID: id };
          } catch {
            /* fall through to NULL */
          }
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* fall through to NULL */
  }
  return { session: null, providerID: 'opencode', modelID: '' };
}

/** Split a `provider/id` (or bare id) model for message-level fields. */
function modelParts(model: string): { providerID: string; modelID: string } {
  const trimmed = (model || '').trim();
  if (!trimmed || trimmed === 'auto') return { providerID: 'opencode', modelID: '' };
  const slash = trimmed.indexOf('/');
  if (slash < 0) return { providerID: 'opencode', modelID: trimmed };
  return { providerID: trimmed.slice(0, slash) || 'opencode', modelID: trimmed.slice(slash + 1) };
}

interface PendingRow {
  table: 'message' | 'part';
  id: string;
  sessionId: string;
  messageId: string;
  ts: number;
  data: Record<string, unknown>;
}

function fallback(ctx: BuildContext): BuildResult {
  return {
    nativeId: '',
    fidelity: 'partial',
    primer: renderPrimer(ctx.turns, ctx.carryThinking),
    files: [],
  };
}

function buildRows(ctx: BuildContext, nativeId: string, stored: StoredModel): { session: Record<string, unknown>; rows: PendingRow[] } {
  const rows: PendingRow[] = [];
  const { providerID, modelID } = stored;
  let clock = Math.max(ctx.now, 1);
  const nextClock = (preferred: number): number => {
    clock = preferred > clock ? preferred : clock + 1;
    return clock;
  };
  const pushMessage = (id: string, ts: number, data: Record<string, unknown>): void => {
    rows.push({ table: 'message', id, sessionId: nativeId, messageId: id, ts, data });
  };
  const pushPart = (id: string, messageId: string, ts: number, data: Record<string, unknown>): void => {
    rows.push({ table: 'part', id, sessionId: nativeId, messageId, ts, data: { id, message_id: messageId, session_id: nativeId, ...data } });
  };

  for (const turn of ctx.turns) {
    const userText = renderTurnUserText(turn, ctx.carryThinking);
    const userTs = nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
    const userMsgId = randId('msg', 24);
    pushMessage(userMsgId, userTs, {
      role: 'user',
      time: { created: userTs },
      agent: AGENT,
      model: { providerID, modelID },
      summary: { diffs: [] },
    });
    pushPart(randId('prt', 24), userMsgId, userTs, { type: 'text', text: userText });

    for (const assistant of turn.assistants) {
      const assistantTs = nextClock(assistant.ts);
      const assistantMsgId = randId('msg', 24);
      const text = renderAssistantText(assistant);
      const hasTools = assistant.tools.length > 0;
      pushMessage(assistantMsgId, assistantTs, {
        parentID: userMsgId,
        role: 'assistant',
        mode: AGENT,
        agent: AGENT,
        path: { cwd: ctx.cwd, root: '/' },
        cost: 0,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
        modelID,
        providerID,
        time: { created: assistantTs, completed: assistantTs },
        finish: hasTools ? 'tool-calls' : 'stop',
      });
      pushPart(randId('prt', 24), assistantMsgId, assistantTs, { type: 'step-start' });
      if (text.trim()) {
        pushPart(randId('prt', 24), assistantMsgId, assistantTs, {
          type: 'text',
          text,
          time: { start: assistantTs, end: assistantTs },
        });
      }
      for (const tool of assistant.tools) {
        const callID = safeCallId(tool.toolUseId);
        pushPart(randId('prt', 24), assistantMsgId, nextClock(tool.ts), {
          type: 'tool',
          tool: tool.name,
          callID,
          state: {
            status: tool.isError ? 'error' : 'completed',
            input: normalizeToolInput(tool.input),
            output: tool.result ?? '',
            metadata: { title: tool.name },
            time: { start: tool.ts, end: tool.ts },
          },
        });
      }
      pushPart(randId('prt', 24), assistantMsgId, clock, {
        reason: hasTools ? 'tool-calls' : 'stop',
        type: 'step-finish',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
        cost: 0,
      });
    }
  }

  const session = {
    id: nativeId,
    directory: ctx.cwd,
    path: nativePath(ctx.cwd),
    title: ctx.title || 'opencode session',
    agent: AGENT,
    model: stored.session,
    time_created: ctx.now,
    time_updated: clock,
  };
  return { session, rows };
}

export const opencodeAdapter: TargetAdapter = {
  agent: 'opencode' as AgentKind,

  get fidelity() {
    return sqliteAvailable() ? 'full' : 'partial';
  },

  newNativeId(): string {
    return newSessionId();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    if (!sqliteAvailable()) return fallback(ctx);
    const nativeId = ctx.nativeId || this.newNativeId();
    const dbPath = joinPath(ctx.paths.opencodeHome, 'opencode.db');
    const stored = resolveStoredModel(ctx, dbPath);
    const { session, rows } = buildRows(ctx, nativeId, stored);
    const version = await opencodeVersion();

    let written = false;
    try {
      written = await mutateSqliteFile(
        ctx.fs,
        dbPath,
        (db: SqliteDb) => {
          db.exec(SCHEMA);
          db.exec('BEGIN IMMEDIATE');
          try {
            const now = Date.now();
            db.prepare(
              `insert or ignore into project
               (id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
                time_created, time_updated, time_initialized, sandboxes, commands)
               values ('${PROJECT_ID}', '/', null, null, null, null, null, ?, ?, null, '[]', null)`,
            ).run(now, now);
            db.prepare(
              `insert into session
               (id, project_id, workspace_id, parent_id, slug, directory, path,
                title, version, share_url, summary_additions, summary_deletions,
                summary_files, summary_diffs, metadata, cost, tokens_input,
                tokens_output, tokens_reasoning, tokens_cache_read,
                tokens_cache_write, revert, permission, agent, model,
                time_created, time_updated, time_compacting, time_archived)
               values (?, ?, null, null, ?, ?, ?, ?, ?, null, 0, 0, 0, null,
                       null, 0, 0, 0, 0, 0, 0, null, null, ?, ?, ?, ?, null, null)`,
            ).run(
              session.id,
              PROJECT_ID,
              `vibe-${nativeId.replace(/^ses_/, '').slice(0, 12)}`,
              session.directory,
              session.path,
              session.title,
              version,
              session.agent,
              session.model,
              session.time_created,
              session.time_updated,
            );
            const insertMessage = db.prepare(
              'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)',
            );
            const insertPart = db.prepare(
              'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)',
            );
            for (const row of rows) {
              if (row.table === 'message') {
                insertMessage.run(row.id, row.sessionId, row.ts, row.ts, JSON.stringify(row.data));
              } else {
                insertPart.run(row.id, row.messageId, row.sessionId, row.ts, row.ts, JSON.stringify(row.data));
              }
            }
            const violations = foreignKeyViolations(db);
            if (violations.length) throw new Error(`opencode foreign_key_check failed: ${JSON.stringify(violations).slice(0, 200)}`);
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
          // opencode 把所有会话放在同一个 opencode.db。远端只合并本次
          // 会话的表，不再整库覆盖；`project.global` 是幂等引用行，
          // 已存在时跳过（INSERT OR IGNORE）而不是让事务冲突回滚；
          // auto 目标在远端读不到本地库，合并后用远端主库的最新 model 回填。
          remoteMerge: {
            tables: ['project', 'session', 'message', 'part'],
            identity: { table: 'session', column: 'id', value: nativeId },
            ignoreTables: ['project'],
            backfillNullModelSessionId: nativeId,
          },
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn(`opencode native SQLite write failed; falling back to primer: ${detail}`);
      return fallback(ctx);
    }
    if (!written) return fallback(ctx);
    return { nativeId, fidelity: 'full', files: [dbPath] };
  },
};
