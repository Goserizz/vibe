import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import type { RemoteHost } from '../../../shared/protocol.js';

/**
 * Registry of SSH-reachable hosts whose Claude sessions Vibe surfaces.
 * Seeded from `VIBE_SSH_HOSTS` (e.g. "prod=user@host,gpu=mygpu-alias") and
 * persisted to ~/.vibe/hosts.json as the user adds/removes hosts in the UI.
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
        if (h?.name && h?.ssh) this.hosts.set(h.name, { name: h.name, ssh: h.ssh, proxy: h.proxy?.trim() || undefined });
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
      if (name && ssh && !this.hosts.has(name)) this.hosts.set(name, { name, ssh });
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

  get(name: string): RemoteHost | undefined {
    return this.hosts.get(name);
  }

  add(host: RemoteHost): RemoteHost {
    const clean: RemoteHost = { name: host.name.trim(), ssh: host.ssh.trim(), proxy: host.proxy?.trim() || undefined };
    this.hosts.set(clean.name, clean);
    this.save();
    return clean;
  }

  /** Patch an existing host's ssh target and/or proxy. */
  update(name: string, patch: Partial<Pick<RemoteHost, 'ssh' | 'proxy'>>): RemoteHost | undefined {
    const h = this.hosts.get(name);
    if (!h) return undefined;
    if (patch.ssh != null) h.ssh = patch.ssh.trim();
    if (patch.proxy != null) h.proxy = patch.proxy.trim() || undefined;
    this.save();
    return h;
  }

  remove(name: string): boolean {
    const ok = this.hosts.delete(name);
    if (ok) this.save();
    return ok;
  }
}

export const hostRegistry = new HostRegistry();
