import zlib from 'node:zlib';
import { log } from '../log.js';
import { BUNDLE_KNOWN_HEADER, bundleKnownStdin, bundleSkipGuard, bundleMtimeMs, cachedBundleSession, markerCmd, mtimeExpr, noteBundleKey, noteBundleSession, parseBundle } from '../remote/bundle.js';
import { loginShellCommand, sshExec } from '../remote/ssh.js';
import { isClaudeSessionId, type DiscoveredSession } from '../sessions/discovery.js';
import { parseCodebuddyBlocks, parseCodebuddyHeadMeta } from './transcript.js';
import { config } from '../config.js';
import type { ChatBlock, RemoteHost } from '../../../shared/protocol.js';

// Remote mirrors of discovery.ts / transcript.ts over one SSH round-trip each.
// CodeBuddy transcripts are Claude-format JSONL under ~/.codebuddy/projects,
// so the shared parsers apply unchanged.

const MAX_FILES = 80;
const HEAD_LINES = 60;
/** Bound a transcript fetch: a single session can carry huge tool outputs. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

const BUNDLE_CMD = [
  BUNDLE_KNOWN_HEADER,
  'cd ~/.codebuddy/projects 2>/dev/null || exit 0',
  // `./*/*.jsonl` (not `*/*.jsonl`) so project dirs whose names start with "-"
  // aren't mistaken for `ls` options.
  `ls -1t ./*/*.jsonl 2>/dev/null | head -${MAX_FILES} | while IFS= read -r f; do`,
  `  m=${mtimeExpr('"$f"')}`,
  `  ${markerCmd(['"$f"', '"$m"'])}`,
  `  ${bundleSkipGuard('f', `head -n ${HEAD_LINES} "$f"`)}`,
  'done',
].join('\n');

/** Discover CodeBuddy sessions on a remote host (most-recent first). */
export async function listRemoteCodebuddySessions(host: RemoteHost): Promise<DiscoveredSession[]> {
  const scope = `codebuddy:${host.name}`;
  const res = await sshExec(host.ssh, loginShellCommand(BUNDLE_CMD), {
    timeoutMs: 20_000,
    input: `${bundleKnownStdin(scope)}\n`,
  });
  if (res.code !== 0) {
    log.debug(`remote codebuddy discovery failed for ${host.name}: ${res.stderr.trim().slice(0, 120)}`);
    return [];
  }
  const sessions: DiscoveredSession[] = [];
  for (const { fields, body } of parseBundle(res.stdout)) {
    const key = fields[0] ?? '';
    const mtimeRaw = fields[1] ?? '';
    const id = key.replace(/^.*\//, '').replace(/\.jsonl$/, '');
    if (!isClaudeSessionId(id)) continue;
    const updatedAt = bundleMtimeMs(mtimeRaw);
    const cached = body === '' ? cachedBundleSession(scope, key) : undefined;
    let session = cached;
    if (!session) {
      const meta = parseCodebuddyHeadMeta(body.split('\n'));
      if (!meta) {
        noteBundleKey(scope, key, mtimeRaw);
        continue;
      }
      session = {
        claudeSessionId: id,
        cwd: meta.cwd,
        title: meta.title,
        model: meta.model || config.defaultCodebuddyModel,
        createdAt: meta.createdAt || updatedAt,
        updatedAt,
        messageCount: meta.messageCount,
      };
      noteBundleSession(scope, key, mtimeRaw, session);
    }
    sessions.push(session);
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a remote CodeBuddy session's transcript into normalized blocks.
 *  Gzip + base64 over the utf8 stdout channel (same trick as Claude remotes). */
export async function readRemoteCodebuddyTranscript(host: RemoteHost, sessionId: string): Promise<ChatBlock[]> {
  if (!isClaudeSessionId(sessionId)) return [];
  const cmd = `head -c ${MAX_TRANSCRIPT_BYTES} ~/.codebuddy/projects/*/${sessionId}.jsonl 2>/dev/null | gzip -c | base64`;
  const res = await sshExec(host.ssh, loginShellCommand(cmd), { timeoutMs: 90_000 });
  if (res.code !== 0 || !res.stdout.trim()) return [];
  try {
    const raw = zlib.gunzipSync(Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64')).toString('utf8');
    return parseCodebuddyBlocks(raw);
  } catch (err) {
    log.debug(`gunzip codebuddy transcript failed for ${host.name}`, err);
    return [];
  }
}
