import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import type { LlmMessage } from './llm.js';
import type { ChatBlock, VibotConvMeta } from '../../../shared/protocol.js';

/** Persisted shape of one Vibot conversation. */
export interface StoredConv {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Raw OpenAI-format LLM history — replayed verbatim into the model so
   *  multi-turn tool-calling resumes losslessly. */
  messages: LlmMessage[];
  /** Rendered snapshot of the conversation for the REST history endpoint and
   *  cold loads. The live seq-log covers an in-flight turn on top of this. */
  blocks: ChatBlock[];
}

const CAP = 200; // sane upper bound on history length per conversation

class ConvStore {
  private convs = new Map<string, StoredConv>();
  private loaded = false;

  private dir(): string {
    fs.mkdirSync(config.vibotConvsDir, { recursive: true });
    return config.vibotConvsDir;
  }

  private file(id: string): string {
    // ids are UUIDs; still guard against any traversal.
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
    return path.join(this.dir(), `${safe || 'conv'}.json`);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir());
    } catch {
      return; // nothing yet
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dir(), f), 'utf8');
        const conv = JSON.parse(raw) as StoredConv;
        if (conv && conv.id && Array.isArray(conv.messages)) {
          this.convs.set(conv.id, conv);
        }
      } catch (err) {
        log.warn('failed to read vibot conversation', f, err);
      }
    }
    log.debug(`loaded ${this.convs.size} vibot conversations`);
  }

  private persist(conv: StoredConv): void {
    try {
      fs.writeFileSync(this.file(conv.id), JSON.stringify(conv, null, 2));
    } catch (err) {
      log.error('failed to persist vibot conversation', conv.id, err);
    }
  }

  list(): VibotConvMeta[] {
    this.load();
    return [...this.convs.values()]
      .map((c) => ({ ...c, running: false }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): StoredConv | undefined {
    this.load();
    return this.convs.get(id);
  }

  create(title?: string): StoredConv {
    this.load();
    const now = Date.now();
    const conv: StoredConv = {
      id: crypto.randomUUID(),
      title: title?.trim() || 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      blocks: [],
    };
    this.convs.set(conv.id, conv);
    this.persist(conv);
    return conv;
  }

  rename(id: string, title: string): StoredConv | undefined {
    this.load();
    const conv = this.convs.get(id);
    if (!conv) return undefined;
    conv.title = title.trim() || conv.title;
    conv.updatedAt = Date.now();
    this.persist(conv);
    return conv;
  }

  /** Append a single finalized block outside a turn (e.g. a delegate status
   *  note posted by the watcher). Does not touch the LLM message history. */
  appendBlock(id: string, block: ChatBlock): void {
    this.load();
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.blocks = [...conv.blocks, block];
    conv.updatedAt = Date.now();
    this.persist(conv);
  }

  remove(id: string): boolean {
    this.load();
    const existed = this.convs.delete(id);
    if (existed) {
      try { fs.rmSync(this.file(id), { force: true }); } catch { /* best effort */ }
    }
    return existed;
  }

  /** Append one turn's outcome: the new LLM messages and rendered blocks.
   *  Also sets the title from the first user message and bounds history. */
  appendRun(id: string, newMessages: LlmMessage[], newBlocks: ChatBlock[], userTurns = 1): StoredConv | undefined {
    this.load();
    const conv = this.convs.get(id);
    if (!conv) return undefined;
    conv.messages = [...conv.messages, ...newMessages];
    if (conv.messages.length > CAP) {
      // Keep the leading system message + the most recent tail.
      const sys = conv.messages[0]?.role === 'system' ? [conv.messages[0]] : [];
      conv.messages = [...sys, ...conv.messages.slice(-(CAP - sys.length))];
    }
    conv.blocks = [...conv.blocks, ...newBlocks];
    conv.messageCount += Math.max(1, userTurns);
    conv.updatedAt = Date.now();
    // Title from the first user message if it's still the default.
    if ((conv.title === 'New chat' || !conv.title) && conv.messages.length) {
      const firstUser = conv.messages.find((m) => m.role === 'user');
      if (firstUser && typeof firstUser.content === 'string') {
        conv.title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 60) || conv.title;
      }
    }
    this.persist(conv);
    return conv;
  }
}

export const convStore = new ConvStore();

/** Projection to the wire meta type (running flag is filled in by the hub). */
export function toMeta(c: StoredConv, running: boolean): VibotConvMeta {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messageCount,
    running,
  };
}
