import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';
import { mutateSqliteFile, sqliteAvailable, type SqliteDb } from '../sqlite.js';
import { renderPrimer } from '../primer.js';

/** Cursor 的 blobs.id 是 data 的 SHA-256（真实库逐行校验为 100% 命中）。 */
export function cursorBlobId(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Cursor 根容器是 protobuf：重复 field 1 / wire type 2，每项固定 32 字节 blob hash。
 * 32 < 128，所以 tag/length 都只占一个字节：`0a 20 <hash>`。
 */
export function encodeCursorRoot(refs: readonly string[]): Buffer {
  const frames: Buffer[] = [];
  for (const ref of refs) {
    if (!/^[0-9a-f]{64}$/i.test(ref)) throw new Error(`invalid Cursor blob id: ${ref}`);
    frames.push(Buffer.from([0x0a, 0x20]), Buffer.from(ref, 'hex'));
  }
  return Buffer.concat(frames);
}

function cwdHash(cwd: string): string {
  return crypto.createHash('md5').update(cwd).digest('hex');
}

interface CursorMessage {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  id?: string;
  providerOptions?: Record<string, unknown>;
}

function buildMessages(ctx: BuildContext): CursorMessage[] {
  const messages: CursorMessage[] = [];
  for (const turn of ctx.turns) {
    const userText = renderTurnUserText(turn, ctx.carryThinking);
    if (userText.trim()) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: userText }],
        providerOptions: { cursor: { requestId: crypto.randomUUID() } },
      });
    }

    for (const assistant of turn.assistants) {
      const content: Record<string, unknown>[] = [];
      const text = renderAssistantText(assistant);
      if (text.trim()) content.push({ type: 'text', text });
      for (const tool of assistant.tools) {
        content.push({
          type: 'tool-call',
          toolCallId: tool.toolUseId,
          toolName: tool.name,
          args: normalizeToolInput(tool.input),
        });
      }
      if (content.length) {
        const messageId = `msg_${crypto.randomUUID()}`;
        messages.push({
          role: 'assistant',
          content,
          id: messageId,
          providerOptions: {
            cursor: {
              modelProviderMessageId: messageId,
              ...(ctx.model && ctx.model !== 'auto' ? { modelName: ctx.model } : {}),
            },
          },
        });
      }

      for (const tool of assistant.tools) {
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: tool.toolUseId,
            toolName: tool.name,
            result: tool.result,
            experimental_content: [{ type: 'text', text: tool.result }],
          }],
          id: tool.toolUseId,
          providerOptions: {
            cursor: {
              highLevelToolCallResult: {
                output: tool.isError
                  ? { error: { error: tool.result } }
                  : { success: { content: tool.result } },
                isError: tool.isError,
                ...(tool.isError ? { rawErrorMessages: [tool.result] } : {}),
              },
            },
          },
        });
      }
    }
  }
  return messages;
}

function integrityOk(db: SqliteDb): boolean {
  const rows = db.pragma('integrity_check');
  return Array.isArray(rows)
    && rows.length === 1
    && Object.values((rows[0] ?? {}) as Record<string, unknown>)[0] === 'ok';
}

function writeStore(
  db: SqliteDb,
  ctx: BuildContext,
  nativeId: string,
  messages: CursorMessage[],
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const insertBlob = db.prepare('insert or ignore into blobs (id, data) values (?, ?)');
    const refs: string[] = [];
    for (const message of messages) {
      const data = Buffer.from(JSON.stringify(message), 'utf8');
      const id = cursorBlobId(data);
      insertBlob.run(id, data);
      refs.push(id);
    }

    const root = encodeCursorRoot(refs);
    const rootId = cursorBlobId(root);
    insertBlob.run(rootId, root);

    const metadata = {
      agentId: nativeId,
      latestRootBlobId: rootId,
      name: ctx.title || 'Vibe switched session',
      mode: 'default',
      isRunEverything: true,
      approvalMode: 'unrestricted',
      createdAt: ctx.now,
      lastUsedModel: ctx.model || 'auto',
      blobEncryptionKey: crypto.randomBytes(32).toString('hex'),
    };
    // Cursor 的 meta.value 是“JSON UTF-8 字节的 hex 文本”，不是原始 JSON。
    const encodedMetadata = Buffer.from(JSON.stringify(metadata), 'utf8').toString('hex');
    db.prepare('insert or replace into meta (key, value) values (?, ?)').run('0', encodedMetadata);
    if (!integrityOk(db)) throw new Error('cursor SQLite integrity_check failed');
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

/** Cursor 原生 content-addressed store.db 重建；原生模块加载失败时降级为 primer。 */
export const cursorAdapter: TargetAdapter = {
  agent: 'cursor' as AgentKind,

  get fidelity() {
    return sqliteAvailable() ? 'full' : 'partial';
  },

  newNativeId(): string {
    return sqliteAvailable() ? crypto.randomUUID() : '';
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    if (!sqliteAvailable()) return fallback(ctx);
    const nativeId = ctx.nativeId || crypto.randomUUID();
    const dir = joinPath(ctx.paths.cursorChatsDir, cwdHash(ctx.cwd), nativeId);
    const storePath = joinPath(dir, 'store.db');
    const acpStorePath = joinPath(ctx.paths.cursorAcpSessionsDir, nativeId, 'store.db');
    const metaPath = joinPath(dir, 'meta.json');
    const messages = buildMessages(ctx);

    const written = await mutateSqliteFile(ctx.fs, storePath, (db) => {
      writeStore(db, ctx, nativeId, messages);
    });
    if (!written) return fallback(ctx);

    // Cursor exposes the same content-addressed store through two roots:
    // discovery/headless CLI uses ~/.cursor/chats, while Vibe's `cursor-agent
    // acp` transport only resolves IDs under ~/.cursor/acp-sessions. Keep an
    // identical checkpointed copy in both places so the advertised native ID
    // is genuinely resumable through the transport Vibe uses.
    const storeSnapshot = await ctx.fs.readBuffer(storePath);
    if (!storeSnapshot) return fallback(ctx);
    await ctx.fs.writeBuffer(acpStorePath, storeSnapshot);

    const meta = {
      schemaVersion: 1,
      // Cursor ignores unknown sidecar fields; Vibe uses this to repair a
      // mapping if an obsolete source runtime ever writes its id back.
      vibeSessionId: ctx.vibeSessionId,
      createdAtMs: ctx.now,
      hasConversation: messages.length > 0,
      title: ctx.title || 'Vibe switched session',
      updatedAtMs: ctx.now,
      cwd: ctx.cwd,
      messageCount: messages.length,
    };
    await ctx.fs.writeFile(metaPath, `${JSON.stringify(meta)}\n`);
    return { nativeId, fidelity: 'full', files: [storePath, metaPath, acpStorePath] };
  },
};
