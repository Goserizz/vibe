import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncQuestionItemsSchema } from '../codex/questions.js';
import type { AgentQuestion, AgentQuestionItem, AgentQuestionState } from '../../../shared/protocol.js';

const entrySchema = z.object({
  id: z.string().min(1).max(128), agent: z.literal('codex'), nativeId: z.string().min(1).max(512),
  sourceId: z.string().min(1).max(512), questions: asyncQuestionItemsSchema, createdAt: z.number().finite(),
  status: z.enum(['pending', 'sending', 'uncertain', 'answered', 'dismissed']),
  answers: z.array(z.string().max(65_536)).max(20).optional(), error: z.string().max(1024).optional(),
  answerHash: z.string().optional(), messageId: z.string().optional(), delivery: z.enum(['steered', 'queued']).optional(),
});
type Entry = z.infer<typeof entrySchema>;
const recordSchema = z.object({ version: z.literal(1), sessionId: z.string(), entries: z.array(entrySchema).max(256) });
type RecordData = z.infer<typeof recordSchema>;
const active = (entry: Entry) => entry.status !== 'answered' && entry.status !== 'dismissed';
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const UNCERTAIN = 'Answer delivery is uncertain. Check the conversation before explicitly retrying; retrying may repeat work.';

/** Private durable pending forms, not transcript reconstruction. Empty on
 * upgrade, so old questions are never silently resurrected. */
export class AgentQuestionStore {
  private cache = new Map<string, RecordData>();
  constructor(private readonly dir: string) {}
  private file(sessionId: string): string { return path.join(this.dir, hash(sessionId) + '.json'); }
  private load(sessionId: string): RecordData {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    let record: RecordData;
    try {
      const file = this.file(sessionId), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid question file');
      record = recordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (record.sessionId !== sessionId) throw new Error('Question session mismatch');
      for (const entry of record.entries) if (entry.status === 'sending') { entry.status = 'uncertain'; entry.error = UNCERTAIN; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Stored questions could not be read; data was left untouched.');
      record = { version: 1, sessionId, entries: [] };
    }
    this.cache.set(sessionId, record);
    return record;
  }
  private save(record: RecordData): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(record.sessionId), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('Question storage limit reached');
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      this.cache.set(record.sessionId, record);
    } catch { throw new Error('Questions could not be saved. Please retry.'); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  snapshot(sessionId: string, nativeId?: string): AgentQuestionState {
    return { items: this.load(sessionId).entries.filter(entry => active(entry) && entry.nativeId === nativeId)
      .map(({ answerHash: _hash, messageId: _id, delivery: _delivery, ...entry }) => structuredClone(entry) as AgentQuestion) };
  }
  add(sessionId: string, nativeId: string, sourceId: string, questions: AgentQuestionItem[]): string {
    const id = hash(nativeId + '\0' + sourceId);
    const current = this.load(sessionId);
    if (current.entries.some(entry => entry.id === id)) return id;
    if (current.entries.filter(active).length >= 20) throw new Error('Too many unanswered questions; answer or dismiss one first.');
    const entry = entrySchema.parse({ id, agent: 'codex', nativeId, sourceId, questions, status: 'pending', createdAt: Date.now() });
    const next = structuredClone(current);
    while (next.entries.length >= 256) {
      const index = next.entries.findIndex(item => !active(item));
      if (index < 0) throw new Error('Too many saved questions');
      next.entries.splice(index, 1);
    }
    next.entries.push(entry);
    this.save(next);
    return id;
  }
  begin(sessionId: string, nativeId: string, id: string, values: string[], retry = false): { duplicate?: 'steered' | 'queued'; messageId: string; text: string } {
    const next = structuredClone(this.load(sessionId)), entry = next.entries.find(item => item.id === id && item.nativeId === nativeId);
    if (!entry) throw new Error('Question not found for this agent session');
    const answers = z.array(z.string().trim().min(1).max(65_536)).length(entry.questions.length).parse(values);
    if (Buffer.byteLength(JSON.stringify(answers)) > 256 * 1024) throw new Error('Answers exceed the size limit');
    const answerHash = hash(JSON.stringify(answers));
    if (entry.status === 'answered') {
      if (entry.answerHash !== answerHash) throw new Error('This question was already answered');
      return { duplicate: entry.delivery!, messageId: entry.messageId!, text: '' };
    }
    if (entry.status === 'dismissed') throw new Error('This question was dismissed');
    if (entry.status === 'sending') throw new Error('An answer is already being submitted');
    if (entry.status === 'uncertain' && !retry) throw new Error(UNCERTAIN);
    entry.status = 'sending'; entry.answers = answers; entry.answerHash = answerHash;
    entry.messageId = crypto.randomUUID(); delete entry.error;
    this.save(next);
    return { messageId: entry.messageId, text: ['用户对先前异步提问的回答：', ...entry.questions.map((question, i) =>
      `${i + 1}. ${question.title}\n回答：${answers[i]}`)].join('\n\n') };
  }
  finish(sessionId: string, id: string, delivery: 'steered' | 'queued'): void {
    const next = structuredClone(this.load(sessionId)), entry = next.entries.find(item => item.id === id);
    if (!entry || entry.status !== 'sending') throw new Error('Question submission is no longer active');
    entry.status = 'answered'; entry.delivery = delivery; delete entry.answers; delete entry.error;
    this.save(next);
  }
  fail(sessionId: string, id: string, uncertain: boolean): void {
    const next = structuredClone(this.load(sessionId)), entry = next.entries.find(item => item.id === id);
    if (!entry || entry.status !== 'sending') return;
    entry.status = uncertain ? 'uncertain' : 'pending';
    entry.error = uncertain ? UNCERTAIN : 'Answer was not sent. Please retry.';
    this.save(next);
  }
  dismiss(sessionId: string, nativeId: string, id: string): void {
    const next = structuredClone(this.load(sessionId)), entry = next.entries.find(item => item.id === id && item.nativeId === nativeId);
    if (!entry) throw new Error('Question not found for this agent session');
    if (entry.status === 'sending') throw new Error('Wait for the current answer submission');
    if (!active(entry)) return;
    entry.status = 'dismissed'; delete entry.answers; delete entry.error;
    this.save(next);
  }
  clear(sessionId: string): void {
    const next = structuredClone(this.load(sessionId));
    if (!next.entries.some(active)) return;
    for (const entry of next.entries) if (active(entry)) { entry.status = 'dismissed'; delete entry.answers; delete entry.error; }
    this.save(next);
  }
  drop(sessionId: string): void {
    try { fs.unlinkSync(this.file(sessionId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.cache.delete(sessionId);
  }
}

export const agentQuestionStore = new AgentQuestionStore(path.join(config.home, 'agent-questions'));
