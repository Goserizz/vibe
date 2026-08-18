import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed ZCode CLI executable.
 *
 * ZCode only ships a desktop build; the CLI is the bundled `zcode.cjs` runtime,
 * usually wrapped as a `zcode` shim on PATH (e.g. /usr/local/bin/zcode).
 * `ZCODE_CLI_PATH` is the explicit override.
 */
export function resolveZcodeExecutable(): string | undefined {
  const explicit = process.env.ZCODE_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['zcode'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common install locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/zcode'),
    '/usr/local/bin/zcode',
    '/opt/homebrew/bin/zcode',
    '/usr/bin/zcode',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
