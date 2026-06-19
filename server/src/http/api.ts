import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { sessionStore, toMeta } from '../sessions/store.js';
import { getRecentProjects, validateDir } from '../projects.js';
import { getClaudeSessionInfo, listClaudeSessions, type DiscoveredSession } from '../sessions/discovery.js';
import { searchConversations } from '../sessions/search.js';
import { hostRegistry } from '../remote/hosts.js';
import { listRemoteSessions, getRemoteSessionInfo } from '../remote/discovery.js';
import { sshCheck } from '../remote/ssh.js';
import { encodeRemoteId, parseSessionId } from '../remote/sessionId.js';
import { hub } from '../ws/hub.js';
import type { EffortLevel, PermissionMode, SessionMeta } from '../../../shared/protocol.js';

const permissionModes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Present a CLI-discovered session as session metadata. For remote hosts the id
 * is namespaced (`host::sessionId`) and tagged with the host name.
 */
function discoveredToMeta(d: DiscoveredSession, host: string, remote: boolean): SessionMeta {
  return {
    id: remote ? encodeRemoteId(host, d.claudeSessionId) : d.claudeSessionId,
    claudeSessionId: d.claudeSessionId,
    title: d.title,
    cwd: d.cwd,
    model: d.model,
    permissionMode: 'default',
    effort: config.defaultEffort as EffortLevel,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    messageCount: d.messageCount,
    running: false,
    source: 'claude',
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

export function createApiRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/me', (_req, res) => {
    res.json({ ok: true, serverVersion: config.serverVersion, defaultModel: config.defaultModel });
  });

  router.get('/projects', (_req, res) => {
    res.json({ projects: getRecentProjects() });
  });

  router.post('/projects/validate', (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json(validateDir(path));
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

    // Local CLI sessions.
    try {
      for (const d of await listClaudeSessions()) {
        if (!known.has(d.claudeSessionId) && !sessionStore.isHidden(d.claudeSessionId)) {
          discovered.push(discoveredToMeta(d, config.localName, false));
        }
      }
    } catch (err) {
      log.warn('local session discovery failed', err);
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
    const session = sessionStore.create({
      cwd,
      model: parsed.data.model || config.defaultModel,
      permissionMode: (parsed.data.permissionMode as PermissionMode) || 'default',
      effort: (parsed.data.effort as EffortLevel) || (config.defaultEffort as EffortLevel),
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
      const info = remoteHost
        ? await getRemoteSessionInfo(remoteHost, claudeSessionId)
        : await getClaudeSessionInfo(id);
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
