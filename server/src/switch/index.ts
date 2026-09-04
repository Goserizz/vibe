import type { AgentKind, ChatBlock } from '../../../shared/protocol.js';
import type { StoredSession } from '../sessions/store.js';
import type { SwitchFs } from './fs.js';
import { localFs } from './fs.js';
import type { SwitchPaths } from './paths.js';
import { defaultSwitchPaths, transcriptFileFor } from './paths.js';
import { toCanonicalTurns } from './canonical.js';
import {
  materializePivotToolResults,
  readPivotBlocks,
  type PivotResultResolver,
  type PivotSource,
} from './pivot.js';
import type { BuildContext, Fidelity, TargetAdapter } from './types.js';
import { claudeAdapter } from './adapters/claude.js';
import { codebuddyAdapter } from './adapters/codebuddy.js';
import { codexAdapter } from './adapters/codex.js';
import { kiroAdapter } from './adapters/kiro.js';
import { grokAdapter } from './adapters/grok.js';
import { kimiAdapter } from './adapters/kimi.js';
import { zcodeAdapter } from './adapters/zcode.js';
import { cursorAdapter } from './adapters/cursor.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { devinAdapter } from './adapters/devin.js';
import { defaultModelForAgent } from '../agents/defaultModel.js';

export type { Fidelity } from './types.js';
export type { SwitchFs } from './fs.js';
export type { SwitchPaths } from './paths.js';
export { localFs, createSshFs, type SshRunner } from './fs.js';
export { defaultSwitchPaths, tempSwitchPaths, transcriptFileFor } from './paths.js';

/** 10 个目标 agent 各一个 adapter —— 转换只走「枢纽格式 → 目标原生」，不做 N×N 直转。 */
const ADAPTERS: Record<AgentKind, TargetAdapter> = {
  claude: claudeAdapter,
  codebuddy: codebuddyAdapter,
  codex: codexAdapter,
  kiro: kiroAdapter,
  grok: grokAdapter,
  kimi: kimiAdapter,
  zcode: zcodeAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
  devin: devinAdapter,
};

export function adapterFor(agent: AgentKind): TargetAdapter {
  return ADAPTERS[agent];
}

/**
 * 某个转换方向的保真等级。
 *
 * 只取决于**目标** agent —— 因为中间格式是统一的归一化 transcript，来源 agent
 * 不影响重建能力。
 */
export function fidelityFor(target: AgentKind): Fidelity {
  return ADAPTERS[target].fidelity;
}

/** 方向矩阵：10×10 = 100 个方向的保真表（含「切到自身」这种实际只改模型的方向）。 */
export function fidelityMatrix(agents: readonly AgentKind[]): { from: AgentKind; to: AgentKind; fidelity: Fidelity }[] {
  const out: { from: AgentKind; to: AgentKind; fidelity: Fidelity }[] = [];
  for (const from of agents) for (const to of agents) out.push({ from, to, fidelity: fidelityFor(to) });
  return out;
}

// ---------------------------------------------------------------------------
// 切换主流程
// ---------------------------------------------------------------------------

export interface SwitchInput {
  /** 被切换的会话（Vibe 的持久化记录）。 */
  session: StoredSession;
  /** 目标 agent。 */
  targetAgent: AgentKind;
  /** 目标模型；省略则使用目标 agent 的默认模型（绝不沿用来源 agent 的模型 ID）。 */
  targetModel?: string;
  /** 时间基准（测试可注入固定值）。 */
  now?: number;
  /** thinking 作为明确标注的普通参考文本携带；默认开启。 */
  carryThinking?: boolean;
}

export interface SwitchOutcome {
  /** 新的原生会话 id（partial 方向为空串）。 */
  nativeId: string;
  fidelity: Fidelity;
  /** partial 方向：等待首轮注入的历史文本。 */
  primer?: string;
  /** 归一化历史（切换点快照），调用方把它写进新 agent 的 transcript 供 UI 展示。 */
  blocks: ChatBlock[];
  /** 写出的原生文件。 */
  files: string[];
  /** 每个方向都必须有明确的保真说明，UI/文档直接展示它。 */
  note: string;
}

export interface SwitchExecutionOptions {
  /**
   * Backward-compatible single-plane IO. Local callers and older tests may
   * still provide these; new remote callers should use the split fields below.
   */
  fs?: SwitchFs;
  paths?: SwitchPaths;
  /** Filesystem/path layout used only for the target agent's native artifact. */
  nativeFs?: SwitchFs;
  nativePaths?: SwitchPaths;
  /** Filesystem/path layout used for Vibe's normalized source/target transcript. */
  transcriptFs?: SwitchFs;
  transcriptPaths?: SwitchPaths;
  /**
   * Authoritative snapshot captured by the caller. Remote HTTP switches use
   * Hub.switchSnapshot(), which reads the complete Vibe-local transcript and
   * falls back to each agent's production native/SSH reader.
   */
  sourceBlocks?: ChatBlock[];
  /** Resolve a preview's opaque resultRef while the source agent is still bound. */
  resolveResultRef?: PivotResultResolver;
}

const NOTES: Record<Fidelity, (agent: string) => string> = {
  full: (agent) => `已把完整历史重建成 ${agent} 的原生会话，${agent} 将用原生 resume 机制无缝接手。`,
  partial: (agent) =>
    `${agent} 的原生会话写入依赖当前不可用；历史将作为首轮上下文注入（内容完整，但新 ${agent} 看到的是转述记录而非自己的原话）。`,
};

/**
 * 执行一次「会话换 agent」。
 *
 * 流程：
 *   1. 读源会话的归一化历史（枢纽格式）—— 源头统一，所以不需要 N×N 转换器；
 *   2. 交给目标 agent 的 adapter，重建成它的原生会话文件（运行时依赖不可用而
 *      降级为 partial 时，则产出待注入的历史文本 `primer`）；
 *   3. 把归一化历史原样写进目标 agent 的 transcript 文件，保证 UI 无论 full /
 *      partial 都能立即看到完整历史（Claude 没有这种 transcript，跳过）。
 *
 * 远端调用必须拆分两套 IO：adapter 的原生产物经 SSH 写到远端 HOME，而 Vibe
 * transcript 始终留在运行 Vibe 的本机。`sourceBlocks` 则由 Hub 在持锁状态下捕获，
 * 避免拿本机 `/root` 路径去远端读取、或把本地 transcript 错写进远端 `~/.vibe`。
 *
 * 这个函数**不碰** sessions.json —— 持久化与广播由调用方（HTTP 路由）负责，
 * 这样单测可以在临时目录里纯粹地验证转换产物。
 */
export async function switchSessionAgent(
  input: SwitchInput,
  opts: SwitchExecutionOptions = {},
): Promise<SwitchOutcome> {
  const defaults = defaultSwitchPaths();
  const nativeFs: SwitchFs = opts.nativeFs ?? opts.fs ?? localFs;
  const nativePaths: SwitchPaths = opts.nativePaths ?? opts.paths ?? defaults;
  const transcriptFs: SwitchFs = opts.transcriptFs ?? opts.fs ?? localFs;
  const transcriptPaths: SwitchPaths = opts.transcriptPaths ?? opts.paths ?? defaults;
  const now = input.now ?? Date.now();

  const source: PivotSource = {
    agent: input.session.agent ?? 'claude',
    sessionId: input.session.id,
    claudeSessionId: input.session.claudeSessionId,
    cwd: input.session.cwd,
  };

  const sourceBlocks = opts.sourceBlocks !== undefined
    ? [...opts.sourceBlocks]
    : await readPivotBlocks(transcriptFs, transcriptPaths, source);
  const materialized = await materializePivotToolResults(
    transcriptFs,
    transcriptPaths,
    source,
    sourceBlocks,
    opts.resolveResultRef,
  );
  const blocks = materialized.transcriptBlocks;
  const adapterBlocks = materialized.adapterBlocks;
  const adapter = adapterFor(input.targetAgent);
  const nativeId = adapter.newNativeId();

  const ctx: BuildContext = {
    fs: nativeFs,
    paths: nativePaths,
    vibeSessionId: input.session.id,
    blocks: adapterBlocks,
    turns: toCanonicalTurns(adapterBlocks),
    cwd: input.session.cwd,
    model: input.targetModel ?? defaultModelForAgent(input.targetAgent),
    title: input.session.title,
    nativeId,
    now,
    carryThinking: input.carryThinking ?? true,
  };
  const result = await adapter.build(ctx);

  // 目标 agent 的 transcript 里预先铺好历史，UI 立刻就能看到（full 方向其实也能
  // 从原生文件读出来，但铺一份可以避免首帧空窗，也省掉一次原生解析）。
  //
  // Claude 例外：它没有 Vibe transcript 目录（`hub.snapshot()` 对 claude 直接读
  // 原生 `~/.claude/projects/**`，`config.ts` 里也没有 claudeTranscriptsDir），
  // 写一份没人读的文件只会误导 —— 它自己的原生产物就是唯一真相源。
  if (input.targetAgent !== 'claude' && blocks.length) {
    const targetFile = transcriptFileFor(transcriptPaths, input.targetAgent, input.session.id);
    const body = `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`;
    const existing = await transcriptFs.readFile(targetFile);
    // 幂等：重复切换同一个会话不会把历史写两遍。
    if (existing !== body) await transcriptFs.writeFile(targetFile, body);
  }

  return {
    nativeId: result.nativeId,
    fidelity: result.fidelity,
    primer: result.primer,
    blocks,
    files: result.files,
    note: NOTES[result.fidelity](input.targetAgent),
  };
}
