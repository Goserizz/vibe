import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Credential injection for the CodeBuddy CLI. CodeBuddy's TUI-only `/login`
 * can't be driven headless, but the CLI honors the CODEBUDDY_API_KEY /
 * CODEBUDDY_AUTH_TOKEN environment variables (verified in its dist). Vibe
 * stores user-pasted credentials at ~/.codebuddy/vibe-auth.env (0600, plain
 * KEY=VALUE lines) and injects them into every turn's environment — locally
 * directly, on remote hosts by sourcing the same file in the login shell.
 */

export interface CodebuddyCredentials {
  apiKey?: string;
  authToken?: string;
}

/** Parse KEY=VALUE lines (# comments and surrounding quotes stripped). */
function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

/** Serialize credentials back to KEY=VALUE lines. */
function serializeEnvFile(creds: CodebuddyCredentials): string {
  const lines = ['# Managed by Vibe — CodeBuddy CLI credentials (codebuddy login).'];
  if (creds.apiKey) lines.push(`CODEBUDDY_API_KEY=${creds.apiKey}`);
  if (creds.authToken) lines.push(`CODEBUDDY_AUTH_TOKEN=${creds.authToken}`);
  return `${lines.join('\n')}\n`;
}

/** Read the stored credentials (empty object when absent/unreadable). */
export function readCodebuddyCredentials(): CodebuddyCredentials {
  let raw = '';
  try {
    raw = fs.readFileSync(config.codebuddyAuthEnvFile, 'utf8');
  } catch {
    return {};
  }
  const env = parseEnvFile(raw);
  return {
    apiKey: env.CODEBUDDY_API_KEY,
    authToken: env.CODEBUDDY_AUTH_TOKEN,
  };
}

/** Whether a Vibe-managed credential file exists (regardless of validity). */
export function hasCodebuddyCredentials(): boolean {
  try {
    fs.accessSync(config.codebuddyAuthEnvFile, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Persist credentials (0600, parent dir created on demand). */
export function writeCodebuddyCredentials(creds: CodebuddyCredentials): void {
  fs.mkdirSync(path.dirname(config.codebuddyAuthEnvFile), { recursive: true });
  fs.writeFileSync(config.codebuddyAuthEnvFile, serializeEnvFile(creds), { mode: 0o600 });
  try {
    fs.chmodSync(config.codebuddyAuthEnvFile, 0o600);
  } catch {
    /* best effort — the write mode above usually suffices */
  }
}

/** Remove the credential file (logout). Returns true when it existed. */
export function clearCodebuddyCredentials(): boolean {
  try {
    fs.rmSync(config.codebuddyAuthEnvFile, { force: true });
  } catch {
    /* ignore */
  }
  return hasCodebuddyCredentials();
}

/** Environment overlay injected into every local CodeBuddy turn. */
export function codebuddyAuthEnv(): Record<string, string> {
  const creds = readCodebuddyCredentials();
  const out: Record<string, string> = {};
  if (creds.apiKey) out.CODEBUDDY_API_KEY = creds.apiKey;
  if (creds.authToken) out.CODEBUDDY_AUTH_TOKEN = creds.authToken;
  return out;
}

/** Shell snippet that sources the same file on a remote host (no-op if absent). */
export function remoteCodebuddyAuthSource(): string {
  return 'set -a; . ~/.codebuddy/vibe-auth.env 2>/dev/null || true; set +a;';
}
