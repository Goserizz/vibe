import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';
import {
  foreignKeyViolations,
  mutateSqliteFile,
  sqliteAvailable,
  type SqliteDb,
} from '../sqlite.js';
import { renderPrimer } from '../primer.js';
import { ZCODE_MIGRATIONS, ZCODE_SCHEMA_SQL } from './zcodeSchema.js';

const ZCODE_VERSION = '0.16.5';

function recordId(prefix: 'msg' | 'part', ms: number): string {
  return `${prefix}_${Math.max(0, Math.floor(ms)).toString(36)}_${crypto.randomUUID()}`;
}

function projectId(cwd: string): string {
  const slug = cwd
    .replace(/^\/+/, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-') || 'root';
  return `proj_${slug}`;
}

function modelIdentity(model: string): { providerID: string; modelID: string } {
  const value = model.trim() || 'auto';
  const slash = value.indexOf('/');
  if (slash > 0 && slash < value.length - 1) {
    return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
  }
  // 历史消息里的 model 只用于展示；续跑时 ZCode 会按当前 CLI 配置选择模型。
  return { providerID: 'bigmodel', modelID: value };
}

function tableExists(db: SqliteDb, name: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}

function initializeSchema(db: SqliteDb): void {
  if (tableExists(db, 'schema_migration')) return;
  for (const sql of ZCODE_SCHEMA_SQL) db.exec(sql);
  const insert = db.prepare(
    'insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)',
  );
  for (const row of ZCODE_MIGRATIONS) {
    insert.run(row.id, row.checksum, row.app_version, row.time_applied);
  }
}

function integrityOk(db: SqliteDb): boolean {
  const rows = db.pragma('integrity_check');
  return Array.isArray(rows)
    && rows.length === 1
    && Object.values((rows[0] ?? {}) as Record<string, unknown>)[0] === 'ok';
}

function writeSession(db: SqliteDb, ctx: BuildContext, nativeId: string): void {
  db.pragma('foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    initializeSchema(db);

    const sessionInsert = db.prepare(`
      insert into session (
        id, project_id, workspace_id, parent_id, slug, directory, path, title,
        version, share_url, summary_additions, summary_deletions, summary_files,
        summary_diffs, revert, permission, time_created, time_updated,
        time_compacting, time_archived, task_type, title_source, title_message_id,
        time_title_updated, trace_id
      ) values (?, ?, null, null, ?, ?, ?, ?, ?, null, null, null, null,
        null, null, ?, ?, ?, null, null, 'interactive', 'custom', null, ?, ?)
    `);
    sessionInsert.run(
      nativeId,
      projectId(ctx.cwd),
      nativeId,
      ctx.cwd,
      ctx.cwd,
      ctx.title || 'Vibe switched session',
      ZCODE_VERSION,
      JSON.stringify({ mode: 'build' }),
      ctx.now,
      ctx.now,
      ctx.now,
      crypto.randomUUID(),
    );

    const messageInsert = db.prepare(
      'insert into message (id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?)',
    );
    const partInsert = db.prepare(
      'insert into part (id, message_id, session_id, time_created, time_updated, data, sequence) values (?, ?, ?, ?, ?, ?, ?)',
    );
    const model = modelIdentity(ctx.model);
    let clock = Math.max(ctx.now, 1);
    let messageSequence = 0;
    let lastMessageId: string | undefined;
    const nextClock = (preferred: number): number => {
      clock = preferred > clock ? preferred : clock + 1;
      return clock;
    };

    const addMessage = (
      data: Record<string, unknown>,
      parts: Record<string, unknown>[],
      preferredTs: number,
    ): string => {
      const created = nextClock(preferredTs);
      const messageId = recordId('msg', created);
      const updated = created + Math.max(0, parts.length - 1);
      messageInsert.run(
        messageId,
        nativeId,
        created,
        updated,
        JSON.stringify(data),
        messageSequence,
      );
      messageSequence += 1;
      parts.forEach((part, sequence) => {
        const stamp = created + sequence;
        partInsert.run(
          recordId('part', stamp),
          messageId,
          nativeId,
          stamp,
          stamp,
          JSON.stringify(part),
          sequence,
        );
      });
      clock = Math.max(clock, updated);
      lastMessageId = messageId;
      return messageId;
    };

    for (const turn of ctx.turns) {
      const turnId = `turn_${crypto.randomUUID()}`;
      let userMessageId: string | undefined;
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        const userTs = turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now;
        const created = Math.max(clock + 1, userTs);
        userMessageId = addMessage(
          {
            role: 'user',
            time: { created },
            agent: 'zcode-agent',
            model,
            contextSnapshot: { envInfo: { cwd: ctx.cwd } },
            semantics: {
              origin: 'real_user',
              kind: 'user_prompt',
              uiVisibility: 'visible',
              providerVisibility: 'visible',
              transcriptVisibility: 'visible',
            },
            anchor: { turnId, origin: 'realUser' },
            tools: {},
          },
          [{ type: 'text', text: userText, time: { start: created, end: created } }],
          userTs,
        );
      }

      for (const assistant of turn.assistants) {
        const created = Math.max(clock + 1, assistant.ts);
        const text = renderAssistantText(assistant);
        const parts: Record<string, unknown>[] = [{ type: 'step-start' }];
        if (text.trim()) {
          parts.push({ type: 'text', text, time: { start: created, end: created } });
        }
        for (const tool of assistant.tools) {
          const state: Record<string, unknown> = {
            status: tool.isError ? 'error' : 'completed',
            input: normalizeToolInput(tool.input),
            title: tool.name,
            metadata: {},
            time: { start: Math.max(created, tool.ts), end: Math.max(created, tool.ts) },
          };
          if (tool.isError) state.error = tool.result;
          else state.output = tool.result;
          parts.push({ type: 'tool', callID: tool.toolUseId, tool: tool.name, state });
        }
        parts.push({
          type: 'step-finish',
          reason: assistant.tools.length ? 'tool-calls' : 'stop',
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        });

        addMessage(
          {
            role: 'assistant',
            time: { created, completed: created + Math.max(0, parts.length - 1) },
            ...(userMessageId || lastMessageId ? { parentID: userMessageId ?? lastMessageId } : {}),
            modelID: model.modelID,
            providerID: model.providerID,
            mode: 'build',
            agent: 'zcode-agent',
            path: { cwd: ctx.cwd, root: ctx.cwd },
            cost: 0,
            tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: assistant.tools.length ? 'tool-calls' : 'stop',
            semantics: {
              origin: 'agent_runtime',
              kind: 'assistant_response',
              uiVisibility: 'visible',
              providerVisibility: 'visible',
              transcriptVisibility: 'visible',
            },
            anchor: { turnId },
          },
          parts,
          assistant.ts,
        );
      }
    }

    db.prepare('update session set time_updated=? where id=?').run(clock, nativeId);
    const violations = foreignKeyViolations(db);
    if (violations.length) throw new Error(`zcode foreign-key check failed: ${JSON.stringify(violations)}`);
    if (!integrityOk(db)) throw new Error('zcode SQLite integrity_check failed');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* original error wins */
    }
    throw error;
  }
}

function fallback(ctx: BuildContext): BuildResult {
  return {
    nativeId: '',
    fidelity: 'partial',
    primer: renderPrimer(ctx.turns, ctx.carryThinking),
    files: [],
  };
}

/** ZCode 原生 SQLite 会话重建；原生模块加载失败时才诚实降级为 primer。 */
export const zcodeAdapter: TargetAdapter = {
  agent: 'zcode' as AgentKind,

  get fidelity() {
    return sqliteAvailable() ? 'full' : 'partial';
  },

  newNativeId(): string {
    return sqliteAvailable() ? `sess_${crypto.randomUUID()}` : '';
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    if (!sqliteAvailable()) return fallback(ctx);
    const nativeId = ctx.nativeId || `sess_${crypto.randomUUID()}`;
    const file = joinPath(ctx.paths.zcodeHome, 'cli', 'db', 'db.sqlite');
    const written = await mutateSqliteFile(
      ctx.fs,
      file,
      (db) => writeSession(db, ctx, nativeId),
      {
        // ZCode 的 db.sqlite 是所有会话共享的全局库。远端切换不能整库
        // 下载—修改—覆盖：SSH 中断会截断主库，并发 ZCode 也会丢写。
        // 只把这次新建的会话三张表交给远端 SQLite 事务合并。
        remoteMerge: {
          tables: ['session', 'message', 'part'],
          identity: { table: 'session', column: 'id', value: nativeId },
        },
      },
    );
    if (!written) return fallback(ctx);
    return { nativeId, fidelity: 'full', files: [file] };
  },
};
