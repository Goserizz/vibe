import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import type { VibotMemory } from '../../../shared/protocol.js';

interface MemFile {
  memories: VibotMemory[];
}

/** Slugify a memory name into a filesystem/id-safe key (kept readable). */
function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'memory';
}

class MemoryStore {
  private items: VibotMemory[] = [];
  private loaded = false;
  private writeTimer: NodeJS.Timeout | null = null;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(config.vibotMemoriesFile, 'utf8');
      const parsed = JSON.parse(raw) as MemFile | VibotMemory[];
      this.items = Array.isArray(parsed) ? parsed : parsed.memories ?? [];
    } catch {
      this.items = [];
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const payload: MemFile = { memories: this.items };
      const tmp = `${config.vibotMemoriesFile}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, config.vibotMemoriesFile);
      } catch (err) {
        log.error('failed to persist vibot memories', err);
      }
    }, 200);
  }

  list(): VibotMemory[] {
    this.load();
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Lookup by slug name or raw id. */
  private find(nameOrId: string): VibotMemory | undefined {
    this.load();
    return this.items.find((m) => m.name === nameOrId || m.id === nameOrId);
  }

  read(nameOrId: string): VibotMemory | undefined {
    return this.find(nameOrId);
  }

  /** Create or update by name (slug is the stable key). */
  upsert(input: { name: string; description: string; content: string }): VibotMemory {
    this.load();
    const name = slugify(input.name);
    const now = Date.now();
    const existing = this.items.find((m) => m.name === name);
    if (existing) {
      existing.description = input.description.trim() || existing.description;
      existing.content = input.content;
      existing.updatedAt = now;
      this.scheduleWrite();
      return existing;
    }
    const memory: VibotMemory = {
      id: crypto.randomUUID(),
      name,
      description: input.description.trim() || name,
      content: input.content,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(memory);
    this.scheduleWrite();
    return memory;
  }

  remove(nameOrId: string): boolean {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((m) => m.name !== nameOrId && m.id !== nameOrId);
    const removed = this.items.length < before;
    if (removed) this.scheduleWrite();
    return removed;
  }
}

export const memoryStore = new MemoryStore();
