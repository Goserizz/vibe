import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveClaudeExecutable } from './claude/resolve.js';

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
  /** Where Vite emits the production bundle. */
  webDist: path.resolve(import.meta.dirname, '../../dist/web'),
  defaultModel: process.env.VIBE_DEFAULT_MODEL || 'opus',
  /** Default reasoning effort for new sessions (low|medium|high|xhigh|max). */
  defaultEffort: process.env.VIBE_DEFAULT_EFFORT || 'max',
  /** Path to the user's real claude binary (preferred over the SDK's bundled one). */
  claudeExecutable: resolveClaudeExecutable(),
  serverVersion: '0.1.0',
} as const;
