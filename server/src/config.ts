import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveClaudeExecutable } from './claude/resolve.js';
import { resolveCursorExecutable } from './cursor/resolve.js';
import { resolveCodexExecutable } from './codex/resolve.js';
import { resolveKimiExecutable } from './kimi/resolve.js';
import { resolveKiroExecutable } from './kiro/resolve.js';

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
  hostsFile: path.join(VIBE_HOME, 'hosts.json'),
  /** MCP server registry + per-scope enable lists (global, local, per host). */
  mcpFile: path.join(VIBE_HOME, 'mcp.json'),
  /** OAuth tokens + registered clients for MCP-OAuth servers (secrets — 0600). */
  mcpOauthFile: path.join(VIBE_HOME, 'mcp-oauth.json'),
  /** Saved New-session engine presets (agent + model + permission + effort). */
  presetsFile: path.join(VIBE_HOME, 'presets.json'),
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
  serverVersion: '0.1.0',
} as const;
