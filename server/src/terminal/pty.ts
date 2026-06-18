import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { log } from '../log.js';
import { shQuote, sshTerminalArgv } from '../remote/ssh.js';
import type { IPty } from 'node-pty';

// node-pty is a native CommonJS module; load it via require for reliable interop.
const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');

// The prebuilt `spawn-helper` sometimes ships without the execute bit, which
// makes posix_spawnp fail. Fix it once before the first spawn.
let helperFixed = false;
function ensureSpawnHelper(): void {
  if (helperFixed) return;
  helperFixed = true;
  try {
    const prebuilds = path.join(path.dirname(require.resolve('node-pty')), '..', 'prebuilds');
    for (const dir of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, dir, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch (err) {
    log.debug('spawn-helper chmod skipped', err);
  }
}

export interface TerminalOptions {
  cwd: string;
  /** SSH target for a remote host; omit for a local shell. */
  sshTarget?: string;
  cols: number;
  rows: number;
}

/**
 * Spawn an interactive shell PTY for a session's host + cwd. Local sessions get
 * a login shell; remote sessions get `ssh -tt` into a login shell on the host
 * (so the user's full environment — nvm, etc. — is available).
 */
export function spawnTerminal(opts: TerminalOptions): IPty {
  ensureSpawnHelper();
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;

  if (opts.sshTarget) {
    const remote = `cd ${shQuote(opts.cwd)} 2>/dev/null; exec \${SHELL:-bash} -l`;
    const { bin, args } = sshTerminalArgv(opts.sshTarget, remote);
    return pty.spawn(bin, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: os.homedir(), env });
  }

  const shell = process.env.SHELL || '/bin/bash';
  return pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env });
}
