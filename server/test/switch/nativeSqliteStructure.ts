import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { config } from '../../src/config.js';
import { switchSessionAgent } from '../../src/switch/index.js';
import { transcriptFileFor } from '../../src/switch/paths.js';
import { openSqlite, openSqliteReadonly, type SqliteDb } from '../../src/switch/sqlite.js';
import type { StoredSession } from '../../src/sessions/store.js';
import { compareTurns, fixtureWithTools, makeTempEnv, readBackNative } from './helpers.js';

type Target = 'opencode' | 'devin';
type Json = Record<string, any>;
type Groups = Map<string, Json[]>;

const TABLES: Record<Target, string[]> = {
  opencode: ['project', 'session', 'message', 'part'],
  devin: ['app_state', 'sessions', 'message_nodes', 'prompt_history', 'rendered_commits', 'tool_call_state'],
};

function tableShape(db: SqliteDb, table: string): unknown {
  return {
    columns: (db.pragma(`table_info(${table})`) as Json[]).map((c) => ({
      name: c.name, type: String(c.type).toUpperCase(), notnull: c.notnull,
      default: c.dflt_value, pk: c.pk,
    })),
    foreignKeys: db.pragma(`foreign_key_list(${table})`),
    uniqueKeys: (db.prepare('select name from pragma_index_list(?) where "unique"=1').all(table) as { name: string }[])
      .map((index) => (db.prepare('select name from pragma_index_info(?) order by seqno').all(index.name) as { name: string }[])
        .map((column) => column.name))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

function compareSchema(actual: SqliteDb, reference: SqliteDb, target: Target): void {
  for (const table of TABLES[target]) {
    assert.deepEqual(tableShape(actual, table), tableShape(reference, table), `${target}.${table} 原生 schema`);
  }
}

function groupDocuments(db: SqliteDb, target: Target, sessionId?: string): Groups {
  const groups: Groups = new Map();
  const add = (key: string, document: Json): void => {
    const group = groups.get(key) ?? [];
    group.push(document);
    groups.set(key, group);
  };
  if (target === 'opencode') {
    for (const table of ['message', 'part']) {
      const rows = db.prepare(
        `select data from ${table} ${sessionId ? 'where session_id = ?' : ''} order by time_created desc limit 2000`,
      ).all(...(sessionId ? [sessionId] : [])) as { data: string }[];
      for (const row of rows) {
        const d = JSON.parse(row.data) as Json;
        const kind = table === 'message' ? d.role : d.type === 'tool' ? `tool/${d.state?.status}` : d.type;
        add(`${table}/${kind}`, d);
      }
    }
  } else {
    const rows = db.prepare(
      `select chat_message from message_nodes ${sessionId ? 'where session_id = ?' : ''} order by row_id desc limit 500`,
    ).all(...(sessionId ? [sessionId] : [])) as { chat_message: string }[];
    for (const row of rows) {
      const d = JSON.parse(row.chat_message) as Json;
      add(`message/${d.role}`, d);
    }
  }
  return groups;
}

// Inspect envelope fields, never arbitrary tool inputs/outputs, provider
// metadata or user-defined keys. Only field names are used in diagnostics.
const NESTED = new Set(['time', 'model', 'path', 'tokens', 'tokens.cache', 'state', 'state.time', 'metadata', 'metadata.telemetry']);
function envelopePaths(document: Json, prefix = ''): string[] {
  return Object.entries(document).flatMap(([key, value]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    return [field, ...(NESTED.has(field) && value && typeof value === 'object' && !Array.isArray(value)
      ? envelopePaths(value, field) : [])];
  });
}

// These fields belong to the old provider/runtime, not an imported turn.
// Never invent signatures, request IDs, usage, snapshots or model variants.
const OMITTED: Record<Target, string[]> = {
  opencode: ['variant', 'model.variant', 'snapshot', 'metadata'],
  devin: ['thinking', 'metadata.num_tokens', 'metadata.request_id', 'metadata.metrics',
    'metadata.started_generation_at', 'metadata.generation_model', 'metadata.extensions'],
};

function compareEnvelopes(actual: Groups, reference: Groups, target: Target): void {
  for (const [kind, documents] of actual) {
    const samples = reference.get(kind);
    if (!samples?.length) continue; // Static invariants below still run without live samples.
    const counts = new Map<string, number>();
    for (const sample of samples) {
      for (const field of envelopePaths(sample)) counts.set(field, (counts.get(field) ?? 0) + 1);
    }
    const required = [...counts].filter(([field, n]) => n >= Math.ceil(samples.length * 0.6)
      && !OMITTED[target].some((omit) => field === omit || field.startsWith(`${omit}.`))).map(([field]) => field);
    for (const document of documents) {
      const fields = new Set(envelopePaths(document));
      assert.deepEqual(required.filter((field) => !fields.has(field)), [], `${target} ${kind} 缺少原生稳定字段`);
    }
  }
}

function assertHealthy(db: SqliteDb): void {
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
}

function assertOpencode(db: SqliteDb, nativeId: string, cwd: string): void {
  const session = db.prepare('select * from session where id=?').get(nativeId) as Json;
  assert.match(nativeId, /^ses_[a-zA-Z0-9]{22}$/);
  assert.equal(session.directory, cwd);
  assert.equal(session.path, cwd.replace(/^\/+/, ''));
  assert.equal(session.agent, 'build');
  assert.deepEqual(JSON.parse(session.model), { id: 'test-model', providerID: 'test-provider' });
  assert.ok(db.prepare('select id from project where id=?').get(session.project_id));

  const messages = db.prepare('select * from message where session_id=? order by time_created').all(nativeId) as Json[];
  const parts = db.prepare('select * from part where session_id=? order by time_created, rowid').all(nativeId) as Json[];
  const byId = new Map(messages.map((m) => [m.id, JSON.parse(m.data) as Json]));
  let successful = 0;
  let failed = 0;
  for (const row of messages) {
    assert.match(row.id, /^msg_[a-zA-Z0-9]{24}$/);
    const m = byId.get(row.id)!;
    assert.equal(typeof m.time.created, 'number');
    if (m.role === 'assistant') {
      assert.equal(byId.get(m.parentID)?.role, 'user', 'assistant 必须指向同会话 user');
      assert.equal(m.modelID, 'test-model');
      assert.equal(m.providerID, 'test-provider');
    }
  }
  for (const row of parts) {
    assert.match(row.id, /^prt_[a-zA-Z0-9]{24}$/);
    assert.ok(byId.has(row.message_id), 'part 必须关联同会话 message');
    const p = JSON.parse(row.data) as Json;
    assert.equal(p.type === 'reasoning', false, '迁移 thinking 不得伪造原生 reasoning');
    if (p.type !== 'tool') continue;
    assert.equal(byId.get(row.message_id)?.role, 'assistant');
    assert.equal(typeof p.callID, 'string');
    assert.equal(typeof p.state.input, 'object');
    assert.equal(typeof p.state.time.start, 'number');
    assert.equal(typeof p.state.time.end, 'number');
    if (p.state.status === 'completed') {
      successful++;
      assert.equal(typeof p.state.title, 'string', 'OpenCode completed 工具必须有 state.title');
      assert.equal(typeof p.state.output, 'string');
      assert.equal(typeof p.state.metadata, 'object');
    } else {
      failed++;
      assert.equal(p.state.status, 'error');
      assert.equal(typeof p.state.error, 'string', 'OpenCode error 工具必须有 state.error，不能用 output 代替');
      assert.equal('output' in p.state, false);
    }
  }
  assert.ok(successful > 0 && failed > 0, '必须同时测试工具成功与失败');
}

function assertDevin(db: SqliteDb, nativeId: string, cwd: string): void {
  const session = db.prepare('select * from sessions where id=?').get(nativeId) as Json;
  assert.equal(session.working_directory, cwd);
  assert.equal(session.backend_type, 'windsurf');
  assert.deepEqual(JSON.parse(session.workspace_dirs), [cwd]);
  const rows = db.prepare('select * from message_nodes where session_id=? order by node_id').all(nativeId) as Json[];
  assert.ok(rows.length > 0);
  assert.equal(session.main_chain_id, rows.at(-1)!.node_id, '主链指针必须指向叶节点');
  const calls = new Map<string, Json>();
  const results = new Map<string, Json>();
  let previous: number | null = null;
  let lastCreated = 0;
  for (const row of rows) {
    assert.equal(row.parent_node_id, previous, '父链不能断裂、成环或指向其他会话');
    previous = row.node_id;
    assert.ok(row.created_at > lastCreated, '节点时间应递增（秒）');
    lastCreated = row.created_at;
    const m = JSON.parse(row.chat_message) as Json;
    assert.match(m.message_id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof m.content, 'string');
    assert.equal('thinking' in m, false, '不得伪造 Devin 原生 thinking/signature');
    assert.ok(Number.isFinite(Date.parse(m.metadata.created_at)));
    if (m.role === 'assistant') {
      assert.ok(Array.isArray(m.tool_calls), 'Devin assistant 必须带 tool_calls 数组（无工具时为空）');
      for (const call of m.tool_calls) {
        assert.equal(calls.has(call.id), false);
        assert.equal(typeof call.name, 'string');
        assert.equal(typeof call.arguments, 'object');
        calls.set(call.id, call);
      }
    }
    if (m.role === 'tool') {
      assert.ok(calls.has(m.tool_call_id), 'tool 结果必须出现在对应调用之后');
      assert.equal(results.has(m.tool_call_id), false);
      results.set(m.tool_call_id, m);
    }
  }
  assert.ok(calls.size > 0);
  assert.deepEqual([...results.keys()], [...calls.keys()]);
  const states = db.prepare('select * from tool_call_state where session_id=?').all(nativeId) as Json[];
  assert.equal(states.length, calls.size);
  const statuses = new Set<string>();
  for (const row of states) {
    const call = JSON.parse(row.tool_call_json) as Json;
    const update = JSON.parse(row.tool_call_update_json) as Json;
    assert.equal(call.id, row.tool_call_id);
    assert.equal(update.id, call.id);
    assert.equal(call.name, calls.get(call.id)?.name);
    const success = results.get(call.id)?.metadata.extensions['chisel/tool_result_meta'].success;
    assert.equal(update.status, success === false ? 'failed' : 'completed');
    statuses.add(update.status);
  }
  assert.deepEqual([...statuses].sort(), ['completed', 'failed']);
}

/** Both skipped SQLite targets now have an independent CLI-schema oracle.
 * Only whitelisted CREATE TABLE definitions and JSON field names are sampled
 * from live libraries. All writes and all conversation content are synthetic.
 * Committed schema-only fixtures keep these tests runnable on clean CI too. */
export async function testNativeSqliteStructure(target: Target, t: TestContext): Promise<void> {
  const fixtureSql = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `${target}-native-schema.sql`), 'utf8');
  const reference = openSqlite(':memory:');
  assert.ok(reference);
  try {
    reference.exec(fixtureSql);
    let schemaSql = fixtureSql;
    let nativeGroups: Groups = new Map();
    const live = openSqliteReadonly(target === 'opencode' ? config.opencodeDb : config.devinSessionsDb);
    if (live) {
      try {
        compareSchema(live, reference, target);
        schemaSql = TABLES[target].map((table) => {
          const row = live.prepare("select sql from sqlite_master where type='table' and name=?").get(table) as { sql: string };
          return `${row.sql};`;
        }).join('\n');
        nativeGroups = groupDocuments(live, target);
        t.diagnostic(`只读对照本机 ${target} schema；原生 JSON 样本类型：${[...nativeGroups.keys()].join(', ')}`);
      } finally {
        live.close();
      }
    } else {
      t.diagnostic(`本机无 ${target} 数据库；使用已采样的 schema-only 夹具，测试照常执行`);
    }

    for (const mode of ['fresh', 'existing']) {
      const env = makeTempEnv(`structure-${target}-${mode}`);
      try {
        const file = target === 'opencode' ? `${env.paths.opencodeHome}/opencode.db` : `${env.paths.devinHome}/cli/sessions.db`;
        const source: StoredSession = {
          id: `structure-${target}`, claudeSessionId: 'source-structure', title: '结构校验',
          cwd: env.root, model: 'auto', permissionMode: 'default', agent: 'codex',
          createdAt: 1_700_000_000_000, updatedAt: 1_700_000_002_000, messageCount: 1,
        };
        const blocks = fixtureWithTools();
        await env.fs.writeFile(transcriptFileFor(env.paths, 'codex', source.id), blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
        const convert = () => switchSessionAgent(
          { session: source, targetAgent: target, targetModel: target === 'opencode' ? 'test-provider/test-model' : 'auto', now: 1_700_000_100_000 },
          { fs: env.fs, paths: env.paths },
        );
        const preserved = new Map<string, string[]>();
        if (mode === 'existing') {
          const db = openSqlite(file);
          assert.ok(db);
          try { db.exec(schemaSql); } finally { db.close(); }
          const first = await convert();
          assert.equal(first.fidelity, 'full');
          const seeded = openSqliteReadonly(file);
          assert.ok(seeded);
          try {
            for (const table of TABLES[target]) preserved.set(table, seeded.prepare(`select * from ${table}`).all().map((r) => JSON.stringify(r)));
          } finally { seeded.close(); }
        }
        const outcome = await convert();
        assert.equal(outcome.fidelity, 'full', `${target} ${mode} 不得悄悄降级为 primer`);
        assert.ok(outcome.files.includes(file));
        const db = openSqliteReadonly(file);
        assert.ok(db);
        try {
          compareSchema(db, reference, target);
          assertHealthy(db);
          for (const [table, oldRows] of preserved) {
            const rows = new Set(db.prepare(`select * from ${table}`).all().map((r) => JSON.stringify(r)));
            assert.ok(oldRows.every((row) => rows.has(row)), `${target}.${table} 不得覆盖已有会话`);
          }
          if (target === 'opencode') assertOpencode(db, outcome.nativeId, env.root);
          else assertDevin(db, outcome.nativeId, env.root);
          compareEnvelopes(groupDocuments(db, target, outcome.nativeId), nativeGroups, target);
        } finally { db.close(); }
        const back = await readBackNative(target, env, outcome.nativeId);
        compareTurns(target, blocks, back.blocks);
        t.diagnostic(`${target} ${mode}：schema / JSON / 工具配对 / FK / integrity / 生产解析器往返通过`);
      } finally {
        env.cleanup();
      }
    }
  } finally {
    reference.close();
  }
}
