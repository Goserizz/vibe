import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';

/**
 * Grok 原生会话重建（fidelity: full）。
 *
 * 目录：`~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/`
 * 续接：ACP `session/load {sessionId, cwd}`（见 `grok/acp.ts:276`）
 *
 * 一个 Grok 会话目录里有多个文件，我们写其中三个：
 *  - `chat_history.jsonl` —— Grok 自己的对话日志（CLI 恢复上下文用的是它）：
 *      {type:'system', content:'…'}
 *      {type:'user', content:[{type:'text',text}], prompt_index:N}
 *      {type:'assistant', content:'…', model_id, model_fingerprint, reasoning_effort}
 *      {type:'reasoning', id, summary, encrypted_content, …}   ← 不写入
 *  - `updates.jsonl` —— ACP 的 session/update 事件流，Vibe 的 `grokNativeBlocks`
 *    正是解析它，所以必须写，否则 UI 读不到历史。
 *  - `summary.json` —— 发现逻辑（`parseGrokSummary`）靠它取 id / cwd / 标题。
 *
 * ⚠️ Grok 的 reasoning 条目带 `encrypted_content`（加密推理块），不可跨模型族
 * 重放，一律不写入。
 */

/** Grok 用 URI 编码的 cwd 作为会话目录名（`/root/vibe` → `%2Froot%2Fvibe`）。 */
function encodeCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

/** 单个 ACP session/update 事件行。 */
function updateLine(
  sessionId: string,
  timestamp: number,
  update: Record<string, unknown>,
  eventId: string,
  meta: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    timestamp,
    method: 'session/update',
    params: { sessionId, update, _meta: { eventId, ...meta } },
  });
}

export const grokAdapter: TargetAdapter = {
  agent: 'grok' as AgentKind,
  fidelity: 'full',

  newNativeId(): string {
    return crypto.randomUUID();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const dir = joinPath(ctx.paths.grokSessionsDir, encodeCwd(ctx.cwd), ctx.nativeId);
    await ctx.fs.mkdirp(dir);
    const chatPath = joinPath(dir, 'chat_history.jsonl');
    const updatesPath = joinPath(dir, 'updates.jsonl');
    const summaryPath = joinPath(dir, 'summary.json');

    const chat: string[] = [];
    const updates: string[] = [];
    let clock = Math.max(ctx.now, 1);
    const nextClock = (preferred: number): void => {
      clock = preferred > clock ? preferred : clock + 1;
    };
    let promptIndex = 0;
    let eventSeq = 0;
    const emit = (
      update: Record<string, unknown>,
      meta: Record<string, unknown> = {},
    ): void => {
      eventSeq += 1;
      updates.push(updateLine(
        ctx.nativeId,
        Math.floor(clock / 1000),
        update,
        `${ctx.nativeId}-${eventSeq}`,
        meta,
      ));
    };

    for (const turn of ctx.turns) {
      const currentPromptIndex = promptIndex;
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
        const content = [{ type: 'text', text: userText }];
        chat.push(JSON.stringify({ type: 'user', content, prompt_index: promptIndex }));
        // Real Grok logs put promptIndex in update._meta. Besides matching the
        // native shape, it lets the production reader distinguish two complete
        // consecutive user messages from chunks of one streamed message.
        emit({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: userText },
          _meta: { modelId: ctx.model || 'auto', promptIndex },
        });
        promptIndex += 1;
      }

      // Grok 给模型恢复上下文用的 chat_history 仍保持“一轮一条 assistant”；
      // updates.jsonl 则保留 Vibe 的原始 assistant/tool 分段。生产 reader 通过每段
      // 独立 promptId 区分完整消息与同一消息的流式 chunk，因此 A→Grok→A 不会
      // 因为中转而丢掉工具所属段或 assistant 边界。
      const texts = turn.assistants
        .map((a) => renderAssistantText(a))
        .filter((text) => Boolean(text.trim()));
      if (texts.length) {
        nextClock(turn.assistants[0].ts);
        const merged = texts.join('\n\n');
        chat.push(
          JSON.stringify({
            type: 'assistant',
            content: merged,
            model_id: ctx.model || 'auto',
            reasoning_effort: 'high',
          }),
        );
      }

      for (const [assistantIndex, assistant] of turn.assistants.entries()) {
        const text = renderAssistantText(assistant);
        if (text.trim()) {
          nextClock(assistant.ts);
          emit(
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            {
              promptId: `${ctx.nativeId}-vibe-${currentPromptIndex}-${assistantIndex}`,
              chunkId: 0,
              updateType: 'AgentMessageChunk',
            },
          );
        }
        for (const tool of assistant.tools) {
          nextClock(tool.ts);
          emit({
            sessionUpdate: 'tool_call',
            toolCallId: tool.toolUseId,
            // grokNativeBlocks 取 `title || kind` 作为工具名，因此 title 必须是真名。
            title: tool.name,
            kind: 'tool_call',
            rawInput: normalizeToolInput(tool.input),
            rawOutput: tool.result,
            status: tool.isError ? 'failed' : 'completed',
          });
        }
      }
    }

    const summary = {
      info: { id: ctx.nativeId, cwd: ctx.cwd },
      session_summary: ctx.title || 'Grok session',
      created_at: new Date(ctx.now).toISOString(),
      updated_at: new Date(clock).toISOString(),
      num_messages: chat.length,
      num_chat_messages: chat.length,
      current_model_id: ctx.model || 'auto',
      next_trace_turn: promptIndex,
      chat_format_version: 1,
      generated_title: ctx.title || 'Grok session',
      last_active_at: new Date(clock).toISOString(),
      reasoning_effort: 'high',
    };

    await ctx.fs.writeFile(chatPath, chat.length ? `${chat.join('\n')}\n` : '');
    await ctx.fs.writeFile(updatesPath, updates.length ? `${updates.join('\n')}\n` : '');
    await ctx.fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    return { nativeId: ctx.nativeId, fidelity: 'full', files: [chatPath, updatesPath, summaryPath] };
  },
};
