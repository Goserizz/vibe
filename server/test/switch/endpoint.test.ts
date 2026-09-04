import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { kiroVerifyBlocks, loadFixture } from './helpers.js';

/**
 * 集成冒烟：真正把 `POST /api/sessions/:id/switch` 端点跑起来，验证
 *  - sessions.json 的映射被正确改写（agent / model / claudeSessionId）；
 *  - 返回值（session + switch.fidelity + note）正确；
 *  - SQLite 目标也注册可 resume 的原生 id；
 *  - sessions.json 始终是合法 JSON，且**原子写**不留下 .tmp 残留。
 *
 * 环境全部隔离：VIBE_HOME 指向临时目录（sessions.json 在此），
 * VIBE_SWITCH_ROOT 指向另一个临时目录（各 agent 的原生会话文件都写在这里），
 * 因此绝不触碰真实数据。
 *
 * 注意：env 必须在**导入**服务端模块之前设置好（config 与 sessionStore 都是
 * 模块加载时就读盘的单例），所以这里全部用动态 import。
 */

// 环境由 `node --import server/test/switch/setup.ts` 预置（必须早于服务端模块
// 的 import），这里直接取用。
import { VIBE_HOME, VIBE_SWITCH_ROOT, VIBE_TOKEN } from './setup.js';

const vibeHome = VIBE_HOME;
const switchRoot = VIBE_SWITCH_ROOT;
const TOKEN = VIBE_TOKEN;
assert.ok(vibeHome && switchRoot && TOKEN, '缺少测试环境预置（应用 --import 加载 setup.ts）');

interface SeededSession {
  id: string;
  claudeSessionId?: string;
  title: string;
  cwd: string;
  model: string;
  permissionMode: string;
  agent: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

class MemorySocket extends Duplex {
  readonly chunks: Buffer[] = [];

  constructor() {
    // Request EOF 不能自动销毁 writable 半边：异步路由会稍后才写 response。
    super({ allowHalfOpen: true, autoDestroy: false });
  }

  _read(): void {
    // Request bytes are fed through IncomingMessage.push() below.
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    done();
  }
}

interface InjectResult {
  status: number;
  text: string;
  json<T>(): T;
}

/**
 * 不监听 TCP 端口，直接用 Node 的真实 HTTP request/response 流驱动 Express。
 * 这仍会经过 express.json、requireAuth、router 与错误处理全链路，只绕开沙箱禁止
 * bind/listen 的限制。
 */
async function inject(
  app: (req: IncomingMessage, res: ServerResponse) => unknown,
  input: { method?: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<InjectResult> {
  const socket = new MemorySocket();
  const httpSocket = socket as unknown as Socket;
  const req = new IncomingMessage(httpSocket);
  // 手工构造的 IncomingMessage 默认会在自身 EOF 时销毁底层 socket；真实 HTTP
  // parser 不会在异步 response 写完前这么做。
  (req as IncomingMessage & { _readableState: { autoDestroy: boolean } })._readableState.autoDestroy = false;
  req.method = input.method ?? 'GET';
  req.url = input.url;
  const body = input.body ?? '';
  req.headers = {
    ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  };
  const res = new ServerResponse(req);
  res.assignSocket(httpSocket);
  const finished = once(res, 'finish');
  app(req, res);
  if (body) req.push(body);
  req.push(null);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      finished,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `in-memory response did not finish (status=${res.statusCode}, ended=${res.writableEnded}, bytes=${socket.chunks.reduce((n, chunk) => n + chunk.length, 0)}, socketDestroyed=${socket.destroyed}, socketWritable=${socket.writable})`,
          ));
        }, 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const raw = Buffer.concat(socket.chunks).toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  const text = split >= 0 ? raw.slice(split + 4) : '';
  return {
    status: res.statusCode,
    text,
    json<T>(): T {
      return JSON.parse(text) as T;
    },
  };
}

/**
 * 在 VIBE_HOME 里铺好 sessions.json（store 在 import 时读它）。
 *
 * 只对**第一次**动态 import 之前调用才有意义 —— 之后 sessionStore 已经在内存里了，
 * 再写文件不会影响它。后续会话请用 `ensureSession()`（走 store 的 adopt API）。
 */
function seedSessions(sessions: SeededSession[]): void {
  fs.writeFileSync(
    path.join(vibeHome, 'sessions.json'),
    JSON.stringify({ sessions, hidden: [], pinned: [] }, null, 2),
  );
}

/** 把会话塞进内存中的 sessionStore（store 只在 import 时读一次盘）。 */
async function ensureSession(session: SeededSession): Promise<void> {
  const { sessionStore } = await import('../../src/sessions/store.js');
  sessionStore.adopt({
    id: session.id,
    claudeSessionId: session.claudeSessionId ?? '',
    cwd: session.cwd,
    title: session.title,
    model: session.model,
    permissionMode: session.permissionMode as 'default',
    agent: session.agent as 'claude',
    createdAt: session.createdAt,
    messageCount: session.messageCount,
  });
}

/**
 * 铺好源会话的归一化 transcript。
 *
 * Hub 从真正的 VIBE_HOME 捕获完整切换快照；adapter 产物仍通过
 * VIBE_SWITCH_ROOT 隔离。两处都写可同时验证这两个 IO plane。
 */
function seedTranscript(agent: string, sessionId: string, blocks: unknown[]): void {
  const body = `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`;
  for (const dir of [
    path.join(vibeHome, `${agent}-transcripts`),
    path.join(switchRoot, 'vibe', `${agent}-transcripts`),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${encodeURIComponent(sessionId)}.jsonl`), body);
  }
}

describe('POST /api/sessions/:id/switch 集成冒烟', { concurrency: false }, () => {
  it('切换端点改写映射、返回保真信息、并原子持久化', async () => {
    const blocks = loadFixture('codex-tools.jsonl');
    const sessionId = 'sess-endpoint';
    const seeded: SeededSession = {
      id: sessionId,
      claudeSessionId: 'native-endpoint-src',
      title: '端点测试会话',
      cwd: '/tmp/proj',
      model: 'old-model',
      permissionMode: 'default',
      agent: 'codex',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 2,
    };
    seedSessions([seeded]);
    await ensureSession(seeded);
    seedTranscript('codex', sessionId, blocks);

    // 动态导入（env 已就绪）。
    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const res = await inject(app, {
      url: `/api/sessions/${sessionId}/switch`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent: 'kiro', model: 'kiro-model-x' }),
    });
    const rawSwitch = res.text;
    assert.equal(res.status, 200, `切换应成功，实际 ${res.status}: ${rawSwitch}`);
    const body = JSON.parse(rawSwitch) as {
      session: { id: string; agent: string; model: string; claudeSessionId?: string };
      switch: {
        from: string;
        to: string;
        fidelity: 'full' | 'partial';
        nativeId: string;
        note: string;
        files: string[];
        blocks: number;
      };
    };

    // --- 返回值 ---
    assert.equal(body.session.id, sessionId, '会话 id 不变（是同一个 Vibe 会话换了引擎）');
    assert.equal(body.session.agent, 'kiro');
    assert.equal(body.session.model, 'kiro-model-x');
    assert.ok(body.session.claudeSessionId, 'full 方向必须注册新的原生会话 id');
    assert.notEqual(body.session.claudeSessionId, 'native-endpoint-src', '原生 id 必须换成新 agent 的');
    assert.equal(body.switch.from, 'codex');
    assert.equal(body.switch.to, 'kiro');
    assert.equal(body.switch.fidelity, 'full', '切到 kiro 应达到 full 保真');
    assert.match(body.switch.nativeId, /^[0-9a-f-]{36}$/);
    assert.ok(body.switch.note.length > 0, '每个方向都要有保真说明');
    assert.ok(body.switch.files.length > 0);
    assert.equal(body.switch.blocks, blocks.length);

    // --- 原生文件真的落地了，且落在 VIBE_SWITCH_ROOT 下（不是真实 ~/.kiro）---
    for (const f of body.switch.files) {
      assert.ok(fs.existsSync(f), `产物文件不存在: ${f}`);
      assert.ok(f.startsWith(switchRoot), `产物必须写在测试目录里: ${f}`);
    }

    // --- sessions.json 被正确改写（原子写：无 .tmp 残留、内容合法）---
    const raw = fs.readFileSync(path.join(vibeHome, 'sessions.json'), 'utf8');
    const persisted = JSON.parse(raw) as { sessions: SeededSession[] };
    assert.equal(fs.existsSync(`${path.join(vibeHome, 'sessions.json')}.tmp`), false, '原子写不应留下 .tmp 残留');
    const stored = persisted.sessions.find((s) => s.id === sessionId)!;
    assert.equal(stored.agent, 'kiro');
    assert.equal(stored.model, 'kiro-model-x');
    assert.equal(stored.claudeSessionId, body.session.claudeSessionId);
    // 向后兼容：既有字段一个不动。
    assert.equal(stored.cwd, '/tmp/proj');
    assert.equal(stored.title, '端点测试会话');
    assert.equal(stored.createdAt, 1_700_000_000_000);

    // --- 目标 agent 的 transcript 里已铺好历史，UI 立刻能看到 ---
    const targetFile = path.join(
      switchRoot,
      'vibe',
      'kiro-transcripts',
      `${encodeURIComponent(sessionId)}.jsonl`,
    );
    const migrated = fs.readFileSync(targetFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(migrated.length, blocks.length, '历史应完整迁移到目标 agent 的 transcript');
  });

  it('长会话切换使用完整快照，不会误用 UI 的最近 200-block 分页', async () => {
    const sessionId = 'sess-endpoint-long-history';
    const blocks = Array.from({ length: 310 }, (_, turn) => [
      { id: `long-u-${turn}`, kind: 'user', text: `第 ${turn} 轮问题`, ts: 1_700_000_000_000 + turn * 2 },
      {
        id: `long-a-${turn}`,
        kind: 'assistant',
        text: `第 ${turn} 轮回答`,
        streaming: false,
        ts: 1_700_000_000_001 + turn * 2,
      },
    ]).flat();
    await ensureSession({
      id: sessionId,
      claudeSessionId: 'native-long-source',
      title: '超过分页上限的会话',
      cwd: '/tmp/proj',
      model: 'old-model',
      permissionMode: 'default',
      agent: 'zcode',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 310,
    });
    seedTranscript('zcode', sessionId, blocks);

    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');
    const { hub } = await import('../../src/ws/hub.js');
    const uiPage = await hub.snapshot(sessionId);
    assert.equal(uiPage.blocks.length, 200, 'UI 快照仍应保持分页上限');
    assert.equal(uiPage.hasMore, true);
    const full = await hub.switchSnapshot(sessionId);
    assert.equal(full.blocks.length, 620, '互转快照必须绕过分页限制');
    assert.equal(full.blocks[0]?.id, 'long-u-0');

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const res = await inject(app, {
      url: `/api/sessions/${sessionId}/switch`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent: 'kiro', model: 'auto' }),
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json<{ switch: { blocks: number } }>();
    assert.equal(body.switch.blocks, 620);

    const targetFile = path.join(
      switchRoot,
      'vibe',
      'kiro-transcripts',
      `${encodeURIComponent(sessionId)}.jsonl`,
    );
    const migrated = fs.readFileSync(targetFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });
    assert.equal(migrated.length, 620);
    assert.equal(migrated[0]?.id, 'long-u-0', '最老一轮不能丢失');
    assert.equal(migrated.at(-1)?.id, 'long-a-309', '最新一轮必须保留');
  });

  it('切换原生历史前还原 blob 工具结果，同时让目标归一化 transcript 保持紧凑', async () => {
    const sessionId = 'sess-endpoint-blob-result';
    const fullResult = 'x'.repeat(1_100_000);
    const preview = fullResult.slice(0, 1024);
    const blocks = [
      { id: 'blob-u', kind: 'user', text: '读取大文件', ts: 1 },
      { id: 'blob-a', kind: 'assistant', text: '开始读取。', streaming: false, ts: 2 },
      {
        id: 'tool-large',
        kind: 'tool',
        toolUseId: 'tool-large',
        name: 'Read',
        input: { file_path: '/tmp/large.txt' },
        status: 'done',
        result: preview,
        resultTruncated: true,
        resultSize: fullResult.length,
        resultRef: `blob:${sessionId}/tool-large`,
        ts: 3,
      },
      { id: 'blob-final', kind: 'assistant', text: '读取完成。', streaming: false, ts: 4 },
    ];
    await ensureSession({
      id: sessionId,
      claudeSessionId: 'native-blob-source',
      title: '大型工具结果',
      cwd: '/tmp/proj',
      model: 'old-model',
      permissionMode: 'default',
      agent: 'codex',
      createdAt: 1,
      updatedAt: 4,
      messageCount: 1,
    });
    seedTranscript('codex', sessionId, blocks);
    const blobFile = path.join(vibeHome, 'blobs', sessionId, 'tool-large.txt');
    fs.mkdirSync(path.dirname(blobFile), { recursive: true });
    fs.writeFileSync(blobFile, fullResult);

    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const res = await inject(app, {
      url: `/api/sessions/${sessionId}/switch`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent: 'kiro' }),
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json<{ switch: { files: string[] } }>();
    const nativeFile = body.switch.files.find((file) => file.endsWith('.jsonl'));
    assert.ok(nativeFile, '缺少 Kiro 原生 JSONL');
    const nativeBlocks = kiroVerifyBlocks(fs.readFileSync(nativeFile, 'utf8'));
    const nativeTool = nativeBlocks.find((block) => block.kind === 'tool');
    assert.equal(nativeTool?.kind, 'tool');
    if (nativeTool?.kind === 'tool') {
      assert.equal(nativeTool.result, fullResult, '目标原生历史必须拿到完整工具结果');
    }

    const targetFile = path.join(
      switchRoot,
      'vibe',
      'kiro-transcripts',
      `${encodeURIComponent(sessionId)}.jsonl`,
    );
    const persisted = fs.readFileSync(targetFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const persistedTool = persisted.find((block) => block.kind === 'tool');
    assert.equal(persistedTool?.result, preview, '归一化文件继续保存预览而非重复写入 1.1MB');
    assert.equal(persistedTool?.resultRef, `blob:${sessionId}/tool-large`);
  });

  it('可从保留的旧 agent transcript 修复跨 agent 遗留的 line 引用', async () => {
    const sessionId = 'sess-endpoint-legacy-line-result';
    const fullResult = 'legacy-full-result\n'.repeat(4096);
    const prefix = [
      { id: 'line-u', kind: 'user', text: '读取历史文件', ts: 1 },
      { id: 'line-a', kind: 'assistant', text: '读取中。', streaming: false, ts: 2 },
    ];
    const offset = Buffer.byteLength(`${prefix.map((block) => JSON.stringify(block)).join('\n')}\n`);
    const fullTool = {
      id: 'line-tool',
      kind: 'tool',
      toolUseId: 'line-tool',
      name: 'Read',
      input: { file_path: '/tmp/history.txt' },
      status: 'done',
      result: fullResult,
      ts: 3,
    };
    const oldAgentBlocks = [...prefix, fullTool];
    const currentBlocks = [
      ...prefix,
      {
        ...fullTool,
        result: fullResult.slice(0, 2048),
        resultTruncated: true,
        resultSize: fullResult.length,
        resultRef: `line:${offset}`,
      },
    ];
    await ensureSession({
      id: sessionId,
      claudeSessionId: 'native-line-source',
      title: '遗留 line 引用',
      cwd: '/tmp/proj',
      model: 'old-model',
      permissionMode: 'default',
      agent: 'codebuddy',
      createdAt: 1,
      updatedAt: 3,
      messageCount: 1,
    });
    seedTranscript('zcode', sessionId, oldAgentBlocks);
    seedTranscript('codebuddy', sessionId, currentBlocks);

    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const res = await inject(app, {
      url: `/api/sessions/${sessionId}/switch`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent: 'kiro' }),
    });
    assert.equal(res.status, 200, res.text);

    const targetFile = path.join(
      switchRoot,
      'vibe',
      'kiro-transcripts',
      `${encodeURIComponent(sessionId)}.jsonl`,
    );
    const targetBlocks = fs.readFileSync(targetFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const targetTool = targetBlocks.find((block) => block.kind === 'tool');
    assert.equal(targetTool?.result, fullResult);
    assert.equal(targetTool?.resultRef, undefined, '源文件 byte offset 不得泄漏到目标 transcript');
    assert.equal(targetTool?.resultTruncated, undefined);
  });

  it('cursor SQLite 方向：写出原生 store.db、注册 resume id，并替换旧 agent runtime', async (t) => {
    const blocks = loadFixture('zcode-multi.jsonl');
    const sessionId = 'sess-endpoint-cursor';
    await ensureSession({
      id: sessionId,
      claudeSessionId: 'native-cursor-src',
      title: 'Cursor full 端点',
      cwd: '/tmp/proj',
      model: 'bigmodel/GLM-5.3',
      permissionMode: 'default',
      agent: 'zcode',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    });
    seedTranscript('zcode', sessionId, blocks);

    // Reproduce the real bug: the browser had already subscribed while this
    // was still a ZCode session, so Hub cached a runtime whose agent/native id
    // fields could not be changed by sessions.json alone.
    const staleMarker = { id: 'stale-zcode-runtime', kind: 'system', text: 'stale zcode runtime', ts: 1 };
    const zcodeOwnedDir = path.join(vibeHome, 'zcode-transcripts');
    fs.mkdirSync(zcodeOwnedDir, { recursive: true });
    fs.appendFileSync(
      path.join(zcodeOwnedDir, `${encodeURIComponent(sessionId)}.jsonl`),
      `${JSON.stringify(staleMarker)}\n`,
    );

    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');
    const { CallbackConn, hub } = await import('../../src/ws/hub.js');
    const conn = new CallbackConn(() => undefined);
    t.after(() => hub.removeConn(conn));
    hub.addConn(conn);
    hub.subscribe(conn, sessionId, 0);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const res = await inject(app, {
      url: `/api/sessions/${sessionId}/switch`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agent: 'cursor' }),
    });
    const rawSwitch = res.text;
    assert.equal(res.status, 200, rawSwitch);
    const body = JSON.parse(rawSwitch) as {
      session: { claudeSessionId?: string; model: string };
      switch: { fidelity: string; nativeId: string; note: string; files: string[] };
    };
    assert.equal(body.switch.fidelity, 'full', '切到 cursor 应原生写出 store.db');
    assert.equal(body.session.model, 'auto', '省略 model 时必须用 Cursor 默认值，不能沿用 ZCode 模型');
    assert.match(body.switch.nativeId, /^[0-9a-f-]{36}$/);
    assert.equal(body.switch.files.length, 3, 'Cursor 必须同时注册 chats 与 ACP 两个原生入口');
    assert.match(body.switch.note, /原生会话|resume/);
    assert.equal(body.session.claudeSessionId, body.switch.nativeId);
    for (const file of body.switch.files) assert.ok(fs.existsSync(file), `缺少 Cursor 产物 ${file}`);

    const cursorMetaFile = body.switch.files.find((file) => file.endsWith('/meta.json'))!;
    const cursorMeta = JSON.parse(fs.readFileSync(cursorMetaFile, 'utf8')) as {
      vibeSessionId?: string;
      createdAtMs: number;
    };
    assert.equal(cursorMeta.vibeSessionId, sessionId, 'Cursor sidecar 应记录可精确恢复的 Vibe id');

    const cursorStoreFiles = body.switch.files.filter((file) => file.endsWith('/store.db'));
    const chatStoreFile = cursorStoreFiles.find((file) => file.includes('/.cursor/chats/'));
    const acpStoreFile = cursorStoreFiles.find((file) => file.includes('/.cursor/acp-sessions/'));
    assert.ok(chatStoreFile && acpStoreFile, 'Cursor 产物必须覆盖 chats 与 acp-sessions');
    assert.deepEqual(
      fs.readFileSync(acpStoreFile),
      fs.readFileSync(chatStoreFile),
      '两个 resume 根目录必须拿到同一个 checkpointed SQLite 快照',
    );

    // Legacy sidecars (including the one involved in the reported incident)
    // predate vibeSessionId. A unique same-title candidate near updatedAt is
    // still recoverable; this never touches the real ~/.cursor tree.
    delete cursorMeta.vibeSessionId;
    fs.writeFileSync(cursorMetaFile, `${JSON.stringify(cursorMeta)}\n`);
    const { ensureCursorAcpSessionFromChat, recoverCursorChatId } = await import('../../src/cursor/discovery.js');
    const cursorChatsDir = path.dirname(path.dirname(path.dirname(cursorMetaFile)));
    assert.equal(
      recoverCursorChatId(
        {
          vibeSessionId: sessionId,
          cwd: '/tmp/proj',
          title: 'Cursor full 端点',
          updatedAt: cursorMeta.createdAtMs + 80_000,
        },
        cursorChatsDir,
      ),
      body.switch.nativeId,
      '旧 sidecar 只在十分钟窗口内有唯一候选时恢复',
    );
    const decoyId = '11111111-1111-4111-8111-111111111111';
    const decoyDir = path.join(path.dirname(path.dirname(cursorMetaFile)), decoyId);
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        hasConversation: true,
        title: 'Cursor full 端点',
        createdAtMs: cursorMeta.createdAtMs + 90_000,
      }),
    );
    assert.equal(
      recoverCursorChatId(
        {
          vibeSessionId: sessionId,
          cwd: '/tmp/proj',
          title: 'Cursor full 端点',
          updatedAt: cursorMeta.createdAtMs + 80_000,
        },
        cursorChatsDir,
      ),
      null,
      '时间窗口内有多个旧候选时必须拒绝猜测',
    );

    assert.equal(
      recoverCursorChatId(
        {
          vibeSessionId: sessionId,
          cwd: '/tmp/proj',
          title: 'Cursor full 端点',
          updatedAt: cursorMeta.createdAtMs + 3_600_000,
          userTexts: blocks.filter((block) => block.kind === 'user').map((block) => block.text),
        },
        cursorChatsDir,
      ),
      body.switch.nativeId,
      '即使 ACP 失败后覆盖成合法新 UUID，也应凭用户轮次前缀找回唯一旧迁移库',
    );

    fs.rmSync(acpStoreFile);
    assert.equal(
      ensureCursorAcpSessionFromChat(
        body.switch.nativeId,
        '/tmp/proj',
        cursorChatsDir,
        path.dirname(path.dirname(acpStoreFile)),
      ),
      true,
      '旧 chats-only 产物应能补登记到 ACP resume 根目录',
    );
    assert.deepEqual(fs.readFileSync(acpStoreFile), fs.readFileSync(chatStoreFile));

    const persisted = JSON.parse(fs.readFileSync(path.join(vibeHome, 'sessions.json'), 'utf8')) as {
      sessions: (SeededSession & { switchPrimer?: string })[];
    };
    const stored = persisted.sessions.find((s) => s.id === sessionId)!;
    assert.equal(stored.switchPrimer, undefined, 'full 方向不应留下首轮 primer');
    assert.equal(stored.claudeSessionId, body.switch.nativeId);
    assert.equal(stored.model, 'auto');

    // Make the two runtime branches observably different. A stale ZCode
    // runtime would read staleMarker; the rebound Cursor runtime must read this.
    const cursorMarker = { id: 'fresh-cursor-runtime', kind: 'system', text: 'fresh cursor runtime', ts: 2 };
    const cursorOwnedDir = path.join(vibeHome, 'cursor-transcripts');
    fs.mkdirSync(cursorOwnedDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorOwnedDir, `${encodeURIComponent(sessionId)}.jsonl`),
      `${JSON.stringify(cursorMarker)}\n`,
    );
    const snapshot = await hub.snapshot(sessionId);
    assert.deepEqual(snapshot.blocks, [cursorMarker], '切换后 Hub 必须立即改用 Cursor runtime');
  });

  it('拒绝非法请求：未知 agent、未知会话、无鉴权', async () => {
    await ensureSession({
      id: 'sess-guard',
      claudeSessionId: 'n',
      title: 'guard',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'claude',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
    });
    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const url = '/api/sessions/sess-guard/switch';
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

    const badAgent = await inject(app, {
      url,
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent: 'gemini' }),
    });
    assert.equal(badAgent.status, 400, '未知 agent 应被 zod 挡下');

    const unknownSession = await inject(app, {
      url: '/api/sessions/nope/switch',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent: 'claude' }),
    });
    assert.equal(unknownSession.status, 404, '未收编的会话不能切换');

    const noAuth = await inject(app, {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude' }),
    });
    assert.equal(noAuth.status, 401, '缺少鉴权应被拒绝');
  });

  it('GET /api/meta/switch-fidelity 返回 100 个方向的保真表', async () => {
    const express = (await import('express')).default;
    const { createApiRouter } = await import('../../src/http/api.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const res = await inject(app, {
      url: '/api/meta/switch-fidelity',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = res.json<{
      byTarget: Record<string, string>;
      matrix: { from: string; to: string; fidelity: string }[];
    }>();
    assert.equal(body.matrix.length, 100, '10×10 = 100 个方向');
    assert.equal(body.matrix.filter((m) => m.fidelity === 'full').length, 100);
    assert.equal(body.matrix.filter((m) => m.fidelity === 'partial').length, 0);
    assert.equal(body.byTarget.zcode, 'full');
    assert.equal(body.byTarget.cursor, 'full');
    assert.equal(body.byTarget.claude, 'full');
    assert.equal(body.byTarget.kiro, 'full');
    assert.equal(body.byTarget.opencode, 'full');
    assert.equal(body.byTarget.devin, 'full');
  });
});
