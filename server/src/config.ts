import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveClaudeExecutable } from './claude/resolve.js';
import { resolveCursorExecutable } from './cursor/resolve.js';
import { resolveCodexExecutable } from './codex/resolve.js';
import { resolveKimiExecutable } from './kimi/resolve.js';
import { resolveKiroExecutable } from './kiro/resolve.js';
import { resolveGrokExecutable } from './grok/resolve.js';
import { resolveZcodeExecutable } from './zcode/resolve.js';
import { resolveCodebuddyExecutable } from './codebuddy/resolve.js';
import { resolveOpencodeExecutable } from './opencode/resolve.js';
import { resolveDevinExecutable } from './devin/resolve.js';

function resolveHome(): string {
  const custom = process.env.VIBE_HOME;
  if (custom && custom.trim()) return path.resolve(custom);
  return path.join(os.homedir(), '.vibe');
}

const VIBE_HOME = resolveHome();
fs.mkdirSync(VIBE_HOME, { recursive: true });
const KIMI_HOME = process.env.KIMI_CODE_HOME
  ? path.resolve(process.env.KIMI_CODE_HOME)
  : path.join(os.homedir(), '.kimi-code');
const GROK_HOME = process.env.GROK_HOME
  ? path.resolve(process.env.GROK_HOME)
  : path.join(os.homedir(), '.grok');
const ZCODE_HOME = process.env.ZCODE_HOME
  ? path.resolve(process.env.ZCODE_HOME)
  : path.join(os.homedir(), '.zcode');
/** Devin stores data under an XDG data dir, not a `~/.*` dotfolder. Its
 *  credentials and session database both live here. */
const DEVIN_HOME = process.env.DEVIN_HOME
  ? path.resolve(process.env.DEVIN_HOME)
  : path.join(os.homedir(), '.local', 'share', 'devin');
/** opencode stores its session library under an XDG data dir. The CLI offers
 *  no home override, so `OPENCODE_HOME` is Vibe's own escape hatch (tests). */
const OPENCODE_HOME = process.env.OPENCODE_HOME
  ? path.resolve(process.env.OPENCODE_HOME)
  : path.join(os.homedir(), '.local', 'share', 'opencode');

/**
 * Single-user access token. Reuses an existing token if present, otherwise
 * generates one and persists it so links stay stable across restarts.
 */
function loadOrCreateToken(): string {
  if (process.env.VIBE_TOKEN && process.env.VIBE_TOKEN.trim()) {
    return process.env.VIBE_TOKEN.trim();
  }
  const tokenPath = path.join(VIBE_HOME, 'token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  const token = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

/**
 * Telegram bot token: env `VIBE_TELEGRAM_BOT_TOKEN` wins, else
 * `~/.vibe/telegram-bot-token`. Empty ⇒ bot disabled.
 */
function loadTelegramBotToken(): string {
  if (process.env.VIBE_TELEGRAM_BOT_TOKEN && process.env.VIBE_TELEGRAM_BOT_TOKEN.trim()) {
    return process.env.VIBE_TELEGRAM_BOT_TOKEN.trim();
  }
  const tokenPath = path.join(VIBE_HOME, 'telegram-bot-token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Parse a comma/whitespace-separated list of Telegram user ids. */
function parseAllowlist(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Telegram allowlist: env `VIBE_TELEGRAM_ALLOWLIST` wins, else
 * `~/.vibe/telegram-allowlist`. Empty ⇒ any user (token is the gate).
 */
function loadTelegramAllowlist(): number[] {
  if (process.env.VIBE_TELEGRAM_ALLOWLIST && process.env.VIBE_TELEGRAM_ALLOWLIST.trim()) {
    return parseAllowlist(process.env.VIBE_TELEGRAM_ALLOWLIST);
  }
  try {
    return parseAllowlist(fs.readFileSync(path.join(VIBE_HOME, 'telegram-allowlist'), 'utf8'));
  } catch {
    return [];
  }
}

export const config = {
  home: VIBE_HOME,
  sessionsFile: path.join(VIBE_HOME, 'sessions.json'),
  /** Durable monitor definitions, observations, incidents, leases, and runs. */
  monitorsDb: path.join(VIBE_HOME, 'monitors.sqlite'),
  /** Public Streamable-HTTP MCP endpoint used by agents running over SSH.
   * Local agents always use the loopback endpoint. Empty means the built-in
   * monitor tools are omitted from remote sessions (the UI/API still work). */
  monitorMcpUrl: process.env.VIBE_MONITOR_MCP_URL?.trim() || '',
  hostsFile: path.join(VIBE_HOME, 'hosts.json'),
  /** MCP server registry + per-scope enable lists (global, local, per host). */
  mcpFile: path.join(VIBE_HOME, 'mcp.json'),
  /** OAuth tokens + registered clients for MCP-OAuth servers (secrets — 0600). */
  mcpOauthFile: path.join(VIBE_HOME, 'mcp-oauth.json'),
  /** Saved New-session engine presets (agent + model + permission + effort). */
  presetsFile: path.join(VIBE_HOME, 'presets.json'),
  /** User accounts for multi-account login (name + scrypt password hash +
   *  per-account token). Secrets — 0600. The admin account is virtual: its
   *  token is always `config.token`. */
  accountsFile: path.join(VIBE_HOME, 'accounts.json'),
  /** Vibot's own LLM API config (baseUrl + apiKey + model + systemPrompt). 0600. */
  vibotConfigFile: path.join(VIBE_HOME, 'vibot.json'),
  /** Vibot's durable memories. */
  vibotMemoriesFile: path.join(VIBE_HOME, 'vibot-memories.json'),
  /** Per-conversation Vibot transcripts (LLM history + rendered blocks). */
  vibotConvsDir: path.join(VIBE_HOME, 'vibot-conversations'),
  /** Persisted Telegram bot token path (written when you save a token locally). */
  telegramBotTokenFile: path.join(VIBE_HOME, 'telegram-bot-token'),
  /** Persisted Telegram allowlist path. */
  telegramAllowlistFile: path.join(VIBE_HOME, 'telegram-allowlist'),
  /** Display name for the machine Vibe runs on (shown as the local host chip). */
  localName: process.env.VIBE_LOCAL_NAME || os.hostname().split('.')[0] || 'local',
  /** SSH executable used to reach remote hosts (override for custom options/testing). */
  sshCommand: process.env.VIBE_SSH || 'ssh',
  port: Number(process.env.VIBE_PORT || process.env.PORT || 8787),
  host: process.env.VIBE_HOST || '0.0.0.0',
  token: loadOrCreateToken(),
  isProd: process.env.NODE_ENV === 'production',
  /** Telegram Bot API token from @BotFather. Empty ⇒ bot disabled. */
  telegramBotToken: loadTelegramBotToken(),
  /** Telegram user ids allowed to use the bot. Empty ⇒ any user who can message it. */
  telegramAllowlist: loadTelegramAllowlist(),
  /** Path to the Claude project transcripts (~/.claude/projects). */
  claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'),
  /** Where Cursor CLI stores per-workspace chats (~/.cursor/chats/<md5(cwd)>/<chatId>). */
  cursorChatsDir: path.join(os.homedir(), '.cursor', 'chats'),
  /** Where Cursor's ACP transport resolves resumable sessions. The on-disk
   *  database format matches `cursorChatsDir`, but ACP only scans this root. */
  cursorAcpSessionsDir: path.join(os.homedir(), '.cursor', 'acp-sessions'),
  /** Where Vibe persists transcripts for Cursor sessions it drives. */
  cursorTranscriptsDir: path.join(VIBE_HOME, 'cursor-transcripts'),
  /** Where the Codex CLI stores rollout transcripts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
  codexSessionsDir: path.join(os.homedir(), '.codex', 'sessions'),
  /** Codex's cached model list (~/.codex/models_cache.json) — no `codex models` subcommand exists. */
  codexModelsCacheFile: path.join(os.homedir(), '.codex', 'models_cache.json'),
  /** Where Vibe persists transcripts for Codex sessions it drives. */
  codexTranscriptsDir: path.join(VIBE_HOME, 'codex-transcripts'),
  /** Kimi Code data root (native installer default: ~/.kimi-code). */
  kimiHome: KIMI_HOME,
  /** Kimi Code's append-only native session index. */
  kimiSessionIndexFile: path.join(KIMI_HOME, 'session_index.jsonl'),
  /** Where Vibe persists normalized transcripts for Kimi sessions it drives. */
  kimiTranscriptsDir: path.join(VIBE_HOME, 'kimi-transcripts'),
  /** Where the Kiro CLI stores ACP/chat sessions (~/.kiro/sessions/cli). */
  kiroSessionsDir: path.join(os.homedir(), '.kiro', 'sessions', 'cli'),
  /** Where Vibe persists normalized transcripts for Kiro sessions it drives. */
  kiroTranscriptsDir: path.join(VIBE_HOME, 'kiro-transcripts'),
  /** Grok Build data root (override with GROK_HOME; default ~/.grok). */
  grokHome: GROK_HOME,
  /** Where the Grok CLI stores sessions (~/.grok/sessions/<encoded-cwd>/<id>). */
  grokSessionsDir: path.join(GROK_HOME, 'sessions'),
  /** Where Vibe persists normalized transcripts for Grok sessions it drives. */
  grokTranscriptsDir: path.join(VIBE_HOME, 'grok-transcripts'),
  /** ZCode data root (override with ZCODE_HOME; default ~/.zcode). */
  zcodeHome: ZCODE_HOME,
  /** ZCode CLI config (~/.zcode/cli/config.json) — providers, models, MCP servers. */
  zcodeConfigFile: path.join(ZCODE_HOME, 'cli', 'config.json'),
  /** Where Vibe persists normalized transcripts for ZCode sessions it drives. */
  zcodeTranscriptsDir: path.join(VIBE_HOME, 'zcode-transcripts'),
  /** Sidecar index for sync session adoption. The async app-server discovery pass
   *  rewrites it so the synchronous hub resolve path does not need to open and
   *  schema-couple itself to ZCode's live SQLite database. */
  zcodeIndexFile: path.join(VIBE_HOME, 'zcode-index.json'),
  /** CodeBuddy data root — fixed at ~/.codebuddy (the CLI offers no override). */
  codebuddyHome: path.join(os.homedir(), '.codebuddy'),
  /** CodeBuddy per-project transcripts (~/.codebuddy/projects — Claude layout). */
  codebuddyProjectsDir: path.join(os.homedir(), '.codebuddy', 'projects'),
  /** Where Vibe persists normalized transcripts for CodeBuddy sessions it drives. */
  codebuddyTranscriptsDir: path.join(VIBE_HOME, 'codebuddy-transcripts'),
  /** Vibe-managed CodeBuddy credentials (CODEBUDDY_API_KEY / _AUTH_TOKEN). */
  codebuddyAuthEnvFile: path.join(os.homedir(), '.codebuddy', 'vibe-auth.env'),
  /** Per-session MCP config files handed to the CodeBuddy CLI (`--mcp-config`). */
  codebuddyMcpDir: path.join(VIBE_HOME, 'codebuddy-mcp'),
  /** Devin data root — an XDG data dir (override with DEVIN_HOME). */
  devinHome: DEVIN_HOME,
  /** Devin's session database. SQLite in WAL mode, so the real data may sit in
   *  the `-wal` sidecar until a checkpoint; readers must copy both together. */
  devinSessionsDb: path.join(DEVIN_HOME, 'cli', 'sessions.db'),
  /** Devin credentials written by `devin auth login` (read-only for Vibe). */
  devinCredentialsFile: path.join(DEVIN_HOME, 'credentials.toml'),
  /** Devin user config (~/.config/devin/config.json — not under the data dir). */
  devinConfigFile: path.join(os.homedir(), '.config', 'devin', 'config.json'),
  /** Where Vibe persists transcripts for Devin sessions it drives. */
  devinTranscriptsDir: path.join(VIBE_HOME, 'devin-transcripts'),
  /** opencode data root — an XDG data dir (override with OPENCODE_HOME). */
  opencodeHome: OPENCODE_HOME,
  /** opencode's session library. SQLite in WAL mode, so the real data may sit
   *  in the `-wal` sidecar until a checkpoint; readers must open the live path
   *  (not a lone copy) so the engine applies the WAL for them. */
  opencodeDb: path.join(OPENCODE_HOME, 'opencode.db'),
  /** Where Vibe persists transcripts for opencode sessions it drives. */
  opencodeTranscriptsDir: path.join(VIBE_HOME, 'opencode-transcripts'),
  /** Sidecar blobs for tool results too large to keep inline in a transcript
   *  line (~/.vibe/blobs/<session>/<block>.txt — see sessions/blobs.ts). */
  blobsDir: path.join(VIBE_HOME, 'blobs'),
  /** Base dir for auto-created (ephemeral) session working directories. A fresh
   *  subfolder is made under here when a New session skips picking a cwd. */
  workdirsBase: path.join(VIBE_HOME, 'workdirs'),
  /** Where Vite emits the production bundle. */
  webDist: path.resolve(import.meta.dirname, '../../dist/web'),
  defaultModel: process.env.VIBE_DEFAULT_MODEL || 'opus',
  /** Default reasoning effort for new sessions (low|medium|high|xhigh|max|ultra).
   *  `ultra` is Codex-only (gpt-5.6 models); Claude tops out at `max`. */
  defaultEffort: process.env.VIBE_DEFAULT_EFFORT || 'max',
  /** Default model for new Cursor sessions. */
  defaultCursorModel: process.env.VIBE_DEFAULT_CURSOR_MODEL || 'auto',
  /** Default model for new Codex sessions. */
  defaultCodexModel: process.env.VIBE_DEFAULT_CODEX_MODEL || 'auto',
  /** Default model for new Kimi sessions (`auto` preserves Kimi's own config). */
  defaultKimiModel: process.env.VIBE_DEFAULT_KIMI_MODEL || 'auto',
  /** Default model for new Kiro sessions (`auto` lets Kiro pick). */
  defaultKiroModel: process.env.VIBE_DEFAULT_KIRO_MODEL || 'auto',
  /** Default model for new Grok sessions (`auto` lets Grok pick). */
  defaultGrokModel: process.env.VIBE_DEFAULT_GROK_MODEL || 'auto',
  /** Default model for new ZCode sessions (`auto` lets ZCode pick; otherwise
   *  `providerID/modelID` as written in ~/.zcode/cli/config.json). */
  defaultZcodeModel: process.env.VIBE_DEFAULT_ZCODE_MODEL || 'auto',
  /** Default model for new CodeBuddy sessions (`auto` lets CodeBuddy pick). */
  defaultCodebuddyModel: process.env.VIBE_DEFAULT_CODEBUDDY_MODEL || 'auto',
  /** Default model for new opencode sessions (`provider/model`; `auto` lets
   *  opencode pick from its own config). */
  defaultOpencodeModel: process.env.VIBE_DEFAULT_OPENCODE_MODEL || 'auto',
  /** Default model *family* for new Devin sessions. `auto` lets Devin pick;
   *  otherwise a family uid (e.g. `claude-opus-5`), with the effort level chosen
   *  separately and assembled into a variant uid at turn time. */
  defaultDevinModel: process.env.VIBE_DEFAULT_DEVIN_MODEL || 'auto',
  /** Which engine new sessions use by default. */
  defaultAgent:
    process.env.VIBE_DEFAULT_AGENT === 'cursor'
      ? 'cursor'
      : process.env.VIBE_DEFAULT_AGENT === 'codex'
        ? 'codex'
        : process.env.VIBE_DEFAULT_AGENT === 'kimi'
          ? 'kimi'
          : process.env.VIBE_DEFAULT_AGENT === 'kiro'
            ? 'kiro'
            : process.env.VIBE_DEFAULT_AGENT === 'grok'
            ? 'grok'
            : process.env.VIBE_DEFAULT_AGENT === 'zcode'
              ? 'zcode'
              : process.env.VIBE_DEFAULT_AGENT === 'codebuddy'
                ? 'codebuddy'
                : process.env.VIBE_DEFAULT_AGENT === 'opencode'
                  ? 'opencode'
                  : process.env.VIBE_DEFAULT_AGENT === 'devin'
                    ? 'devin'
                    : 'claude',
  /** Path to the user's real claude binary (preferred over the SDK's bundled one). */
  claudeExecutable: resolveClaudeExecutable(),
  /** Path to the user's cursor-agent binary (the Cursor CLI). */
  cursorExecutable: resolveCursorExecutable(),
  /** Path to the user's codex binary (the Codex CLI). */
  codexExecutable: resolveCodexExecutable(),
  /** Path to the user's Kimi Code binary. */
  kimiExecutable: resolveKimiExecutable(),
  /** Path to the user's Kiro CLI binary (`kiro-cli`). */
  kiroExecutable: resolveKiroExecutable(),
  /** Path to the user's Grok Build binary (`grok`). */
  grokExecutable: resolveGrokExecutable(),
  /** Path to the user's ZCode CLI binary (`zcode`). */
  zcodeExecutable: resolveZcodeExecutable(),
  /** Path to the user's CodeBuddy CLI binary (`codebuddy`, aka `cbc`). */
  codebuddyExecutable: resolveCodebuddyExecutable(),
  /** Path to the user's opencode CLI binary (`opencode`). */
  opencodeExecutable: resolveOpencodeExecutable(),
  /** Path to the user's Devin CLI binary (`devin`). */
  devinExecutable: resolveDevinExecutable(),
  serverVersion: '0.1.0',
} as const;
