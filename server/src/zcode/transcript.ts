import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { externalizeResults } from '../sessions/blobs.js';
import { log } from '../log.js';
import { isZcodeSessionId, resolveZcodeSessionSync } from './discovery.js';
import { withZcodeAppServer } from './appServer.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.zcodeTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a ZCode session Vibe drove. */
export function readZcodeTranscript(sessionId: string): ChatBlock[] {
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      blocks.push(JSON.parse(line) as ChatBlock);
    } catch {
      /* skip corrupt line */
    }
  }
  // Stable-sort by creation time. Normally a no-op — lines are already in
  // time order. But a tool whose completion arrived after its turn's result
  // footer was persisted behind that footer (the app would render it as an
  // "extra tool call after the conversation ended"); the sort moves it back
  // to its conversation position. Stability keeps same-ts lines as written;
  // blocks without a timestamp stay where they are.
  return blocks
    .map((block, i) => ({ block, i }))
    .sort((x, y) => {
      const tx = Number(x.block.ts);
      const ty = Number(y.block.ts);
      const dx = Number.isFinite(tx) ? tx : Infinity;
      const dy = Number.isFinite(ty) ? ty : Infinity;
      return dx - dy || x.i - y.i;
    })
    .map(({ block }) => block);
}

export function appendZcodeBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.zcodeTranscriptsDir, { recursive: true });
    const persisted = externalizeResults(sessionId, blocks);
    fs.appendFileSync(transcriptFile(sessionId), `${persisted.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist zcode transcript', error);
  }
}

export function deleteZcodeTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Convert a `session/messages` result into normalized blocks. Message shape
 * (probed): `{info:{role:'user'|'assistant', semantics:{kind}, time:{created}},
 *  parts:[{type:'text'|'reasoning'|'tool'|'step-start'|'step-finish'|'timeline', …}]}`.
 * Tool parts carry `{tool, callID, state:{status, input, output, error, time}}`.
 */
export function zcodeMessagesToBlocks(messages: unknown): ChatBlock[] {
  if (!Array.isArray(messages)) return [];
  const blocks: ChatBlock[] = [];
  let n = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const info = (message as { info?: Record<string, unknown> }).info ?? {};
    const role = typeof info.role === 'string' ? info.role : '';
    const kind = typeof (info.semantics as { kind?: unknown } | undefined)?.kind === 'string'
      ? (info.semantics as { kind: string }).kind
      : '';
    // Skip engine-internal timeline entries (model-change separators etc.).
    if (kind && kind !== 'user_prompt' && kind !== 'assistant_response' && role !== 'user') continue;
    const ts = Number((info.time as { created?: unknown } | undefined)?.created) || Date.now();
    for (const part of (message as { parts?: unknown[] }).parts ?? []) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      n += 1;
      switch (p.type) {
        case 'text': {
          const text = typeof p.text === 'string' ? p.text : '';
          if (!text) continue;
          if (role === 'user') {
            blocks.push({ id: `zc_user_${n}`, kind: 'user', text, ts });
          } else {
            blocks.push({ id: `zc_as_${n}`, kind: 'assistant', text, streaming: false, ts });
          }
          continue;
        }
        case 'reasoning': {
          const text = typeof p.text === 'string' ? p.text : '';
          if (!text) continue;
          blocks.push({ id: `zc_th_${n}`, kind: 'thinking', text, streaming: false, ts });
          continue;
        }
        case 'tool': {
          const id = typeof p.callID === 'string' ? p.callID : `zc_tool_${n}`;
          const name = typeof p.tool === 'string' ? p.tool : 'tool';
          const state = (p.state as Record<string, unknown> | undefined) ?? {};
          const status = state.status === 'failed' || state.status === 'error'
            ? 'error'
            : state.status === 'completed'
              ? 'done'
              : 'running';
          const output = state.output ?? state.error;
          const block: ToolBlock = {
            id,
            kind: 'tool',
            toolUseId: id,
            name,
            input: state.input ?? {},
            status,
            result: output == null ? undefined : toolResultText(output),
            isError: status === 'error',
            ts: Number((state.time as { start?: unknown } | undefined)?.start) || ts,
          };
          blocks.push(block);
          continue;
        }
        default:
          // step-start / step-finish / timeline — no rendered content.
          continue;
      }
    }
  }
  return blocks;
}

function toolResultText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2).slice(0, 8000);
  } catch {
    return String(output);
  }
}

function listedWorkspacePath(rows: unknown, sessionId: string): string {
  const sessions = Array.isArray(rows)
    ? rows
    : (rows as { sessions?: unknown } | null | undefined)?.sessions;
  if (!Array.isArray(sessions)) return '';
  const match = sessions.find((row) =>
    row && typeof row === 'object'
      && (row as { sessionId?: unknown }).sessionId === sessionId);
  const workspace = (match as { workspace?: { workspacePath?: unknown } } | undefined)?.workspace;
  return typeof workspace?.workspacePath === 'string' ? workspace.workspacePath.trim() : '';
}

type ZcodeRequest = (method: string, params: unknown) => Promise<any>;

/** Activate one session in an app-server process, then return its messages. */
export async function requestZcodeSessionMessages(
  request: ZcodeRequest,
  sessionId: string,
  cwd?: string,
): Promise<unknown> {
  let workspacePath = cwd?.trim() || resolveZcodeSessionSync(sessionId)?.cwd.trim() || '';
  if (!workspacePath) {
    workspacePath = listedWorkspacePath(await request('session/list', {}), sessionId);
  }
  if (!workspacePath) throw new Error(`cannot resolve workspace for ZCode session ${sessionId}`);
  const workspace = { workspaceKey: workspacePath, workspacePath };
  await request('session/resume', { sessionId, workspace });
  return request('session/messages', { sessionId });
}

/**
 * Read a native ZCode session's history via `zcode app-server`.
 *
 * `session/messages` is not a database lookup: ZCode returns -32004 unless the
 * requested session is active in this particular app-server process. Always
 * resume it first, resolving the strict workspace argument from the caller,
 * the discovery sidecar, or a same-process `session/list` probe.
 */
export async function readZcodeNativeTranscript(sessionId: string, cwd?: string): Promise<ChatBlock[]> {
  if (!isZcodeSessionId(sessionId)) return [];
  try {
    const result = await withZcodeAppServer({ cwd: cwd?.trim() || undefined, timeoutMs: 45_000 }, (request) =>
      requestZcodeSessionMessages(request, sessionId, cwd),
    );
    return zcodeMessagesToBlocks((result as { messages?: unknown })?.messages ?? result);
  } catch (error) {
    log.warn('zcode session/messages failed', sessionId, error);
    return [];
  }
}
