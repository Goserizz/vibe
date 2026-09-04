import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed opencode CLI executable.
 *
 * The official installer places `opencode` under `~/.opencode/bin`, which may
 * not be on PATH for a service process. `OPENCODE_CLI_PATH` is the explicit
 * override.
 */
export function resolveOpencodeExecutable(): string | undefined {
  const explicit = process.env.OPENCODE_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['opencode'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common install locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
