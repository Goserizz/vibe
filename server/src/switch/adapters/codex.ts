import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';
import { codexCallIdAliases } from '../../codex/callIds.js';

/**
 * Codex 原生会话重建（fidelity: full）。
 *
 * 文件：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`
 * 续接：`codex exec resume <sessionId>`（见 `codex/runner.ts:54`）
 *
 * 每行是 `{timestamp, type, payload}`：
 *  - `session_meta`（首行）携带 id / cwd / timestamp，发现逻辑依赖它；
 *  - `response_item` 承载对话条目：
 *      message:user         {content:[{type:'input_text',text}]}
 *      message:assistant    {content:[{type:'output_text',text}]}
 *      function_call        {call_id, name, arguments:'<json 字符串>'}
 *      function_call_output {call_id, output:'<文本>', is_error}
 *      reasoning            ← 不写入（厂商私有推理块，跨模型族不可回放）
 *
 * 工具结果靠 `call_id` 与 `function_call` 配对，顺序上紧跟其后即可。
 */

/** rollout 文件名里的时间戳格式：`2026-08-02T15-27-55`（ISO 去掉毫秒、`:`→`-`）。 */
function stampForFileName(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

export const codexAdapter: TargetAdapter = {
  agent: 'codex' as AgentKind,
  fidelity: 'full',

  newNativeId(): string {
    return crypto.randomUUID();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const now = new Date(Math.max(ctx.now, 1));
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dir = joinPath(ctx.paths.codexSessionsDir, yyyy, mm, dd);
    const file = joinPath(dir, `rollout-${stampForFileName(ctx.now)}-${ctx.nativeId}.jsonl`);

    const lines: string[] = [];
    const callIdAliases = codexCallIdAliases(
      ctx.turns.flatMap((turn) => turn.assistants.flatMap((assistant) => assistant.tools.map((tool) => tool.toolUseId))),
    );
    let clock = Math.max(ctx.now, 1);
    const nextClock = (preferred: number): void => {
      clock = preferred > clock ? preferred : clock + 1;
    };
    /** 写一行 `{timestamp, type, payload}`。 */
    const push = (type: string, payload: Record<string, unknown>, extra?: Record<string, unknown>): void => {
      lines.push(JSON.stringify({ timestamp: new Date(clock).toISOString(), type, payload, ...extra }));
    };

    // 首行必须是 session_meta：Codex 的发现逻辑（parseCodexRolloutHead）靠它取 id/cwd。
    push('session_meta', {
      id: ctx.nativeId,
      timestamp: new Date(ctx.now).toISOString(),
      cwd: ctx.cwd,
      originator: 'vibe',
      source: 'vscode',
      model_provider: 'openai',
      // CLI 版本只用于展示，缺了不影响 resume。
      cli_version: 'vibe-switch',
    }, callIdAliases.size ? {
      // Keep Vibe provenance outside payload: Codex sends only response_item
      // payloads to its model. The production reader restores original IDs
      // from this header during native-only round trips as well.
      vibe: { callIdAliases: Object.fromEntries([...callIdAliases].map(([original, alias]) => [alias, original])) },
    } : undefined);
    nextClock(ctx.now);

    for (const turn of ctx.turns) {
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
        push('response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: userText }],
        });
      }
      for (const assistant of turn.assistants) {
        const assistantText = renderAssistantText(assistant);
        if (assistantText.trim()) {
          nextClock(assistant.ts);
          push('response_item', {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: assistantText }],
          });
        }
        for (const tool of assistant.tools) {
          const callId = callIdAliases.get(tool.toolUseId) ?? tool.toolUseId;
          nextClock(tool.ts);
          push('response_item', {
            type: 'function_call',
            call_id: callId,
            name: tool.name,
            arguments: JSON.stringify(normalizeToolInput(tool.input)),
          });
          nextClock(tool.ts);
          push('response_item', {
            type: 'function_call_output',
            call_id: callId,
            output: tool.result,
            ...(tool.isError ? { is_error: true } : {}),
          });
        }
      }
    }

    await ctx.fs.mkdirp(dir);
    await ctx.fs.writeFile(file, lines.length ? `${lines.join('\n')}\n` : '');
    return { nativeId: ctx.nativeId, fidelity: 'full', files: [file] };
  },
};
