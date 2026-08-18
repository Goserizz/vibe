import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { invalidateSessionListCache } from '../sessions/listCache.js';
import { ADMIN_ACCOUNT, type AgentKind, type RemoteHost } from '../../../shared/protocol.js';

/** Drop empty/whitespace entries so a persisted map never carries '' values. */
function cleanProxyMap(map?: Record<string, string>): Partial<Record<AgentKind, string>> | undefined {
  if (!map) return undefined;
  const out: Partial<Record<AgentKind, string>> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed) (out as Record<string, string>)[k] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Resolve the effective proxy a host uses for one agent: the agent-specific
 * override in `proxyByAgent` if set, else the default `proxy`. Returns undefined
 * when neither applies (no proxy for that agent).
 */
export function proxyForAgent(host: RemoteHost | undefined, agent: AgentKind): string | undefined {
  if (!host) return undefined;
  const specific = host.proxyByAgent?.[agent]?.trim();
  if (specific) return specific;
  return host.proxy?.trim() || undefined;
}

/** Thrown by registry mutations when the acting account lacks ownership or the
 *  name is taken by another account. `status` maps to an HTTP code. */
export class HostRegistryError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
  }
}

/**
 * Registry of SSH-reachable hosts whose Claude sessions Vibe surfaces.
 * Seeded from `VIBE_SSH_HOSTS` (e.g. "prod=user@host,gpu=mygpu-alias") and
 * persisted to ~/.vibe/hosts.json as the user adds/removes hosts in the UI.
 *
 * Hosts carry an `owner` account and accounts are fully peer-isolated: every
 * account — admin included — only sees and manages the hosts it added (hosts
 * persisted before multi-account default to `admin`). The local machine is
 * admin-only. Names are globally unique across accounts — remote session ids
 * are `host::sessionId`, so a shared name would collide in the hub and the
 * session store.
 */
class HostRegistry {
  private hosts = new Map<string, RemoteHost>();

  constructor() {
    this.load();
    this.seedFromEnv();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.hostsFile, 'utf8')) as RemoteHost[];
      for (const h of parsed)
        if (h?.name && h?.ssh)
          this.hosts.set(h.name, {
            name: h.name,
            ssh: h.ssh,
            proxy: h.proxy?.trim() || undefined,
            proxyByAgent: cleanProxyMap(h.proxyByAgent),
            owner: h.owner || ADMIN_ACCOUNT,
          });
    } catch {
      /* first run */
    }
  }

  private seedFromEnv(): void {
    const raw = process.env.VIBE_SSH_HOSTS;
    if (!raw) return;
    for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = entry.indexOf('=');
      const [name, ssh] = eq >= 0 ? [entry.slice(0, eq).trim(), entry.slice(eq + 1).trim()] : [entry, entry];
      if (name && ssh && !this.hosts.has(name)) this.hosts.set(name, { name, ssh, owner: ADMIN_ACCOUNT });
    }
  }

  private save(): void {
    try {
      const tmp = `${config.hostsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.hosts.values()], null, 2));
      fs.renameSync(tmp, config.hostsFile);
    } catch (err) {
      log.error('failed to persist hosts', err);
    }
  }

  list(): RemoteHost[] {
    return [...this.hosts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Hosts an account manages: strictly the ones it added. Admin has no
   *  superuser view here — accounts are peers, each seeing only their own. */
  listFor(account: string): RemoteHost[] {
    return this.list().filter((h) => (h.owner ?? ADMIN_ACCOUNT) === account);
  }

  /** Names of every host the account may touch (its own plus the local machine). */
  isLocalName(name: string): boolean {
    return name === 'local' || name === config.localName;
  }

  get(name: string): RemoteHost | undefined {
    return this.hosts.get(name);
  }

  /** Whether `account` may use/manage the named host. The local machine
   *  (where Vibe itself runs, with all its credentials) is admin-only; remote
   *  hosts belong to the account that added them — no exceptions for admin. */
  visibleTo(account: string, name: string): boolean {
    if (this.isLocalName(name)) return account === ADMIN_ACCOUNT;
    const host = this.hosts.get(name);
    if (!host) return false;
    return (host.owner ?? ADMIN_ACCOUNT) === account;
  }

  add(host: RemoteHost, owner: string): RemoteHost {
    const clean: RemoteHost = {
      name: host.name.trim(),
      ssh: host.ssh.trim(),
      proxy: host.proxy?.trim() || undefined,
      proxyByAgent: cleanProxyMap(host.proxyByAgent),
      owner: owner,
    };
    const existing = this.hosts.get(clean.name);
    // A different account already owns this name — ids are `host::sessionId`,
    // so names must stay unique across accounts.
    if (existing && (existing.owner ?? ADMIN_ACCOUNT) !== owner) {
      throw new HostRegistryError(`the name "${clean.name}" is already used by another account`, 409);
    }
    this.hosts.set(clean.name, clean);
    this.save();
    invalidateSessionListCache();
    return clean;
  }

  /** Patch an existing host's ssh target and/or proxy config. `proxyByAgent` is
   *  replaced wholesale (caller sends the full normalized map). */
  update(name: string, patch: Partial<Pick<RemoteHost, 'ssh' | 'proxy' | 'proxyByAgent'>>, acting: string): RemoteHost | undefined {
    const h = this.hosts.get(name);
    if (!h) return undefined;
    if (!this.visibleTo(acting, name)) throw new HostRegistryError('this host belongs to another account', 403);
    if (patch.ssh != null) h.ssh = patch.ssh.trim();
    if (patch.proxy != null) h.proxy = patch.proxy.trim() || undefined;
    if (patch.proxyByAgent !== undefined) h.proxyByAgent = cleanProxyMap(patch.proxyByAgent);
    this.save();
    invalidateSessionListCache();
    return h;
  }

  remove(name: string, acting: string): boolean {
    if (!this.hosts.has(name)) return false;
    if (!this.visibleTo(acting, name)) throw new HostRegistryError('this host belongs to another account', 403);
    const ok = this.hosts.delete(name);
    if (ok) {
      this.save();
      invalidateSessionListCache();
    }
    return ok;
  }

  /** Delete every host an account owned (account deletion — accounts are
   *  peers, so nobody inherits them). Returns how many were removed. */
  removeOwnedBy(owner: string): number {
    let removed = 0;
    for (const [name, h] of [...this.hosts.entries()]) {
      if ((h.owner ?? ADMIN_ACCOUNT) === owner && this.hosts.delete(name)) removed += 1;
    }
    if (removed) {
      this.save();
      invalidateSessionListCache();
    }
    return removed;
  }
}

export const hostRegistry = new HostRegistry();
