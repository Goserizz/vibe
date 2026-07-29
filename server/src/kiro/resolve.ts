import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed Kiro CLI executable.
 *
 * The official installer places binaries under `~/.local/bin/kiro-cli`, which
 * may not be on PATH for a service process. `KIRO_CLI_PATH` is the explicit override.
 */
export function resolveKiroExecutable(): string | undefined {
  const explicit = process.env.KIRO_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['kiro-cli'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common install locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/kiro-cli'),
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
    '/usr/bin/kiro-cli',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
