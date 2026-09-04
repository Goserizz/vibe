import type { AgentKind, ChatBlock } from '../../../shared/protocol.js';
import type { SwitchFs } from './fs.js';
import type { SwitchPaths } from './paths.js';

/**
 * 保真等级（只取决于**目标** agent，与来源无关 —— 因为中间格式是统一的）：
 *  - `full`：把完整历史（user/assistant 文本、工具调用 + 结果及配对关系）重建成
 *    目标 agent 的原生会话文件，CLI 用原生 resume 机制接手；
 *  - `partial`：目标 adapter 的运行时依赖不可用，无法安全构造原生会话 ⇒ 退化为
 *    「把历史序列化成结构化文本，作为新会话首轮上下文注入」。标准安装下 10 个
 *    目标均为 full；当前实际降级点是 zcode/cursor/devin/opencode 的原生 SQLite 模块加载失败。
 */
export type Fidelity = 'full' | 'partial';

/** 构造目标 agent 原生会话的入参。 */
export interface BuildContext {
  fs: SwitchFs;
  paths: SwitchPaths;
  /** Stable Vibe session id, used only as recovery provenance in sidecars. */
  vibeSessionId: string;
  /** 源会话的归一化历史（枢纽格式）。 */
  blocks: ChatBlock[];
  /** 归一化后的轮次结构（由 canonical.ts 从 blocks 推导，adapter 直接用）。 */
  turns: CanonicalTurn[];
  /** 会话工作目录 —— 决定原生文件落在哪个 project/chat 目录下。 */
  cwd: string;
  /** 切换后的模型（写入原生文件里，便于 CLI 端保持模型语义）。 */
  model: string;
  /** 切换后的会话标题。 */
  title: string;
  /** 预先生成好的目标 agent 原生会话 id（格式已按 agent 要求处理）。 */
  nativeId: string;
  /** 时间基准（ms）—— 原生文件里的所有时间戳由它派生，保证顺序单调。 */
  now: number;
  /** 是否把历史 thinking 作为同轮 user 侧明确标注的迁移档案携带；默认 true。 */
  carryThinking: boolean;
}

/** 构造结果。 */
export interface BuildResult {
  /** 实际使用的原生会话 id（一般等于 ctx.nativeId）。 */
  nativeId: string;
  fidelity: Fidelity;
  /** partial 方向才有：要作为首轮上下文注入的历史文本。 */
  primer?: string;
  /** 写出的原生文件（相对路径或绝对路径，用于日志/测试断言）。 */
  files: string[];
}

export interface TargetAdapter {
  agent: AgentKind;
  fidelity: Fidelity;
  /** 为目标 agent 生成原生 id（各 agent 的 id 格式约束不同）。 */
  newNativeId(): string;
  build(ctx: BuildContext): Promise<BuildResult>;
}

// ---------------------------------------------------------------------------
// 规范化轮次模型（canonical.ts 的产物）
// ---------------------------------------------------------------------------

export interface CanonUser {
  text: string;
  ts: number;
}

export interface CanonTool {
  toolUseId: string;
  name: string;
  input: unknown;
  /** 工具结果文本。孤儿工具（没有结果）会被填成占位串，以满足目标格式的配对要求。 */
  result: string;
  isError: boolean;
  ts: number;
  /** 源 transcript 里这个工具调用没有记录结果（孤儿），本字段为 true。 */
  orphan: boolean;
}

export interface CanonAssistant {
  text: string;
  ts: number;
  tools: CanonTool[];
  /**
   * 与这一段 assistant 输出相邻的源端 thinking 文本（已按出现顺序拼接）。
   *
   * 厂商的 thinking 块带签名或加密，**不能**作为原生 thinking 写入新会话 ——
   * 重放他厂签名会被 API 直接拒绝。所以默认走「非签名携带」：把它渲染成同轮
   * user 消息尾部的明确迁移档案（见 `canonical.ts` 的 `renderTurnUserText`）。
   * 不放进 assistant 文本，避免目标模型把标记学成回复格式。归一化 transcript
   * 里的 thinking 始终原样保留。
   */
  thinking?: string;
}

/**
 * 是否把源端 thinking 以非签名方式带到新 agent。默认开。
 *
 * 关掉之后，切换产出的原生会话里就完全看不到旧思考链（归一化 transcript 里仍
 * 有），适合目标模型对长上下文敏感、或不想让参考文本干扰输出风格的场景。
 */
export interface ThinkingCarryOptions {
  carryThinking?: boolean;
}

export interface CanonicalTurn {
  /** 用户消息。唤醒轮次（后台任务唤醒 agent）可能没有 user。 */
  user?: CanonUser;
  /** 一次或多次 assistant 输出（多段回复会拆成多条）。 */
  assistants: CanonAssistant[];
}
