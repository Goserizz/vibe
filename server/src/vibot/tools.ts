import { config } from '../config.js';
import { log } from '../log.js';
import { listAllSessions, awaitFullSessionList } from '../sessions/list.js';
import { peekSessionListCache } from '../sessions/listCache.js';
import { sessionStore } from '../sessions/store.js';
import { searchConversations } from '../sessions/search.js';
import { hub, CallbackConn } from '../ws/hub.js';
import { hostRegistry } from '../remote/hosts.js';
import { parseSessionId } from '../remote/sessionId.js';
import { mcpRegistry } from '../mcp/registry.js';
import { presetRegistry } from '../presets/registry.js';
import { createLocalWorkdir, validateDir } from '../projects.js';
import { memoryStore } from './memories.js';
import { loadVibotConfig } from './config.js';
import { createDelegateWatcher, teardownDelegateSession } from './delegate.js';
import { vibotHub } from './hub.js';
import { runCommand } from './runCommand.js';
import type { LlmToolDef } from './llm.js';
import type { AgentKind, ChatBlock, EffortLevel, PermissionMode, VibotAskQuestion } from '../../../shared/protocol.js';
import crypto from 'node:crypto';

/** Cap on any single tool result returned to the model (keeps context bounded). */
const MAX_RESULT = 24_000;

function clip(s: string): string {
  return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n…(truncated)` : s;
}

const agents: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy', 'opencode', 'devin'];
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
          agent: { type: 'string', enum: ['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy'], description: 'Filter to one agent.' },
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
      name: 'ask_user_question',
      description:
        'Ask the user 1–4 clarifying questions rendered as an interactive dialog with clickable options. The turn blocks until the user answers or 10 minutes elapse. Use whenever requirements are ambiguous instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1–4 clarifying questions to show the user.',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The question text.' },
                header: { type: 'string', description: 'Short chip/label shown above the question.' },
                options: {
                  type: 'array',
                  description: '2–4 clickable options.',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Option label.' },
                      description: { type: 'string', description: 'Optional longer explanation.' },
                    },
                    required: ['label'],
                  },
                },
                multiSelect: { type: 'boolean', description: 'Allow selecting multiple options.' },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
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
          agent: { type: 'string', enum: ['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy'], description: 'Which coding agent. Defaults to claude.' },
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
      name: 'continue_session',
      description:
        'Resume an EXISTING coding conversation (from list_sessions / search_sessions) by sending a follow-up prompt to it. The session keeps its own agent, model, host, cwd and full history — do not restate setup, just the next step. First read_session it and open your prompt with a short recap of where it left off (goal, decisions, files touched, what remains) so the agent picks up seamlessly. Errors if the session id is unknown or a turn is currently running there. By default (manage:"auto") you WATCH the continued turn exactly like a created one: auto-approve its permission prompts / plan approvals and get woken with an outcome tally. Use create_session when no existing session fits the task.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The existing session id from list_sessions / search_sessions ("host::uuid" for remote, bare uuid for local).' },
          prompt: { type: 'string', description: 'The follow-up to send, carrying the context the agent needs to continue where it left off.' },
          manage: { type: 'string', enum: ['auto', 'none'], description: 'auto (default): Vibot watches the continued turn and auto-approves its permission prompts / plans, reporting a tally back. none: just send it; the user approves things themselves.', default: 'auto' },
          autoApprove: { type: 'string', enum: ['safe', 'all'], description: 'Only with manage:"auto". safe (default): approve each prompt, remember safe tools, approve commands/plans per-call. all: run with no prompts at all (bypass) and just report completion.', default: 'safe' },
        },
        required: ['sessionId', 'prompt'],
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
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a SHORT, mostly read-only shell command on the local machine or a remote SSH host (ls, cat, ps, df, git status, systemctl status, …). Returns exitCode, combined stdout/stderr (truncated at 10KB), and timedOut. Destructive / power commands are server-blocked. Do NOT use this to edit code, install packages, write files, or run long jobs — delegate those to create_session / continue_session.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run (executed via bash -c).' },
          host: {
            type: 'string',
            description: 'Remote host name from list_hosts. Omit for the local machine.',
          },
          cwd: { type: 'string', description: 'Working directory for the command.' },
          timeout_ms: {
            type: 'integer',
            description: 'Kill the command after this many ms. Default 30000; max 120000.',
            default: 30000,
          },
        },
        required: ['command'],
      },
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
            : agent === 'grok'
              ? config.defaultGrokModel
              : agent === 'zcode'
                ? config.defaultZcodeModel
                : agent === 'codebuddy'
                  ? config.defaultCodebuddyModel
                  : agent === 'opencode'
                    ? config.defaultOpencodeModel
                    : agent === 'devin'
                      ? config.defaultDevinModel
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

  // Always link so the Vibot sidebar can expand this chat and jump into the
  // coding session — even when manage:"none" (no watcher / no wake).
  if (input.vibotConvId) {
    vibotHub.linkSession(input.vibotConvId, {
      id: session.id,
      title: session.title,
      agent,
      host: host ?? config.localName,
    });
  }

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

/**
 * Resume an existing coding session with a new user turn — the same path the
 * web UI takes when the user messages an old session (`hub.send`). The session
 * keeps its own cwd/host/agent/model and its CLI-side history (`resume`), so
 * only the follow-up prompt is needed. Optionally watched like create_session.
 */
async function continueCodingSession(input: {
  sessionId: string;
  prompt: string;
  manage?: 'auto' | 'none';
  autoApprove?: 'safe' | 'all';
  /** The Vibot conversation to report watcher status notes back to. */
  vibotConvId?: string;
}): Promise<{ sessionId: string; title: string; agent: AgentKind; host: string; started: boolean; managed: boolean }> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new ToolError('sessionId is required. Call list_sessions for valid ids.');
  if (!input.prompt.trim()) throw new ToolError('prompt is required');

  const { host } = parseSessionId(sessionId);
  if (host && !hostRegistry.get(host)) {
    throw new ToolError(`Unknown host "${host}". Call list_hosts for valid names.`);
  }
  if (hub.isRunning(sessionId)) {
    throw new ToolError('That session is currently running — wait for it to finish or create a new session instead.');
  }

  // The session must resolve to a runnable runtime (store row, local CLI
  // discovery, or the remote discovery cache). Remote ids may need one warm
  // discovery pass before the hub can route them over SSH.
  if (!hub.locate(sessionId)) {
    if (host) {
      try {
        await raceOrFail(awaitFullSessionList(), 8_000);
      } catch { /* fall through to the not-found error */ }
    }
    if (!hub.locate(sessionId)) {
      throw new ToolError(`Session ${sessionId} not found. Call list_sessions for valid ids.`);
    }
    // A turn may have started while discovery was warming.
    if (hub.isRunning(sessionId)) {
      throw new ToolError('That session is currently running — wait for it to finish or create a new session instead.');
    }
  }

  const stored = sessionStore.get(sessionId);
  const listed = peekSessionListCache()?.find((s) => s.id === sessionId);
  const title = stored?.title ?? listed?.title ?? 'Session';
  const agent: AgentKind = stored?.agent ?? listed?.agent ?? 'claude';
  const hostName = stored?.host ?? host ?? listed?.host ?? config.localName;

  const manage: 'auto' | 'none' = input.manage === 'none' ? 'none' : 'auto';
  const managed = manage === 'auto' && Boolean(input.vibotConvId);

  // Mirror create_session's autoApprove: 'all' (with manage:'auto') runs the
  // turn with no prompts at all; 'safe' keeps prompts so the watcher can see
  // and tally each one. startTurn re-reads the store, so writing the mode here
  // (pre-adopting discovered sessions if needed) makes it stick for this turn.
  if (manage === 'auto' && input.autoApprove === 'all' && stored?.permissionMode !== 'bypassPermissions') {
    if (stored) {
      sessionStore.update(sessionId, { permissionMode: 'bypassPermissions' });
    } else if (listed) {
      sessionStore.adopt({
        id: sessionId,
        claudeSessionId: listed.claudeSessionId ?? parseSessionId(sessionId).claudeSessionId,
        cwd: listed.cwd,
        title: listed.title,
        model: listed.model,
        permissionMode: 'bypassPermissions',
        effort: listed.effort,
        agent: listed.agent,
        host,
      });
    }
  }

  // Link before send so the sidebar shows the child even if the turn fails to
  // start (and so continue_session also surfaces previously-discovered sessions).
  if (input.vibotConvId) {
    vibotHub.linkSession(input.vibotConvId, {
      id: sessionId,
      title,
      agent,
      host: hostName,
    });
  }

  // Same conn strategy as create_session: the managed watcher subscribes for
  // the whole turn; otherwise fire-and-forget, unsubscribed right after.
  const conn = managed
    ? createDelegateWatcher(sessionId, title, input.vibotConvId!)
    : new CallbackConn(() => { /* fire-and-forget */ });
  hub.send(conn, sessionId, crypto.randomUUID(), input.prompt);
  if (!managed) hub.unsubscribe(conn, sessionId);
  // hub.send reports start failures on the conn (ignored above); running going
  // true synchronously inside send is the reliable signal the turn began.
  const started = hub.isRunning(sessionId);
  if (!started && managed) teardownDelegateSession(sessionId);

  return { sessionId, title, agent, host: hostName, started, managed };
}

class ToolError extends Error {}

/** A safe Vibe configuration summary (no secrets). */
function configSummary(): string {
  const mcp = mcpRegistry.snapshot();
  const presets = presetRegistry.list();
  const vibot = loadVibotConfig();
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
        grok: Boolean(config.grokExecutable),
        zcode: Boolean(config.zcodeExecutable),
        codebuddy: Boolean(config.codebuddyExecutable),
      },
      hosts: hostRegistry.list().map((h) => ({ name: h.name, ssh: h.ssh, proxy: h.proxy })),
      // Vibot's own settings (non-secret projection — no key, no baseUrl creds).
      vibot: {
        model: vibot.model,
        reasoning_effort: vibot.reasoning_effort ?? null,
      },
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
  /** OpenAI-style tool_call id — used as the ask-user callId. */
  toolCallId?: string;
}

const ASK_TIMEOUT_MSG =
  'The user did not answer within 10 minutes — proceed with your best judgment and state your assumptions.';
const ASK_DISMISS_MSG =
  'The user dismissed the question — proceed with your best judgment and state your assumptions.';

/** Validate / clamp ask_user_question input into 1–4 questions with 2–4 options each. */
function parseAskQuestions(raw: unknown): VibotAskQuestion[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'questions must be a non-empty array';
  const slice = raw.slice(0, 4);
  const out: VibotAskQuestion[] = [];
  for (const item of slice) {
    if (!item || typeof item !== 'object') return 'each question must be an object';
    const q = item as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) return 'each question needs a non-empty question string';
    if (!Array.isArray(q.options)) return `question "${question}" needs an options array`;
    const options: VibotAskQuestion['options'] = [];
    for (const o of q.options.slice(0, 4)) {
      if (!o || typeof o !== 'object') continue;
      const opt = o as Record<string, unknown>;
      const label = typeof opt.label === 'string' ? opt.label.trim() : '';
      if (!label) continue;
      const description =
        typeof opt.description === 'string' && opt.description.trim() ? opt.description.trim() : undefined;
      options.push(description ? { label, description } : { label });
    }
    if (options.length < 2) return `question "${question}" needs 2–4 options with non-empty labels`;
    out.push({
      question,
      header: typeof q.header === 'string' && q.header.trim() ? q.header.trim() : undefined,
      options,
      multiSelect: q.multiSelect === true ? true : undefined,
    });
  }
  return out;
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
      case 'ask_user_question': {
        if (!ctx.convId) return 'Error: ask_user_question requires a conversation context.';
        const parsed = parseAskQuestions(args.questions);
        if (typeof parsed === 'string') return `Error: ${parsed}`;
        const callId = ctx.toolCallId?.trim() || crypto.randomUUID();
        const outcome = await vibotHub.askUser(ctx.convId, callId, parsed);
        if (outcome.type === 'answered') return JSON.stringify({ answers: outcome.answers });
        if (outcome.type === 'timeout') return ASK_TIMEOUT_MSG;
        return ASK_DISMISS_MSG;
      }
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
      case 'continue_session': {
        const result = await continueCodingSession({
          sessionId: String(args.sessionId ?? ''),
          prompt: String(args.prompt ?? ''),
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
      case 'run_command': {
        const result = await runCommand({
          command: String(args.command ?? ''),
          host: args.host,
          cwd: args.cwd,
          timeoutMs: args.timeout_ms ?? args.timeoutMs,
        });
        return clip(JSON.stringify(result));
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
