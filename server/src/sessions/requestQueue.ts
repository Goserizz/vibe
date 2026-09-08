import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import type { QueuedSessionRequest, RequestQueuePauseReason, SessionRequestQueueState } from '../../../shared/protocol.js';

export const MAX_QUEUED_REQUESTS = 20;
export const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const RECENT_IDS = 512;

export interface StoredQueuedRequest extends QueuedSessionRequest {
  owner: string;
}

const requestSchema = z.object({
  id: z.string().min(1).max(128), text: z.string().min(1).max(MAX_REQUEST_BYTES),
  owner: z.string().min(1).max(128), queuedAt: z.number().finite(), interrupted: z.boolean().optional(),
});
const recordSchema = z.object({
  version: z.literal(1), sessionId: z.string(), items: z.array(requestSchema).max(MAX_QUEUED_REQUESTS + 1),
  active: requestSchema.optional(), recent: z.array(z.string().max(128)).max(RECENT_IDS),
  reason: z.enum(['manual', 'stopped', 'error', 'restart', 'unavailable']).optional(),
});
type QueueRecord = z.infer<typeof recordSchema>;

/** Pending prompts live on the Vibe host, not in an agent's native history.
 * Atomic private files make acceptance durable before ACK. A dispatch is also
 * recorded before starting the CLI; restart never blindly replays that work.
 */
export class RequestQueueStore {
  private cache = new Map<string, QueueRecord>();

  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    return path.join(this.dir, `${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  }

  private load(sessionId: string): QueueRecord {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    let record: QueueRecord;
    try {
      const file = this.file(sessionId);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid request queue file');
      record = recordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (record.sessionId !== sessionId) throw new Error('Request queue session mismatch');
      if (record.active) {
        record.items.unshift({ ...record.active, interrupted: true });
        record.active = undefined;
      }
      if (record.items.length) record.reason = 'restart';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Queued requests could not be read; stored data was left untouched.');
      record = { version: 1, sessionId, items: [], recent: [] };
    }
    this.cache.set(sessionId, record);
    return record;
  }

  private save(record: QueueRecord): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(record.sessionId);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      this.cache.set(record.sessionId, record);
    } catch {
      throw new Error('Queued requests could not be saved. Please retry.');
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
    }
  }

  snapshot(sessionId: string): SessionRequestQueueState {
    const record = this.load(sessionId);
    return {
      items: record.items.map(({ owner: _owner, ...request }) => ({ ...request })),
      paused: Boolean(record.reason), reason: record.reason,
    };
  }

  enqueue(sessionId: string, owner: string, id: string, text: string): void {
    const request = requestSchema.parse({ id, owner, text: text.trim(), queuedAt: Date.now() });
    if (Buffer.byteLength(request.text) > MAX_REQUEST_BYTES) throw new Error('Request is too large (maximum 1 MiB).');
    const current = this.load(sessionId);
    const previous = current.items.find((item) => item.id === id) ?? (current.active?.id === id ? current.active : undefined);
    if (previous && previous.text !== request.text) throw new Error('Message id was already used for different text.');
    if (previous || current.recent.includes(id)) return;
    if (current.items.length >= MAX_QUEUED_REQUESTS) throw new Error(`Queue is full (maximum ${MAX_QUEUED_REQUESTS} waiting requests).`);
    const bytes = [...current.items, ...(current.active ? [current.active] : []), request]
      .reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    if (bytes > MAX_QUEUE_BYTES) throw new Error('Queued requests are too large (maximum 4 MiB per session).');
    const next = structuredClone(current);
    // An explicit new message after an empty, stopped queue starts normally.
    if (!next.items.length && !next.active) next.reason = undefined;
    next.items.push(request);
    next.recent = [...next.recent, id].slice(-RECENT_IDS);
    this.save(next);
  }

  peek(sessionId: string): StoredQueuedRequest | undefined {
    const record = this.load(sessionId);
    return !record.reason && !record.active && record.items[0] ? { ...record.items[0] } : undefined;
  }

  claim(sessionId: string): StoredQueuedRequest | undefined {
    const item = this.peek(sessionId);
    if (!item) return;
    const next = structuredClone(this.load(sessionId));
    next.active = next.items.shift();
    this.save(next);
    return item;
  }

  restore(sessionId: string, reason?: RequestQueuePauseReason): void {
    const next = structuredClone(this.load(sessionId));
    if (!next.active) return;
    next.items.unshift({ ...next.active, ...(reason ? { interrupted: true } : {}) });
    next.active = undefined;
    next.reason = reason;
    this.save(next);
  }

  complete(sessionId: string, reason?: RequestQueuePauseReason): void {
    const current = this.load(sessionId);
    if (!current.active && !(reason && current.items.length)) return;
    const next = structuredClone(current);
    if (!reason && next.active && next.reason === 'error') next.reason = undefined;
    next.active = undefined;
    if (reason && next.items.length && (reason !== 'error' || !next.reason || next.reason === 'error')) next.reason = reason;
    if (!next.items.length) next.reason = undefined;
    this.save(next);
  }

  pause(sessionId: string, reason: RequestQueuePauseReason): void {
    const next = structuredClone(this.load(sessionId));
    if (!next.items.length) return;
    if (reason === 'error' && next.reason && next.reason !== 'error') return;
    next.reason = reason;
    this.save(next);
  }

  resume(sessionId: string, owner: string): void {
    const next = structuredClone(this.load(sessionId));
    next.reason = undefined;
    for (const item of next.items) {
      item.owner = owner;
      // An explicit recovery retry is a NEW transcript message, not an upsert
      // of a possibly already-persisted user block from before the restart.
      if (item.interrupted) {
        item.id = crypto.randomUUID();
        delete item.interrupted;
        next.recent.push(item.id);
      }
    }
    next.recent = next.recent.slice(-RECENT_IDS);
    this.save(next);
  }

  remove(sessionId: string, id: string): boolean {
    const next = structuredClone(this.load(sessionId));
    const index = next.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    next.items.splice(index, 1);
    if (!next.items.length) next.reason = undefined;
    this.save(next);
    return true;
  }

  drop(sessionId: string): void {
    try { fs.unlinkSync(this.file(sessionId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.cache.delete(sessionId);
  }
}

export const requestQueueStore = new RequestQueueStore(path.join(config.home, 'request-queues'));
