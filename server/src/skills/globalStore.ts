import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { GlobalSkillDeployment, GlobalSkillInput } from '../../../shared/protocol.js';

export const globalSkillInputSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  description: z.string().trim().min(1).max(4000),
  whenToUse: z.string().max(8000).optional(),
  body: z.string().max(256 * 1024),
  agents: z.array(z.enum(['claude', 'cursor', 'codex', 'kimi', 'kiro', 'grok', 'zcode', 'codebuddy', 'opencode', 'devin'])).min(1).max(10),
  replaceConflicts: z.boolean().optional(),
}).strict();

export interface StoredDeployment extends GlobalSkillDeployment {
  /** Never trust a report for an SSH target that has since changed. */
  targetKey: string;
  /** Last file bytes we installed/adopted. Protects manual edits on later syncs. */
  managedHash?: string;
  appliedRevision?: number;
  nextAttemptAt: number;
}

export interface StoredGlobalSkill extends GlobalSkillInput {
  id: string;
  owner: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deployments: StoredDeployment[];
}

export class GlobalSkillError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Definitions and retry/provenance state survive a Vibe restart. Bodies may
 * contain credentials, so this file is private and never belongs in the repo. */
export class GlobalSkillStore {
  private records: StoredGlobalSkill[] = [];
  private loadFailed = false;
  constructor(private readonly file: string) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; skills: StoredGlobalSkill[] };
      if (value.version !== 1 || !Array.isArray(value.skills)) throw new Error('Unsupported global skill registry');
      for (const record of value.skills) {
        globalSkillInputSchema.parse({ name: record.name, description: record.description, whenToUse: record.whenToUse,
          body: record.body, agents: record.agents, replaceConflicts: record.replaceConflicts });
        if (!record.id || !record.owner || !Number.isInteger(record.revision) || !Array.isArray(record.deployments)) throw new Error('Invalid global skill registry');
      }
      this.records = value.skills;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadFailed = true;
    }
  }

  private save(next: StoredGlobalSkill[]): void {
    this.assertReadable();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, skills: next })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      this.records = next;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  list(owner?: string): StoredGlobalSkill[] {
    this.assertReadable();
    return structuredClone(this.records.filter((record) => owner === undefined || record.owner === owner));
  }
  get(owner: string, id: string): StoredGlobalSkill | undefined {
    this.assertReadable();
    const record = this.records.find((record) => record.id === id && record.owner === owner);
    return record ? structuredClone(record) : undefined;
  }
  create(owner: string, input: GlobalSkillInput): StoredGlobalSkill {
    this.assertReadable();
    const parsed = globalSkillInputSchema.parse(input);
    if (this.records.some((r) => r.owner === owner && r.name === parsed.name)) throw new GlobalSkillError('A global skill with this name already exists', 409);
    const now = Date.now();
    const record: StoredGlobalSkill = { ...parsed, agents: [...new Set(parsed.agents)], id: crypto.randomUUID(), owner,
      revision: 1, createdAt: now, updatedAt: now, deployments: [] };
    this.save([...this.records, record]);
    return structuredClone(record);
  }
  update(owner: string, id: string, input: GlobalSkillInput): StoredGlobalSkill {
    const old = this.get(owner, id);
    if (!old) throw new GlobalSkillError('Global skill not found', 404);
    const parsed = globalSkillInputSchema.parse(input);
    if (parsed.name !== old.name) throw new GlobalSkillError('Create a new global skill to use a different name');
    const next = { ...old, ...parsed, replaceConflicts: parsed.replaceConflicts ?? false,
      agents: [...new Set(parsed.agents)], revision: old.revision + 1, updatedAt: Date.now() };
    this.save(this.records.map((r) => r.id === id ? next : r));
    return structuredClone(next);
  }
  record(owner: string, id: string, revision: number, reports: StoredDeployment[]): void {
    const skill = this.get(owner, id);
    if (!skill || skill.revision < revision) return;
    // A save may occur while the old revision is writing. Retain its managed
    // hash so the next revision can safely update it, but never call it current.
    reports = reports.filter((report) => !skill.deployments.some((existing) =>
      existing.targetKey === report.targetKey && existing.agent === report.agent && existing.revision > revision));
    const keys = new Set(reports.map((r) => `${r.targetKey}:${r.agent}`));
    skill.deployments = [...skill.deployments.filter((r) => !keys.has(`${r.targetKey}:${r.agent}`)), ...reports];
    this.save(this.records.map((r) => r.id === id ? skill : r));
  }
  retry(owner: string, id: string): void {
    const skill = this.get(owner, id);
    if (!skill) throw new GlobalSkillError('Global skill not found', 404);
    skill.deployments = skill.deployments.map((r) => ({ ...r, nextAttemptAt: 0 }));
    this.save(this.records.map((r) => r.id === id ? skill : r));
  }
  /** Stops future synchronization. Native copies are intentionally retained. */
  remove(owner: string, id: string): boolean {
    if (!this.get(owner, id)) return false;
    this.save(this.records.filter((r) => r.id !== id));
    return true;
  }
  removeOwnedBy(owner: string): void {
    this.save(this.records.filter((r) => r.owner !== owner));
  }
  private assertReadable(): void {
    if (this.loadFailed) throw new GlobalSkillError('Cannot read global skill registry; refusing to overwrite it', 503);
  }
}
