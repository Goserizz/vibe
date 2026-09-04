import type { ChatBlock } from '../../../shared/protocol.js';
import type { CanonTool, CanonicalTurn } from './types.js';
import {
  THINKING_REFERENCE_CLOSE,
  THINKING_REFERENCE_OPEN,
  renderAssistantText,
} from './canonical.js';

/**
 * 降级方案（fidelity: partial）用的历史序列化。
 *
 * 当前适用对象：ZCode、Cursor 在 `better-sqlite3` 原生模块加载失败时的兜底。
 * 标准安装会直接写它们的原生 SQLite 会话；只有缺预编译包、ABI 不兼容等环境问题
 * 让驱动不可用时，才不能安全构造 `session/resume` 所需的原生产物。
 *
 * 降级时把完整历史序列化成结构化文本，作为**新会话首轮的上下文**
 * 注入。历史内容一条不落（含工具调用与结果），但新 agent 看到的是「别人转述的
 * 记录」而不是自己说过的原话 —— 这就是 partial 与 full 的差别。
 *
 * 设计取舍：不做摘要。摘要会丢信息，而这里的目标恰恰是「历史无损保留」。
 */

const HEADER_BASE = [
  '以下是从另一个 coding agent 的会话完整导入的历史记录。',
  '它是你接手的上下文背景：这些用户消息和工具调用都**已经真实发生过**，',
  '其中的工具结果就是当时真实返回的内容。',
  '',
  '请把它当作自己参与过的对话来接续：不要重述、不要总结、不要向用户复述这段历史，',
  '直接基于它理解当前进展，并在用户下一条消息时据此行动。',
].join('\n');

/** 把工具 input 渲染成紧凑的 JSON（不换行，避免撑爆首轮 prompt）。 */
function renderInput(input: unknown): string {
  if (input === undefined || input === null) return '{}';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function renderTool(tool: CanonTool, index: number): string {
  const lines = [`  工具调用 #${index}: ${tool.name}`];
  lines.push(`    输入: ${renderInput(tool.input)}`);
  lines.push(`    结果${tool.isError ? '（出错）' : ''}: ${tool.result}`);
  return lines.join('\n');
}

/** 把轮次结构渲染成注入用的文本（供 partial adapter 使用）。 */
export function renderPrimer(turns: CanonicalTurn[], carryThinking = true): string {
  const thinkingNote = carryThinking
    ? '可读的历史思考仅以“前会话思考（参考）”普通文本携带；厂商签名/密文绝不伪造。'
    : '历史思考未导入；厂商签名/密文绝不跨会话重放。';
  const out: string[] = [HEADER_BASE, thinkingNote, '', '=== 导入的历史对话 ==='];
  for (const turn of turns) {
    if (turn.user) {
      out.push('', `## 用户: ${turn.user.text}`);
    }
    for (const [assistantIndex, assistant] of turn.assistants.entries()) {
      if (carryThinking && assistant.thinking?.trim()) {
        out.push(
          `${THINKING_REFERENCE_OPEN}\n` +
          `对应本轮历史助手片段 ${assistantIndex + 1}；这是迁移存档，不是回复格式，后续回答不得复述本标记。\n` +
          `${assistant.thinking}\n${THINKING_REFERENCE_CLOSE}`,
        );
      }
      const text = renderAssistantText(assistant);
      if (text.trim()) out.push(`## 助手: ${text}`);
      assistant.tools.forEach((tool, i) => out.push(renderTool(tool, i + 1)));
    }
  }
  out.push('', '=== 历史导入结束，以下为新的对话 ===');
  return out.join('\n');
}

/**
 * 直接从归一化块渲染（不经过轮次折叠）—— 用于测试与诊断。
 * 保留 thinking 块，因为这里是给人/测试看的，不是喂给模型的。
 */
export function renderPrimerFromBlocks(blocks: ChatBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'user') out.push(`user: ${block.text}`);
    else if (block.kind === 'assistant') out.push(`assistant: ${block.text}`);
    else if (block.kind === 'thinking') out.push(`thinking: ${block.text}`);
    else if (block.kind === 'tool') out.push(`tool(${block.name}): ${block.result ?? ''}`);
  }
  return out.join('\n');
}
