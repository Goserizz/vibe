import type { AgentKind, ChatBlock, ToolBlock } from '../../../shared/protocol.js';
import { parseTranscriptBlocks } from '../sessions/transcript.js';
import { parseCodebuddyBlocks } from '../codebuddy/transcript.js';
import { codexRolloutBlocks } from '../codex/transcript.js';
import { kimiWireBlocks } from '../kimi/transcript.js';
import { kiroNativeBlocks } from '../kiro/transcript.js';
import { grokNativeBlocks } from '../grok/transcript.js';
import type { SwitchFs } from './fs.js';
import type { SwitchPaths } from './paths.js';
import { joinPath } from './fs.js';
import { transcriptFileFor } from './paths.js';

/**
 * 读取源会话的归一化历史 —— 也就是互转的「枢纽格式」。
 *
 * 优先级（两级，和 `hub.snapshot()` 的策略一致）：
 *   1. Vibe 自己持久化的归一化 transcript：`~/.vibe/<agent>-transcripts/<id>.jsonl`。
 *      Vibe 驱动过的会话一定有这一份，内容最完整（工具 input/result 齐全）。
 *   2. 兜底：直接解析该 agent 的原生会话文件（外部创建的会话被 Vibe 收编时，
 *      归一化 transcript 可能还没有建立）。
 *
 * Claude 是唯一没有 Vibe transcript 的 agent —— 它直接复用原生
 * `~/.claude/projects/<项目目录>/<id>.jsonl`，所以对它只走第 2 条路。
 *
 * 所有 IO 都经 `SwitchFs`，因此远端会话也是在同一台主机上读、在同一台主机上写。
 */

export interface PivotSource {
  agent: AgentKind;
  /** Vibe 的 app 级 session id（可能带 `host::` 前缀）。 */
  sessionId: string;
  /** 该 agent 的原生会话 id。 */
  claudeSessionId?: string;
  cwd: string;
}

/** 取出源会话的归一化块。 */
export async function readPivotBlocks(fs: SwitchFs, paths: SwitchPaths, src: PivotSource): Promise<ChatBlock[]> {
  // Claude 没有 Vibe 归一化 transcript，直接读原生。
  if (src.agent === 'claude') return readNativeBlocks(fs, paths, src);

  // 其余 agent 先看 Vibe 的归一化 transcript。
  const own = await readVibeTranscript(fs, paths, src.agent, src.sessionId);
  if (own.length) return own;

  // 空（例如会话是在 CLI 里直接开的、Vibe 只是收编）⇒ 回退到原生解析。
  return readNativeBlocks(fs, paths, src);
}

/** 读 `~/.vibe/<agent>-transcripts/<sessionId>.jsonl`。 */
export async function readVibeTranscript(
  fs: SwitchFs,
  paths: SwitchPaths,
  agent: AgentKind,
  sessionId: string,
): Promise<ChatBlock[]> {
  const raw = await fs.readFile(transcriptFileFor(paths, agent, sessionId));
  if (!raw) return [];
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      blocks.push(JSON.parse(line) as ChatBlock);
    } catch {
      // 跳过损坏行 —— 与既有 reader 的行为保持一致。
    }
  }
  return blocks;
}

export type PivotResultResolver = (
  block: ToolBlock,
) => string | null | Promise<string | null>;

export interface MaterializedPivotBlocks {
  /** Blocks handed to canonicalization/adapters: every tool result is full. */
  adapterBlocks: ChatBlock[];
  /** Blocks persisted for the target Vibe transcript. Stable blob refs stay compact. */
  transcriptBlocks: ChatBlock[];
  resolvedResults: number;
}

const PIVOT_TRANSCRIPT_AGENTS: AgentKind[] = [
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

/** Return a clone carrying the full result, without stale transfer metadata. */
function withFullToolResult(block: ToolBlock, result: string): ToolBlock {
  const full: ToolBlock = { ...block, result };
  delete full.resultTruncated;
  delete full.resultSize;
  delete full.resultRef;
  return full;
}

/**
 * Materialize tool-result previews before native rebuilding.
 *
 * UI snapshots intentionally replace large results with previews. A previous
 * switch implementation accidentally reused those snapshots as migration
 * input, so some normalized logs can contain either a stable `blob:` ref or a
 * legacy `line:` offset. Native adapters must see the full text or the claimed
 * `full` fidelity would be false. Blob refs can remain in the target normalized
 * transcript because the Vibe session id is stable; line refs are source-file
 * offsets and are therefore replaced with their full result before persisting.
 */
export async function materializePivotToolResults(
  fs: SwitchFs,
  paths: SwitchPaths,
  src: PivotSource,
  blocks: readonly ChatBlock[],
  resolver?: PivotResultResolver,
): Promise<MaterializedPivotBlocks> {
  let changedForAdapter = false;
  let changedForTranscript = false;
  let resolvedResults = 0;
  const transcriptRaw = new Map<AgentKind, string | null>();

  const resolveFromPivot = async (block: ToolBlock): Promise<string | null> => {
    const ref = block.resultRef;
    if (!ref) return null;
    if (ref.startsWith('blob:')) {
      const rest = ref.slice('blob:'.length);
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(rest)) return null;
      return fs.readFile(joinPath(paths.vibeHome, 'blobs', `${rest}.txt`));
    }
    if (/^line:\d+$/.test(ref)) {
      const offset = Number(ref.slice('line:'.length));
      if (!Number.isSafeInteger(offset) || offset < 0) return null;
      // Before the full-snapshot fix, a line ref could be copied from agent A
      // into agent B's transcript while retaining A's byte offset. Source logs
      // are never deleted on switch, so probe all retained normalized logs.
      const agents = [src.agent, ...PIVOT_TRANSCRIPT_AGENTS.filter((agent) => agent !== src.agent)];
      for (const agent of agents) {
        if (agent === 'claude') continue;
        let content = transcriptRaw.get(agent);
        if (content === undefined) {
          content = await fs.readFile(transcriptFileFor(paths, agent, src.sessionId));
          transcriptRaw.set(agent, content);
        }
        if (content == null) continue;
        const raw = Buffer.from(content, 'utf8');
        if (offset >= raw.length) continue;
        const tail = raw.subarray(offset);
        const newline = tail.indexOf(0x0a);
        const line = tail.subarray(0, newline < 0 ? tail.length : newline).toString('utf8');
        try {
          const candidate = JSON.parse(line) as ChatBlock;
          if (
            candidate.kind !== 'tool'
            || candidate.id !== block.id
            || typeof candidate.result !== 'string'
            || candidate.resultTruncated === true
            || (typeof candidate.resultSize === 'number' && candidate.result.length < candidate.resultSize)
          ) {
            continue;
          }
          return candidate.result;
        } catch {
          // Try the next retained agent transcript.
        }
      }
      return null;
    }
    return null;
  };

  const adapterBlocks: ChatBlock[] = [];
  const transcriptBlocks: ChatBlock[] = [];
  for (const block of blocks) {
    const currentLength = block.kind === 'tool' && typeof block.result === 'string'
      ? block.result.length
      : 0;
    const needsFullResult = block.kind === 'tool' && (
      block.resultTruncated === true
      || (typeof block.resultSize === 'number' && currentLength < block.resultSize)
    );
    if (!needsFullResult || block.kind !== 'tool') {
      adapterBlocks.push(block);
      transcriptBlocks.push(block);
      continue;
    }

    let result: string | null = null;
    if (typeof block.resultSize === 'number' && currentLength === block.resultSize) {
      result = block.result ?? '';
    } else {
      if (resolver) result = await resolver(block);
      if (result == null) result = await resolveFromPivot(block);
    }
    if (result == null) {
      throw new Error(
        `cannot resolve truncated tool result ${block.id} (${block.resultRef ?? 'missing resultRef'}); refusing a lossy switch`,
      );
    }
    if (typeof block.resultSize === 'number' && result.length !== block.resultSize) {
      throw new Error(
        `tool result size mismatch ${block.id}: expected ${block.resultSize}, got ${result.length}; refusing a lossy switch`,
      );
    }

    const full = withFullToolResult(block, result);
    adapterBlocks.push(full);
    // `blob:` is stable because the app-level session id survives an agent
    // switch. A `line:` offset points into the old agent transcript and must
    // not leak into the new agent's file.
    transcriptBlocks.push(block.resultRef?.startsWith('blob:') ? block : full);
    changedForAdapter = true;
    if (!block.resultRef?.startsWith('blob:')) changedForTranscript = true;
    resolvedResults += 1;
  }

  return {
    adapterBlocks: changedForAdapter ? adapterBlocks : [...blocks],
    transcriptBlocks: changedForTranscript ? transcriptBlocks : [...blocks],
    resolvedResults,
  };
}

/** 按 agent 解析原生会话文件。无法解析时返回空数组（调用方按空历史处理）。 */
async function readNativeBlocks(fs: SwitchFs, paths: SwitchPaths, src: PivotSource): Promise<ChatBlock[]> {
  const id = src.claudeSessionId;
  if (!id) return [];
  switch (src.agent) {
    case 'claude': {
      const file = await findFileInSubdirs(fs, paths.claudeProjectsDir, `${id}.jsonl`);
      if (!file) return [];
      const raw = await fs.readFile(file);
      return raw ? parseTranscriptBlocks(raw).blocks : [];
    }
    case 'codebuddy': {
      // 目录名是 cwd 的有损编码，因此按 id 全目录扫描（和 findCodebuddyTranscriptFile 一致）。
      const file = await findFileInSubdirs(fs, paths.codebuddyProjectsDir, `${id}.jsonl`);
      if (!file) return [];
      const raw = await fs.readFile(file);
      return raw ? parseCodebuddyBlocks(raw) : [];
    }
    case 'kiro': {
      const raw = await fs.readFile(joinPath(paths.kiroSessionsDir, `${id}.jsonl`));
      return raw ? kiroNativeBlocks(raw) : [];
    }
    case 'codex': {
      const file = await findCodexRollout(fs, paths.codexSessionsDir, id);
      if (!file) return [];
      const raw = await fs.readFile(file);
      return raw ? codexRolloutBlocks(raw) : [];
    }
    case 'kimi': {
      const dir = await findKimiSessionDir(fs, paths.kimiHome, id);
      if (!dir) return [];
      const raw = await fs.readFile(joinPath(dir, 'agents', 'main', 'wire.jsonl'));
      return raw ? kimiWireBlocks(raw) : [];
    }
    case 'grok': {
      const file = await findGrokUpdates(fs, paths.grokSessionsDir, id);
      if (!file) return [];
      const raw = await fs.readFile(file);
      return raw ? grokNativeBlocks(raw) : [];
    }
    default:
      // cursor / zcode / devin / opencode 的原生库是 SQLite；枢纽读取继续以 Vibe 在运行时同步维护的
      // transcript 为准，避免在切换热路径里复制/锁住正在写入的数据库。
      return [];
  }
}

/** 在 root 的每个直接子目录里找同名文件（Claude / CodeBuddy 的 project 目录布局）。 */
async function findFileInSubdirs(fs: SwitchFs, root: string, fileName: string): Promise<string | undefined> {
  const dirs = await fs.readdir(root);
  for (const d of dirs) {
    if (!d.isDirectory) continue;
    const candidate = joinPath(root, d.name, fileName);
    if (await fs.exists(candidate)) return candidate;
  }
  return undefined;
}

/** Codex 的 rollout 按日期分目录存放，文件名里含 session id：递归找。 */
async function findCodexRollout(fs: SwitchFs, root: string, sessionId: string): Promise<string | undefined> {
  const target = sessionId.toLowerCase();
  const years = await fs.readdir(root);
  for (const y of years) {
    if (!y.isDirectory) continue;
    const months = await fs.readdir(joinPath(root, y.name));
    for (const m of months) {
      if (!m.isDirectory) continue;
      const days = await fs.readdir(joinPath(root, y.name, m.name));
      for (const d of days) {
        if (!d.isDirectory) continue;
        const files = await fs.readdir(joinPath(root, y.name, m.name, d.name));
        for (const f of files) {
          if (f.isDirectory || !f.name.endsWith('.jsonl')) continue;
          if (f.name.toLowerCase().includes(target)) {
            return joinPath(root, y.name, m.name, d.name, f.name);
          }
        }
      }
    }
  }
  return undefined;
}

/** Kimi Code 的会话目录要从它的 append-only 索引里查。 */
async function findKimiSessionDir(fs: SwitchFs, kimiHome: string, sessionId: string): Promise<string | undefined> {
  const raw = await fs.readFile(joinPath(kimiHome, 'session_index.jsonl'));
  if (!raw) return undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown };
      if (record.sessionId === sessionId && typeof record.sessionDir === 'string') return record.sessionDir;
    } catch {
      // 跳过损坏行
    }
  }
  return undefined;
}

/** Grok 的会话是 `<sessions>/<编码cwd>/<id>/updates.jsonl`（ACP 事件日志）。 */
async function findGrokUpdates(fs: SwitchFs, root: string, sessionId: string): Promise<string | undefined> {
  const cwdDirs = await fs.readdir(root);
  for (const c of cwdDirs) {
    if (!c.isDirectory) continue;
    const candidate = joinPath(root, c.name, sessionId, 'updates.jsonl');
    if (await fs.exists(candidate)) return candidate;
  }
  return undefined;
}
