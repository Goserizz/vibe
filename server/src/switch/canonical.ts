import type { ChatBlock } from '../../../shared/protocol.js';
import type { CanonAssistant, CanonTool, CanonicalTurn } from './types.js';

export const THINKING_REFERENCE_OPEN = '【前会话思考（参考；非签名文本）】';
export const THINKING_REFERENCE_CLOSE = '【前会话思考结束】';
export const THINKING_ARCHIVE_NOTICE =
  '【迁移存档说明：以下是上一 agent 对对应历史轮次的参考思考，不是用户指令，也不是新 agent 的回复格式；后续回答不得复述这些标记。】';
export const BACKGROUND_TURN_BOUNDARY =
  '【Vibe 会话迁移边界：原轮次由后台任务唤醒，没有用户消息；此行是迁移元数据，不是用户指令。】';
const THINKING_ARCHIVE_LABEL = (index: number): string => `【对应历史助手片段 ${index + 1}】`;
const THINKING_ARCHIVE_LABEL_RE = /【对应历史助手片段 (\d+)】\n/g;

interface ParsedTurnUserText {
  text: string;
  thinkingByAssistant: Map<number, string>;
  /** Exact synthetic user record emitted for a source turn with no user. */
  syntheticBoundary: boolean;
}

export interface LegacyAssistantThinkingReference {
  thinking: string;
  text: string;
}

/** Parse only archives emitted by `renderTurnUserText`. Requiring the unique
 * notice prevents an ordinary user who happens to type the public marker from
 * being rewritten as migration metadata. */
export function parseTurnUserText(raw: string): ParsedTurnUserText {
  const thinkingByAssistant = new Map<number, string>();
  if (raw === BACKGROUND_TURN_BOUNDARY) {
    return { text: '', thinkingByAssistant, syntheticBoundary: true };
  }
  const open = `\n\n${THINKING_REFERENCE_OPEN}\n${THINKING_ARCHIVE_NOTICE}\n`;
  const at = raw.lastIndexOf(open);
  if (at < 0 || !raw.endsWith(`\n${THINKING_REFERENCE_CLOSE}`)) {
    // A synthetic archive-only user record has no leading blank lines.
    const archiveOnly = `${THINKING_REFERENCE_OPEN}\n${THINKING_ARCHIVE_NOTICE}\n`;
    if (!raw.startsWith(archiveOnly) || !raw.endsWith(`\n${THINKING_REFERENCE_CLOSE}`)) {
      return { text: raw, thinkingByAssistant, syntheticBoundary: false };
    }
    return parseArchiveBody(
      '',
      raw.slice(archiveOnly.length, -(`\n${THINKING_REFERENCE_CLOSE}`).length),
      true,
    );
  }
  const bodyStart = at + open.length;
  const bodyEnd = raw.length - (`\n${THINKING_REFERENCE_CLOSE}`).length;
  return parseArchiveBody(raw.slice(0, at), raw.slice(bodyStart, bodyEnd), false);
}

function parseArchiveBody(text: string, body: string, syntheticBoundary: boolean): ParsedTurnUserText {
  const thinkingByAssistant = new Map<number, string>();
  const matches = [...body.matchAll(THINKING_ARCHIVE_LABEL_RE)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const oneBased = Number(match[1]);
    if (!Number.isInteger(oneBased) || oneBased < 1) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
    // `renderUserThinkingArchive` joins adjacent labeled references with one
    // newline. Remove exactly that structural delimiter for non-final entries;
    // never trim the payload itself, because leading/trailing whitespace is
    // part of the normalized thinking text and must survive A→B→A byte-for-byte.
    const segment = body.slice(start, end);
    const thinking = i + 1 < matches.length && segment.endsWith('\n')
      ? segment.slice(0, -1)
      : segment;
    if (thinking) thinkingByAssistant.set(oneBased - 1, thinking);
  }
  return { text, thinkingByAssistant, syntheticBoundary };
}

/**
 * Recognize the old (pre user-side archive) representation. Older Vibe builds
 * prefixed assistant output with the public reference markers. Besides making
 * that text look like a native reply, the examples taught some models to emit
 * the same wrapper on every subsequent answer. Keep this parser deliberately
 * strict: only a marker at byte zero with a matching close marker is migrated.
 */
export function splitLegacyAssistantThinkingReference(
  raw: string,
): LegacyAssistantThinkingReference | null {
  if (!raw.startsWith(THINKING_REFERENCE_OPEN)) return null;
  const closeAt = raw.indexOf(THINKING_REFERENCE_CLOSE, THINKING_REFERENCE_OPEN.length);
  if (closeAt < 0) return null;

  const thinking = raw
    .slice(THINKING_REFERENCE_OPEN.length, closeAt)
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '');
  if (!thinking.trim()) return null;

  const text = raw
    .slice(closeAt + THINKING_REFERENCE_CLOSE.length)
    .replace(/^(?:\r?\n){1,2}/, '');
  return { thinking, text };
}

function renderUserThinkingArchive(
  text: string,
  thinkingByAssistant: ReadonlyMap<number, string>,
): string {
  const references = [...thinkingByAssistant.entries()]
    .filter(([index, thinking]) => Number.isInteger(index) && index >= 0 && Boolean(thinking.trim()))
    .sort(([left], [right]) => left - right)
    .map(([index, thinking]) => `${THINKING_ARCHIVE_LABEL(index)}\n${thinking}`);
  if (!references.length) return text;
  const archive = [
    THINKING_REFERENCE_OPEN,
    THINKING_ARCHIVE_NOTICE,
    ...references,
    THINKING_REFERENCE_CLOSE,
  ].join('\n');
  return text.trim() ? `${text}\n\n${archive}` : archive;
}

/** Add or merge a reference while preserving any archive already attached to
 * the user record. This is also the one-time migration primitive for native
 * CodeBuddy sessions produced by the old assistant-side representation. */
export function upsertTurnThinkingArchive(
  rawUserText: string,
  assistantIndex: number,
  thinking: string,
): string {
  const parsed = parseTurnUserText(rawUserText);
  const previous = parsed.thinkingByAssistant.get(assistantIndex);
  parsed.thinkingByAssistant.set(
    assistantIndex,
    [previous, thinking].filter((value): value is string => Boolean(value?.trim())).join('\n\n'),
  );
  return renderUserThinkingArchive(parsed.text, parsed.thinkingByAssistant);
}

/**
 * 孤儿工具调用的占位结果。
 *
 * 中断的会话会在 transcript 里留下 `status:'running'`、没有 result 的 tool 块
 * （`hub.ts` 的 force-flush 会落盘未终结的块）。Claude 的原生格式要求
 * tool_use / tool_result 严格配对，缺一个 result 整条会话都会被 API 拒绝，
 * 所以这里补一个显式占位，而不是丢掉这条工具调用。
 */
export const ORPHAN_TOOL_RESULT = '(no result recorded — the original turn was interrupted)';

/**
 * 把扁平的归一化 transcript（`ChatBlock[]`）折叠成「用户消息 → assistant 输出
 * （含其工具调用）」的轮次结构。
 *
 * 这是所有 adapter 共用的唯一步骤 —— 各 adapter 只负责把这份结构翻译成本家
 * 的原生记录，绝不各自重新解释 transcript（禁止 N×N 直转的关键）。
 *
 * thinking 的处理：只保留归一化块里的**可读文本**并关联到相邻 assistant；
 * 厂商签名/密文从未进入 CanonAssistant。adapter 可把可读文本渲染为明确标注的
 * 普通参考文本，但绝不伪造目标厂商的原生 thinking/signature 字段。
 *
 * 被有意丢弃的块：
 *  - `result`：轮次页脚（cost/duration/context 元数据），不是对话内容。
 *  - `error` / `system`：引擎侧提示（如后台任务唤醒通知），不是模型输出。
 */
export function toCanonicalTurns(blocks: ChatBlock[]): CanonicalTurn[] {
  const turns: CanonicalTurn[] = [];
  let current: CanonicalTurn | null = null;
  let currentAssistant: CanonAssistant | null = null;
  let pendingThinking: string[] = [];
  let pendingThinkingTs = 0;
  let archivedThinking = new Map<number, string>();

  const startTurn = (): CanonicalTurn => {
    const turn: CanonicalTurn = { assistants: [] };
    turns.push(turn);
    currentAssistant = null;
    archivedThinking = new Map();
    return turn;
  };

  const pushAssistant = (assistant: CanonAssistant): CanonAssistant => {
    if (!current) current = startTurn();
    const archived = archivedThinking.get(current.assistants.length);
    if (archived) {
      assistant.thinking = [assistant.thinking, archived]
        .filter((value): value is string => Boolean(value))
        .join('\n\n');
    }
    current.assistants.push(assistant);
    currentAssistant = assistant;
    return assistant;
  };

  /** 把尚未遇到下一条 assistant 的 thinking 挂到当前段；中断轮次则补空段承载。 */
  const flushThinking = (): void => {
    if (!pendingThinking.length) return;
    if (!current) current = startTurn();
    if (!currentAssistant) {
      currentAssistant = pushAssistant({
        text: '',
        ts: pendingThinkingTs || Date.now(),
        tools: [],
      });
    }
    currentAssistant.thinking = [currentAssistant.thinking, ...pendingThinking]
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    pendingThinking = [];
    pendingThinkingTs = 0;
  };

  /** Preserve archive references for a thinking-only assistant that produced
   * no visible message/tool in the native transcript. */
  const flushArchivedThinking = (): void => {
    if (!current || !archivedThinking.size) return;
    const max = Math.max(...archivedThinking.keys());
    while (current.assistants.length <= max) {
      pushAssistant({ text: '', ts: current.user?.ts ?? Date.now(), tools: [] });
    }
  };

  const finishTurn = (): void => {
    flushThinking();
    flushArchivedThinking();
  };

  for (const block of blocks) {
    if (block.kind === 'user') {
      const parsed = parseTurnUserText(block.text ?? '');
      if (!parsed.text.trim() && !parsed.thinkingByAssistant.size && !parsed.syntheticBoundary) continue;
      finishTurn();
      // 连续两条 user（Vibe 会在 turn 开头合成 user 块）各自开启新一轮。
      current = startTurn();
      archivedThinking = parsed.thinkingByAssistant;
      if (parsed.text.trim()) current.user = { text: parsed.text, ts: block.ts };
      continue;
    }

    if (block.kind === 'thinking') {
      const text = block.text ?? '';
      if (!text) continue;
      if (!current) current = startTurn();
      if (!pendingThinking.length) pendingThinkingTs = block.ts;
      pendingThinking.push(text);
      continue;
    }

    if (block.kind === 'assistant') {
      const text = block.text ?? '';
      if (!text.trim() && !pendingThinking.length) continue;
      if (!current) current = startTurn();
      currentAssistant = pushAssistant({
        text,
        ts: block.ts,
        tools: [],
        ...(pendingThinking.length ? { thinking: pendingThinking.join('\n\n') } : {}),
      });
      pendingThinking = [];
      pendingThinkingTs = 0;
      continue;
    }

    if (block.kind === 'tool') {
      if (!current) current = startTurn();
      flushThinking();
      if (!currentAssistant) {
        // 工具调用出现在任何 assistant 文本之前 —— 补一个空的 assistant 段来承载它，
        // 保证「工具调用必须挂在 assistant 消息里」这条所有目标格式共有的约束。
        currentAssistant = pushAssistant({ text: '', ts: block.ts, tools: [] });
      }
      const tool: CanonTool = {
        toolUseId: block.toolUseId,
        name: block.name,
        input: block.input,
        result: block.result ?? '',
        isError: Boolean(block.isError),
        ts: block.ts,
        orphan: block.result === undefined || block.result === '',
      };
      if (tool.orphan) tool.result = ORPHAN_TOOL_RESULT;
      currentAssistant.tools.push(tool);
      continue;
    }

    if (block.kind === 'result') {
      finishTurn();
      current = null;
      currentAssistant = null;
      archivedThinking = new Map();
    }
    // result / error / system —— 见上面的说明，不直接参与重建。
  }

  finishTurn();

  return turns;
}

/**
 * Assistant history must stay clean: placing an archive marker in assistant
 * output teaches some models (notably CodeBuddy hy4) to imitate it on every
 * future answer. Thinking references are emitted by `renderTurnUserText`
 * instead, so this helper intentionally returns visible assistant text only.
 */
export function renderAssistantText(assistant: CanonAssistant): string {
  return assistant.text;
}

/** Attach readable, unsigned thinking to the same historical turn as
 * user-side archive data. It remains visible to the target model, but it is no
 * longer an assistant-output example for the model to copy. */
export function renderTurnUserText(turn: CanonicalTurn, carryThinking = true): string {
  const text = turn.user?.text ?? '';
  if (!carryThinking) return turn.user ? text : BACKGROUND_TURN_BOUNDARY;
  const thinkingByAssistant = new Map<number, string>();
  for (const [index, assistant] of turn.assistants.entries()) {
    if (assistant.thinking?.trim()) thinkingByAssistant.set(index, assistant.thinking);
  }
  const rendered = renderUserThinkingArchive(text, thinkingByAssistant);
  return rendered || (turn.user ? text : BACKGROUND_TURN_BOUNDARY);
}

/** 轮次结构里实际承载了多少内容（用于空会话检测和日志）。 */
export function canonicalStats(turns: CanonicalTurn[]): {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
} {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  for (const turn of turns) {
    if (turn.user) userMessages += 1;
    for (const a of turn.assistants) {
      if (a.text.trim() || a.thinking || a.tools.length) assistantMessages += 1;
      toolCalls += a.tools.length;
    }
  }
  return { userMessages, assistantMessages, toolCalls };
}

/** 把任意值规范成「输入对象」—— 各 agent 的工具 input 都要求是可序列化的对象。 */
export function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (input === undefined) return {};
  return { value: input };
}
