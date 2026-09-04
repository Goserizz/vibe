import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import { codebuddyProjectKey, comparableCodebuddyCwd } from '../../codebuddy/projectKey.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';

/**
 * CodeBuddy 原生会话重建（fidelity: full）。
 *
 * 文件：`~/.codebuddy/projects/<encoded-cwd>/<sessionUuid>.jsonl`
 * 续接：`codebuddy -r <sessionUuid>`（见 `codebuddy/runner.ts:69`）
 *
 * ⚠️ 注意：虽然目录布局和 Claude 一样（`<encoded-cwd>/<id>.jsonl`），**行格式
 * 完全不同** —— CodeBuddy 用的是 OpenAI responses 风格的日志，不是 Claude 的
 * `{type,message,uuid,parentUuid}` 结构。所以这里必须独立实现，不能复用 Claude
 * 的转换器。
 *
 * 行类型（`codebuddy/transcript.ts` 的解析器就是权威说明）：
 *   message:user         {content:[{type:'input_text',text}]}
 *   message:assistant    {content:[{type:'output_text',text}]}
 *   reasoning            {rawContent:[{type:'reasoning_text',text}]}   ← 不写入
 *   function_call        {name, callId, arguments:'<json 字符串>'}
 *   function_call_result {name, callId, status, output:{type:'text',text}}
 * 每行带 id / parentId / timestamp(epoch-ms) / sessionId / cwd。
 *
 * ⚠️ reasoning 不写入：厂商私有推理块，跨模型族不可回放（同 Claude 的 thinking）。
 */

/** 与 Claude 适配器同一套策略：优先复用已存在的（cwd 命中的）project 目录。 */
async function resolveProjectDir(ctx: BuildContext, root: string): Promise<string> {
  const dirs = await ctx.fs.readdir(root);
  for (const d of dirs) {
    if (!d.isDirectory) continue;
    const files = await ctx.fs.readdir(joinPath(root, d.name));
    for (const f of files.slice(0, 5)) {
      if (f.isDirectory || !f.name.endsWith('.jsonl')) continue;
      const head = await ctx.fs.readHead(joinPath(root, d.name, f.name), 8192);
      const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      try {
        const existingCwd = JSON.parse(`"${m[1]}"`) as string;
        if (comparableCodebuddyCwd(existingCwd) === comparableCodebuddyCwd(ctx.cwd)) {
          return joinPath(root, d.name);
        }
      } catch {
        // 头部截断，跳过
      }
    }
  }
  const dir = joinPath(root, codebuddyProjectKey(ctx.cwd));
  await ctx.fs.mkdirp(dir);
  return dir;
}

export const codebuddyAdapter: TargetAdapter = {
  agent: 'codebuddy' as AgentKind,
  fidelity: 'full',

  newNativeId(): string {
    return crypto.randomUUID();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const dir = await resolveProjectDir(ctx, ctx.paths.codebuddyProjectsDir);
    const file = joinPath(dir, `${ctx.nativeId}.jsonl`);
    const sessionId = ctx.nativeId;

    const lines: string[] = [];
    let parentId: string | undefined;
    let clock = Math.max(ctx.now, 1);
    const nextClock = (preferred: number): void => {
      clock = preferred > clock ? preferred : clock + 1;
    };

    /** 写一行，并把它接成 parentId 链。 */
    const push = (entry: Record<string, unknown>): string => {
      const id = crypto.randomUUID();
      lines.push(
        JSON.stringify({
          id,
          ...(parentId ? { parentId } : {}),
          timestamp: clock,
          sessionId,
          cwd: ctx.cwd,
          ...entry,
        }),
      );
      parentId = id;
      return id;
    };

    for (const turn of ctx.turns) {
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
        push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] });
      }

      for (const assistant of turn.assistants) {
        nextClock(assistant.ts);
        const assistantText = renderAssistantText(assistant);
        const hasText = Boolean(assistantText.trim());
        if (hasText) {
          push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: assistantText }],
            providerData: { model: ctx.model || 'auto', agent: 'cli' },
          });
        }
        // 工具调用：function_call 紧跟一条 function_call_result，靠 callId 配对。
        for (const tool of assistant.tools) {
          nextClock(tool.ts);
          push({
            type: 'function_call',
            callId: tool.toolUseId,
            name: tool.name,
            arguments: JSON.stringify(normalizeToolInput(tool.input)),
          });
          nextClock(tool.ts);
          push({
            type: 'function_call_result',
            callId: tool.toolUseId,
            name: tool.name,
            status: tool.isError ? 'failed' : 'completed',
            output: { type: 'text', text: tool.result },
          });
        }
      }
    }

    await ctx.fs.writeFile(file, lines.length ? `${lines.join('\n')}\n` : '');
    return { nativeId: ctx.nativeId, fidelity: 'full', files: [file] };
  },
};
