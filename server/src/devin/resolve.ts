import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed Devin CLI executable.
 *
 * The official installer places the launcher at `~/.local/bin/devin`, which may
 * not be on PATH for a service process. `DEVIN_CLI_PATH` is the explicit override.
 *
 * The launcher is a symlink into `~/.local/share/devin/cli/_versions/current`,
 * which is what `devin update` rewrites — resolve it rather than pinning a version.
 */
export function resolveDevinExecutable(): string | undefined {
  const explicit = process.env.DEVIN_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['devin'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common install locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/devin'),
    '/usr/local/bin/devin',
    '/opt/homebrew/bin/devin',
    '/usr/bin/devin',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
