import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { AgentKind, ChatBlock } from '../../../shared/protocol.js';
import type { SwitchFs } from '../../src/switch/fs.js';
import { localFs } from '../../src/switch/fs.js';
import { tempSwitchPaths, type SwitchPaths } from '../../src/switch/paths.js';
import { toCanonicalTurns } from '../../src/switch/canonical.js';
import { parseTranscriptBlocks } from '../../src/sessions/transcript.js';
import { parseCodebuddyBlocks } from '../../src/codebuddy/transcript.js';
import { codexRolloutBlocks } from '../../src/codex/transcript.js';
import { kimiWireBlocks } from '../../src/kimi/transcript.js';
import { grokNativeBlocks } from '../../src/grok/transcript.js';
import {
  cursorStoreBlocks,
  parseCursorStoreDump,
} from '../../src/cursor/transcript.js';
import { zcodeMessagesToBlocks } from '../../src/zcode/transcript.js';
import { readDevinNativeTranscriptAt } from '../../src/devin/transcript.js';
import { readOpencodeNativeTranscriptAt } from '../../src/opencode/transcript.js';
import { openSqlite } from '../../src/switch/sqlite.js';
import { renderAssistantText } from '../../src/switch/canonical.js';

/** 全部 10 个 agent（与 `shared/protocol.ts` 的 AgentKind 联合类型保持一致）。 */
export const AGENTS: AgentKind[] = [
  'claude',
  'cursor',
  'codex',
  'kimi',
  'kiro',
  'grok',
  'zcode',
  'codebuddy',
  'opencode',
  'devin',
];

// ---------------------------------------------------------------------------
// 临时环境
// ---------------------------------------------------------------------------

export interface TempEnv {
  root: string;
  paths: SwitchPaths;
  fs: SwitchFs;
  cleanup: () => void;
}

/**
 * 建一个完全隔离的临时环境。
 *
 * `SwitchPaths` 全部指向临时目录，**绝不接触** 真实的 ~/.vibe、~/.claude、
 * ~/.codex、~/.kiro、~/.grok、~/.kimi-code 等生产数据。
 */
export function makeTempEnv(label = 'switch'): TempEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-${label}-`));
  const paths = tempSwitchPaths(root);
  return {
    root,
    paths,
    fs: localFs,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');

/** 读一个归一化 transcript 夹具（`server/test/switch/fixtures/*.jsonl`）。 */
export function loadFixture(name: string): ChatBlock[] {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    blocks.push(JSON.parse(line) as ChatBlock);
  }
  return blocks;
}

/** 磁盘上的真实归一化 transcript（只读，供「结构对比」类测试用）。 */
export const REAL_TRANSCRIPTS: Partial<Record<AgentKind, string>> = {
  codex: `${process.env.HOME}/.vibe/codex-transcripts`,
  cursor: `${process.env.HOME}/.vibe/cursor-transcripts`,
  kimi: `${process.env.HOME}/.vibe/kimi-transcripts`,
  kiro: `${process.env.HOME}/.vibe/kiro-transcripts`,
  grok: `${process.env.HOME}/.vibe/grok-transcripts`,
  zcode: `${process.env.HOME}/.vibe/zcode-transcripts`,
  codebuddy: `${process.env.HOME}/.vibe/codebuddy-transcripts`,
};

/** 磁盘上是否存在真实数据（CI / 干净机器上跑测试时会自动跳过相关断言）。 */
export function hasRealData(): boolean {
  return fs.existsSync(`${process.env.HOME}/.vibe/sessions.json`);
}

// ---------------------------------------------------------------------------
// 合成夹具（覆盖边界）
// ---------------------------------------------------------------------------

let seq = 0;
const id = (): string => `b${(seq += 1)}`;

function user(text: string, ts = 1_700_000_000_000): ChatBlock {
  return { id: id(), kind: 'user', text, ts };
}
function assistant(text: string, ts = 1_700_000_001_000, streaming = false): ChatBlock {
  return { id: id(), kind: 'assistant', text, ts, streaming };
}
function thinking(text: string, ts = 1_700_000_000_500): ChatBlock {
  return { id: id(), kind: 'thinking', text, ts, streaming: false };
}
function tool(name: string, input: unknown, result: string | undefined, opts: { isError?: boolean; status?: 'running' | 'done' | 'error' } = {}): ChatBlock {
  const toolUseId = `tu_${(seq += 1)}`;
  return {
    id: toolUseId,
    kind: 'tool',
    toolUseId,
    name,
    input,
    status: opts.status ?? (result === undefined ? 'running' : 'done'),
    ...(result === undefined ? {} : { result }),
    ...(opts.isError ? { isError: true } : {}),
    ts: 1_700_000_001_500,
  };
}
function result(ts = 1_700_000_002_000): ChatBlock {
  return { id: id(), kind: 'result', ts, durationMs: 1234, costUsd: 0.01 };
}

/** 多轮纯文本对话。 */
export function fixtureMultiTurn(): ChatBlock[] {
  return [
    user('第一轮：帮我看看这个项目是干什么的'),
    assistant('这是一个叫 Vibe 的项目。'),
    result(),
    user('第二轮：它支持哪些 agent？'),
    thinking('让我数一下：claude、cursor、codex……'),
    assistant('支持 10 个：claude、cursor、codex、kimi、kiro、grok、zcode、codebuddy、opencode、devin。'),
    result(),
    user('第三轮：谢谢'),
    assistant('不客气。'),
    result(),
  ];
}

/** 工具调用 + 结果（含一个出错的工具）。 */
export function fixtureWithTools(): ChatBlock[] {
  return [
    user('列一下当前目录，然后读 README'),
    thinking('需要先 ls 再读文件。'),
    assistant('好的，我先列目录。'),
    tool('Bash', { command: 'ls -la' }, 'total 8\n-rw-r--r-- 1 root root 120 README.md\n'),
    tool('Read', { file_path: '/tmp/README.md' }, '# Vibe\n'),
    assistant('目录里有 README.md，内容如下：# Vibe'),
    tool('Bash', { command: 'rm -rf /nope' }, 'rm: cannot remove: Permission denied', { isError: true }),
    assistant('删除失败（权限不足）。'),
    result(),
  ];
}

/** 中断的轮次：文字仍在流式、工具没有结果（孤儿工具）。 */
export function fixtureInterrupted(): ChatBlock[] {
  return [
    user('帮我重构这个模块'),
    assistant('我先看一下代码结构……', 1_700_000_001_000, true),
    tool('Grep', { pattern: 'function foo' }, undefined, { status: 'running' }),
  ];
}

/** 含 thinking 的会话（只以带标记普通文本携带，不写原生 signed-thinking 字段）。 */
export function fixtureWithThinking(): ChatBlock[] {
  return [
    user('1+1 等于几'),
    thinking('这是一个简单的算术问题，答案显然是 2。'),
    assistant('等于 2。'),
    result(),
  ];
}

/** 空会话。 */
export function fixtureEmpty(): ChatBlock[] {
  return [];
}

/** 超长工具输出（约 256KB）—— 验证不会被截断、不会爆内存。 */
export function fixtureHugeToolOutput(): ChatBlock[] {
  const big = 'x'.repeat(256 * 1024);
  return [
    user('把这个长文本读进来'),
    assistant('好的。'),
    tool('Read', { file_path: '/tmp/big.txt' }, big),
    assistant('读完了，共 262144 字节。'),
    result(),
  ];
}

/** 只有助手输出、没有 user（后台任务唤醒的轮次）。 */
export function fixtureWakeTurn(): ChatBlock[] {
  return [assistant('后台任务完成了，继续下一步。'), result()];
}

/** 多个连续后台唤醒轮次：没有 user，且工具可能先于 assistant 正文出现。
 * result 边界必须在原生写出/生产 reader 往返后仍可区分，否则后一轮工具会被
 * 错挂到上一轮 assistant。这个形状来自真实的长时监控会话。 */
export function fixtureConsecutiveWakeTurns(): ChatBlock[] {
  return [
    user('启动后台监控'),
    assistant('监控已启动。'),
    result(),
    tool('Bash', { command: 'tail -5 monitor.log' }, 'state A -> B'),
    thinking('这是一次正常状态变化。'),
    assistant('状态变化正常，重新挂载监控。'),
    tool('Bash', { command: 'python monitor.py' }, 'background id: wake-2'),
    result(),
    tool('Bash', { command: 'tail -5 monitor.log' }, 'state B -> C'),
    assistant('第二次状态变化也正常。'),
    result(),
  ];
}

/** 一轮用户消息没有 assistant，紧接下一轮；随后同轮含多段 assistant + 工具。
 * Grok 的流式 updates reader 必须靠 promptIndex/promptId 区分完整消息边界。 */
export function fixtureConsecutiveUsers(): ChatBlock[] {
  return [
    user('第一条消息没有模型回复'),
    result(),
    user('第二条消息开始正式处理'),
    thinking('先执行第一步。'),
    assistant('第一段回复。'),
    tool('Read', { file_path: '/tmp/a.txt' }, 'alpha'),
    thinking('工具完成，继续总结。'),
    assistant('第二段回复。'),
    result(),
  ];
}

/** 会话在一次传输中断后停在未回答的 user：下一次原生 resume 会再追加一条 user。
 * 真实来源是 `poly_status` 的 ZCode → CodeBuddy 切换现场。 */
export function fixtureDanglingUser(): ChatBlock[] {
  return [
    user('先执行一次检查'),
    assistant('检查已开始。'),
    result(),
    user('继续'),
  ];
}

export const SYNTHETIC_FIXTURES: { name: string; blocks: () => ChatBlock[] }[] = [
  { name: 'multiTurn', blocks: fixtureMultiTurn },
  { name: 'withTools', blocks: fixtureWithTools },
  { name: 'interrupted', blocks: fixtureInterrupted },
  { name: 'withThinking', blocks: fixtureWithThinking },
  { name: 'empty', blocks: fixtureEmpty },
  { name: 'hugeToolOutput', blocks: fixtureHugeToolOutput },
  { name: 'wakeTurn', blocks: fixtureWakeTurn },
  { name: 'consecutiveWakeTurns', blocks: fixtureConsecutiveWakeTurns },
  { name: 'consecutiveUsers', blocks: fixtureConsecutiveUsers },
  { name: 'danglingUser', blocks: fixtureDanglingUser },
];

// ---------------------------------------------------------------------------
// 反解析（把原生产物读回统一格式，用于往返/等价性断言）
// ---------------------------------------------------------------------------

/** 读回某个 agent 的原生产物 → ChatBlock[]。 */
export async function readBackNative(
  agent: AgentKind,
  env: TempEnv,
  nativeId: string,
): Promise<{ blocks: ChatBlock[]; files: string[] }> {
  const { fs, paths } = env;
  switch (agent) {
    case 'claude': {
      const file = await findInSubdirs(paths.claudeProjectsDir, `${nativeId}.jsonl`);
      if (!file) throw new Error('claude native file not found');
      const raw = await fs.readFile(file);
      return { blocks: raw ? parseTranscriptBlocks(raw).blocks : [], files: [file] };
    }
    case 'codebuddy': {
      const file = await findInSubdirs(paths.codebuddyProjectsDir, `${nativeId}.jsonl`);
      if (!file) throw new Error('codebuddy native file not found');
      const raw = await fs.readFile(file);
      return { blocks: raw ? parseCodebuddyBlocks(raw) : [], files: [file] };
    }
    case 'codex': {
      const file = await findRecursive(paths.codexSessionsDir, (n) => n.endsWith('.jsonl') && n.includes(nativeId));
      if (!file) throw new Error('codex rollout not found');
      const raw = await fs.readFile(file);
      return { blocks: raw ? codexRolloutBlocks(raw) : [], files: [file] };
    }
    case 'kimi': {
      // Kimi 的会话目录要从索引里查（和真实 CLI 一样）。
      const index = await fs.readFile(`${paths.kimiHome}/session_index.jsonl`);
      if (!index) throw new Error('kimi session index not written');
      let dir: string | undefined;
      for (const line of index.split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as { sessionId?: string; sessionDir?: string };
        if (rec.sessionId === nativeId) dir = rec.sessionDir;
      }
      if (!dir) throw new Error('kimi session dir not indexed');
      const raw = await fs.readFile(`${dir}/agents/main/wire.jsonl`);
      return { blocks: raw ? kimiWireBlocks(raw) : [], files: [`${dir}/agents/main/wire.jsonl`] };
    }
    case 'grok': {
      const file = await findRecursive(paths.grokSessionsDir, (n) => n === 'updates.jsonl');
      if (!file) throw new Error('grok updates.jsonl not found');
      const raw = await fs.readFile(file);
      return { blocks: raw ? grokNativeBlocks(raw) : [], files: [file] };
    }
    case 'kiro': {
      // kiroNativeBlocks 只渲染文本（不解析 ToolResults），所以这里用一个
      // 覆盖 Prompt/AssistantMessage/ToolResults 的完整校验解析器。
      const file = `${paths.kiroSessionsDir}/${nativeId}.jsonl`;
      const raw = await fs.readFile(file);
      return { blocks: raw ? kiroVerifyBlocks(raw) : [], files: [file] };
    }
    case 'zcode': {
      const file = `${paths.zcodeHome}/cli/db/db.sqlite`;
      const db = openSqlite(file);
      if (!db) throw new Error('better-sqlite3 unavailable while reading zcode output');
      try {
        const rows = db.prepare(
          'select id, data from message where session_id=? order by sequence, time_created, id',
        ).all(nativeId) as { id: string; data: string }[];
        const partQuery = db.prepare(
          'select data from part where message_id=? order by sequence, time_created, id',
        );
        const messages = rows.map((row) => ({
          info: JSON.parse(row.data) as Record<string, unknown>,
          parts: (partQuery.all(row.id) as { data: string }[]).map((part) => JSON.parse(part.data)),
        }));
        return { blocks: zcodeMessagesToBlocks(messages), files: [file] };
      } finally {
        db.close();
      }
    }
    case 'cursor': {
      const file = await findRecursive(
        paths.cursorChatsDir,
        (name) => name === 'store.db',
      );
      if (!file || !file.includes(nativeId)) throw new Error('cursor store.db not found');
      const db = openSqlite(file);
      if (!db) throw new Error('better-sqlite3 unavailable while reading cursor output');
      try {
        const metaRows = db.prepare('select value from meta order by key').all() as { value: unknown }[];
        const blobRows = db.prepare('select id, data from blobs order by rowid').all() as {
          id: string;
          data: unknown;
        }[];
        // 用生产解析器的 dump 入口 + DAG walker 读回，测试不另写一套 Cursor 解码器。
        const metaDump = metaRows
          .map((row) => Buffer.from(String(row.value), 'utf8').toString('hex'))
          .join('\n');
        const blobsDump = blobRows
          .map((row) => {
            const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as Uint8Array);
            return `${row.id}\t${data.toString('hex')}`;
          })
          .join('\n');
        return {
          blocks: cursorStoreBlocks(parseCursorStoreDump(metaDump, blobsDump)),
          files: [file],
        };
      } finally {
        db.close();
      }
    }
    case 'devin': {
      // Devin 的会话在 SQLite 里；这里用生产解析器（按路径参数化）读回，
      // 测试不另写一套解码器。
      const file = `${paths.devinHome}/cli/sessions.db`;
      return {
        blocks: readDevinNativeTranscriptAt(file, nativeId),
        files: [file],
      };
    }
    case 'opencode': {
      const file = `${paths.opencodeHome}/opencode.db`;
      return {
        blocks: readOpencodeNativeTranscriptAt(file, nativeId),
        files: [file],
      };
    }
  }
}

/**
 * Kiro 专用校验解析器。
 *
 * 生产环境的 `kiroNativeBlocks` 是「尽力渲染」，只取 AssistantMessage 的文本，
 * 不解析 ToolResults。要做往返等价性断言就必须能读全量，所以测试里单独实现
 * 一份完整解析（它同时也是「产物结构是否符合 Kiro 真实格式」的一项验证）。
 */
export function kiroVerifyBlocks(raw: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const toolById = new Map<string, ChatBlock & { kind: 'tool' }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const data = rec?.data ?? {};
    const ts = (Number(data?.meta?.timestamp) || 0) * 1000;
    if (rec.kind === 'Prompt') {
      const text = (data.content ?? [])
        .filter((p: any) => p?.kind === 'text')
        .map((p: any) => String(p.data ?? ''))
        .join('\n');
      if (text) blocks.push({ id: data.message_id ?? `kr_${blocks.length}`, kind: 'user', text, ts });
      continue;
    }
    if (rec.kind === 'AssistantMessage') {
      const text = (data.content ?? [])
        .filter((p: any) => p?.kind === 'text')
        .map((p: any) => String(p.data ?? ''))
        .join('\n');
      if (text) {
        blocks.push({ id: data.message_id ?? `kr_${blocks.length}`, kind: 'assistant', text, streaming: false, ts });
      }
      for (const p of data.content ?? []) {
        if (p?.kind !== 'toolUse') continue;
        const block = {
          id: p.data.toolUseId,
          kind: 'tool' as const,
          toolUseId: p.data.toolUseId,
          name: String(p.data.name ?? 'tool'),
          input: p.data.input,
          status: 'running' as const,
          ts,
        };
        toolById.set(block.toolUseId, block);
        blocks.push(block);
      }
      continue;
    }
    if (rec.kind === 'ToolResults') {
      for (const p of data.content ?? []) {
        if (p?.kind !== 'toolResult') continue;
        const target = toolById.get(p.data.toolUseId);
        if (!target) continue;
        const text = (p.data.content ?? [])
          .map((c: any) => (typeof c?.data === 'string' ? c.data : JSON.stringify(c?.data)))
          .join('\n');
        target.result = text;
        target.status = p.data.status === 'error' ? 'error' : 'done';
        if (p.data.status === 'error') target.isError = true;
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 比较用的轮次形状：时间戳归零、去掉出处标注（`orphan`）。 */
export interface ComparedTurn {
  user?: { text: string; ts: number };
  assistants: {
    text: string;
    thinking: string;
    ts: number;
    tools: { toolUseId: string; name: string; input: unknown; result: string; isError: boolean; ts: number }[];
  }[];
}

/**
 * 归一化轮次，抹掉「不可比」的差异，便于深比较。
 *
 * 抹掉两类：
 *  - 时间戳：原生格式的时间精度/基准各不相同，内容相同即可；
 *  - `orphan` 标记：它是「源端有没有记录结果」的出处标注，不是内容。孤儿工具
 *    会被补上占位结果，读回来时自然就不再是孤儿了 —— 断言的是结果文本本身。
 */
export function turnsForCompare(blocks: ChatBlock[]): ComparedTurn[] {
  return toCanonicalTurns(blocks).map((turn) => ({
    ...(turn.user ? { user: { text: turn.user.text, ts: 0 } } : {}),
    assistants: turn.assistants.map((a) => ({
      text: renderAssistantText(a),
      thinking: a.thinking ?? '',
      ts: 0,
      tools: a.tools.map((t) => ({
        toolUseId: t.toolUseId,
        name: t.name,
        input: t.input,
        result: t.result,
        isError: t.isError,
        ts: 0,
      })),
    })),
  }));
}

/**
 * 各目标 agent 的「结构保真上限」。
 *
 * Grok 的 updates.jsonl 本身是流式 ACP 事件；adapter 为每个完整历史 assistant
 * 片段写独立 promptId，生产 reader 同 promptId 才拼 chunk、promptId 变化就结束
 * 当前片段，因此现在 9 家都能逐 assistant 做严格比较。
 */
export const STRUCTURAL_COMPARE: Record<AgentKind, boolean> = {
  claude: true,
  codebuddy: true,
  codex: true,
  kimi: true,
  kiro: true,
  grok: true,
  zcode: true,
  cursor: true,
  opencode: true,
  devin: true,
};

/** 按轮折叠：把同一轮的多段 assistant 文本合并，工具按轮汇总。 */
export function turnsForLooseCompare(blocks: ChatBlock[]): {
  user?: string;
  assistant: string;
  tools: { name: string; input: unknown; result: string; isError: boolean }[];
}[] {
  return toCanonicalTurns(blocks).map((turn) => ({
    ...(turn.user ? { user: turn.user.text } : {}),
    assistant: turn.assistants
      .map((a) => renderAssistantText(a).trim())
      .filter(Boolean)
      .join('\n\n'),
    tools: turn.assistants.flatMap((a) =>
      a.tools.map((t) => ({ name: t.name, input: t.input, result: t.result, isError: t.isError })),
    ),
  }));
}

/** 按目标 agent 选比较方式：能逐条比就逐条比，否则退到按轮比。 */
export function compareTurns(target: AgentKind, sourceBlocks: ChatBlock[], readBackBlocks: ChatBlock[]): void {
  if (STRUCTURAL_COMPARE[target]) {
    assert.deepEqual(
      turnsForCompare(readBackBlocks),
      turnsForCompare(sourceBlocks),
      `${target} 往返后内容与源不一致（逐条比较）`,
    );
    return;
  }
  assert.deepEqual(
    turnsForLooseCompare(readBackBlocks),
    turnsForLooseCompare(sourceBlocks),
    `${target} 往返后内容与源不一致（按轮比较）`,
  );
}

async function findInSubdirs(root: string, fileName: string): Promise<string | undefined> {
  const found = await findRecursive(root, (n) => n === fileName, 2);
  return found;
}

/** 递归找文件；`maxDepth` 限制层数，避免扫描整个临时目录。 */
export async function findRecursive(
  root: string,
  match: (name: string) => boolean,
  maxDepth = 6,
): Promise<string | undefined> {
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    if (depth > maxDepth) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
      } else if (match(e.name)) return full;
    }
    return undefined;
  };
  return walk(root, 0);
}
