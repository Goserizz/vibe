import crypto from 'node:crypto';
import type { AgentKind } from '../../../../shared/protocol.js';
import type { BuildContext, BuildResult, TargetAdapter } from '../types.js';
import { joinPath } from '../fs.js';
import { normalizeToolInput, renderAssistantText, renderTurnUserText } from '../canonical.js';

/**
 * Kimi Code 原生会话重建（fidelity: full）。
 *
 * 文件（Kimi 的原生布局，数据根默认是 `~/.kimi-code`，可被 KIMI_CODE_HOME 覆盖）：
 *   `<kimiHome>/sessions/wd_<slug>_<hash>/session_<uuid>/state.json`
 *   `<kimiHome>/sessions/wd_<slug>_<hash>/session_<uuid>/agents/main/wire.jsonl`
 *   `<kimiHome>/session_index.jsonl`   ← append-only 索引，发现逻辑靠它定位会话
 * 续接：`kimi --resume session_<uuid>`（见 `kimi/runner.ts:32`），
 *       ACP 路径则是 `session/resume` / `session/load`（`kimi/acp.ts:478`）。
 *
 * wire.jsonl 是 Kimi 自己的 append-only 事件日志，我们写这些记录：
 *   {type:'metadata', protocol_version, created_at}                    ← 首行
 *   {type:'config.update', modelAlias, time}
 *   {type:'turn.prompt', input:[{type:'text',text}], origin:{kind:'user'}, time}
 *   {type:'context.append_message', message:{role:'user',…}, time}
 *   {type:'context.append_loop_event', event:{type:'content.part', part:{type:'text',text}}, time}
 *   {type:'context.append_loop_event', event:{type:'tool.call', toolCallId, name, args}, time}
 *   {type:'context.append_loop_event', event:{type:'tool.result', toolCallId, result}, time}
 *
 * ⚠️ `part.type === 'think'`（推理块）不写入：厂商私有，跨模型族不可回放。
 */

const PROTOCOL_VERSION = '1.4';

/** 会话目录名：`wd_<cwd 末段 slug>_<8 位随机 hex>`（Kimi 自己用的是内容 hash，
 *  这里只需保证唯一 —— 定位会话走的是 append-only 索引，不靠目录名）。 */
function sessionDirName(cwd: string): string {
  const last = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'root';
  const slug = last.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'root';
  return `wd_${slug}_${crypto.randomBytes(4).toString('hex')}`;
}

export const kimiAdapter: TargetAdapter = {
  agent: 'kimi' as AgentKind,
  fidelity: 'full',

  newNativeId(): string {
    // Kimi 的会话 id 形如 `session_<uuid>`（见 kimi/discovery.ts 的 KIMI_SESSION_RE）。
    return `session_${crypto.randomUUID()}`;
  },

  async build(ctx: BuildContext): Promise<BuildResult> {
    const sessionsRoot = joinPath(ctx.paths.kimiHome, 'sessions');
    const sessionDir = joinPath(sessionsRoot, sessionDirName(ctx.cwd), ctx.nativeId);
    const wirePath = joinPath(sessionDir, 'agents', 'main', 'wire.jsonl');
    const statePath = joinPath(sessionDir, 'state.json');
    const indexPath = joinPath(ctx.paths.kimiHome, 'session_index.jsonl');

    const lines: string[] = [];
    let clock = Math.max(ctx.now, 1);
    const nextClock = (preferred: number): void => {
      clock = preferred > clock ? preferred : clock + 1;
    };
    const push = (record: Record<string, unknown>): void => {
      lines.push(JSON.stringify(record));
    };
    /** 包一层 context.append_loop_event —— Kimi 的模型循环事件都这么嵌套。 */
    const pushEvent = (event: Record<string, unknown>): void => {
      push({ type: 'context.append_loop_event', event, time: clock });
    };

    push({ type: 'metadata', protocol_version: PROTOCOL_VERSION, created_at: ctx.now });
    if (ctx.model && ctx.model !== 'auto') {
      push({ type: 'config.update', modelAlias: ctx.model, time: ctx.now });
    }

    let turnId = 0;
    for (const turn of ctx.turns) {
      const userText = renderTurnUserText(turn, ctx.carryThinking);
      if (userText.trim()) {
        nextClock(turn.user?.ts ?? turn.assistants[0]?.ts ?? ctx.now);
        push({
          type: 'turn.prompt',
          input: [{ type: 'text', text: userText }],
          origin: { kind: 'user' },
          time: clock,
        });
        push({
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: userText }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: clock,
        });
      }

      for (const assistant of turn.assistants) {
        nextClock(assistant.ts);
        const stepUuid = crypto.randomUUID();
        const assistantText = renderAssistantText(assistant);
        if (assistantText.trim()) {
          pushEvent({
            type: 'content.part',
            uuid: crypto.randomUUID(),
            turnId: String(turnId),
            step: 1,
            stepUuid,
            part: { type: 'text', text: assistantText },
          });
        }
        for (const tool of assistant.tools) {
          nextClock(tool.ts);
          pushEvent({
            type: 'tool.call',
            uuid: crypto.randomUUID(),
            turnId: String(turnId),
            step: 1,
            stepUuid,
            toolCallId: tool.toolUseId,
            name: tool.name,
            args: normalizeToolInput(tool.input),
          });
          nextClock(tool.ts);
          pushEvent({
            type: 'tool.result',
            uuid: crypto.randomUUID(),
            turnId: String(turnId),
            step: 1,
            stepUuid,
            toolCallId: tool.toolUseId,
            result: tool.isError ? { error: tool.result } : { output: tool.result },
          });
        }
      }
      turnId += 1;
    }

    const state = {
      createdAt: new Date(ctx.now).toISOString(),
      updatedAt: new Date(clock).toISOString(),
      title: ctx.title || 'Kimi session',
      isCustomTitle: true,
      agents: {
        main: {
          homedir: joinPath(sessionDir, 'agents', 'main'),
          type: 'main',
          parentAgentId: null,
        },
      },
      custom: {},
      workDir: ctx.cwd,
      lastPrompt: ctx.turns.filter((t) => t.user).at(-1)?.user?.text ?? '',
    };

    await ctx.fs.mkdirp(joinPath(sessionDir, 'agents', 'main'));
    await ctx.fs.writeFile(wirePath, lines.length ? `${lines.join('\n')}\n` : '');
    await ctx.fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    // 索引是 append-only 的，追加一行即可（不加锁，与 Kimi 自己的写入方式一致）。
    await ctx.fs.appendFile(
      indexPath,
      `${JSON.stringify({ sessionId: ctx.nativeId, sessionDir, workDir: ctx.cwd })}\n`,
    );

    return { nativeId: ctx.nativeId, fidelity: 'full', files: [wirePath, statePath, indexPath] };
  },
};
