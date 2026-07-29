import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import type { AgentKind, EffortLevel, PermissionMode, SessionPreset } from '../../../shared/protocol.js';

const AGENTS: AgentKind[] = ['claude', 'cursor', 'codex', 'kimi', 'kiro'];
const PERMISSIONS: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Normalize + validate a preset. Returns undefined if the name or any field is invalid. */
function normalize(def: SessionPreset): SessionPreset | undefined {
  const name = def.name?.trim();
  if (!name) return undefined;
  const agent = AGENTS.includes(def.agent as AgentKind) ? def.agent : undefined;
  const model = def.model?.trim();
  const permissionMode = PERMISSIONS.includes(def.permissionMode as PermissionMode) ? def.permissionMode : undefined;
  const effort = EFFORTS.includes(def.effort as EffortLevel) ? def.effort : undefined;
  if (!agent || !model || !permissionMode || !effort) return undefined;
  return { name, agent, model, permissionMode, effort };
}

/**
 * Registry of saved New-session engine presets, persisted to ~/.vibe/presets.json.
 * Each preset bundles agent + model + permission + effort so it can be reapplied
 * in one click from the New Session dialog. Definitions live here once and are
 * referenced by name.
 */
class PresetRegistry {
  private presets = new Map<string, SessionPreset>();

  constructor() {
    this.load();
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(config.presetsFile, 'utf8'));
    } catch {
      return; /* first run */
    }
    if (Array.isArray(parsed)) {
      // Tolerate either a bare array or { presets: [...] }.
      this.ingest(parsed);
    } else if (parsed && typeof parsed === 'object') {
      const list = (parsed as { presets?: unknown }).presets;
      if (Array.isArray(list)) this.ingest(list);
    }
  }

  private ingest(list: unknown[]): void {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const clean = normalize(item as SessionPreset);
      if (clean) this.presets.set(clean.name, clean);
    }
  }

  private save(): void {
    try {
      const tmp = `${config.presetsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ presets: this.list() }, null, 2));
      fs.renameSync(tmp, config.presetsFile);
    } catch (err) {
      log.error('failed to persist presets registry', err);
    }
  }

  list(): SessionPreset[] {
    return [...this.presets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SessionPreset | undefined {
    return this.presets.get(name);
  }

  /** Insert or update a preset (keyed by name). */
  upsert(def: SessionPreset): SessionPreset | undefined {
    const clean = normalize(def);
    if (!clean) return undefined;
    this.presets.set(clean.name, clean);
    this.save();
    return clean;
  }

  remove(name: string): boolean {
    const ok = this.presets.delete(name);
    if (ok) this.save();
    return ok;
  }
}

export const presetRegistry = new PresetRegistry();
