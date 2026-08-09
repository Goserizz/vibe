import { config } from '../config.js';
import { log } from '../log.js';
import { listAllSessions, awaitFullSessionList } from '../sessions/list.js';
import { peekSessionListCache } from '../sessions/listCache.js';
import { sessionStore } from '../sessions/store.js';
import { searchConversations } from '../sessions/search.js';
import { hub, CallbackConn } from '../ws/hub.js';
import { hostRegistry } from '../remote/hosts.js';
import { mcpRegistry } from '../mcp/registry.js';
import { presetRegistry } from '../presets/registry.js';
import { createLocalWorkdir, validateDir } from '../projects.js';
import { memoryStore } from './memories.js';
import { createDelegateWatcher } from './delegate.js';
import type { LlmToolDef } from './llm.js';
import type { AgentKind, ChatBlock, EffortLevel, PermissionMode } from '../../../shared/protocol.js';
import crypto from 'node:crypto';

/** Cap on any single tool result returned to the model (keeps context bounded). */
const MAX_RESULT = 24_000;

function clip(s: string): string {
  return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n…(truncated)` : s;
}

const agents: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro'];
function isAgent(v: unknown): v is AgentKind {
  return typeof v === 'string' && (agents as string[]).includes(v);
}

/**
 * Tool schemas exposed to the model (OpenAI function-calling format). The
 * descriptions double as Vibot's understanding of what each tool does.
 */
export const VIBOT_TOOLS: LlmToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description:
        'List coding conversations across ALL hosts and ALL agents (Claude, Codex, Cursor, Kimi, Kiro), local and remote. Use this (with search_sessions / read_session) to answer questions about what the user has been working on. Each row has id, title, agent, model, host, cwd, updatedAt, messageCount, running.',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Filter to a host name (e.g. the local machine name or a remote host).' },
          agent: { type: 'string', enum: ['claude', 'cursor', 'codex', 'kimi', 'kiro'], description: 'Filter to one agent.' },
          limit: { type: 'integer', description: 'Max rows to return.', default: 40 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_sessions',
      description: 'Full-text search across the messages of all conversations (local + remote). Returns matching conversations with short snippets. Use this to find past work by keyword.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search terms.' }, limit: { type: 'integer', default: 20 } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session',
      description: 'Read the message history of one coding conversation (by its session id) as readable text: user prompts, assistant replies, and tool calls performed. Use this to answer "what did we do in <session>" or to check progress on a session you created.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session id from list_sessions / search_sessions / create_session.' },
          limit: { type: 'integer', description: 'Max number of recent blocks to read.', default: 40 },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_config',
      description: 'Read how Vibe is configured: server defaults, remote hosts, MCP servers and where they are enabled, and saved session presets. Does NOT include any API keys. Use this to answer questions about the setup.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_hosts',
      description: 'List the machines Vibe knows about: the local machine plus any remote SSH hosts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_session',
      description:
        'Create a new CODING conversation to accomplish a task, and (by default) immediately start it by sending the prompt to the chosen coding agent. You DELEGATE coding — you never write code yourself. Choose agent/model/host/cwd, pass a clear prompt, and tell the user which session you started. Returns the new session id, title, agent, host, and whether the first turn was started. By default (manage:"auto") you also WATCH the session: you auto-approve its permission prompts and plan approvals and report a tally back here; set manage:"none" only if the user wants to approve things themselves.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The coding task to hand to the agent. Be specific and complete.' },
          agent: { type: 'string', enum: ['claude', 'cursor', 'codex', 'kimi', 'kiro'], description: 'Which coding agent. Defaults to claude.' },
          cwd: { type: 'string', description: 'Working directory for the session. Omit to auto-create a throwaway folder.' },
          host: { type: 'string', description: 'Remote host name to run on. Omit for the local machine.' },
          model: { type: 'string', description: 'Model for the agent (e.g. "opus", "auto"). Omit for the agent default.' },
          title: { type: 'string', description: 'Optional session title.' },
          run: { type: 'boolean', description: 'Start the first turn immediately. Default true.', default: true },
          manage: { type: 'string', enum: ['auto', 'none'], description: 'auto (default): Vibot watches the session and auto-approves its permission prompts / plans, reporting a tally back. none: just start it; the user approves things themselves.', default: 'auto' },
          autoApprove: { type: 'string', enum: ['safe', 'all'], description: 'Only with manage:"auto". safe (default): approve each prompt, remember safe tools, approve commands/plans per-call. all: run with no prompts at all (bypass) and just report completion.', default: 'safe' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a durable, important note for later (a key decision, durable preference, important constraint, or hard-won fact). Do not memorize trivia or transient state.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short kebab-case name (unique key).' },
          description: { type: 'string', description: 'One-line summary.' },
          content: { type: 'string', description: 'The full note content.' },
        },
        required: ['name', 'description', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description: 'List saved memories. Use this to recall what you previously chose to remember before answering.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read one saved memory by its name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'Delete a saved memory by name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
];

/** Render a session's normalized blocks into readable text for the model. */
function blocksToText(blocks: ChatBlock[], limit: number): string {
  const slice = blocks.slice(-limit);
  const lines: string[] = [];
  for (const b of slice) {
    switch (b.kind) {
      case 'user':
        lines.push(`USER: ${b.text}`);
        break;
      case 'assistant':
        lines.push(`ASSISTANT: ${b.text}`);
        break;
      case 'thinking':
        // Usually internal; include briefly.
        lines.push(`(thinking) ${b.text}`);
        break;
      case 'tool':
        lines.push(`TOOL ${b.name}(${shortInput(b.input)}): ${b.result ? truncate(b.result, 600) : '(no result yet)'}`);
        break;
      case 'result':
        // metadata-only; skip
        break;
      case 'error':
        lines.push(`ERROR: ${b.text}`);
        break;
    }
  }
  return lines.join('\n');
}

function shortInput(input: unknown): string {
  if (input == null) return '';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return truncate(s, 160);
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Resolve and read one session's transcript (local or remote) via the hub. */
async function readSessionText(sessionId: string, limit: number): Promise<string> {
  const meta = peekSessionListCache()?.find((s) => s.id === sessionId);
  const { blocks } = await hub.snapshot(sessionId);
  const header = meta
    ? `Session "${meta.title}" (${meta.agent}, model ${meta.model}, host ${meta.host}, cwd ${meta.cwd})`
    : `Session ${sessionId}`;
  if (blocks.length === 0) return `${header}\n(empty — no history readable)`;
  return `${header}\n${blocksToText(blocks, limit)}`;
}

/** Create a coding session (mirrors POST /sessions) and optionally start it. */
function createCodingSession(input: {
  prompt: string;
  agent?: string;
  cwd?: string;
  host?: string;
  model?: string;
  title?: string;
  run?: boolean;
  manage?: 'auto' | 'none';
  autoApprove?: 'safe' | 'all';
  /** The Vibot conversation to report watcher status notes back to. */
  vibotConvId?: string;
}): { sessionId: string; title: string; agent: AgentKind; host: string; started: boolean; managed: boolean } {
  const agent: AgentKind = isAgent(input.agent) ? input.agent : (config.defaultAgent as AgentKind);
  const host = input.host?.trim() || undefined;
  const wantAuto = !input.cwd?.trim();
  const manage: 'auto' | 'none' = input.manage === 'none' ? 'none' : 'auto';
  // 'all' ⇒ no prompts at all; otherwise 'safe' (approve each, remember safe tools).
  const autoApproveAll = manage === 'auto' && input.autoApprove === 'all';

  let cwd = input.cwd?.trim() ?? '';
  if (host) {
    const remoteHost = hostRegistry.get(host);
    if (!remoteHost) throw new ToolError(`Unknown host "${host}". Call list_hosts for valid names.`);
    if (wantAuto) {
      // Sync function can't await remote mkdir; require an explicit cwd for remote auto.
      throw new ToolError('Provide an explicit "cwd" when creating a session on a remote host.');
    }
    // Trust the path; validated lazily when the turn runs over SSH.
  } else if (wantAuto) {
    cwd = createLocalWorkdir();
  } else {
    const check = validateDir(cwd);
    if (!check.ok) throw new ToolError(check.error || 'invalid cwd');
    cwd = check.path;
  }

  const model =
    input.model?.trim() ||
    (agent === 'cursor'
      ? config.defaultCursorModel
      : agent === 'codex'
        ? config.defaultCodexModel
        : agent === 'kimi'
          ? config.defaultKimiModel
          : agent === 'kiro'
            ? config.defaultKiroModel
            : config.defaultModel);

  // autoApprove 'all' (or the safe-mode watcher) both want the agent to run
  // autonomously. 'all' skips prompts entirely (bypass); 'safe' keeps prompts so
  // the watcher can see and tally each one.
  const permissionMode: PermissionMode = autoApproveAll ? 'bypassPermissions' : 'default';

  const session = sessionStore.create({
    cwd,
    model,
    permissionMode,
    effort: config.defaultEffort as EffortLevel,
    agent,
    title: input.title,
    host,
    ephemeral: wantAuto || undefined,
  });
  hub.broadcastMeta(session.id);

  let started = false;
  const shouldRun = input.run !== false;
  const hasPrompt = input.prompt.trim().length > 0;
  const managed = manage === 'auto' && Boolean(input.vibotConvId) && shouldRun && hasPrompt;
  if (shouldRun && hasPrompt) {
    try {
      // The connection that subscribes to the delegate turn. When managing, it's
      // the long-lived watcher (auto-approves prompts + reports back); otherwise
      // a fire-and-forget conn we unsubscribe right after starting. The run
      // itself continues independently of subscribers in both cases.
      const conn = managed
        ? createDelegateWatcher(session.id, session.title, input.vibotConvId!)
        : new CallbackConn(() => { /* fire-and-forget */ });
      hub.send(conn, session.id, crypto.randomUUID(), input.prompt);
      if (!managed) hub.unsubscribe(conn, session.id);
      started = true;
    } catch (err) {
      log.warn('vibot create_session start failed', err);
    }
  }

  return { sessionId: session.id, title: session.title, agent, host: host ?? config.localName, started, managed };
}

class ToolError extends Error {}

/** A safe Vibe configuration summary (no secrets). */
function configSummary(): string {
  const mcp = mcpRegistry.snapshot();
  const presets = presetRegistry.list();
  return JSON.stringify(
    {
      defaults: {
        defaultAgent: config.defaultAgent,
        defaultModel: config.defaultModel,
        defaultEffort: config.defaultEffort,
        localName: config.localName,
      },
      agentsInstalled: {
        claude: Boolean(config.claudeExecutable),
        cursor: Boolean(config.cursorExecutable),
        codex: Boolean(config.codexExecutable),
        kimi: Boolean(config.kimiExecutable),
        kiro: Boolean(config.kiroExecutable),
      },
      hosts: hostRegistry.list().map((h) => ({ name: h.name, ssh: h.ssh, proxy: h.proxy })),
      mcp: {
        servers: mcp.servers.map((s) => ({ name: s.name, transport: s.transport })),
        enabled: mcp.enabled,
      },
      presets: presets.map((p) => ({ name: p.name, agent: p.agent, model: p.model, permissionMode: p.permissionMode, effort: p.effort })),
    },
    null,
    0,
  );
}

/** Context available to every tool call (e.g. the owning Vibot conversation,
 *  so the delegate watcher knows where to report). */
export interface ToolCtx {
  convId?: string;
}

/** Dispatch one tool call, returning the string result for the model. */
export async function dispatchTool(name: string, args: Record<string, any>, ctx: ToolCtx = {}): Promise<string> {
  try {
    switch (name) {
      case 'list_sessions': {
        const limit = clampInt(args.limit, 200, 40);
        // Serve the warm cache instantly, but if remote discovery hasn't completed
        // yet, wait briefly so Vibot actually sees remote-host history.
        let sessions = peekSessionListCache() ?? [];
        if (sessions.length === 0) {
          try {
            await raceOrFail(awaitFullSessionList(), 8_000);
          } catch { /* fall back to whatever we have */ }
        }
        sessions = await listAllSessions();
        let rows = sessions;
        if (typeof args.host === 'string' && args.host) rows = rows.filter((s) => s.host === args.host);
        if (isAgent(args.agent)) rows = rows.filter((s) => s.agent === args.agent);
        rows = rows.slice(0, limit);
        return clip(
          JSON.stringify(
            rows.map((s) => ({
              id: s.id,
              title: s.title,
              agent: s.agent,
              model: s.model,
              host: s.host,
              cwd: s.cwd,
              updatedAt: new Date(s.updatedAt).toISOString(),
              messageCount: s.messageCount,
              running: s.running,
            })),
          ),
        );
      }
      case 'search_sessions': {
        const q = String(args.query ?? '').trim();
        if (!q) return 'query is required';
        const limit = clampInt(args.limit, 50, 20);
        const results = await searchConversations(q, limit);
        return clip(
          JSON.stringify(
            results.map((r) => ({
              sessionId: r.sessionId,
              title: r.title,
              host: r.host,
              cwd: r.cwd,
              updatedAt: new Date(r.updatedAt).toISOString(),
              hits: r.hits,
            })),
          ),
        );
      }
      case 'read_session': {
        const sid = String(args.sessionId ?? '').trim();
        if (!sid) return 'sessionId is required';
        const limit = clampInt(args.limit, 200, 40);
        try {
          return clip(await readSessionText(sid, limit));
        } catch (err) {
          return `Could not read session ${sid}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      case 'get_config':
        return clip(configSummary());
      case 'list_hosts':
        return clip(
          JSON.stringify({
            local: { name: config.localName },
            remote: hostRegistry.list().map((h) => ({ name: h.name, ssh: h.ssh, proxy: h.proxy })),
          }),
        );
      case 'create_session': {
        const result = createCodingSession({
          prompt: String(args.prompt ?? ''),
          agent: args.agent,
          cwd: args.cwd,
          host: args.host,
          model: args.model,
          title: args.title,
          run: args.run,
          manage: args.manage,
          autoApprove: args.autoApprove,
          vibotConvId: ctx.convId,
        });
        return clip(JSON.stringify(result));
      }
      case 'save_memory': {
        const m = memoryStore.upsert({
          name: String(args.name ?? ''),
          description: String(args.description ?? ''),
          content: String(args.content ?? ''),
        });
        return `Saved memory "${m.name}".`;
      }
      case 'list_memories':
        return clip(
          JSON.stringify(
            memoryStore.list().map((m) => ({ name: m.name, description: m.description, updatedAt: new Date(m.updatedAt).toISOString() })),
          ),
        );
      case 'read_memory': {
        const m = memoryStore.read(String(args.name ?? ''));
        return m ? clip(`name: ${m.name}\ndescription: ${m.description}\n\n${m.content}`) : `No memory named "${args.name}".`;
      }
      case 'delete_memory': {
        const ok = memoryStore.remove(String(args.name ?? ''));
        return ok ? `Deleted memory "${args.name}".` : `No memory named "${args.name}".`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    log.warn('vibot tool error', name, err);
    return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function clampInt(v: unknown, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Resolve `p` but never wait longer than `ms`; rejects on timeout. */
function raceOrFail<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
