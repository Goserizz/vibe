import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express, { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, accountOf } from '../auth.js';
import { accountManager, AccountError } from '../accounts.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import { sessionVisible } from '../sessions/visibility.js';
import { createLocalWorkdir, getRecentProjects, validateDir } from '../projects.js';
import { getClaudeSessionInfo, type DiscoveredSession } from '../sessions/discovery.js';
import { listAllSessions } from '../sessions/list.js';
import { peekSessionListCache } from '../sessions/listCache.js';
import { resolveCursorSessionSync } from '../cursor/discovery.js';
import { invalidateCursorModelsCache, listCursorModels, listRemoteCursorModels } from '../cursor/models.js';
import { resolveCodexSessionSync } from '../codex/discovery.js';
import { invalidateCodexModelsCache, listCodexModels, listRemoteCodexModels } from '../codex/models.js';
import {
  discoverKimiCapabilities,
  discoverRemoteKimiCapabilities,
  invalidateKimiCapabilitiesCache,
} from '../kimi/capabilities.js';
import { resolveKimiSessionSync } from '../kimi/discovery.js';
import { deleteKimiTranscript } from '../kimi/transcript.js';
import { resolveKiroSessionSync } from '../kiro/discovery.js';
import {
  invalidateKiroModelsCache,
  KIRO_PERMISSIONS,
  listKiroModels,
  listRemoteKiroModels,
} from '../kiro/models.js';
import { deleteKiroTranscript } from '../kiro/transcript.js';
import { resolveGrokSessionSync } from '../grok/discovery.js';
import {
  GROK_PERMISSIONS,
  invalidateGrokModelsCache,
  listGrokModels,
  listRemoteGrokModels,
} from '../grok/models.js';
import { deleteGrokTranscript } from '../grok/transcript.js';
import { resolveZcodeSessionSync } from '../zcode/discovery.js';
import {
  ZCODE_PERMISSIONS,
  invalidateZcodeModelsCache,
  listRemoteZcodeModels,
  listZcodeModels,
} from '../zcode/models.js';
import { deleteZcodeTranscript } from '../zcode/transcript.js';
import { prefetchAgentModels } from '../agents/prefetchModels.js';
import { searchConversations } from '../sessions/search.js';
import { hostRegistry, proxyForAgent, HostRegistryError } from '../remote/hosts.js';
import { mcpRegistry } from '../mcp/registry.js';
import { oauthStore } from '../mcp/oauth.js';
import { presetRegistry } from '../presets/registry.js';
import { deleteSkill, listSkills, readSkill, validateSkillName, writeSkill } from '../skills/skills.js';
import { listConfigFiles, readConfigFile, writeConfigFile } from '../agentconfig/registry.js';
import { resolveRemoteSession } from '../remote/discovery.js';
import { sshExec, loginShellCommand, shQuote } from '../remote/ssh.js';
import { createRemoteWorkdir } from '../remote/workdir.js';
import {
  getLatestAgentVersions,
  isAgentKind,
  localProbeAgents,
  localUpdateAgent,
  sshProbeAgents,
  sshUpdateAgent,
} from '../remote/agents.js';
import { parseSessionId } from '../remote/sessionId.js';
import { hub } from '../ws/hub.js';
import { loadVibotConfig, updateVibotConfig, vibotConfigClient } from '../vibot/config.js';
import { vibotHub } from '../vibot/hub.js';
import { memoryStore } from '../vibot/memories.js';
import type {
  AgentKind,
  EffortLevel,
  FileEntry,
  PermissionMode,
  SkillDetail,
  SkillScope,
  ConfigFileDetail,
  ConfigFileEntry,
} from '../../../shared/protocol.js';

const permissionModes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** Cache a remote session's resolution so the WS hub can build a runtime for it. */
async function ensureRemoteCached(sessionId: string): Promise<void> {
  const { host, claudeSessionId } = parseSessionId(sessionId);
  if (!host || sessionStore.get(sessionId)) return;
  const remoteHost = hostRegistry.get(host);
  if (!remoteHost) return;
  const hit = await resolveRemoteSession(remoteHost, claudeSessionId);
  if (hit) {
    hub.cacheRemoteSession(sessionId, {
      host: remoteHost.name,
      sshTarget: remoteHost.ssh,
      cwd: hit.session.cwd,
      model: hit.session.model,
      title: hit.session.title,
      agent: hit.agent,
      proxy: proxyForAgent(remoteHost, hit.agent),
    });
  }
}

const createSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    /** Skip the working-directory picker: Vibe creates a throwaway folder for the session. */
    autoCwd: z.boolean().optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
    effort: z.enum(effortLevels).optional(),
    /** Engine to drive the session; defaults to the server's default agent. */
    agent: z.enum(['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode']).optional(),
    title: z.string().optional(),
    /** Remote host name to create the session on; omit for local. */
    host: z.string().optional(),
  })
  .refine((d) => d.autoCwd || (d.cwd && d.cwd.trim() !== ''), { message: 'cwd or autoCwd is required' });

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  effort: z.enum(effortLevels).optional(),
});

const pinSchema = z.object({ pinned: z.boolean() });

// Per-agent proxy overrides: a sparse map keyed by AgentKind. Zod 4's
// `z.record(enumKeys, value)` would require *every* enum key to be present, so
// model it as a partial object instead (unknown keys are stripped by default).
const proxyByAgentSchema = z
  .object({
    claude: z.string(),
    cursor: z.string(),
    codex: z.string(),
    kimi: z.string(),
    kiro: z.string(),
    grok: z.string(),
    zcode: z.string(),
  })
  .partial();

const hostSchema = z.object({
  name: z.string().min(1).refine((n) => !n.includes('::'), 'name cannot contain "::"'),
  ssh: z.string().min(1),
  proxy: z.string().optional(),
  proxyByAgent: proxyByAgentSchema.optional(),
});

const hostPatchSchema = z.object({
  ssh: z.string().min(1).optional(),
  proxy: z.string().optional(),
  proxyByAgent: proxyByAgentSchema.optional(),
});

// MCP server definition (stdio command, or sse/http URL). Validation of which
// fields apply is finalized server-side in the registry (normalize()).
const mcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: z.enum(['none', 'oauth']).optional(),
});

// Saved New-session engine preset (agent + model + permission + effort).
const presetSchema = z.object({
  name: z.string().min(1),
  agent: z.enum(['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode']),
  model: z.string().min(1),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']),
  effort: z.enum(effortLevels),
});

// Agent skills (personal CRUD + read-only system view) for Claude/Cursor/Codex/
// Kimi/Kiro/Grok. Skill names become directory names under the agent's user skills dir,
// so the charset is locked down here and re-checked server-side (no traversal).
const skillAgentSchema = z.enum(['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode']);
const skillNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'invalid skill name');
const skillSaveSchema = z.object({
  agent: skillAgentSchema,
  name: skillNameSchema,
  description: z.string().min(1),
  whenToUse: z.string().optional(),
  body: z.string(),
  host: z.string().optional(),
});
const skillReadQuery = z.object({
  agent: skillAgentSchema,
  host: z.string().optional(),
  name: z.string().min(1),
  scope: z.enum(['personal', 'system']).optional(),
  source: z.string().optional(),
});

// Agent config files: view/edit each agent's main config (e.g. Claude's
// ~/.claude/settings.json). The id is an opaque key from a server-side
// allowlist (regex here + re-validated in the registry), so no client-supplied
// path is ever interpolated — traversal is impossible regardless of input.
const configIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, 'invalid config id');
const configSaveSchema = z.object({
  agent: skillAgentSchema,
  id: configIdSchema,
  content: z.string(),
  host: z.string().optional(),
});

// -- File browser/editor (local + remote) ------------------------------------

/** Max bytes we're willing to load into the editor. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Max bytes for a raw (e.g. image) download. */
const MAX_RAW_BYTES = 25 * 1024 * 1024;

/** Max bytes for a single uploaded file (chat attachments + FilesPane upload). */
const MAX_UPLOAD_MB = 100;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
/** Raw-body parser limit — set a touch above the cap so the handler's friendly
 *  'file too large' message wins over body-parser's terse 413 for files just
 *  over the limit. Only files larger than this are rejected by the parser. */
const UPLOAD_BODY_LIMIT = (MAX_UPLOAD_MB + 10) * 1024 * 1024;

/** Content-Type for image extensions served by /files/raw. */
const imageMimes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

function mimeForPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return imageMimes[ext] ?? 'application/octet-stream';
}

/** Resolve a local path the user is browsing/editing: expand `~`, make it
 *  absolute. Unlike validateDir this does NOT require the path to exist or be
 *  a directory — callers stat/read/write as needed. */
function resolveLocalPath(input: string): string {
  let p = input.trim();
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/** Resolve an optional host param to an SSH target. Absent/empty ⇒ local. */
function resolveFileTarget(host?: string): { remote: boolean; target: string } {
  if (!host) return { remote: false, target: '' };
  const h = hostRegistry.get(host);
  return { remote: true, target: h?.ssh ?? host };
}

/** Reduce a session id to a filesystem-safe slug for a per-session temp folder. */
function attachmentSlug(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'session';
}

/** Per-session dir on the host running the session where chat attachments land.
 *  Local uses the OS temp dir; remote assumes /tmp (Linux remotes). The agent
 *  runs on this host, so a path here is reachable by its file tools. */
function localAttachmentDir(slug: string): string {
  return path.join(os.tmpdir(), 'vibe', slug);
}
function remoteAttachmentDir(slug: string): string {
  return `/tmp/vibe/${slug}`;
}

/** Write an uploaded chat attachment locally, mkdir -p the session folder. */
function writeLocalAttachment(slug: string, name: string, body: Buffer): string {
  const dir = localAttachmentDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, body);
  return dest;
}

/** Write an uploaded chat attachment on a remote host over SSH. mkdir -p the
 *  folder, then pipe a base64 of the bytes through `base64 -d > file` (sshExec's
 *  stdin is text-only, like /files/upload). */
async function writeRemoteAttachment(target: string, slug: string, name: string, body: Buffer): Promise<string> {
  const dir = remoteAttachmentDir(slug);
  const dest = `${dir}/${name}`;
  const mk = await sshExec(target, loginShellCommand(`mkdir -p ${shQuote(dir)}`), { timeoutMs: 10_000 });
  if (mk.timedOut) throw new HttpError(504, 'write timed out');
  if (mk.code !== 0) throw new HttpError(400, (mk.stderr.trim() || 'mkdir failed').slice(0, 500));
  const r = await sshExec(target, loginShellCommand(`base64 -d > ${shQuote(dest)}`), {
    input: body.toString('base64'),
    timeoutMs: 120_000,
  });
  if (r.timedOut) throw new HttpError(504, 'write timed out');
  if (r.code !== 0) throw new HttpError(400, (r.stderr.trim() || 'write failed').slice(0, 500));
  return dest;
}

/** An error carrying an HTTP status, so shared helpers can signal e.g. 422/504
 *  and the route handler maps it to the right response code. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Read up to MAX_RAW_BYTES of a file into a Buffer — local fs, or remote over
 *  SSH as base64 (sshExec accumulates text stdout, so raw bytes would corrupt).
 *  Shared by /files/raw (inline display) and /files/download (attachment). */
async function readFileBytes(filePath: string, remote: boolean, target: string): Promise<Buffer> {
  if (remote) {
    const sizeRes = await sshExec(target, loginShellCommand(`wc -c < ${shQuote(filePath)}`), { timeoutMs: 10_000 });
    const size = Number((sizeRes.stdout || '').trim());
    if (sizeRes.code === 0 && Number.isFinite(size) && size > MAX_RAW_BYTES) {
      throw new HttpError(422, 'file too large (>25MB)');
    }
    const r = await sshExec(target, loginShellCommand(`base64 < ${shQuote(filePath)}`), { timeoutMs: 30_000 });
    if (r.timedOut) throw new HttpError(504, 'read timed out');
    if (r.code !== 0) throw new HttpError(400, (r.stderr.trim() || 'read failed').slice(0, 500));
    return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
  }
  const resolved = resolveLocalPath(filePath);
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_RAW_BYTES) throw new HttpError(422, 'file too large (>25MB)');
  return fs.readFileSync(resolved);
}

/** `Content-Disposition: attachment` with an ASCII fallback plus a UTF-8
 *  filename* so non-ASCII names download with the right name everywhere. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Split a path being typed in the "Working directory" field into the directory
 * to list (`stem`) and the prefix to match (`prefix`). `stem` keeps its literal
 * form (including a leading `~`) so the chosen entry can be filled back verbatim
 * — important for remote hosts, where the server can't resolve `~` to an
 * absolute path. Examples: `/root/vi`→(`/root`,`vi`), `/root/`→(`/root`,``),
 * `/`→(`/`,``), `~/co`→(`~`,`co`).
 */
function splitCompletionInput(input: string): { stem: string; prefix: string } {
  const lastSlash = input.lastIndexOf('/');
  if (lastSlash < 0) return { stem: '~', prefix: input };
  return { stem: input.slice(0, lastSlash) || '/', prefix: input.slice(lastSlash + 1) };
}

const filesQuerySchema = z.object({
  host: z.string().optional(),
  path: z.string().min(1),
});

const fileWriteSchema = z.object({
  host: z.string().optional(),
  path: z.string().min(1),
  content: z.string(),
});

const filesUploadQuerySchema = z.object({
  host: z.string().optional(),
  dir: z.string().min(1),
  name: z.string().min(1),
});

const completeSchema = z.object({
  path: z.string(),
  host: z.string().optional(),
});

/** Best-effort origin the user's browser reaches this server at (respects the
 *  X-Forwarded-* headers a reverse proxy sets). Used to build OAuth redirect URIs. */
function vibeBaseUrl(req: express.Request): string {
  const protoH = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(protoH) ? protoH[0] : protoH) || (req.protocol === 'https' || req.secure ? 'https' : 'http');
  const hostH = req.headers['x-forwarded-host'];
  const host = (Array.isArray(hostH) ? hostH[0] : hostH) || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

/** Minimal self-closing result page rendered at the end of the OAuth callback. */
function oauthResultPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vibe — ${title}</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;background:#0b0f17;color:#cbd5e1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;max-width:380px;padding:24px}</style></head>
<body><div class="box"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#94a3b8">${message}</p>
<p><a href="/" style="color:#6ee7b7">Open Vibe</a></p></div>
<script>try{setTimeout(()=>window.close(),1500);}catch(e){}</script></body></html>`;
}

/** Reject a ?host= request when the acting account can't use that host. An
 *  empty host means the local machine, which is admin-only. Returns true when
 *  the response was sent (caller should return). */
function hostForbidden(res: express.Response, account: string, host?: string): boolean {
  if (hostRegistry.visibleTo(account, host?.trim() || 'local')) return false;
  res.status(403).json({
    error: host?.trim() ? 'this host is not available for your account' : 'the local machine is admin-only',
  });
  return true;
}

/** Reject a session-scoped request the account can't see. Returns true when
 *  the response was sent. Uses 404 (not 403) so session existence isn't leaked. */
function sessionForbidden(res: express.Response, account: string, sessionId: string): boolean {
  if (sessionVisible(account, sessionId)) return false;
  res.status(404).json({ error: 'not found' });
  return true;
}

export function createApiRouter(): Router {
  const router = Router();

  // The OAuth callback is hit by the user's browser as a top-level redirect from
  // the MCP provider — it carries no Authorization header — so it MUST sit before
  // requireAuth. CSRF is bounded by the random `state` we issued at /start.
  router.get('/mcp/oauth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
    const fail = (msg: string) =>
      res
        .type('html')
        .status(400)
        .send(
          oauthResultPage('Could not connect', msg),
        );
    if (error) return fail(`${error}${error_description ? `: ${error_description}` : ''}`);
    if (!code || !state) return fail('missing code/state in callback');
    try {
      const name = await oauthStore.handleCallback(state, code);
      res.type('html').send(oauthResultPage('Connected', `MCP server “${name}” is connected. You can close this tab and return to Vibe.`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'token exchange failed');
    }
  });

  // Password login — must sit before requireAuth (the caller has no token yet).
  // Rate-limited inside the account manager (5 failures ⇒ 60s lock per name).
  router.post('/auth/login', (req, res) => {
    const parsed = z.object({ name: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    try {
      const ref = accountManager.verifyLogin(parsed.data.name, parsed.data.password);
      res.json({ token: accountManager.tokenFor(ref.name), account: ref.name, isAdmin: ref.isAdmin });
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'login failed' });
    }
  });

  router.use(requireAuth);

  // -- Accounts (admin only) --------------------------------------------------

  router.get('/accounts', requireAdmin, (_req, res) => {
    res.json({ accounts: accountManager.list() });
  });

  router.post('/accounts', requireAdmin, (req, res) => {
    const parsed = z
      .object({ name: z.string().min(1), password: z.string().min(6) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
      return;
    }
    try {
      res.json(accountManager.create(parsed.data.name, parsed.data.password));
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'create failed' });
    }
  });

  router.delete('/accounts/:name', requireAdmin, (req, res) => {
    try {
      const name = String(req.params.name);
      accountManager.remove(name);
      // Accounts are peers — nobody inherits the deleted account's hosts, so
      // they (and their sessions) go away with it.
      const removed = hostRegistry.removeOwnedBy(name);
      res.json({ ok: true, hostsRemoved: removed });
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'delete failed' });
    }
  });

  router.post('/accounts/:name/token', requireAdmin, (req, res) => {
    try {
      res.json(accountManager.resetToken(String(req.params.name)));
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'reset failed' });
    }
  });

  router.put('/accounts/:name/password', requireAdmin, (req, res) => {
    const parsed = z.object({ password: z.string().min(6) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid body' });
      return;
    }
    try {
      accountManager.setPassword(String(req.params.name), parsed.data.password);
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'update failed' });
    }
  });

  router.get('/me', (req, res) => {
    const account = accountOf(req);
    res.json({
      ok: true,
      serverVersion: config.serverVersion,
      defaultModel: config.defaultModel,
      account: account.name,
      isAdmin: account.isAdmin,
    });
  });

  // Recent local working directories — local machine info, admin-only.
  router.get('/projects', requireAdmin, (_req, res) => {
    res.json({ projects: getRecentProjects() });
  });

  // The Cursor CLI enumerates every model variant (effort/thinking/fast); list
  // them dynamically so the picker always matches the installed CLI. Optional
  // `?host=` runs the listing on that remote (with its proxy) so region-gated
  // models match what a turn on that host can actually use.
  router.get('/cursor/models', async (req, res) => {
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const models = host ? await listRemoteCursorModels(host) : await listCursorModels();
    res.json({ models });
  });

  // Codex has no `models` subcommand; its cached model list (~/.codex/models_cache.json)
  // is read directly so the picker matches the installed CLI. Optional `?host=` reads
  // the cache on that remote host (with its proxy) so models match what a turn there
  // can actually use — same rationale as Cursor above.
  router.get('/codex/models', async (req, res) => {
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const models = host ? await listRemoteCodexModels(host) : listCodexModels();
    res.json({ models });
  });

  // Kimi exposes configured model aliases as JSON. Permission modes are gated
  // by flags/ACP support advertised by that exact local or remote CLI build.
  router.get('/kimi/capabilities', async (req, res) => {
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const capabilities = host ? await discoverRemoteKimiCapabilities(host) : await discoverKimiCapabilities();
    res.json(capabilities);
  });

  // Kiro CLI lists models as JSON; permission modes are fixed (spawn trust flags + planner mode).
  router.get('/kiro/models', async (req, res) => {
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const models = host ? await listRemoteKiroModels(host) : await listKiroModels();
    res.json({ models, permissions: KIRO_PERMISSIONS });
  });

  // Grok Build lists models via `grok models`; permission modes are fixed (Ask / Plan / Auto / Always-approve).
  router.get('/grok/models', async (req, res) => {
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const models = host ? await listRemoteGrokModels(host) : await listGrokModels();
    res.json({ models, permissions: GROK_PERMISSIONS });
  });

  // ZCode models come from ~/.zcode/cli/config.json (no CLI spawn needed);
  // permission modes are fixed (Ask / Plan / Edit / Yolo).
  router.get('/zcode/models', async (req, res) => {
    const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const models = host ? await listRemoteZcodeModels(host) : await listZcodeModels();
    res.json({ models, permissions: ZCODE_PERMISSIONS });
  });

  router.post('/projects/validate', requireAdmin, (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json(validateDir(path));
  });

  // Live directory completion for the "Working directory" field. Lists the
  // directory named by the input's stem and returns sub-directories whose name
  // starts with the trailing prefix. Local uses readdir; remote shells out over
  // SSH (same `ls -1Ap` as /files). Unreadable/missing dirs ⇒ empty entries.
  router.post('/projects/complete', async (req, res) => {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    const { remote, target } = resolveFileTarget(parsed.data.host);
    const { stem, prefix } = splitCompletionInput(parsed.data.path);
    const pfx = prefix.toLowerCase();
    const keep = (name: string, dir: boolean) => dir && (!pfx || name.toLowerCase().startsWith(pfx));
    const matches: { name: string; full: string; dir: boolean }[] = [];
    try {
      if (remote) {
        const r = await sshExec(target, loginShellCommand(`ls -1Ap ${shQuote(stem)}`), { timeoutMs: 8_000 });
        if (r.timedOut) {
          res.status(504).json({ error: 'list timed out' });
          return;
        }
        if (r.code === 0) {
          const stemNorm = stem === '/' ? '/' : stem.replace(/\/+$/, '');
          for (const line of r.stdout.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            const dir = t.endsWith('/'); // `-p` appends `/` only to directories
            const name = dir ? t.slice(0, -1) : t;
            if (!keep(name, dir)) continue;
            const full = stemNorm.endsWith('/') ? `${stemNorm}${name}` : `${stemNorm}/${name}`;
            matches.push({ name, full, dir });
          }
        }
      } else {
        const resolved = resolveLocalPath(stem);
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(resolved);
        } catch {
          /* not found — no suggestions */
        }
        if (stat?.isDirectory()) {
          for (const e of fs.readdirSync(resolved, { withFileTypes: true })) {
            const dir = e.isDirectory();
            if (!keep(e.name, dir)) continue;
            matches.push({ name: e.name, full: path.join(resolved, e.name), dir });
          }
        }
      }
      matches.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: stem, entries: matches.slice(0, 50) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'complete failed' });
    }
  });

  // -- Files: list / read / write (local + remote over SSH) ------------------

  router.get('/files', async (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    const dirPath = parsed.data.path;
    const { remote, target } = resolveFileTarget(parsed.data.host);
    try {
      let entries: FileEntry[];
      let resolved = dirPath;
      if (remote) {
        // `ls -1Ap`: one per line, append `/` to directories, almost-all.
        const r = await sshExec(target, loginShellCommand(`ls -1Ap ${shQuote(dirPath)}`), { timeoutMs: 15_000 });
        if (r.timedOut) {
          res.status(504).json({ error: 'list timed out' });
          return;
        }
        if (r.code !== 0) {
          res.status(400).json({ error: (r.stderr.trim() || r.stdout.trim() || 'list failed').slice(0, 500) });
          return;
        }
        entries = r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((name): FileEntry => {
            const dir = name.endsWith('/');
            return { name: dir ? name.slice(0, -1) : name, dir };
          });
      } else {
        resolved = resolveLocalPath(dirPath);
        const ents = fs.readdirSync(resolved, { withFileTypes: true });
        entries = ents.map((e): FileEntry => {
          const entry: FileEntry = { name: e.name, dir: e.isDirectory() };
          try {
            entry.size = fs.statSync(path.join(resolved, e.name)).size;
          } catch {
            /* broken symlink etc. — skip size */
          }
          return entry;
        });
      }
      res.json({ path: resolved, entries });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'list failed' });
    }
  });

  router.get('/files/read', async (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    const filePath = parsed.data.path;
    const { remote, target } = resolveFileTarget(parsed.data.host);
    try {
      let content: string;
      if (remote) {
        // Refuse huge files before slurping them over SSH.
        const sizeRes = await sshExec(target, loginShellCommand(`wc -c < ${shQuote(filePath)}`), { timeoutMs: 10_000 });
        const size = Number((sizeRes.stdout || '').trim());
        if (sizeRes.code === 0 && Number.isFinite(size) && size > MAX_FILE_BYTES) {
          res.status(422).json({ error: 'file too large to edit (>2MB)' });
          return;
        }
        const r = await sshExec(target, loginShellCommand(`cat ${shQuote(filePath)}`), { timeoutMs: 20_000 });
        if (r.timedOut) {
          res.status(504).json({ error: 'read timed out' });
          return;
        }
        if (r.code !== 0) {
          res.status(400).json({ error: (r.stderr.trim() || 'read failed').slice(0, 500) });
          return;
        }
        content = r.stdout;
      } else {
        const resolved = resolveLocalPath(filePath);
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_FILE_BYTES) {
          res.status(422).json({ error: 'file too large to edit (>2MB)' });
          return;
        }
        content = fs.readFileSync(resolved, 'utf8');
      }
      // Reject binary (NUL bytes survive utf8 decode).
      if (content.includes('\0')) {
        res.status(422).json({ error: 'binary file (not editable)' });
        return;
      }
      res.json({ path: filePath, content });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'read failed' });
    }
  });

  // Raw bytes (e.g. an image) for <img> display. The token may arrive via
  // ?token= so the URL works directly in an <img src>. Remote binary is
  // transported as base64 because sshExec accumulates stdout as utf8 text,
  // which would corrupt raw bytes.
  router.get('/files/raw', async (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    const filePath = parsed.data.path;
    const { remote, target } = resolveFileTarget(parsed.data.host);
    try {
      const buf = await readFileBytes(filePath, remote, target);
      res.set('Content-Type', mimeForPath(filePath));
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'read failed' });
    }
  });

  // Download a file as an attachment (forces Save As in the browser). Same
  // bytes as /files/raw via readFileBytes, but with Content-Disposition:
  // attachment + the file's name. The token in ?token= lets an <a href> click
  // download without a custom auth header.
  router.get('/files/download', async (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    const filePath = parsed.data.path;
    const { remote, target } = resolveFileTarget(parsed.data.host);
    try {
      const buf = await readFileBytes(filePath, remote, target);
      res.set('Content-Type', mimeForPath(filePath));
      res.set('Content-Disposition', attachmentDisposition(path.basename(filePath)));
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'download failed' });
    }
  });

  router.put('/files', async (req, res) => {
    const parsed = fileWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    const { path: filePath, content, host } = parsed.data;
    if (content.includes('\0')) {
      res.status(422).json({ error: 'cannot write binary content' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, host)) return;
    const { remote, target } = resolveFileTarget(host);
    try {
      if (remote) {
        // `cat > file` writes piped stdin verbatim — the content never goes
        // through shell quoting. Truncates + replaces, like an editor Save.
        const r = await sshExec(target, loginShellCommand(`cat > ${shQuote(filePath)}`), { input: content, timeoutMs: 30_000 });
        if (r.timedOut) {
          res.status(504).json({ error: 'write timed out' });
          return;
        }
        if (r.code !== 0) {
          res.status(400).json({ error: (r.stderr.trim() || 'write failed').slice(0, 500) });
          return;
        }
      } else {
        fs.writeFileSync(resolveLocalPath(filePath), content, 'utf8');
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'write failed' });
    }
  });

  // Upload a file into the listed directory. The request body is the file's raw
  // bytes (Content-Type: application/octet-stream), parsed by a route-local
  // express.raw() — the global express.json() only handles JSON, so it leaves
  // this body untouched. `dir` + `name` come via the query; `name` is reduced to
  // its basename so a crafted name can't escape `dir`. Remote writes pipe a
  // base64 of the buffer through `base64 -d > file` (sshExec's stdin is
  // text-only — the mirror of how /files/raw ships remote binary back).
  router.post(
    '/files/upload',
    express.raw({ type: () => true, limit: UPLOAD_BODY_LIMIT }),
    async (req, res) => {
      const parsed = filesUploadQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid query' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'empty file' });
        return;
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `file too large (limit ${MAX_UPLOAD_MB}MB)` });
        return;
      }
      const { dir, host } = parsed.data;
      if (hostForbidden(res, accountOf(req).name, host)) return;
      const name = path.basename(parsed.data.name) || 'upload';
      const dest = path.posix.join(dir, name);
      const { remote, target } = resolveFileTarget(host);
      try {
        if (remote) {
          const r = await sshExec(target, loginShellCommand(`base64 -d > ${shQuote(dest)}`), {
            input: body.toString('base64'),
            timeoutMs: 60_000,
          });
          if (r.timedOut) {
            res.status(504).json({ error: 'write timed out' });
            return;
          }
          if (r.code !== 0) {
            res.status(400).json({ error: (r.stderr.trim() || 'write failed').slice(0, 500) });
            return;
          }
        } else {
          fs.writeFileSync(resolveLocalPath(dest), body);
        }
        res.json({ ok: true, path: dest });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'write failed' });
      }
    },
  );

  // Attach a file to a chat message. The raw bytes are the body (route-local
  // express.raw, like /files/upload); `name` is reduced to its basename. The
  // file lands in a per-session temp dir on the session's host (resolved via
  // hub.locate, so it works for local and SSH-remote sessions alike) and the
  // absolute path is returned for the client to fold into the prompt text.
  router.post(
    '/sessions/:id/attachments',
    express.raw({ type: () => true, limit: UPLOAD_BODY_LIMIT }),
    async (req, res) => {
      const id = req.params.id;
      if (sessionForbidden(res, accountOf(req).name, id)) return;
      const rawName = typeof req.query.name === 'string' ? req.query.name : '';
      const name = path.basename(rawName) || 'upload';
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'empty file' });
        return;
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `file too large (limit ${MAX_UPLOAD_MB}MB)` });
        return;
      }
      const loc = hub.locate(id);
      if (!loc) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      const slug = attachmentSlug(id);
      try {
        const dest = loc.sshTarget
          ? await writeRemoteAttachment(loc.sshTarget, slug, name, body)
          : writeLocalAttachment(slug, name, body);
        res.json({ ok: true, path: dest });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400;
        res.status(status).json({ error: err instanceof Error ? err.message : 'write failed' });
      }
    },
  );

  // -- Remote hosts ---------------------------------------------------------

  router.get('/hosts', (req, res) => {
    res.json({ hosts: hostRegistry.listFor(accountOf(req).name), localName: config.localName });
  });

  router.post('/hosts', (req, res) => {
    const parsed = hostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid host' });
      return;
    }
    try {
      const host = hostRegistry.add(parsed.data, accountOf(req).name);
      // Warm remote model caches so the new-session picker never waits on SSH.
      prefetchAgentModels([host.name]);
      res.json({ host });
    } catch (err) {
      const status = err instanceof HostRegistryError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'invalid host' });
    }
  });

  // Patch an existing host's ssh target and/or proxy (e.g. set/clear the proxy
  // a remote agent routes its API traffic through).
  router.patch('/hosts/:name', (req, res) => {
    const parsed = hostPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid host' });
      return;
    }
    let updated;
    try {
      updated = hostRegistry.update(req.params.name, parsed.data, accountOf(req).name);
    } catch (err) {
      const status = err instanceof HostRegistryError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'invalid host' });
      return;
    }
    if (!updated) {
      res.status(404).json({ error: 'unknown host' });
      return;
    }
    // Any proxy change (default or a per-agent override) can move which models a
    // host advertises (Cursor/Kiro) or caches (Codex), and which aliases Kimi sees —
    // so drop discovery caches and let the next request re-fetch.
    const proxyChanged = parsed.data.proxy !== undefined || parsed.data.proxyByAgent !== undefined;
    // SSH/proxy changes can point discovery at a different CLI/config.
    if (parsed.data.ssh !== undefined || proxyChanged) {
      invalidateKimiCapabilitiesCache(updated.name);
      invalidateKiroModelsCache(updated.name);
    }
    if (proxyChanged) {
      invalidateCursorModelsCache(updated.name);
      invalidateCodexModelsCache(updated.name);
      invalidateGrokModelsCache(updated.name);
    }
    if (parsed.data.ssh !== undefined || proxyChanged) {
      prefetchAgentModels([updated.name]);
    }
    res.json({ host: updated });
  });

  router.delete('/hosts/:name', (req, res) => {
    try {
      const ok = hostRegistry.remove(req.params.name, accountOf(req).name);
      if (!ok) {
        res.status(404).json({ error: 'unknown host' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof HostRegistryError ? err.status : 400;
      res.status(status).json({ error: err instanceof Error ? err.message : 'invalid host' });
    }
  });

  // -- MCP servers (global registry + per-scope enable) --------------------

  // The MCP server registry is the shared toolbox — every account can read it
  // and toggle per-scope enablement for scopes it owns, but only admin edits
  // definitions (env vars may carry secrets) and manages OAuth connections.
  router.get('/mcp', (_req, res) => {
    res.json(mcpRegistry.snapshot());
  });

  // Insert or update a server definition in the global registry.
  router.post('/mcp/servers', requireAdmin, (req, res) => {
    const parsed = mcpServerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid server' });
      return;
    }
    const server = mcpRegistry.upsert(parsed.data);
    if (!server) {
      res.status(400).json({ error: 'invalid server definition (stdio needs command; sse/http needs url)' });
      return;
    }
    res.json({ server });
  });

  router.delete('/mcp/servers/:name', requireAdmin, (req, res) => {
    mcpRegistry.remove(String(req.params.name));
    res.json({ ok: true });
  });

  // Set which server names are enabled for a scope ('local' or a host name).
  router.put('/mcp/enabled/:scope', (req, res) => {
    const parsed = z.object({ names: z.array(z.string()) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid enable list' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, req.params.scope)) return;
    mcpRegistry.setEnabled(req.params.scope, parsed.data.names);
    res.json({ enabled: mcpRegistry.enabledFor(req.params.scope) });
  });

  // -- Saved New-session presets (agent + model + permission + effort) --------

  router.get('/presets', (_req, res) => {
    res.json({ presets: presetRegistry.list() });
  });

  router.post('/presets', (req, res) => {
    const parsed = presetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid preset' });
      return;
    }
    const preset = presetRegistry.upsert(parsed.data);
    if (!preset) {
      res.status(400).json({ error: 'invalid preset definition' });
      return;
    }
    res.json({ preset });
  });

  router.delete('/presets/:name', (req, res) => {
    presetRegistry.remove(req.params.name);
    res.json({ ok: true });
  });

  // -- Agent skills (personal CRUD + read-only system view) -----------------

  // List personal + system skills for an agent on this machine or a remote host.
  // Lightweight rows only; descriptions/bodies load via /skills/read on open.
  router.get('/skills', async (req, res) => {
    const parsed = z.object({ agent: skillAgentSchema, host: z.string().optional() }).safeParse({
      agent: req.query.agent,
      host: req.query.host,
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      res.json({ skills: await listSkills({ agent: parsed.data.agent, host: parsed.data.host }) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'list failed' });
    }
  });

  // Read one skill's full content (frontmatter + body). System skills are read-only.
  router.get('/skills/read', async (req, res) => {
    const parsed = skillReadQuery.safeParse({
      agent: req.query.agent,
      host: req.query.host,
      name: req.query.name,
      scope: req.query.scope,
      source: req.query.source,
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      const skill = await readSkill({
        agent: parsed.data.agent,
        host: parsed.data.host,
        name: parsed.data.name,
        scope: parsed.data.scope as SkillScope | undefined,
        source: parsed.data.source,
      });
      res.json({ skill });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'read failed';
      res.status(/not found/i.test(msg) ? 404 : /timed out/i.test(msg) ? 504 : 400).json({ error: msg });
    }
  });

  // Create or update a personal skill (writes <agent user dir>/skills/<name>/SKILL.md).
  router.post('/skills', async (req, res) => {
    const parsed = skillSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid skill' });
      return;
    }
    if (!validateSkillName(parsed.data.name)) {
      res.status(400).json({ error: 'invalid skill name' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      const skill: SkillDetail = await writeSkill(parsed.data);
      res.json({ skill });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'save failed';
      res.status(/timed out/i.test(msg) ? 504 : 400).json({ error: msg });
    }
  });

  // Delete a personal skill directory. System skills are read-only — a crafted
  // system name can't match a personal dir, so this only ever removes personal.
  router.delete('/skills', async (req, res) => {
    const parsed = z.object({ agent: skillAgentSchema, host: z.string().optional(), name: skillNameSchema }).safeParse({
      agent: req.query.agent,
      host: req.query.host,
      name: req.query.name,
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid skill' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      await deleteSkill({ agent: parsed.data.agent, host: parsed.data.host, name: parsed.data.name });
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'delete failed';
      res.status(/timed out/i.test(msg) ? 504 : 400).json({ error: msg });
    }
  });

  // -- Agent config files (raw-text view/edit, local + remote) ----------------
  // Only the fixed per-agent allowlist is reachable; the client sends an opaque
  // `id`, never a path. Configs are JSON or TOML and are stored verbatim.

  // List an agent's config files with exists/size (this machine or a remote host).
  router.get('/agent-config', async (req, res) => {
    const parsed = z.object({ agent: skillAgentSchema, host: z.string().optional() }).safeParse({
      agent: req.query.agent,
      host: req.query.host,
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      const files: ConfigFileEntry[] = await listConfigFiles({ agent: parsed.data.agent, host: parsed.data.host });
      res.json({ files });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'list failed' });
    }
  });

  // Read one config file's raw content. Missing file ⇒ content:'', exists:false.
  router.get('/agent-config/read', async (req, res) => {
    const parsed = z
      .object({ agent: skillAgentSchema, host: z.string().optional(), id: configIdSchema })
      .safeParse({ agent: req.query.agent, host: req.query.host, id: req.query.id });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid query' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      const file: ConfigFileDetail = await readConfigFile({ agent: parsed.data.agent, host: parsed.data.host, id: parsed.data.id });
      res.json({ file });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'read failed';
      res.status(/timed out/i.test(msg) ? 504 : /too large/i.test(msg) ? 413 : 400).json({ error: msg });
    }
  });

  // Create or overwrite a config file (mkdir -p parent first).
  router.post('/agent-config', async (req, res) => {
    const parsed = configSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid config' });
      return;
    }
    if (hostForbidden(res, accountOf(req).name, parsed.data.host)) return;
    try {
      const file: ConfigFileDetail = await writeConfigFile(parsed.data);
      res.json({ file });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'save failed';
      res.status(/timed out/i.test(msg) ? 504 : /too large/i.test(msg) ? 413 : 400).json({ error: msg });
    }
  });

  // Begin the MCP-OAuth flow for a server: discover + register, return the
  // provider consent URL for the client to open in the user's browser.
  router.post('/mcp/oauth/start', requireAdmin, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const def = mcpRegistry.get(name);
    if (!def || def.transport === 'stdio' || def.auth !== 'oauth' || !def.url) {
      res.status(400).json({ error: 'not an OAuth remote MCP server' });
      return;
    }
    const redirectUri = `${vibeBaseUrl(req)}/api/mcp/oauth/callback`;
    try {
      const authUrl = await oauthStore.startAuth(name, def.url, redirectUri);
      res.json({ authUrl });
    } catch (err) {
      log.warn('mcp oauth start failed', err);
      res.status(502).json({ error: err instanceof Error ? err.message : 'OAuth discovery failed' });
    }
  });

  // Drop stored tokens for an OAuth server (best-effort revocation).
  router.post('/mcp/oauth/disconnect/:name', requireAdmin, async (req, res) => {
    await oauthStore.disconnect(String(req.params.name));
    res.json({ ok: true, oauth: oauthStore.snapshotStatus() });
  });

  // Reachability + per-agent install/version probe for a host (by name or raw ssh target).
  // `local` / the configured localName probes this machine without SSH —
  // admin-only, like every other use of the local machine.
  router.get('/hosts/:name/check', async (req, res) => {
    const name = req.params.name;
    if (hostForbidden(res, accountOf(req).name, name)) return;
    if (name === 'local' || name === config.localName) {
      const result = await localProbeAgents();
      res.json({ name: config.localName, ssh: 'local', ...result });
      return;
    }
    const host = hostRegistry.get(name);
    const target = host?.ssh ?? name;
    const result = await sshProbeAgents(target);
    res.json({ name, ssh: target, ...result });
  });

  // Latest published versions for all supported agents (cached server-side).
  router.get('/agents/latest', async (_req, res) => {
    const versions = await getLatestAgentVersions();
    res.json({ versions });
  });

  // Install or upgrade an agent CLI on a host (local machine or remote over SSH).
  router.post('/hosts/:name/agents/:agent/update', async (req, res) => {
    const agentParam = req.params.agent;
    if (!isAgentKind(agentParam)) {
      res.status(400).json({ error: 'agent must be claude, cursor, codex, kimi, kiro, grok, or zcode' });
      return;
    }
    const name = req.params.name;
    if (hostForbidden(res, accountOf(req).name, name)) return;
    const isLocal = name === 'local' || name === config.localName;
    if (!isLocal && !hostRegistry.get(name)) {
      res.status(404).json({ error: 'unknown host' });
      return;
    }
    try {
      const result = isLocal
        ? await localUpdateAgent(agentParam)
        : await sshUpdateAgent(hostRegistry.get(name)!.ssh, agentParam);
      if (!result.ok) {
        res.status(502).json(result);
        return;
      }
      if (agentParam === 'kimi') invalidateKimiCapabilitiesCache(isLocal ? undefined : name);
      if (agentParam === 'kiro') invalidateKiroModelsCache(isLocal ? undefined : name);
      if (agentParam === 'grok') invalidateGrokModelsCache(isLocal ? undefined : name);
      if (agentParam === 'zcode') invalidateZcodeModelsCache(isLocal ? undefined : name);
      // Re-warm in the background; the update response itself stays snappy.
      prefetchAgentModels(isLocal ? [] : [name]);
      res.json(result);
    } catch (err) {
      log.warn('agent update failed', err);
      res.status(500).json({
        ok: false,
        agent: agentParam,
        error: err instanceof Error ? err.message : 'update failed',
      });
    }
  });

  // Unified list: local Vibe-managed + local CLI-discovered + every remote
  // host's sessions, deduped and tagged with their host — filtered down to the
  // hosts and sessions the acting account may see.
  router.get('/sessions', async (req, res) => {
    res.json({ sessions: await listAllSessions(accountOf(req).name) });
  });

  router.post('/sessions', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.issues });
      return;
    }
    const account = accountOf(req).name;
    const { host } = parsed.data;
    // autoCwd only applies when the caller didn't also hand us an explicit path.
    const wantAuto = !!parsed.data.autoCwd && !parsed.data.cwd?.trim();
    let cwd = parsed.data.cwd?.trim() ?? '';
    if (host) {
      // Remote: trust the path (validated lazily when the turn runs over SSH).
      if (hostForbidden(res, account, host)) return;
      const remoteHost = hostRegistry.get(host);
      if (!remoteHost) {
        res.status(400).json({ error: 'unknown host' });
        return;
      }
      if (wantAuto) {
        try {
          cwd = await createRemoteWorkdir(remoteHost.ssh);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'remote workdir create failed';
          res.status(msg.includes('timed out') ? 504 : 502).json({ error: msg });
          return;
        }
      }
    } else {
      // No host = the local machine, which is admin-only.
      if (hostForbidden(res, account)) return;
      if (wantAuto) {
        cwd = createLocalWorkdir();
      } else {
        const check = validateDir(cwd);
        if (!check.ok) {
          res.status(400).json({ error: check.error || 'invalid cwd' });
          return;
        }
        cwd = check.path;
      }
    }
    const agent: AgentKind = parsed.data.agent ?? config.defaultAgent;
    const session = sessionStore.create({
      cwd,
      model:
        parsed.data.model
        || (agent === 'cursor'
          ? config.defaultCursorModel
          : agent === 'codex'
            ? config.defaultCodexModel
            : agent === 'kimi'
              ? config.defaultKimiModel
              : agent === 'kiro'
                ? config.defaultKiroModel
                : agent === 'grok'
                  ? config.defaultGrokModel
                  : agent === 'zcode'
                    ? config.defaultZcodeModel
                    : config.defaultModel),
      permissionMode: (parsed.data.permissionMode as PermissionMode) || 'default',
      effort: (parsed.data.effort as EffortLevel) || (config.defaultEffort as EffortLevel),
      agent,
      title: parsed.data.title,
      host,
      // Local New-Session rows are private to their creator; remote rows follow
      // the host's owner (the field is bookkeeping there).
      owner: account,
      ephemeral: wantAuto || undefined,
    });
    const meta = toMeta(session, false, 'vibe');
    hub.broadcastMeta(session.id);
    res.json({ session: meta });
  });

  router.get('/sessions/:id', (req, res) => {
    if (sessionForbidden(res, accountOf(req).name, req.params.id)) return;
    const stored = sessionStore.get(req.params.id);
    if (!stored) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({
      session: toMeta(stored, hub.isRunning(stored.id), 'vibe', hub.hasActiveBackgroundTasks(stored.id)),
    });
  });

  router.patch('/sessions/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    const id = req.params.id;
    if (sessionForbidden(res, accountOf(req).name, id)) return;
    // Editing a discovered CLI session (local or remote) adopts it so the change persists.
    if (!sessionStore.get(id)) {
      const { host, claudeSessionId } = parseSessionId(id);
      const remoteHost = host ? hostRegistry.get(host) : undefined;
      let agent: AgentKind = 'claude';
      let info: DiscoveredSession | null = null;
      if (remoteHost) {
        // Remote: any agent's native session on that host.
        const hit = await resolveRemoteSession(remoteHost, claudeSessionId);
        if (hit) {
          info = hit.session;
          agent = hit.agent;
        }
      } else {
        info = await getClaudeSessionInfo(id);
      }
      // Not a Claude session — maybe another local agent's native session.
      if (!info && !host) {
        const c = resolveCursorSessionSync(id);
        if (c) {
          info = c;
          agent = 'cursor';
        } else {
          const x = resolveCodexSessionSync(id);
          if (x) {
            info = x;
            agent = 'codex';
          } else {
            const k = resolveKimiSessionSync(id);
            if (k) {
              info = k;
              agent = 'kimi';
            } else {
              const r = resolveKiroSessionSync(id);
              if (r) {
                info = r;
                agent = 'kiro';
              } else {
                const g = resolveGrokSessionSync(id);
                if (g) {
                  info = g;
                  agent = 'grok';
                } else {
                  const z = resolveZcodeSessionSync(id);
                  if (z) {
                    info = z;
                    agent = 'zcode';
                  }
                }
              }
            }
          }
        }
      }
      if (!info) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      sessionStore.adopt({
        id,
        claudeSessionId,
        cwd: info.cwd,
        title: info.title,
        model: info.model,
        permissionMode: 'default',
        agent,
        createdAt: info.createdAt,
        messageCount: info.messageCount,
        host,
      });
    }
    const updated = sessionStore.update(id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    hub.broadcastMeta(updated.id);
    res.json({
      session: toMeta(updated, hub.isRunning(updated.id), 'vibe', hub.hasActiveBackgroundTasks(updated.id)),
    });
  });

  // Favorite/pin toggle. A standalone id set (like `hidden`) so it works for
  // discovered sessions too without adopting them. The store patches the list
  // cache; we broadcast the cached meta so other tabs stay in sync.
  router.put('/sessions/:id/pin', (req, res) => {
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    const id = req.params.id;
    if (sessionForbidden(res, accountOf(req).name, id)) return;
    if (parsed.data.pinned) sessionStore.pin(id);
    else sessionStore.unpin(id);
    const meta = peekSessionListCache()?.find((s) => s.id === id);
    if (meta) hub.broadcastMetaObject(meta);
    res.json({ ok: true, pinned: parsed.data.pinned });
  });

  // Delete = stop tracking in Vibe. We never delete the underlying ~/.claude
  // transcript; instead we dismiss it (so discovery won't resurface it).
  router.delete('/sessions/:id', (req, res) => {
    const id = req.params.id;
    if (sessionForbidden(res, accountOf(req).name, id)) return;
    const stored = sessionStore.get(id);
    sessionStore.remove(id);
    if (stored?.agent === 'kimi') deleteKimiTranscript(id);
    if (stored?.agent === 'kiro') deleteKiroTranscript(id);
    if (stored?.agent === 'grok') deleteGrokTranscript(id);
    if (stored?.agent === 'zcode') deleteZcodeTranscript(id);
    // Dismiss every form discovery might resurface it under (the list id and,
    // for local sessions, the bare Claude id).
    sessionStore.hide(id);
    if (stored?.claudeSessionId) sessionStore.hide(stored.claudeSessionId);
    hub.broadcastRemoved(id);
    res.json({ ok: true });
  });

  // Conversation history + the seq to subscribe from (see Hub.snapshot).
  // Works for local Vibe-managed, local CLI, and remote sessions.
  router.get('/sessions/:id/messages', async (req, res) => {
    if (sessionForbidden(res, accountOf(req).name, req.params.id)) return;
    await ensureRemoteCached(req.params.id);
    res.json(await hub.snapshot(req.params.id));
  });

  // Full-text search across local + remote conversation messages.
  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;
    res.json({ results: await searchConversations(q, limit, accountOf(req).name) });
  });

  // Surface available permission modes for the UI.
  router.get('/meta/permission-modes', (_req, res) => {
    res.json({ permissionModes });
  });

  // -- Vibot (the separate assistant interface) -----------------------------
  // Its own config (LLM API + system prompt), conversations, and memories.
  // The API key is masked on read; an empty apiKey on write keeps the stored one.
  // Admin-only: Vibot's tools can drive any host's sessions, so it stays with
  // the superuser account.
  router.use('/vibot', requireAdmin);

  router.get('/vibot/config', (_req, res) => {
    res.json({ config: vibotConfigClient(loadVibotConfig()) });
  });

  router.put('/vibot/config', (req, res) => {
    const parsed = z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional(),
        systemPrompt: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid config' });
      return;
    }
    const updated = updateVibotConfig(parsed.data);
    res.json({ config: vibotConfigClient(updated) });
  });

  router.get('/vibot/conversations', (_req, res) => {
    res.json({ convs: vibotHub.listConversations() });
  });

  router.post('/vibot/conversations', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const conv = vibotHub.createConversation(title);
    res.json({ conv });
  });

  router.patch('/vibot/conversations/:id', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    const conv = vibotHub.renameConversation(req.params.id, title);
    if (!conv) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ conv });
  });

  router.delete('/vibot/conversations/:id', (req, res) => {
    vibotHub.deleteConversation(req.params.id);
    res.json({ ok: true });
  });

  router.get('/vibot/conversations/:id/messages', async (req, res) => {
    res.json(await vibotHub.snapshot(req.params.id));
  });

  router.get('/vibot/memories', (_req, res) => {
    res.json({ memories: memoryStore.list() });
  });

  return router;
}
