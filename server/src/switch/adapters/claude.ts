import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';

/**
 * Claude Code 原生会话重建（fidelity: full）。
 *
 * 文件：`~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl`
 * 续接：Agent SDK 的 `resume: <sessionUuid>`（见 `claude/runner.ts:167`）
 *
 * 每行是一条 `{type:'user'|'assistant', message:{role, content:[...]}, uuid,
 * parentUuid, sessionId, cwd, timestamp, ...}`，`parentUuid` 串成一条链。
 * content 元素支持 `text` / `thinking` / `tool_use` / `tool_result`：
 *  - `tool_use` 必须写在 **assistant** 消息里；
 *  - `tool_result` 必须写在紧随其后的 **user** 消息里，且按 `tool_use_id` 配对。
 *
 * ⚠️ thinking 不写入：Claude 的 thinking 块带厂商签名（`signature` 字段），
 * 重放他厂的 thinking 会被 API 直接拒绝。源归一化 transcript 里 thinking 仍然
 * 完整保留，只是不参与新会话的推理。
 */

const VERSION = '2.1.206';

/** Claude Code 把 cwd 编码成目录名：非字母数字字符一律换成 `-`（有损且不可逆）。 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 定位（必要时创建）该 cwd 对应的 project 目录。
 *
 * 编码是有损的，所以我们**不信任**编码结果：先扫描现有目录，看哪个目录里的
 * 会话文件头部记录的 cwd 与我们一致 —— 命中就复用，避免为同一个 cwd 造出第二
 * 个 project 目录。扫描不到才按编码结果新建。
 */
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
        if ((JSON.parse(`"${m[1]}"`) as string) === ctx.cwd) return joinPath(root, d.name);
      } catch {
        // 头部截断，跳过
      }
    }
  }
  const dir = joinPath(root, encodeCwd(ctx.cwd));
  await ctx.fs.mkdirp(dir);
  return dir;
}

export const claudeAdapter: TargetAdapter = {
  agent: 'claude' as AgentKind,
  fidelity: 'full',

  newNativeId(): string {
    return crypto.randomUUID();
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const dir = await resolveProjectDir(ctx, ctx.paths.claudeProjectsDir);
    const file = joinPath(dir, `${ctx.nativeId}.jsonl`);
    const sessionId = ctx.nativeId;

    const lines: string[] = [];
    let parentUuid: string | null = null;
    // 时间戳必须单调递增：原生文件按时间排序，回退会造成 CLI 侧顺序错乱。
    let clock = Math.max(ctx.now, 1);
    const iso = (): string => new Date(clock).toISOString();
    const nextClock = (preferred: number): void => {
      clock = preferred > clock ? preferred : clock + 1;
    };

    /** 写一行并推进 parentUuid 链。 */
    const push = (type: 'user' | 'assistant', message: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
      const uuid = crypto.randomUUID();
      lines.push(
        JSON.stringify({
          parentUuid,
          isSidechain: false,
          type,
          message,
          uuid,
          timestamp: iso(),
          userType: 'external',
          entrypoint: 'sdk-ts',
          cwd: ctx.cwd,
          sessionId,
          version: VERSION,
          ...extra,
        }),
      );
      parentUuid = uuid;
    };

    for (const turn of ctx.turns) {
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
        push('user', { role: 'user', content: userText }, { promptId: crypto.randomUUID(), promptSource: 'sdk' });
      }

      for (const assistant of turn.assistants) {
        nextClock(assistant.ts);
        const content: unknown[] = [];
        const assistantText = renderAssistantText(assistant);
        if (assistantText.trim()) content.push({ type: 'text', text: assistantText });
        for (const tool of assistant.tools) {
          content.push({ type: 'tool_use', id: tool.toolUseId, name: tool.name, input: normalizeToolInput(tool.input) });
        }
        // 没有正文也没有工具调用的 assistant 段不落盘（空消息会让 API 报错）。
        if (!content.length) continue;
        push('assistant', {
          id: `msg_vibe_${crypto.randomUUID().replace(/-/g, '')}`,
          type: 'message',
          role: 'assistant',
          model: ctx.model || 'opus',
          content,
          stop_reason: assistant.tools.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        });

        // 工具结果：紧跟在 assistant 之后的一条 user 消息，按 tool_use_id 严格配对。
        if (assistant.tools.length) {
          nextClock(assistant.ts);
          push('user', {
            role: 'user',
            content: assistant.tools.map((tool) => ({
              type: 'tool_result',
              tool_use_id: tool.toolUseId,
              content: tool.result,
              is_error: tool.isError,
            })),
          });
        }
      }
    }

    const body = lines.length ? `${lines.join('\n')}\n` : '';
    await ctx.fs.writeFile(file, body);
    return { nativeId: ctx.nativeId, fidelity: 'full', files: [file] };
  },
};
