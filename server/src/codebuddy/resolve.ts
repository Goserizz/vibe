import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed CodeBuddy CLI executable (npm package
 * @tencent-ai/codebuddy-code; `cbc` is the same binary). `CODEBUDDY_CLI_PATH`
 * is the explicit override.
 */
export function resolveCodebuddyExecutable(): string | undefined {
  const explicit = process.env.CODEBUDDY_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['codebuddy'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common install locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/codebuddy'),
    '/usr/local/bin/codebuddy',
    '/opt/homebrew/bin/codebuddy',
    '/usr/bin/codebuddy',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
