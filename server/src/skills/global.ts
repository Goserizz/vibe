import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry } from '../remote/hosts.js';
import { ADMIN_ACCOUNT, type AgentKind, type GlobalSkillDetail, type GlobalSkillSummary } from '../../../shared/protocol.js';
import { buildSkillFile, parseSkill, serializeSkill } from './frontmatter.js';
import { nativeSkillPath } from './skills.js';
import { GlobalSkillStore, type StoredDeployment, type StoredGlobalSkill } from './globalStore.js';
import { createGlobalSkillTransport, type GlobalSkillTransport, type SkillFileWrite, type SkillTarget } from './globalTransport.js';

const RETRY_MS = 60_000;
const VERIFY_MS = 15 * 60_000;
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Global means all of this account's hosts, never all accounts' hosts. */
export function globalSkillTargets(owner: string): SkillTarget[] {
  const targets: SkillTarget[] = owner === ADMIN_ACCOUNT ? [{ host: 'local', local: true, key: 'local' }] : [];
  for (const h of hostRegistry.listFor(owner)) {
    targets.push({ host: h.name, local: false, ssh: h.ssh, key: hash(`${h.name}\0${h.ssh}`) });
  }
  return targets;
}

function equivalent(content: string, skill: StoredGlobalSkill): boolean {
  const parsed = parseSkill(content);
  const text = (s?: string) => (s ?? '').replace(/\r\n/g, '\n').trim();
  return parsed.name === skill.name && text(parsed.description) === text(skill.description)
    && text(parsed.whenToUse) === text(skill.whenToUse) && text(parsed.body) === text(skill.body);
}

function render(skill: StoredGlobalSkill, existing?: string | null): string {
  if (!existing) return buildSkillFile(skill.name, skill.description, skill.whenToUse, skill.body);
  const parsed = parseSkill(existing);
  parsed.name = skill.name;
  parsed.description = skill.description;
  parsed.whenToUse = skill.whenToUse;
  parsed.body = skill.body;
  return serializeSkill(parsed);
}

export class GlobalSkillService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private unsubscribe?: () => void;

  constructor(
    readonly store: GlobalSkillStore,
    private readonly transport: GlobalSkillTransport = createGlobalSkillTransport(),
    private readonly targets: (owner: string) => SkillTarget[] = globalSkillTargets,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unsubscribe = hostRegistry.onChange(() => this.kick());
    this.timer = setInterval(() => this.kick(), RETRY_MS);
    this.timer.unref?.();
    log.info('global skill deployment scheduler started');
    this.kick();
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
  }
  kick(): void {
    if (this.stopped) return;
    void this.sync().catch(() => log.warn('global skill synchronization failed; pending targets will retry'));
  }
  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        const jobs: { skill: StoredGlobalSkill; target: SkillTarget; agents: AgentKind[] }[] = [];
        for (const skill of this.store.list()) {
          for (const target of this.targets(skill.owner)) {
            const agents = skill.agents.filter((agent) => {
              const old = skill.deployments.find((r) => r.targetKey === target.key && r.agent === agent);
              return !old || old.revision !== skill.revision || old.nextAttemptAt <= this.now();
            });
            if (agents.length) jobs.push({ skill, target, agents });
          }
        }
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
          while (next < jobs.length && !this.stopped) {
            const job = jobs[next++]!;
            await this.deploy(job.skill, job.target, job.agents);
          }
        }));
      } while (this.again && !this.stopped);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async deploy(skill: StoredGlobalSkill, target: SkillTarget, agents: AgentKind[]): Promise<void> {
    const current = () => this.store.get(skill.owner, skill.id)?.revision === skill.revision
      && this.targets(skill.owner).some((t) => t.key === target.key);
    if (!current()) return;
    const reports = new Map<AgentKind, StoredDeployment>();
    const paths = new Map(agents.map((agent) => [nativeSkillPath(agent, skill.name), agent]));
    const makeReport = (agent: AgentKind, status: StoredDeployment['status'], message?: string, managedHash?: string): StoredDeployment => {
      const old = skill.deployments.find((r) => r.targetKey === target.key && r.agent === agent);
      return { host: target.host, local: target.local, agent, targetKey: target.key,
        status, revision: skill.revision, attemptedAt: this.now(), message,
        managedHash: managedHash ?? old?.managedHash,
        appliedRevision: status === 'synced' ? skill.revision : old?.appliedRevision,
        nextAttemptAt: this.now() + (status === 'synced' ? VERIFY_MS : status === 'conflict' ? 5 * RETRY_MS : RETRY_MS) };
    };
    try {
      const snapshots = await this.transport.inspect(target, [...paths.keys()]);
      if (!current()) return;
      const writes: SkillFileWrite[] = [];
      for (const [file, agent] of paths) {
        const snapshot = snapshots.find((s) => s.path === file);
        if (!snapshot || snapshot.status !== 'ok') {
          reports.set(agent, makeReport(agent, snapshot?.status === 'conflict' ? 'conflict' : 'failed', snapshot?.message ?? 'No file inspection result'));
          continue;
        }
        const previous = skill.deployments.find((r) => r.targetKey === target.key && r.agent === agent);
        if (snapshot.content != null && equivalent(snapshot.content, skill)) {
          reports.set(agent, makeReport(agent, 'synced', 'Matching skill adopted', snapshot.hash ?? undefined));
          continue;
        }
        const mayReplace = skill.replaceConflicts && previous?.appliedRevision !== skill.revision;
        if (snapshot.content != null && snapshot.hash !== previous?.managedHash && !mayReplace) {
          reports.set(agent, makeReport(agent, 'conflict', 'Different or manually edited skill exists; explicit replacement required'));
          continue;
        }
        writes.push({ path: file, content: render(skill, snapshot.content), expectedHash: snapshot.hash ?? null });
      }
      if (!current()) return;
      if (writes.length) {
        const results = await this.transport.write(target, writes);
        for (const write of writes) {
          const agent = paths.get(write.path)!;
          const result = results.find((r) => r.path === write.path);
          reports.set(agent, makeReport(agent, result?.status ?? 'failed', result?.message,
            result?.status === 'synced' ? result.hash ?? hash(write.content) : undefined));
        }
      }
    } catch {
      // Never include remote stdout or skill bodies (they may contain tokens).
      for (const agent of agents) if (!reports.has(agent)) reports.set(agent,
        makeReport(agent, 'failed', 'Host unreachable, python3 unavailable, or transfer failed; will retry'));
    }
    this.store.record(skill.owner, skill.id, skill.revision, [...reports.values()]);
  }

  summary(skill: StoredGlobalSkill): GlobalSkillSummary {
    const deployments = this.targets(skill.owner).flatMap((target) => skill.agents.map((agent) => {
      const report = skill.deployments.find((r) => r.targetKey === target.key && r.agent === agent);
      if (!report || report.revision !== skill.revision) return { host: target.host, local: target.local, agent,
        status: 'pending' as const, revision: skill.revision };
      const { host, local, status, revision, attemptedAt, message } = report;
      return { host, local, agent, status, revision, attemptedAt, message };
    }));
    return { id: skill.id, name: skill.name, description: skill.description, whenToUse: skill.whenToUse,
      agents: skill.agents, revision: skill.revision, createdAt: skill.createdAt, updatedAt: skill.updatedAt, deployments };
  }
  list(owner: string): GlobalSkillSummary[] { return this.store.list(owner).map((skill) => this.summary(skill)); }
  detail(owner: string, id: string): GlobalSkillDetail | undefined {
    const skill = this.store.get(owner, id);
    return skill ? { ...this.summary(skill), body: skill.body } : undefined;
  }
}

export const globalSkillStore = new GlobalSkillStore(path.join(config.home, 'global-skills.json'));
export const globalSkillService = new GlobalSkillService(globalSkillStore);
