import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed `codex` executable (the Codex CLI).
 *
 * Prefer whatever is on PATH, then fall back to common install locations so Vibe
 * works even when launched from a shell that didn't source the user's profile.
 * Override with CODEX_CLI_PATH.
 */
export function resolveCodexExecutable(): string | undefined {
  const explicit = process.env.CODEX_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['codex'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common locations
  }

  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/codex',
    path.join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}
