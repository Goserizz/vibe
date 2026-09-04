import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostRegistry } from '../remote/hosts.js';
import { cleanRemoteStderr, loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { MonitorInput, MonitorProbeResult } from '../../../shared/protocol.js';

const OUTPUT_LIMIT = 32 * 1024;
const SUMMARY_LIMIT = 240;

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function cap(value: string, limit = OUTPUT_LIMIT): string {
  const text = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (Buffer.byteLength(text) <= limit) return text;
  let out = text.slice(0, limit);
  while (Buffer.byteLength(out) > limit) out = out.slice(0, Math.floor(out.length * 0.9));
  return `${out}\n… output truncated by Vibe`;
}

function firstLine(value: string): string | undefined {
  const line = value.split('\n').map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
}

function fingerprint(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function joinOutput(stdout: string, stderr: string): string | undefined {
  const out = cap(stdout);
  const err = cap(stderr);
  const sections: string[] = [];
  if (out) sections.push(`stdout:\n${out}`);
  if (err) sections.push(`stderr:\n${err}`);
  return sections.join('\n\n') || undefined;
}

function runLocalCommand(command: string, cwd: string | undefined, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: cwd || undefined,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const push = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= OUTPUT_LIMIT) return current;
      const remaining = OUTPUT_LIMIT - current;
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      return current + kept.length;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = push(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = push(stderr, chunk, stderrBytes); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    timer.unref?.();
    const finish = (code: number | null, extraError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const extra = extraError ? Buffer.from(extraError) : undefined;
      if (extra) stderr.push(extra);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    };
    child.on('error', (error) => finish(-1, error instanceof Error ? error.message : String(error)));
    child.on('close', (code) => finish(code));
  });
}

async function commandProbe(input: Pick<MonitorInput, 'probe' | 'host' | 'cwd'>): Promise<MonitorProbeResult> {
  if (input.probe.kind !== 'command') throw new Error('not a command probe');
  const startedAt = Date.now();
  let result: CommandResult;
  if (input.host) {
    const remote = hostRegistry.get(input.host);
    if (!remote) {
      const summary = `Remote host “${input.host}” is no longer registered`;
      return {
        healthy: false,
        kind: 'probe-error',
        summary,
        fingerprint: fingerprint(['probe-error', summary]),
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
    const inner = input.cwd
      ? `cd ${shQuote(input.cwd)} && ${input.probe.command}`
      : input.probe.command;
    const remoteResult = await sshExec(remote.ssh, loginShellCommand(inner), {
      timeoutMs: input.probe.timeoutMs,
      maxOutputBytes: OUTPUT_LIMIT,
      mux: false,
    });
    result = {
      code: remoteResult.code,
      stdout: remoteResult.stdout,
      stderr: cleanRemoteStderr(remoteResult.stderr, OUTPUT_LIMIT),
      timedOut: remoteResult.timedOut,
    };
  } else {
    try {
      result = await runLocalCommand(input.probe.command, input.cwd, input.probe.timeoutMs);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      return {
        healthy: false,
        kind: 'probe-error',
        summary,
        fingerprint: fingerprint(['probe-error', summary]),
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const checkedAt = Date.now();
  const detail = joinOutput(result.stdout, result.stderr);
  const line = firstLine(result.stderr) ?? firstLine(result.stdout);
  if (result.timedOut) {
    const summary = `Probe timed out after ${input.probe.timeoutMs}ms${line ? `: ${line}` : ''}`;
    return {
      healthy: false,
      kind: 'probe-error',
      summary,
      detail,
      fingerprint: fingerprint(['timeout', detail]),
      checkedAt,
      durationMs: checkedAt - startedAt,
      exitCode: result.code ?? undefined,
    };
  }
  // OpenSSH reserves 255 for transport/setup failures. Keep it distinct from
  // the monitored command's ordinary non-zero "unhealthy" result.
  if (input.host && result.code === 255) {
    const summary = `SSH probe failed${line ? `: ${line}` : ''}`;
    return {
      healthy: false,
      kind: 'probe-error',
      summary,
      detail,
      fingerprint: fingerprint(['ssh-error', detail]),
      checkedAt,
      durationMs: checkedAt - startedAt,
      exitCode: 255,
    };
  }
  const healthy = result.code === 0;
  const summary = healthy
    ? `Command healthy${firstLine(result.stdout) ? `: ${firstLine(result.stdout)}` : ''}`
    : `Command exited with code ${result.code ?? 'unknown'}${line ? `: ${line}` : ''}`;
  return {
    healthy,
    kind: 'observation',
    summary,
    detail,
    fingerprint: fingerprint([healthy, result.code, detail]),
    checkedAt,
    durationMs: checkedAt - startedAt,
    exitCode: result.code ?? undefined,
  };
}

async function readBody(response: Response, limit = OUTPUT_LIMIT): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const keep = value.byteLength > limit - size ? value.subarray(0, limit - size) : value;
      chunks.push(keep);
      size += keep.byteLength;
      if (keep.byteLength < value.byteLength) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* response already closed */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function remoteHttpProbe(
  input: Pick<MonitorInput, 'probe' | 'host'>,
  startedAt: number,
): Promise<MonitorProbeResult> {
  if (input.probe.kind !== 'http' || !input.host) throw new Error('not a remote HTTP probe');
  const remote = hostRegistry.get(input.host);
  if (!remote) {
    const summary = `Remote host “${input.host}” is no longer registered`;
    return {
      healthy: false,
      kind: 'probe-error',
      summary,
      fingerprint: fingerprint(['probe-error', summary]),
      checkedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }
  const seconds = Math.max(1, Math.ceil(input.probe.timeoutMs / 1_000));
  const head = input.probe.method === 'HEAD' ? '--head ' : '';
  const command = [
    'curl --silent --show-error --location',
    head,
    `--max-time ${seconds}`,
    `--request ${input.probe.method}`,
    `--write-out ${shQuote('\\n__VIBE_HTTP_STATUS__:%{http_code}')}`,
    '--',
    shQuote(input.probe.url),
  ].join(' ');
  const result = await sshExec(remote.ssh, loginShellCommand(command), {
    timeoutMs: input.probe.timeoutMs + 10_000,
    maxOutputBytes: OUTPUT_LIMIT + 1_024,
    mux: false,
  });
  const checkedAt = Date.now();
  if (result.timedOut || result.code !== 0) {
    const detail = joinOutput(result.stdout, cleanRemoteStderr(result.stderr, OUTPUT_LIMIT));
    const line = firstLine(result.stderr) ?? firstLine(result.stdout);
    const summary = result.timedOut
      ? `Remote HTTP probe timed out after ${input.probe.timeoutMs}ms`
      : `Remote HTTP probe failed${line ? `: ${line}` : ''}`;
    return {
      healthy: false,
      kind: 'probe-error',
      summary,
      detail,
      fingerprint: fingerprint(['remote-http-error', result.code, detail]),
      checkedAt,
      durationMs: checkedAt - startedAt,
      exitCode: result.code ?? undefined,
    };
  }
  const marker = '\n__VIBE_HTTP_STATUS__:';
  const at = result.stdout.lastIndexOf(marker);
  if (at < 0) {
    const summary = 'Remote HTTP probe returned no status marker';
    return {
      healthy: false,
      kind: 'probe-error',
      summary,
      detail: cap(result.stdout) || undefined,
      fingerprint: fingerprint(['remote-http-parse', result.stdout]),
      checkedAt,
      durationMs: checkedAt - startedAt,
    };
  }
  const body = result.stdout.slice(0, at);
  const status = Number(result.stdout.slice(at + marker.length).trim());
  if (!Number.isInteger(status)) {
    const summary = 'Remote HTTP probe returned an invalid status';
    return {
      healthy: false,
      kind: 'probe-error',
      summary,
      detail: cap(result.stdout) || undefined,
      fingerprint: fingerprint(['remote-http-status', result.stdout]),
      checkedAt,
      durationMs: checkedAt - startedAt,
    };
  }
  const statusHealthy = status >= input.probe.expectedStatusMin && status <= input.probe.expectedStatusMax;
  const bodyHealthy = input.probe.bodyIncludes ? body.includes(input.probe.bodyIncludes) : true;
  const healthy = statusHealthy && bodyHealthy;
  const bodyLine = firstLine(body);
  const summary = healthy
    ? `HTTP ${status} healthy${bodyLine ? `: ${bodyLine}` : ''}`
    : !statusHealthy
      ? `Unexpected HTTP status ${status}`
      : `HTTP ${status} body did not contain expected text`;
  return {
    healthy,
    kind: 'observation',
    summary,
    detail: cap(body) || undefined,
    fingerprint: fingerprint([healthy, status, body]),
    checkedAt,
    durationMs: checkedAt - startedAt,
    httpStatus: status,
  };
}

async function httpProbe(input: Pick<MonitorInput, 'probe' | 'host'>): Promise<MonitorProbeResult> {
  if (input.probe.kind !== 'http') throw new Error('not an HTTP probe');
  const startedAt = Date.now();
  if (input.host) return remoteHttpProbe(input, startedAt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.probe.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(input.probe.url, {
      method: input.probe.method,
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'text/plain, application/json;q=0.9, */*;q=0.1' },
    });
    const body = input.probe.method === 'HEAD' ? '' : await readBody(response);
    const statusHealthy =
      response.status >= input.probe.expectedStatusMin
      && response.status <= input.probe.expectedStatusMax;
    const bodyHealthy = input.probe.bodyIncludes ? body.includes(input.probe.bodyIncludes) : true;
    const healthy = statusHealthy && bodyHealthy;
    const checkedAt = Date.now();
    const bodyLine = firstLine(body);
    const summary = healthy
      ? `HTTP ${response.status} healthy${bodyLine ? `: ${bodyLine}` : ''}`
      : !statusHealthy
        ? `Unexpected HTTP status ${response.status}`
        : `HTTP ${response.status} body did not contain expected text`;
    return {
      healthy,
      kind: 'observation',
      summary,
      detail: cap(body) || undefined,
      fingerprint: fingerprint([healthy, response.status, body]),
      checkedAt,
      durationMs: checkedAt - startedAt,
      httpStatus: response.status,
    };
  } catch (error) {
    const checkedAt = Date.now();
    const aborted = controller.signal.aborted;
    const message = aborted
      ? `HTTP probe timed out after ${input.probe.timeoutMs}ms`
      : `HTTP probe failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      healthy: false,
      kind: 'probe-error',
      summary: message,
      fingerprint: fingerprint(['http-error', message]),
      checkedAt,
      durationMs: checkedAt - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runMonitorProbe(
  input: Pick<MonitorInput, 'probe' | 'host' | 'cwd'>,
): Promise<MonitorProbeResult> {
  return input.probe.kind === 'command' ? commandProbe(input) : httpProbe(input);
}
