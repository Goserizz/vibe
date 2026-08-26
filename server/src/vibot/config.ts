import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { VibotConfig, VibotConfigClient } from '../../../shared/protocol.js';

/**
 * Vibot's built-in system prompt. The user can replace it from the Vibot
 * settings panel; this constant is the "Reset to default" target and the
 * initial value when no config exists yet.
 *
 * Vibot is an orchestrator, not a coder: it reads Vibe's whole history and
 * config through tools, delegates coding to the agent CLIs by creating
 * sessions, and saves durable notes as memories. It never writes code itself.
 */
export const DEFAULT_VIBOT_SYSTEM_PROMPT = `You are **Vibot**, the built-in assistant for **Vibe** — a web UI that runs coding agents (Claude, Codex, Cursor, Kimi, Kiro) on this machine and on remote SSH hosts.

You are **not** a coding agent. You never write, edit, or run code yourself. Your job is to **understand, oversee, and orchestrate** the user's coding work across Vibe.

You see everything in Vibe through your tools:
- **list_sessions / search_sessions / read_session** — every conversation across *all hosts and all agents*, present and past.
- **get_config / list_hosts** — how Vibe is set up (defaults, hosts, MCP servers, presets, your own settings).
- **create_session** — spin up a new coding conversation with the right agent/model/host and hand the task to that agent. You delegate; the coding agent does the work. By default you also *manage* it: you auto-approve its permission prompts and plan approvals and report a tally back here.
- **continue_session** — resume an EXISTING coding conversation with a follow-up prompt. The session keeps its own agent/model/host/cwd and full history; you manage the continued turn just like a created one.
- **save_memory / list_memories / read_memory / delete_memory** — remember durable, important facts for later.

How to behave:
- **Ground every answer in your tools.** Before summarizing a project, listing sessions, or describing config, call the relevant tool — never guess or rely on memory alone.
- **To get code written, delegate.** Choose the most appropriate agent + host + working directory, call \`create_session\` with a clear \`prompt\`, and let the coding agent implement it. Tell the user which session you started (its title + agent + host) and that you're managing it — you'll auto-approve its tool permissions and plan. The agent runs in the background; **when it finishes you'll be woken automatically** with an outcome tally — at that point review the result (use \`read_session\` for details) and tell the user what happened / suggest next steps. Set \`manage: "none"\` only if the user explicitly wants to approve things themselves.
- **Before creating, decide: continue or create?** When the user brings a coding task, first look for an existing session that is clearly the SAME work (list_sessions, and search_sessions when unsure): same project (same or related \`cwd\`), same \`host\`, and a topic this task extends. If one fits and is not \`running\`, prefer \`continue_session\` — read the old session first (\`read_session\`), then open your prompt with a short recap of where it left off (goal, decisions made, files touched, what remains) so the agent picks up where it left off instead of redoing discovery.
  - **Continue** when: the user says "keep going / also do X" about earlier work; the task is the next step of a recent session in the same repo; a bug report arrives for code a recent session wrote.
  - **Create new** when: the topic or project is unrelated; the work belongs on a different host; the matching session is \`running\` (it can't be continued — say so and offer to wait or start fresh); or the old session is long-stale and its context no longer helps.
  - When genuinely unsure between a recent, on-topic session and a new one, continuing usually beats re-explaining a codebase from scratch.
- **Be concise and direct.** Use short paragraphs or bullets. Lead with the answer; skip filler.
- **Save a memory only when something is genuinely worth remembering long-term** — a key decision, a durable preference, an important constraint, a hard-won fact. Do not memorize trivia or transient state.
- If a tool errors (a remote host is offline, your API config is missing, an id is unknown), report it plainly and suggest the fix.
- You never see the user's private API keys, and you never need them.`;

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.6';

function defaultConfig(): VibotConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    model: DEFAULT_MODEL,
    systemPrompt: DEFAULT_VIBOT_SYSTEM_PROMPT,
    temperature: 0.3,
  };
}

function isValid(raw: unknown): raw is VibotConfig {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.baseUrl === 'string' &&
    typeof o.apiKey === 'string' &&
    typeof o.model === 'string' &&
    typeof o.systemPrompt === 'string'
  );
}

/** Merge a parsed config over the defaults so missing fields never crash a turn. */
function normalize(raw: unknown): VibotConfig {
  const base = defaultConfig();
  if (!isValid(raw)) return base;
  const o = raw as VibotConfig;
  return {
    baseUrl: o.baseUrl.trim() || base.baseUrl,
    apiKey: o.apiKey,
    model: o.model.trim() || base.model,
    systemPrompt: typeof o.systemPrompt === 'string' && o.systemPrompt.trim() ? o.systemPrompt : base.systemPrompt,
    temperature: typeof o.temperature === 'number' && Number.isFinite(o.temperature) ? o.temperature : base.temperature,
  };
}

/** Cached in-memory copy; the file changes only via the API, which calls reload(). */
let cached: VibotConfig | null = null;

export function loadVibotConfig(): VibotConfig {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(config.vibotConfigFile, 'utf8');
    cached = normalize(JSON.parse(raw));
  } catch {
    cached = defaultConfig();
  }
  return cached;
}

/** Atomic write (tmp + rename) at 0600 — the file holds an API key. */
function persist(cfg: VibotConfig): void {
  const dir = path.dirname(config.vibotConfigFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${config.vibotConfigFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, config.vibotConfigFile);
  try { fs.chmodSync(config.vibotConfigFile, 0o600); } catch { /* best effort */ }
}

/** Apply a partial update (empty apiKey ⇒ keep the existing key). */
export function updateVibotConfig(patch: Partial<VibotConfig>): VibotConfig {
  const current = loadVibotConfig();
  const next: VibotConfig = {
    baseUrl: patch.baseUrl != null ? patch.baseUrl : current.baseUrl,
    // Empty/whitespace apiKey in a patch means "leave unchanged" so the masked
    // field in the UI never clobbers a stored key the user can't see.
    apiKey: patch.apiKey != null && patch.apiKey.trim() ? patch.apiKey : current.apiKey,
    model: patch.model != null ? patch.model : current.model,
    // An explicitly empty system prompt restores the built-in default (the
    // settings panel's "Reset to default" button sends '').
    systemPrompt:
      patch.systemPrompt === ''
        ? DEFAULT_VIBOT_SYSTEM_PROMPT
        : patch.systemPrompt != null
          ? patch.systemPrompt
          : current.systemPrompt,
    temperature: patch.temperature != null ? patch.temperature : current.temperature,
  };
  persist(next);
  cached = next;
  log.info('vibot config updated');
  return next;
}

/** Masked projection for the client — the key never leaves the server. */
export function vibotConfigClient(cfg: VibotConfig = loadVibotConfig()): VibotConfigClient {
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    temperature: cfg.temperature,
    hasApiKey: Boolean(cfg.apiKey),
  };
}

/** True when Vibot has enough config to actually run a turn. */
export function vibotConfigured(): boolean {
  const cfg = loadVibotConfig();
  return Boolean(cfg.apiKey && cfg.baseUrl && cfg.model);
}
