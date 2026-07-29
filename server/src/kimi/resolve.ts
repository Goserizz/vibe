import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed Kimi Code executable.
 *
 * The native installer keeps the binary under `~/.kimi-code/bin/kimi`, which
 * is not necessarily visible to a service process even when it works in the
 * user's interactive shell. `KIMI_CLI_PATH` remains the explicit override.
 */
export function resolveKimiExecutable(): string | undefined {
  const explicit = process.env.KIMI_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['kimi'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common install locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.kimi-code/bin/kimi'),
    path.join(home, '.local/bin/kimi'),
    '/usr/local/bin/kimi',
    '/opt/homebrew/bin/kimi',
    '/usr/bin/kimi',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
