import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Find the user's installed `claude` executable.
 *
 * The Agent SDK ships its own platform binary, but that can be the wrong
 * architecture (e.g. an x64 build picked up by a Rosetta node on Apple
 * Silicon, which spins forever). Pointing the SDK at the user's real,
 * working `claude` install avoids that entirely and reuses their config.
 */
export function resolveClaudeExecutable(): string | undefined {
  const explicit = process.env.CLAUDE_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['claude'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // not on PATH for this shell; fall back to common locations
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}
