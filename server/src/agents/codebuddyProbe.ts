import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import { readCodebuddyCredentials } from '../codebuddy/auth.js';

/**
 * CodeBuddy login probes: cheap on-disk evidence first, then (only when needed)
 * a one-turn live probe — `codebuddy -p 'Reply with exactly: pong'
 * --output-format json` — which proves the credentials the CLI would actually
 * use can reach the model.
 */

/** Strip shell/CLI noise so probe errors stay readable. */
export function cleanCodebuddyProbeOutput(s: string, maxLen = 500): string {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
    .join('\n')
    .slice(0, maxLen);
}

// ---- on-disk evidence --------------------------------------------------------

export interface CodebuddyLoginEvidence {
  host: string;
  /** Extra env for the probe turn (credential verification). */
  env?: Record<string, string>;
  /** Account label when Vibe-managed credentials exist. */
  credentialAccount?: string;
  /** Account label when the CLI's own storage shows a TUI login. */
  storageAccount?: string;
}

/** Label for the credentials found in vibe-auth.env. */
function credentialLabel(creds: { apiKey?: string; authToken?: string }): string | undefined {
  if (creds.apiKey && creds.authToken) return 'API key + token (Vibe)';
  if (creds.apiKey) return 'API key (Vibe)';
  if (creds.authToken) return 'Auth token (Vibe)';
  return undefined;
}

/** The local_storage entry holding the apiKeySource endpoint is a tiny file
 *  whose whole content is a quoted URL (e.g. "https://copilot.tencent.com"). */
const QUOTED_URL_FILE_RE = /^"(https?:\/\/[^"]+)"$/;

/** Scan ~/.codebuddy/local_storage for the quoted-URL login marker (local). */
function scanLocalStorage(): string | undefined {
  const dir = path.join(config.codebuddyHome, 'local_storage');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (!name.endsWith('.info')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.size > 256) continue; // the marker file is tiny
      const m = fs.readFileSync(path.join(dir, name), 'utf8').trim().match(QUOTED_URL_FILE_RE);
      if (m) return m[1].replace(/^https?:\/\//, '');
    } catch {
      /* unreadable entry — try the next */
    }
  }
  return undefined;
}

/** Remote one-liner: report vibe-auth.env keys + the quoted-URL marker. */
const REMOTE_EVIDENCE_CMD = [
  'if [ -f ~/.codebuddy/vibe-auth.env ]; then echo "AUTH:$(grep -o \'^CODEBUDDY_[A-Z_]*\' ~/.codebuddy/vibe-auth.env | tr \'\\n\' \',\')"; else echo AUTH:-; fi',
  'src=""',
  'for f in ~/.codebuddy/local_storage/*.info; do',
  '  [ -f "$f" ] || continue',
  '  sz=$(wc -c < "$f" 2>/dev/null || echo 999)',
  '  if [ "$sz" -le 256 ]; then',
  '    u=$(head -c 200 "$f" | tr -d \'\\n\' | grep -oE \'^"https?://[^"]+"$\' | tr -d \'"\' | sed \'s|^https\\?://||\')',
  '    [ -n "$u" ] && src="$u" && break',
  '  fi',
  'done',
  'echo "SRC:${src:--}"',
].join('\n');

function parseCredentialKeys(raw: string): { apiKey?: boolean; authToken?: boolean } {
  const out: { apiKey?: boolean; authToken?: boolean } = {};
  if (raw.includes('CODEBUDDY_API_KEY')) out.apiKey = true;
  if (raw.includes('CODEBUDDY_AUTH_TOKEN')) out.authToken = true;
  return out;
}

function keysToLabel(keys: { apiKey?: boolean; authToken?: boolean }): string | undefined {
  return credentialLabel({
    apiKey: keys.apiKey ? 'set' : undefined,
    authToken: keys.authToken ? 'set' : undefined,
  });
}

/** Collect cheap login evidence on this machine or a remote host. */
export async function codebuddyLoginEvidence(hostName: string): Promise<CodebuddyLoginEvidence> {
  const host = hostName.trim();
  if (!host) {
    return {
      host,
      credentialAccount: credentialLabel(readCodebuddyCredentials()),
      storageAccount: scanLocalStorage(),
    };
  }
  const hostRec = hostRegistry.get(host);
  if (!hostRec) return { host };
  try {
    const res = await sshExec(hostRec.ssh, loginShellCommand(REMOTE_EVIDENCE_CMD), { timeoutMs: 15_000 });
    const pick = (key: string): string =>
      res.stdout.split('\n').find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? '';
    const auth = pick('AUTH');
    const src = pick('SRC');
    return {
      host,
      credentialAccount: auth && auth !== '-' ? keysToLabel(parseCredentialKeys(auth)) : undefined,
      storageAccount: src && src !== '-' ? src : undefined,
    };
  } catch (err) {
    log.debug(`codebuddy evidence probe failed for ${host}`, err);
    return { host };
  }
}

// ---- live one-turn probe ------------------------------------------------------

export interface CodebuddyProbeResult {
  ok: boolean;
  /** Where the probe ran / what it authenticated with. */
  account?: string;
  error?: string;
}

const PROBE_PROMPT = 'Reply with exactly: pong';
const PROBE_TIMEOUT_MS = 90_000;

/** Parse the probe's `--output-format json` single-result object. */
function parseProbeJson(raw: string): CodebuddyProbeResult {
  let parsed: any;
  try {
    // The result JSON is the last JSON line on stdout (warnings may precede it).
    for (const line of raw.split('\n').reverse()) {
      if (!line.trim().startsWith('{')) continue;
      try {
        parsed = JSON.parse(line);
        break;
      } catch {
        /* keep looking */
      }
    }
  } catch {
    /* fall through */
  }
  if (parsed && typeof parsed === 'object' && parsed.type === 'result') {
    if (parsed.is_error) {
      return { ok: false, error: cleanCodebuddyProbeOutput(String(parsed.result ?? 'probe turn failed')) };
    }
    const source = typeof parsed.apiKeySource === 'string' ? parsed.apiKeySource.replace(/^https?:\/\//, '') : undefined;
    return { ok: true, account: source };
  }
  return { ok: false, error: raw.trim() ? cleanCodebuddyProbeOutput(raw) : 'no result from probe turn' };
}

/** Run the pong probe locally (env override on top of vibe-auth.env). */
function probeLocal(env?: Record<string, string>): Promise<CodebuddyProbeResult> {
  const exe = config.codebuddyExecutable;
  if (!exe) return Promise.resolve({ ok: false, error: 'codebuddy CLI not found' });
  return new Promise((resolve) => {
    const child = spawn(exe, ['-p', PROBE_PROMPT, '--output-format', 'json'], {
      cwd: os.tmpdir(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `failed to run codebuddy: ${err.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: 'probe timed out' });
        return;
      }
      const parsed = parseProbeJson(stdout);
      if (parsed.ok) resolve(parsed);
      else resolve({ ok: false, error: parsed.error || cleanCodebuddyProbeOutput(stderr) || 'probe failed' });
    });
  });
}

/** Run the pong probe over SSH (env override exported in the remote shell). */
async function probeRemote(
  sshTarget: string,
  proxy: string | undefined,
  env?: Record<string, string>,
): Promise<CodebuddyProbeResult> {
  const exports = Object.entries(env ?? {})
    .map(([k, v]) => `export ${k}=${shQuote(v)}`)
    .join(' ');
  const inner = [
    exports,
    'cd /tmp',
    `codebuddy -p ${shQuote(PROBE_PROMPT)} --output-format json 2>&1`,
  ].filter(Boolean).join('\n');
  const remoteCmd = proxyEnvPrefix(proxy) + loginShellCommand(inner);
  const res = await sshExec(sshTarget, remoteCmd, { timeoutMs: PROBE_TIMEOUT_MS + 15_000 });
  if (res.timedOut) return { ok: false, error: 'probe timed out' };
  const parsed = parseProbeJson(res.stdout);
  if (parsed.ok) return parsed;
  return { ok: false, error: parsed.error || cleanCodebuddyProbeOutput(res.stderr) || 'probe failed' };
}

/** One cheap turn proving the CLI can authenticate (and reach a model). */
export async function probeCodebuddyTurn(
  hostName: string,
  env?: Record<string, string>,
): Promise<CodebuddyProbeResult> {
  const host = hostName.trim();
  if (!host) return probeLocal(env);
  const hostRec = hostRegistry.get(host);
  if (!hostRec) return { ok: false, error: `unknown host "${host}"` };
  return probeRemote(hostRec.ssh, proxyForAgent(hostRec, 'codebuddy'), env);
}

/** Same probe against a raw SSH target (used by the push-installer, which
 *  knows the target but not a registered host name). */
export function probeCodebuddyTarget(sshTarget: string): Promise<CodebuddyProbeResult> {
  return probeRemote(sshTarget, undefined, undefined);
}
