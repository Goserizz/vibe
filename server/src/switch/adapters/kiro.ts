import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';

/**
 * Kiro 原生会话重建（fidelity: full）。
 *
 * 文件：`~/.kiro/sessions/cli/<sessionUuid>.jsonl`（对话）+ 同名 `.json`（索引/元数据）
 * 续接：ACP `session/load {sessionId, cwd}`（见 `kiro/acp.ts:236`）
 *
 * .jsonl 每行是 `{version:'v1', kind, data}`：
 *   Prompt           {message_id, content:[{kind:'text',data}], meta:{timestamp}}
 *   AssistantMessage {message_id, content:[{kind:'text',data} | {kind:'toolUse',data:{toolUseId,name,input}}]}
 *   ToolResults      {message_id, content:[{kind:'toolResult',data:{toolUseId,content:[...],status}}], results:{}}
 *
 * ⚠️ Kiro 的 thinking 内容块带 `signature` / `modelId`，是 Anthropic 的签名推理块，
 * 跨模型族重放会被 API 拒绝 —— 一律不写入。
 *
 * 已知限制：`ToolResults.data.results` 这个 map 存的是 Kiro 自己的工具元数据
 * （tool 定义快照等），无法从归一化历史反推，这里写成空对象。它属于派生数据，
 * 不影响 `session/load` 读取对话内容。
 */

const VERSION = 'v1';

export const kiroAdapter: TargetAdapter = {
  agent: 'kiro' as AgentKind,
  fidelity: 'full',

  newNativeId(): string {
    return crypto.randomUUID();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    await ctx.fs.mkdirp(ctx.paths.kiroSessionsDir);
    const jsonlPath = joinPath(ctx.paths.kiroSessionsDir, `${ctx.nativeId}.jsonl`);
    const jsonPath = joinPath(ctx.paths.kiroSessionsDir, `${ctx.nativeId}.json`);

    const lines: string[] = [];
    let clock = Math.max(ctx.now, 1);
    const nextClock = (preferred: number): void => {
      clock = preferred > clock ? preferred : clock + 1;
    };
    const push = (kind: string, data: Record<string, unknown>): void => {
      lines.push(JSON.stringify({ version: VERSION, kind, data }));
    };

    for (const turn of ctx.turns) {
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
        push('Prompt', {
          message_id: crypto.randomUUID(),
          content: [{ kind: 'text', data: userText }],
          // Kiro 的时间戳是秒级 epoch。
          meta: { timestamp: Math.floor(clock / 1000) },
        });
      }

      for (const assistant of turn.assistants) {
        nextClock(assistant.ts);
        const content: unknown[] = [];
        const assistantText = renderAssistantText(assistant);
        if (assistantText.trim()) content.push({ kind: 'text', data: assistantText });
        for (const tool of assistant.tools) {
          content.push({
            kind: 'toolUse',
            data: { toolUseId: tool.toolUseId, name: tool.name, input: normalizeToolInput(tool.input) },
          });
        }
        if (!content.length) continue;
        push('AssistantMessage', { message_id: crypto.randomUUID(), content });

        if (assistant.tools.length) {
          nextClock(assistant.ts);
          push('ToolResults', {
            message_id: crypto.randomUUID(),
            content: assistant.tools.map((tool) => ({
              kind: 'toolResult',
              data: {
                toolUseId: tool.toolUseId,
                content: [{ kind: 'text', data: tool.result }],
                status: tool.isError ? 'error' : 'success',
              },
            })),
            results: {},
          });
        }
      }
    }

    // .json 索引：Kiro 的发现逻辑（parseKiroMeta）靠它取 session_id / cwd / 标题。
    const meta = {
      session_id: ctx.nativeId,
      cwd: ctx.cwd,
      created_at: new Date(ctx.now).toISOString(),
      updated_at: new Date(clock).toISOString(),
      title: ctx.title || 'Kiro session',
      session_created_reason: 'vibe-switch',
      session_state: {
        version: VERSION,
        conversation_metadata: {
          user_turn_metadatas: [],
          user_turn_start_request: null,
          last_request: null,
        },
        rts_model_state: {
          conversation_id: ctx.nativeId,
          model_info: { model_id: ctx.model || 'auto' },
          context_usage_percentage: null,
        },
        permissions: {
          filesystem: { allowed_read_paths: [], allowed_write_paths: [], denied_read_paths: [], denied_write_paths: [] },
          trusted_tools: [],
          denied_tools: [],
          allowed_commands: [],
        },
        agent_name: null,
        goal: null,
      },
    };

    await ctx.fs.writeFile(jsonlPath, lines.length ? `${lines.join('\n')}\n` : '');
    await ctx.fs.writeFile(jsonPath, `${JSON.stringify(meta, null, 2)}\n`);
    return { nativeId: ctx.nativeId, fidelity: 'full', files: [jsonlPath, jsonPath] };
  },
};
