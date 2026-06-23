import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import { getRecentProjects, validateDir } from '../projects.js';
import { getClaudeSessionInfo, listClaudeSessions, type DiscoveredSession } from '../sessions/discovery.js';
import { listCursorSessions, resolveCursorSessionSync } from '../cursor/discovery.js';
import { listCursorModels } from '../cursor/models.js';
import { searchConversations } from '../sessions/search.js';
import { hostRegistry } from '../remote/hosts.js';
import { listRemoteSessions, getRemoteSessionInfo } from '../remote/discovery.js';
import { sshExec, loginShellCommand, shQuote, sshCheck } from '../remote/ssh.js';
import { encodeRemoteId, parseSessionId } from '../remote/sessionId.js';
import { hub } from '../ws/hub.js';
import type { AgentKind, EffortLevel, FileEntry, PermissionMode, SessionMeta } from '../../../shared/protocol.js';

const permissionModes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Present a CLI-discovered session as session metadata. For remote hosts the id
 * is namespaced (`host::sessionId`) and tagged with the host name.
 */
function discoveredToMeta(d: DiscoveredSession, host: string, remote: boolean, agent: AgentKind = 'claude'): SessionMeta {
  return {
    id: remote ? encodeRemoteId(host, d.claudeSessionId) : d.claudeSessionId,
    claudeSessionId: d.claudeSessionId,
    title: d.title,
    cwd: d.cwd,
    model: d.model,
    permissionMode: 'default',
    effort: config.defaultEffort as EffortLevel,
    agent,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    messageCount: d.messageCount,
    running: false,
    source: agent === 'cursor' ? 'cursor' : 'claude',
    host,
  };
}

/** Cache a remote session's resolution so the WS hub can build a runtime for it. */
async function ensureRemoteCached(sessionId: string): Promise<void> {
  const { host, claudeSessionId } = parseSessionId(sessionId);
  if (!host || sessionStore.get(sessionId)) return;
  const remoteHost = hostRegistry.get(host);
  if (!remoteHost) return;
  const info = await getRemoteSessionInfo(remoteHost, claudeSessionId);
  if (info) {
    hub.cacheRemoteSession(sessionId, { host: remoteHost.name, sshTarget: remoteHost.ssh, cwd: info.cwd, model: info.model, title: info.title });
  }
}

const createSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  effort: z.enum(effortLevels).optional(),
  /** Engine to drive the session; defaults to the server's default agent. */
  agent: z.enum(['claude', 'cursor']).optional(),
  title: z.string().optional(),
  /** Remote host name to create the session on; omit for local. */
  host: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  effort: z.enum(effortLevels).optional(),
});

const hostSchema = z.object({
  name: z.string().min(1).refine((n) => !n.includes('::'), 'name cannot contain "::"'),
  ssh: z.string().min(1),
});

// -- File browser/editor (local + remote) ------------------------------------

/** Max bytes we're willing to load into the editor. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Max bytes for a raw (e.g. image) download. */
const MAX_RAW_BYTES = 25 * 1024 * 1024;

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

const filesQuerySchema = z.object({
  host: z.string().optional(),
  path: z.string().min(1),
});

const fileWriteSchema = z.object({
  host: z.string().optional(),
  path: z.string().min(1),
  content: z.string(),
});

export function createApiRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/me', (_req, res) => {
    res.json({ ok: true, serverVersion: config.serverVersion, defaultModel: config.defaultModel });
  });

  router.get('/projects', (_req, res) => {
    res.json({ projects: getRecentProjects() });
  });

  // The Cursor CLI enumerates every model variant (effort/thinking/fast); list
  // them dynamically so the picker always matches the installed CLI.
  router.get('/cursor/models', async (_req, res) => {
    res.json({ models: await listCursorModels() });
  });

  router.post('/projects/validate', (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json(validateDir(path));
  });

  // -- Files: list / read / write (local + remote over SSH) ------------------

  router.get('/files', async (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query' });
      return;
    }
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
    const filePath = parsed.data.path;
    const { remote, target } = resolveFileTarget(parsed.data.host);
    try {
      let buf: Buffer;
      if (remote) {
        const sizeRes = await sshExec(target, loginShellCommand(`wc -c < ${shQuote(filePath)}`), { timeoutMs: 10_000 });
        const size = Number((sizeRes.stdout || '').trim());
        if (sizeRes.code === 0 && Number.isFinite(size) && size > MAX_RAW_BYTES) {
          res.status(422).json({ error: 'file too large (>25MB)' });
          return;
        }
        const r = await sshExec(target, loginShellCommand(`base64 < ${shQuote(filePath)}`), { timeoutMs: 30_000 });
        if (r.timedOut) {
          res.status(504).json({ error: 'read timed out' });
          return;
        }
        if (r.code !== 0) {
          res.status(400).json({ error: (r.stderr.trim() || 'read failed').slice(0, 500) });
          return;
        }
        buf = Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
      } else {
        const resolved = resolveLocalPath(filePath);
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_RAW_BYTES) {
          res.status(422).json({ error: 'file too large (>25MB)' });
          return;
        }
        buf = fs.readFileSync(resolved);
      }
      res.set('Content-Type', mimeForPath(filePath));
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'read failed' });
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

  // -- Remote hosts ---------------------------------------------------------

  router.get('/hosts', (_req, res) => {
    res.json({ hosts: hostRegistry.list(), localName: config.localName });
  });

  router.post('/hosts', (req, res) => {
    const parsed = hostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid host' });
      return;
    }
    res.json({ host: hostRegistry.add(parsed.data) });
  });

  router.delete('/hosts/:name', (req, res) => {
    hostRegistry.remove(req.params.name);
    res.json({ ok: true });
  });

  // Reachability + claude-installed probe for a host (by name or raw ssh target).
  router.get('/hosts/:name/check', async (req, res) => {
    const host = hostRegistry.get(req.params.name);
    const target = host?.ssh ?? req.params.name;
    const result = await sshCheck(target);
    res.json({ name: req.params.name, ssh: target, ...result });
  });

  // Unified list: local Vibe-managed + local CLI-discovered + every remote
  // host's sessions, deduped and tagged with their host.
  router.get('/sessions', async (_req, res) => {
    const stored = sessionStore.list();
    const storeMetas = stored.map((s) => toMeta(s, hub.isRunning(s.id), 'vibe'));

    // A conversation is identified by its (bare) Claude session id; dedup
    // discovered sessions against that so a stored session and its on-disk
    // transcript never both appear.
    const known = new Set<string>();
    for (const s of stored) {
      known.add(s.id);
      if (s.claudeSessionId) known.add(s.claudeSessionId);
    }

    const discovered: SessionMeta[] = [];

    // Local CLI sessions (Claude).
    try {
      for (const d of await listClaudeSessions()) {
        if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
          discovered.push(discoveredToMeta(d, config.localName, false));
        }
      }
    } catch (err) {
      log.warn('local session discovery failed', err);
    }

    // Local Cursor CLI sessions (~/.cursor/chats, cwd recovered via md5).
    try {
      for (const d of listCursorSessions()) {
        if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
          discovered.push(discoveredToMeta(d, config.localName, false, 'cursor'));
        }
      }
    } catch (err) {
      log.warn('cursor session discovery failed', err);
    }

    // Remote hosts (in parallel; a down host just contributes nothing).
    await Promise.all(
      hostRegistry.list().map(async (host) => {
        try {
          for (const d of await listRemoteSessions(host)) {
            const id = encodeRemoteId(host.name, d.claudeSessionId);
            hub.cacheRemoteSession(id, { host: host.name, sshTarget: host.ssh, cwd: d.cwd, model: d.model, title: d.title });
            // Dedup by the conversation's Claude session id; the hide-list keys
            // on the host-namespaced id (what delete dismisses).
            if (!known.has(d.claudeSessionId) && !known.has(id) && !sessionStore.isHidden(id)) {
              discovered.push(discoveredToMeta(d, host.name, true));
            }
          }
        } catch (err) {
          log.debug(`remote discovery failed for ${host.name}`, err);
        }
      }),
    );

    const sessions = [...storeMetas, ...discovered].sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ sessions });
  });

  router.post('/sessions', (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.issues });
      return;
    }
    const { host } = parsed.data;
    let cwd = parsed.data.cwd;
    if (host) {
      // Remote: trust the path (validated lazily when the turn runs over SSH).
      if (!hostRegistry.get(host)) {
        res.status(400).json({ error: 'unknown host' });
        return;
      }
    } else {
      const check = validateDir(cwd);
      if (!check.ok) {
        res.status(400).json({ error: check.error || 'invalid cwd' });
        return;
      }
      cwd = check.path;
    }
    const agent: AgentKind = parsed.data.agent ?? config.defaultAgent;
    const session = sessionStore.create({
      cwd,
      model: parsed.data.model || (agent === 'cursor' ? config.defaultCursorModel : config.defaultModel),
      permissionMode: (parsed.data.permissionMode as PermissionMode) || 'default',
      effort: (parsed.data.effort as EffortLevel) || (config.defaultEffort as EffortLevel),
      agent,
      title: parsed.data.title,
      host,
    });
    const meta = toMeta(session, false, 'vibe');
    hub.broadcastMeta(session.id);
    res.json({ session: meta });
  });

  router.get('/sessions/:id', (req, res) => {
    const stored = sessionStore.get(req.params.id);
    if (!stored) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ session: toMeta(stored, hub.isRunning(stored.id)) });
  });

  router.patch('/sessions/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body' });
      return;
    }
    const id = req.params.id;
    // Editing a discovered CLI session (local or remote) adopts it so the change persists.
    if (!sessionStore.get(id)) {
      const { host, claudeSessionId } = parseSessionId(id);
      const remoteHost = host ? hostRegistry.get(host) : undefined;
      let info: DiscoveredSession | null = remoteHost
        ? await getRemoteSessionInfo(remoteHost, claudeSessionId)
        : await getClaudeSessionInfo(id);
      let agent: AgentKind = 'claude';
      // Not a Claude session — maybe a local Cursor chat.
      if (!info && !host) {
        const c = resolveCursorSessionSync(id);
        if (c) {
          info = c;
          agent = 'cursor';
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
    res.json({ session: toMeta(updated, hub.isRunning(updated.id), 'vibe') });
  });

  // Delete = stop tracking in Vibe. We never delete the underlying ~/.claude
  // transcript; instead we dismiss it (so discovery won't resurface it).
  router.delete('/sessions/:id', (req, res) => {
    const id = req.params.id;
    const stored = sessionStore.get(id);
    sessionStore.remove(id);
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
    await ensureRemoteCached(req.params.id);
    res.json(await hub.snapshot(req.params.id));
  });

  // Full-text search across local + remote conversation messages.
  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;
    res.json({ results: await searchConversations(q, limit) });
  });

  // Surface available permission modes for the UI.
  router.get('/meta/permission-modes', (_req, res) => {
    res.json({ permissionModes });
  });

  return router;
}
