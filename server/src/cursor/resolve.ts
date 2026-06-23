import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed `cursor-agent` executable (the Cursor CLI).
 *
 * The installer typically symlinks `~/.local/bin/cursor-agent` to a versioned
 * binary under `~/.local/share/cursor-agent/versions/<ver>/cursor-agent`. We
 * prefer whatever is on PATH, then fall back to common install locations so
 * Vibe works even when launched from a shell that didn't source the user's
 * profile. Override with CURSOR_CLI_PATH.
 */
export function resolveCursorExecutable(): string | undefined {
  const explicit = process.env.CURSOR_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['cursor-agent'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/cursor-agent'),
    '/opt/homebrew/bin/cursor-agent',
    '/usr/local/bin/cursor-agent',
    '/usr/bin/cursor-agent',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}
