import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveClaudeExecutable } from './claude/resolve.js';
import { resolveCursorExecutable } from './cursor/resolve.js';
import { resolveCodexExecutable } from './codex/resolve.js';

function resolveHome(): string {
  const custom = process.env.VIBE_HOME;
  if (custom && custom.trim()) return path.resolve(custom);
  return path.join(os.homedir(), '.vibe');
}

const VIBE_HOME = resolveHome();
fs.mkdirSync(VIBE_HOME, { recursive: true });

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

export const config = {
  home: VIBE_HOME,
  sessionsFile: path.join(VIBE_HOME, 'sessions.json'),
  hostsFile: path.join(VIBE_HOME, 'hosts.json'),
  /** Display name for the machine Vibe runs on (shown as the local host chip). */
  localName: process.env.VIBE_LOCAL_NAME || os.hostname().split('.')[0] || 'local',
  /** SSH executable used to reach remote hosts (override for custom options/testing). */
  sshCommand: process.env.VIBE_SSH || 'ssh',
  port: Number(process.env.VIBE_PORT || process.env.PORT || 8787),
  host: process.env.VIBE_HOST || '0.0.0.0',
  token: loadOrCreateToken(),
  isProd: process.env.NODE_ENV === 'production',
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
  /** Where Vite emits the production bundle. */
  webDist: path.resolve(import.meta.dirname, '../../dist/web'),
  defaultModel: process.env.VIBE_DEFAULT_MODEL || 'opus',
  /** Default reasoning effort for new sessions (low|medium|high|xhigh|max). */
  defaultEffort: process.env.VIBE_DEFAULT_EFFORT || 'max',
  /** Default model for new Cursor sessions. */
  defaultCursorModel: process.env.VIBE_DEFAULT_CURSOR_MODEL || 'auto',
  /** Default model for new Codex sessions. */
  defaultCodexModel: process.env.VIBE_DEFAULT_CODEX_MODEL || 'auto',
  /** Which engine new sessions use by default ('claude' | 'cursor' | 'codex'). */
  defaultAgent: process.env.VIBE_DEFAULT_AGENT === 'cursor' ? 'cursor' : process.env.VIBE_DEFAULT_AGENT === 'codex' ? 'codex' : 'claude',
  /** Path to the user's real claude binary (preferred over the SDK's bundled one). */
  claudeExecutable: resolveClaudeExecutable(),
  /** Path to the user's cursor-agent binary (the Cursor CLI). */
  cursorExecutable: resolveCursorExecutable(),
  /** Path to the user's codex binary (the Codex CLI). */
  codexExecutable: resolveCodexExecutable(),
  serverVersion: '0.1.0',
} as const;
