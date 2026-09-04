import { describe, it, beforeEach, afterEach, skip } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentKind } from '../../../shared/protocol.js';
import { switchSessionAgent } from '../../src/switch/index.js';
import { transcriptFileFor } from '../../src/switch/paths.js';
import type { StoredSession } from '../../src/sessions/store.js';
import { AGENTS, loadFixture, makeTempEnv, findRecursive, hasRealData, type TempEnv } from './helpers.js';
import { openSqlite } from '../../src/switch/sqlite.js';

/**
 * 结构校验：把转换产物与**各 agent 真实产生的文件**做字段级对比。
 *
 * 单靠往返解析只能证明「我们自己的解析器读得懂」，不能证明 CLI 读得懂。这里
 * 直接读磁盘上真实的原生文件，统计它们每个记录类型都写了哪些字段，再要求转换
 * 产物覆盖这些字段（缺字段是 CLI 拒绝会话最常见的原因）。
 */

const HOME = process.env.HOME ?? '/root';

/** 真实文件的位置与「取哪种记录」的判定。 */
const REAL: Partial<Record<AgentKind, { dir: string; pattern: (name: string) => boolean; pick: (o: any) => boolean }>> = {
  claude: {
    dir: `${HOME}/.claude/projects`,
    pattern: (n) => n.endsWith('.jsonl'),
    pick: (o) => o.type === 'user' || o.type === 'assistant',
  },
  codebuddy: {
    dir: `${HOME}/.codebuddy/projects`,
    pattern: (n) => n.endsWith('.jsonl'),
    pick: (o) => o.type === 'message' || o.type === 'function_call' || o.type === 'function_call_result',
  },
  codex: {
    dir: `${HOME}/.codex/sessions`,
    pattern: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    pick: (o) => o.type === 'session_meta' || o.type === 'response_item',
  },
  kiro: {
    dir: `${HOME}/.kiro/sessions/cli`,
    pattern: (n) => n.endsWith('.jsonl'),
    pick: (o) => o.kind === 'Prompt' || o.kind === 'AssistantMessage' || o.kind === 'ToolResults',
  },
  grok: {
    dir: `${HOME}/.grok/sessions`,
    pattern: (n) => n === 'updates.jsonl',
    pick: (o) => typeof o.params?.update?.sessionUpdate === 'string',
  },
  kimi: {
    dir: `${HOME}/.kimi-code/sessions`,
    pattern: (n) => n === 'wire.jsonl',
    pick: (o) => o.type === 'turn.prompt' || o.type === 'context.append_loop_event',
  },
};

/** 从真实文件里采样记录（每种类型最多采 `perFile` 条）。 */
function sampleReal(agent: AgentKind, maxFiles = 6, perFile = 200): Record<string, unknown>[] {
  const spec = REAL[agent];
  if (!spec || !fs.existsSync(spec.dir)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (spec.pattern(e.name)) found.push(full);
    }
  };
  walk(spec.dir, 0);

  const out: Record<string, unknown>[] = [];
  for (const file of found) {
    let n = 0;
    for (const line of readLines(file)) {
      if (n >= perFile) break;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (spec.pick(o)) {
        out.push(o);
        n += 1;
      }
    }
  }
  return out;
}

function* readLines(file: string): Generator<string> {
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (line.trim()) yield line;
  }
}

/**
 * 有意不写的**展示性**字段。
 *
 * 这些字段在真实文件里稳定出现，但纯属展示/统计用途，CLI 恢复会话并不依赖它们。
 * 与其编造一个假值（比如凭空写个 git 分支名），不如明确列出并说明原因 —— 编造
 * 的元数据比缺失的元数据更容易误导人。
 */
const OMITTED_DISPLAY_FIELDS: Record<string, string> = {
  gitBranch: '仓库分支名，纯展示用途；无法从归一化历史反推，编造一个假值反而误导',
  promptId: 'Claude 内部的一次性 prompt 追踪 id，新会话不需要沿用旧值',
  promptSource: '标记消息来自 SDK 还是交互终端，与恢复无关',
  permissionMode: '按会话当前权限模式由 Vibe 在开新一轮时决定，不在历史里回放',
};

/**
 * 统计真实记录里「稳定出现」的字段名（出现率 ≥ `ratio`），这些就是事实上的
 * 必填字段。用出现率而不是「出现过」来过滤，避免把偶发字段当必填。
 */
function stableKeys(records: Record<string, unknown>[], ratio = 0.6): Set<string> {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const k of Object.keys(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const need = Math.max(1, Math.ceil(records.length * ratio));
  return new Set([...counts.entries()].filter(([, c]) => c >= need).map(([k]) => k));
}

describe('产物结构 vs 真实 CLI 文件', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = makeTempEnv('structure');
  });
  afterEach(() => env.cleanup());

  for (const target of AGENTS) {
    it(`${target}：产物的每一行都是合法 JSON，且覆盖真实文件的稳定字段`, async (t) => {
      const real = sampleReal(target);
      const sqliteTarget = target === 'zcode' || target === 'cursor';
      if (!real.length && !sqliteTarget) {
        // 本机没装这个 agent / 没有原生会话数据 —— 跳过而不是误报成失败。
        t.skip(`本机没有 ${target} 的真实原生会话文件，跳过字段覆盖校验`);
        return;
      }

      const blocks = loadFixture('codex-tools.jsonl');
      const session: StoredSession = {
        id: 'sess-struct',
        claudeSessionId: 'native-struct-1',
        title: '结构校验',
        cwd: '/tmp/proj',
        model: 'auto',
        permissionMode: 'default',
        agent: 'codex',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_002_000,
        messageCount: 2,
      };
      const file = transcriptFileFor(env.paths, 'codex', session.id);
      await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
      await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

      const outcome = await switchSessionAgent(
        { session, targetAgent: target, now: 1_700_000_100_000 },
        { fs: env.fs, paths: env.paths },
      );

      if (target === 'zcode') {
        const dbFile = outcome.files.find((fileName) => fileName.endsWith('db.sqlite'));
        assert.ok(dbFile, 'zcode 必须产出 db.sqlite');
        const db = openSqlite(dbFile);
        assert.ok(db);
        try {
          const tables = db.prepare(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
          ).all() as { name: string }[];
          assert.equal(tables.length, 19, 'zcode 从零建库必须包含完整 19 表 schema');
          const sessionRow = db.prepare('select * from session where id=?').get(outcome.nativeId) as Record<string, unknown>;
          assert.equal(sessionRow.directory, '/tmp/proj');
          assert.equal(sessionRow.path, '/tmp/proj');
          assert.equal(sessionRow.task_type, 'interactive');
          assert.match(String(sessionRow.id), /^sess_[0-9a-f-]{36}$/);
          const messages = db.prepare(
            'select id, sequence from message where session_id=? order by sequence',
          ).all(outcome.nativeId) as { id: string; sequence: number }[];
          assert.deepEqual(messages.map((row) => row.sequence), messages.map((_, i) => i));
          for (const message of messages) {
            assert.match(message.id, /^msg_[0-9a-z]+_[0-9a-f-]{36}$/);
            const parts = db.prepare(
              'select id, sequence from part where message_id=? order by sequence',
            ).all(message.id) as { id: string; sequence: number }[];
            assert.deepEqual(parts.map((row) => row.sequence), parts.map((_, i) => i));
            for (const part of parts) assert.match(part.id, /^part_[0-9a-z]+_[0-9a-f-]{36}$/);
          }
          assert.deepEqual(db.pragma('foreign_key_check'), []);
          assert.equal(
            Object.values((db.pragma('integrity_check') as Record<string, unknown>[])[0])[0],
            'ok',
          );
        } finally {
          db.close();
        }
        return;
      }

      if (target === 'cursor') {
        const storeFiles = outcome.files.filter((fileName) => fileName.endsWith('store.db'));
        const storeFile = storeFiles.find((fileName) => fileName.includes('/.cursor/chats/'));
        const acpStoreFile = storeFiles.find((fileName) => fileName.includes('/.cursor/acp-sessions/'));
        const metaFile = outcome.files.find((fileName) => fileName.endsWith('meta.json'));
        assert.ok(storeFile && acpStoreFile && metaFile, 'cursor 必须产出 chats/ACP store.db + meta.json');
        assert.deepEqual(
          fs.readFileSync(acpStoreFile),
          fs.readFileSync(storeFile),
          'ACP 与 chats 原生库必须字节一致',
        );
        const db = openSqlite(storeFile);
        assert.ok(db);
        try {
          const tables = db.prepare(
            "select name from sqlite_master where type='table' order by name",
          ).all() as { name: string }[];
          assert.deepEqual(tables.map((row) => row.name), ['blobs', 'meta']);
          const rows = db.prepare('select id, data from blobs').all() as { id: string; data: Buffer }[];
          assert.ok(rows.length > 1);
          const byId = new Map(rows.map((row) => [row.id, row.data]));
          for (const row of rows) {
            assert.equal(crypto.createHash('sha256').update(row.data).digest('hex'), row.id);
          }
          const documents = rows.flatMap((row) => {
            try {
              return [JSON.parse(row.data.toString('utf8')) as Record<string, any>];
            } catch {
              return [];
            }
          });
          const toolMessages = documents.filter((document) => document.role === 'tool');
          assert.ok(toolMessages.length > 0, '工具夹具必须生成 Cursor role=tool 消息');
          for (const message of toolMessages) {
            assert.equal(message.content?.length, 1, '真实 Cursor 每条 tool 消息只承载一个结果');
            assert.equal(message.id, message.content[0]?.toolCallId);
            assert.equal(message.content[0]?.type, 'tool-result');
            assert.equal(
              typeof message.providerOptions?.cursor?.highLevelToolCallResult?.isError,
              'boolean',
              'Cursor 工具错误标志应写在原生 providerOptions 位置',
            );
          }
          const metaRow = db.prepare("select value from meta where key='0'").get() as { value: string };
          const metadata = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8')) as {
            agentId: string;
            latestRootBlobId: string;
          };
          assert.equal(metadata.agentId, outcome.nativeId);
          const root = byId.get(metadata.latestRootBlobId);
          assert.ok(root, 'meta.latestRootBlobId 必须指向现存 root blob');
          assert.equal(root.length % 34, 0, 'Cursor 根容器应由固定 34-byte 引用帧组成');
          for (let at = 0; at < root.length; at += 34) {
            assert.equal(root[at], 0x0a);
            assert.equal(root[at + 1], 0x20);
            assert.ok(byId.has(root.subarray(at + 2, at + 34).toString('hex')));
          }
          assert.equal(
            Object.values((db.pragma('integrity_check') as Record<string, unknown>[])[0])[0],
            'ok',
          );
        } finally {
          db.close();
        }
        const discoveryMeta = JSON.parse((await env.fs.readFile(metaFile))!) as {
          cwd?: string;
          hasConversation?: boolean;
        };
        assert.equal(discoveryMeta.cwd, '/tmp/proj');
        assert.equal(discoveryMeta.hasConversation, true);
        return;
      }

      // partial 方向不产出原生文件，只要求产物（注入文本）可用。
      if (outcome.fidelity === 'partial') {
        assert.ok(outcome.primer && outcome.primer.length > 0);
        return;
      }

      // 1. 每个产物文件都必须是合法 JSON：`.jsonl` 按行解析（CLI 就是按行读的），
      //    `.json` 是整体一个文档（kiro 的元数据、grok 的 summary、kimi 的 state）。
      const produced: Record<string, unknown>[] = [];
      for (const f of outcome.files) {
        const raw = (await env.fs.readFile(f)) ?? '';
        if (!raw.trim()) continue; // 空会话允许产出空文件
        if (f.endsWith('.jsonl')) {
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line) as Record<string, unknown>;
            assert.ok(parsed && typeof parsed === 'object', `${target} 产物里有非法 JSON 行: ${f}`);
            produced.push(parsed);
          }
        } else {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          assert.ok(parsed && typeof parsed === 'object', `${target} 的 ${f} 不是合法 JSON`);
          produced.push(parsed);
        }
      }
      assert.ok(produced.length > 0, `${target} 没有产出任何记录`);

      // 2. 真实文件里稳定出现的字段，产物里也都要出现（按「至少一个记录有」判，
      //    因为不同记录类型的字段集本来就不同）。
      const required = stableKeys(real);
      const mine = new Set<string>();
      for (const r of produced) for (const k of Object.keys(r)) mine.add(k);
      const missing = [...required].filter((k) => !mine.has(k) && !(k in OMITTED_DISPLAY_FIELDS));
      assert.deepEqual(missing, [], `${target} 产物缺少真实文件里稳定出现的字段: ${missing.join(', ')}`);
    });
  }

  it('真实数据存在时才做上述校验（本机会话数据是校验基准）', () => {
    if (!hasRealData()) skip('本机没有 ~/.vibe 数据');
    assert.ok(fs.existsSync(`${HOME}/.vibe/sessions.json`));
  });

  it('kimi 会话被追加进 append-only 索引（发现逻辑靠它定位会话）', async () => {
    const blocks = loadFixture('codex-tools.jsonl');
    const session: StoredSession = {
      id: 'sess-kimi-idx',
      claudeSessionId: 'native-k-1',
      title: 'kimi 索引',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'codex',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 2,
    };
    const file = transcriptFileFor(env.paths, 'codex', session.id);
    await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
    await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const outcome = await switchSessionAgent(
      { session, targetAgent: 'kimi', now: 1_700_000_100_000 },
      { fs: env.fs, paths: env.paths },
    );
    const index = (await env.fs.readFile(`${env.paths.kimiHome}/session_index.jsonl`)) ?? '';
    const records = index
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { sessionId?: string; sessionDir?: string; workDir?: string });
    const hit = records.find((r) => r.sessionId === outcome.nativeId);
    assert.ok(hit, 'kimi 会话必须写进 session_index.jsonl');
    assert.equal(hit.workDir, '/tmp/proj');
    assert.ok(hit.sessionDir?.includes(outcome.nativeId));
    // 会话目录里 state.json + wire.jsonl 都要在。
    assert.ok(await env.fs.exists(`${hit.sessionDir}/state.json`));
    assert.ok(await env.fs.exists(`${hit.sessionDir}/agents/main/wire.jsonl`));
  });

  it('grok 会话目录结构对齐真实布局（chat_history + updates + summary）', async () => {
    const blocks = loadFixture('grok-small.jsonl');
    const session: StoredSession = {
      id: 'sess-grok-struct',
      claudeSessionId: 'native-g-1',
      title: 'grok 结构',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'grok',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    };
    const file = transcriptFileFor(env.paths, 'grok', session.id);
    await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
    await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const outcome = await switchSessionAgent(
      { session, targetAgent: 'grok', now: 1_700_000_100_000 },
      { fs: env.fs, paths: env.paths },
    );
    // 真实布局：~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/
    const dir = path.join(env.paths.grokSessionsDir, encodeURIComponent('/tmp/proj'), outcome.nativeId);
    for (const name of ['chat_history.jsonl', 'updates.jsonl', 'summary.json']) {
      assert.ok(await env.fs.exists(path.join(dir, name)), `grok 会话目录缺少 ${name}`);
    }
    const summary = JSON.parse((await env.fs.readFile(path.join(dir, 'summary.json')))!) as {
      info?: { id?: string; cwd?: string };
    };
    assert.equal(summary.info?.id, outcome.nativeId);
    assert.equal(summary.info?.cwd, '/tmp/proj');
  });

  it('codex rollout 落在日期目录里，首行是 session_meta（发现逻辑依赖）', async () => {
    const blocks = loadFixture('kiro-tools.jsonl');
    const session: StoredSession = {
      id: 'sess-codex-struct',
      claudeSessionId: 'native-c-1',
      title: 'codex 结构',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'kiro',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    };
    const file = transcriptFileFor(env.paths, 'kiro', session.id);
    await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
    await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const outcome = await switchSessionAgent(
      { session, targetAgent: 'codex', now: Date.UTC(2026, 7, 31, 12, 0, 0) },
      { fs: env.fs, paths: env.paths },
    );
    const found = await findRecursive(
      env.paths.codexSessionsDir,
      (n) => n.endsWith('.jsonl') && n.includes(outcome.nativeId),
    );
    assert.ok(found, '未找到 codex rollout');
    // 路径形态：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
    const rel = path.relative(env.paths.codexSessionsDir, found);
    assert.match(rel, /^\d{4}\/\d{2}\/\d{2}\/rollout-.+-.+\.jsonl$/, `rollout 路径形态不对: ${rel}`);
    const lines = ((await env.fs.readFile(found)) ?? '').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]) as { type?: string; payload?: { id?: string; cwd?: string } };
    assert.equal(first.type, 'session_meta', 'rollout 首行必须是 session_meta');
    assert.equal(first.payload?.id, outcome.nativeId);
    assert.equal(first.payload?.cwd, '/tmp/proj');
  });

  it('kiro 同时写出 .jsonl（对话）与 .json（发现用的元数据）', async () => {
    const blocks = loadFixture('zcode-multi.jsonl');
    const session: StoredSession = {
      id: 'sess-kiro-struct',
      claudeSessionId: 'native-kr-1',
      title: 'kiro 结构',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'zcode',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    };
    const file = transcriptFileFor(env.paths, 'zcode', session.id);
    await env.fs.mkdirp(file.slice(0, file.lastIndexOf('/')));
    await env.fs.writeFile(file, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const outcome = await switchSessionAgent(
      { session, targetAgent: 'kiro', now: 1_700_000_100_000 },
      { fs: env.fs, paths: env.paths },
    );
    const metaPath = path.join(env.paths.kiroSessionsDir, `${outcome.nativeId}.json`);
    const meta = JSON.parse((await env.fs.readFile(metaPath))!) as {
      session_id?: string;
      cwd?: string;
      title?: string;
    };
    assert.equal(meta.session_id, outcome.nativeId);
    assert.equal(meta.cwd, '/tmp/proj');
    assert.ok(meta.title);
  });
});
