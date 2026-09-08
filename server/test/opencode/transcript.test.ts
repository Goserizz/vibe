import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { opencodeNativeBlocksFromRows, readOpencodeNativeTranscriptAt } from '../../src/opencode/transcript.js';
import { readRemoteOpencodeTranscript } from '../../src/opencode/remote.js';
import { openSqlite } from '../../src/switch/sqlite.js';
import { makeTempEnv, type TempEnv } from '../switch/helpers.js';

const execFileAsync = promisify(execFile);
const SID = `ses_${'s'.repeat(22)}`;
const USER = `msg_${'u'.repeat(24)}`;
const ASSISTANT = `msg_${'a'.repeat(24)}`;
const messages = [
  { id: USER, time_created: 1000, data: JSON.stringify({ role: 'user' }) },
  { id: ASSISTANT, time_created: 1001, data: JSON.stringify({ role: 'assistant', parentID: USER }) },
];
// Native OpenCode keeps IDs/relationships in SQL columns, not in data JSON.
// These envelopes are synthetic, independently shaped after real CLI rows.
const parts = [
  { id: 'prt_user', message_id: USER, time_created: 1000, data: JSON.stringify({ type: 'text', text: 'Read two files.' }) },
  { id: 'prt_text', message_id: ASSISTANT, time_created: 1001, data: JSON.stringify({ type: 'text', text: 'Reading.' }) },
  { id: 'prt_ok', message_id: ASSISTANT, time_created: 1002, data: JSON.stringify({
    type: 'tool', tool: 'Read', callID: 'call_ok',
    state: { status: 'completed', input: { path: 'one.txt' }, output: 'sample file', title: 'Read', metadata: {}, time: { start: 1002, end: 1003 } },
  }) },
  { id: 'prt_error', message_id: ASSISTANT, time_created: 1004, data: JSON.stringify({
    type: 'tool', tool: 'Read', callID: 'call_error',
    state: { status: 'error', input: { path: 'missing.txt' }, error: 'File not found', time: { start: 1004, end: 1005 } },
  }) },
];

function assertNativeContent(blocks: ReturnType<typeof readOpencodeNativeTranscriptAt>): void {
  assert.deepEqual(blocks.map((b) => b.kind), ['user', 'assistant', 'tool', 'tool']);
  const tools = blocks.filter((b) => b.kind === 'tool');
  assert.deepEqual(tools.map((b) => [b.toolUseId, b.result, b.isError]), [
    ['call_ok', 'sample file', false], ['call_error', 'File not found', true],
  ]);
}

describe('OpenCode 原生 transcript（非 adapter 自产 JSON）', () => {
  let env: TempEnv;
  let dbFile: string;
  beforeEach(() => {
    env = makeTempEnv('opencode-reader');
    dbFile = `${env.paths.opencodeHome}/opencode.db`;
    const db = openSqlite(dbFile);
    assert.ok(db);
    try {
      db.exec(fs.readFileSync(path.join(import.meta.dirname, '../switch/fixtures/opencode-native-schema.sql'), 'utf8'));
      db.pragma('foreign_keys=ON');
      db.prepare('insert into project (id,worktree,time_created,time_updated,sandboxes) values (?,?,?,?,?)').run('global', env.root, 1000, 1000, '[]');
      db.prepare('insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values (?,?,?,?,?,?,?,?)')
        .run(SID, 'global', 'test', env.root, 'Synthetic session', '1.18.27', 1000, 1005);
      for (const m of messages) db.prepare('insert into message (id,session_id,time_created,time_updated,data) values (?,?,?,?,?)')
        .run(m.id, SID, m.time_created, m.time_created, m.data);
      for (const p of parts) db.prepare('insert into part (id,message_id,session_id,time_created,time_updated,data) values (?,?,?,?,?,?)')
        .run(p.id, p.message_id, SID, p.time_created, p.time_created, p.data);
    } finally { db.close(); }
  });
  afterEach(() => env.cleanup());

  it('本地读取使用 part.message_id 列，并保留 state.error 的错误文本', () => {
    assertNativeContent(readOpencodeNativeTranscriptAt(dbFile, SID));
  });

  it('SQL 关联列优先于 JSON 内过时的冗余 message_id', () => {
    const conflicting = parts.map((p) => ({ ...p, data: JSON.stringify({ ...JSON.parse(p.data), message_id: 'stale-parent' }) }));
    assertNativeContent(opencodeNativeBlocksFromRows(messages, conflicting));
  });

  it('兼容旧 Vibe 的嵌入式 message_id 与 error.output', () => {
    const legacy = parts.map(({ message_id, ...p }) => {
      const data = JSON.parse(p.data);
      if (data.state?.status === 'error') {
        data.state.output = data.state.error;
        delete data.state.error;
      }
      return { ...p, data: JSON.stringify({ ...data, message_id }) };
    });
    assertNativeContent(opencodeNativeBlocksFromRows(messages, legacy));
  });

  it('远端生产 Python 查询也读取关联列（临时库模拟 SSH，不连接真实主机）', async () => {
    const blocks = await readRemoteOpencodeTranscript({ name: 'test-host', ssh: 'test-host' }, SID, {
      ssh: async (_host, command) => {
        const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', command], {
          env: { ...process.env, OPENCODE_HOME: env.paths.opencodeHome }, timeout: 5000,
        });
        return { code: 0, stdout, stderr, timedOut: false };
      },
    });
    assertNativeContent(blocks);
  });
});
