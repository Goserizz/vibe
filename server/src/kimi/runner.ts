import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { KimiStreamNormalizer } from './normalize.js';
import { KimiAcpClient } from './acp.js';
import {
  cleanRemoteStderr,
  loginShellCommand,
  proxyEnvPrefix,
  shQuote,
  sshConnectPrefix,
} from '../remote/ssh.js';
import { MAX_RETRIES, backoffFor, isContentEvent, mentionsTransient, sleep } from '../claude/retry.js';
import type { McpServerDef, PermissionMode } from '../../../shared/protocol.js';
import type { RunCallbacks, RunHandle } from '../claude/types.js';

export interface KimiRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Kimi Code native session id (`session_<uuid>`) to resume. */
  resume?: string;
  /** Vibe-managed MCP servers, injected per turn over ACP. */
  mcpServers?: McpServerDef[];
  /** When set, the turn runs on a remote host over SSH. */
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

function cliArgs(opts: KimiRunOptions): string[] {
  const args: string[] = [];
  if (opts.resume) args.push('--resume', opts.resume);
  // `auto` means preserve Kimi Code's configured/session model.
  if (opts.model && opts.model !== 'auto') args.push('--model', opts.model);
  args.push('--prompt', opts.prompt, '--output-format', 'stream-json');
  return args;
}

/** Build the local spawn or remote SSH invocation. */
function buildSpawn(opts: KimiRunOptions): { bin?: string; args: string[]; remote: boolean } {
  const args = cliArgs(opts);
  if (!opts.remote) return { bin: config.kimiExecutable, args, remote: false };

  // The native installer uses ~/.kimi-code/bin without guaranteeing it is on
  // PATH. Resolve that fallback inside the remote login shell as well.
  const invoke = `"$kimi_bin" ${args.map(shQuote).join(' ')}`;
  const inner = [
    `cd ${shQuote(opts.remote.cwd)}`,
    'kimi_fallback="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin/kimi"; '
      + 'if command -v kimi >/dev/null 2>&1; then kimi_bin="$(command -v kimi)"; '
      + 'elif [ -x "$kimi_fallback" ]; then kimi_bin="$kimi_fallback"; '
      + 'else echo "kimi not found" >&2; exit 127; fi',
    invoke,
  ].join('\n');
  const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(inner);
  const { bin, opts: sshOpts } = sshConnectPrefix();
  return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
}

interface Outcome {
  transient: boolean;
  durationMs: number;
  error?: string;
}

/** Legacy fallback for Kimi builds that predate the `acp` subcommand. */
function runOnce(
  opts: KimiRunOptions,
  normalizer: KimiStreamNormalizer,
  setChild: (child: ChildProcess) => void,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const { bin, args, remote } = buildSpawn(opts);
    if (!bin) {
      resolve({
        transient: false,
        durationMs: 0,
        error: 'kimi not found — install Kimi Code or set KIMI_CLI_PATH',
      });
      return;
    }

    const child = spawn(bin, args, {
      cwd: remote ? undefined : opts.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    setChild(child);

    let settled = false;
    let stderr = '';
    let buffer = '';
    let sawTransient = false;
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const onLine = (line: string) => {
      if (!line.trim()) return;
      if (mentionsTransient(line)) sawTransient = true;
      try {
        normalizer.push(JSON.parse(line));
      } catch {
        /* non-JSON stdout noise — ignore */
      }
    };

    child.stdout.on('data', (data) => {
      buffer += data.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (mentionsTransient(text)) sawTransient = true;
    });
    child.on('error', (error) => {
      finish({
        transient: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer);
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        finish({ transient: false, durationMs });
        return;
      }
      finish({
        transient: sawTransient,
        durationMs,
        error: cleanRemoteStderr(stderr) || `kimi exited with code ${code}`,
      });
    });
  });
}

function acpUnavailable(error: string): boolean {
  return /(?:unknown|unrecognized|invalid)\s+(?:command|subcommand).*\bacp\b|unknown command ['"]?acp/i.test(error);
}

/** Drive a Kimi turn through ACP so discovered model/mode config and interactive
 * approvals are real. Old CLIs without ACP retain prompt-mode Auto behavior. */
export function startKimiRun(opts: KimiRunOptions, cb: RunCallbacks): RunHandle {
  const abortController = new AbortController();
  let child: ChildProcess | undefined;
  let acpClient: KimiAcpClient | undefined;
  let aborted = false;
  let usingFallback = false;
  let producedAny = false;
  let resume = opts.resume;
  const wrappedCb: RunCallbacks = {
    ...cb,
    onClaudeSessionId: (id) => {
      resume = id;
      cb.onClaudeSessionId(id);
    },
    onEvent: (event) => {
      if (isContentEvent(event)) producedAny = true;
      cb.onEvent(event);
    },
  };

  const done = (async () => {
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      const normalizer = new KimiStreamNormalizer(wrappedCb);
      acpClient = new KimiAcpClient({ ...opts, resume }, wrappedCb);
      const acpOutcome = await acpClient.run();
      let outcome: Outcome = {
        transient: Boolean(acpOutcome.error && mentionsTransient(acpOutcome.error)),
        durationMs: Date.now() - startedAt,
        error: acpOutcome.error,
      };

      // A pre-ACP Kimi can still run the one supported UI mode (prompt Auto).
      if (outcome.error && opts.permissionMode === 'default' && acpUnavailable(outcome.error)) {
        log.debug('kimi acp unavailable; falling back to prompt mode');
        usingFallback = true;
        outcome = await runOnce({ ...opts, resume }, normalizer, (next) => (child = next));
        usingFallback = false;
      }
      if (aborted) {
        log.debug('kimi run aborted');
        return;
      }
      if (outcome.transient && !producedAny && attempt < MAX_RETRIES) {
        const backoff = backoffFor(attempt);
        log.warn(`kimi transient error, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        try {
          await sleep(backoff, abortController.signal);
        } catch {
          log.debug('kimi run aborted during backoff');
          return;
        }
        continue;
      }
      normalizer.finish(outcome.durationMs, Boolean(outcome.error));
      if (outcome.error) {
        log.error('kimi run error:', outcome.error);
        cb.onEvent({ k: 'error', text: outcome.error });
      }
      return;
    }
  })();

  return {
    abort: () => {
      if (usingFallback) {
        // Legacy prompt mode is one process per reply and has no persistent task
        // transport, so terminating that process is its only interrupt primitive.
        aborted = true;
        abortController.abort();
        child?.kill('SIGTERM');
        return;
      }
      acpClient?.abort();
    },
    sendMessage: (text: string) => acpClient?.sendMessage(text) ?? false,
    stopTask: async (taskId: string) => {
      if (!acpClient) throw new Error('Kimi task control is unavailable');
      await acpClient.stopTask(taskId);
    },
    done,
  };
}
