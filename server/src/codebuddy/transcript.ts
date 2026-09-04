import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { externalizeResults } from '../sessions/blobs.js';
import { log } from '../log.js';
import {
  splitLegacyAssistantThinkingReference,
  upsertTurnThinkingArchive,
} from '../switch/canonical.js';
import type { ChatBlock, ToolBlock } from '../../../shared/protocol.js';

function transcriptFile(sessionId: string): string {
  return path.join(config.codebuddyTranscriptsDir, `${encodeURIComponent(sessionId)}.jsonl`);
}

/** Read the normalized transcript persisted for a CodeBuddy session Vibe drove. */
export function readCodebuddyTranscript(sessionId: string): ChatBlock[] {
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const blocks: ChatBlock[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const block = JSON.parse(line) as ChatBlock;
      // Empty thinking shells are debris from generations the engine cancelled
      // mid-stream (written before the normalizer learned to hold them back),
      // and history is static — a persisted streaming flag would render as a
      // "Thinking…" row that never resolves.
      if (block.kind === 'thinking') {
        if (!block.text) continue;
        if (block.streaming) block.streaming = false;
      }
      // Adjacent assistant blocks of one generation with identical text are the
      // overlay misalignment the normalizer used to write (final text part
      // landed on the thinking slot next to its streamed copy) — keep one.
      if (
        block.kind === 'assistant' && block.text &&
        block.id.includes(':')
      ) {
        const gen = block.id.slice(0, block.id.lastIndexOf(':'));
        const prev = blocks[blocks.length - 1];
        if (
          prev?.kind === 'assistant' && prev.text === block.text &&
          prev.id.startsWith(`${gen}:`)
        ) {
          continue;
        }
      }
      blocks.push(block);
    } catch {
      /* skip corrupt line */
    }
  }
  return migrateLegacyThinkingBlocks(blocks).blocks;
}

export function appendCodebuddyBlocks(sessionId: string, blocks: ChatBlock[]): void {
  if (!blocks.length) return;
  try {
    fs.mkdirSync(config.codebuddyTranscriptsDir, { recursive: true });
    const persisted = externalizeResults(sessionId, blocks);
    fs.appendFileSync(transcriptFile(sessionId), `${persisted.map((block) => JSON.stringify(block)).join('\n')}\n`);
  } catch (error) {
    log.warn('failed to persist codebuddy transcript', error);
  }
}

export function deleteCodebuddyTranscript(sessionId: string): void {
  try {
    fs.rmSync(transcriptFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Native transcript format
// ---------------------------------------------------------------------------

/**
 * CodeBuddy keeps transcripts at ~/.codebuddy/projects/<encoded-cwd>/<id>.jsonl
 * (the Claude directory layout, but its own line schema — closer to an OpenAI
 * responses log than Claude's). Entry shapes probed on 2.141.0:
 *   message:user        {content:[{type:'input_text',text}]}
 *   message:assistant   {content:[{type:'output_text',text}], providerData.model}
 *   reasoning           {rawContent:[{type:'reasoning_text',text}]}
 *   function_call       {name, callId, arguments:'<json>'}
 *   function_call_result{name, callId, status, output:{type:'text',text}}
 * All entries carry top-level id/parent_id-style ids, epoch-ms timestamps,
 * sessionId and cwd; file-history-snapshot entries are bookkeeping.
 */

interface NativeEntry {
  type?: string;
  role?: string;
  id?: string;
  timestamp?: number;
  sessionId?: string;
  cwd?: string;
  content?: any[];
  rawContent?: any[];
  providerData?: { model?: string };
  name?: string;
  callId?: string;
  arguments?: string;
  status?: string;
  output?: { type?: string; text?: string } | string;
  durationMs?: number;
}

export interface LegacyBlocksMigrationResult {
  blocks: ChatBlock[];
  changedReferences: number;
}

/**
 * Turn assistant-side legacy wrappers back into normalized thinking blocks.
 * This keeps old CodeBuddy sessions safe as a future switch source even before
 * their native JSONL has been rewritten on disk.
 */
export function migrateLegacyThinkingBlocks(
  input: readonly ChatBlock[],
): LegacyBlocksMigrationResult {
  const blocks: ChatBlock[] = [];
  const ids = new Set(input.map((block) => block.id));
  let changedReferences = 0;

  for (const block of input) {
    if (block.kind !== 'assistant') {
      blocks.push(block);
      continue;
    }
    const legacy = splitLegacyAssistantThinkingReference(block.text);
    if (!legacy) {
      blocks.push(block);
      continue;
    }

    let thinkingId = `${block.id}:migrated-thinking`;
    let suffix = 2;
    while (ids.has(thinkingId)) {
      thinkingId = `${block.id}:migrated-thinking-${suffix}`;
      suffix += 1;
    }
    ids.add(thinkingId);
    blocks.push({
      id: thinkingId,
      kind: 'thinking',
      text: legacy.thinking,
      streaming: false,
      ts: block.ts,
    });
    blocks.push({ ...block, text: legacy.text, streaming: false });
    changedReferences += 1;
  }

  return { blocks, changedReferences };
}

export interface LegacyContentMigrationResult {
  content: string;
  changedReferences: number;
}

interface ParsedNativeLine {
  raw: string;
  entry?: NativeEntry;
  changed: boolean;
}

function parsedJsonlLines(content: string): { lines: ParsedNativeLine[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith('\n');
  const rawLines = content.split('\n');
  if (trailingNewline) rawLines.pop();
  return {
    trailingNewline,
    lines: rawLines.map((raw) => {
      if (!raw.trim()) return { raw, changed: false };
      try {
        return { raw, entry: JSON.parse(raw) as NativeEntry, changed: false };
      } catch {
        return { raw, changed: false };
      }
    }),
  };
}

function serializeParsedJsonl(lines: ParsedNativeLine[], trailingNewline: boolean): string {
  const content = lines
    .map((line) => line.changed && line.entry ? JSON.stringify(line.entry) : line.raw)
    .join('\n');
  return trailingNewline ? `${content}\n` : content;
}

/**
 * Rewrite a native CodeBuddy transcript produced by the old adapter:
 *
 *   user "question" -> assistant "[thinking wrapper] answer"
 *
 * becomes:
 *
 *   user "question + migration archive" -> assistant "answer"
 *
 * The existing ids, parent chain, timestamps, provider metadata, unknown lines
 * and non-text content parts remain untouched. If an assistant has no preceding
 * user record it is intentionally left alone rather than silently losing data.
 */
export function migrateLegacyCodebuddyNativeJsonl(content: string): LegacyContentMigrationResult {
  const parsed = parsedJsonlLines(content);
  let lastUserLine: ParsedNativeLine | undefined;
  let lastUserTextPart: { text?: string } | undefined;
  let assistantIndex = 0;
  let changedReferences = 0;

  for (const line of parsed.lines) {
    const entry = line.entry;
    if (!entry || entry.type !== 'message') continue;

    if (entry.role === 'user') {
      const part = Array.isArray(entry.content)
        ? entry.content.find((candidate: any) =>
            candidate?.type === 'input_text' && typeof candidate.text === 'string') as { text?: string } | undefined
        : undefined;
      lastUserLine = part ? line : undefined;
      lastUserTextPart = part;
      assistantIndex = 0;
      continue;
    }

    if (entry.role !== 'assistant') continue;
    if (lastUserLine && lastUserTextPart) {
      for (const part of Array.isArray(entry.content) ? entry.content : []) {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') continue;
        const legacy = splitLegacyAssistantThinkingReference(part.text);
        if (!legacy) continue;
        lastUserTextPart.text = upsertTurnThinkingArchive(
          lastUserTextPart.text ?? '',
          assistantIndex,
          legacy.thinking,
        );
        part.text = legacy.text;
        lastUserLine.changed = true;
        line.changed = true;
        changedReferences += 1;
      }
    }
    assistantIndex += 1;
  }

  return {
    content: changedReferences
      ? serializeParsedJsonl(parsed.lines, parsed.trailingNewline)
      : content,
    changedReferences,
  };
}

/** Rewrite Vibe's normalized CodeBuddy JSONL while preserving corrupt or
 * unknown lines byte-for-byte. Each migrated wrapper expands to a thinking
 * block followed by the clean assistant reply. */
export function migrateLegacyCodebuddyVibeJsonl(content: string): LegacyContentMigrationResult {
  const trailingNewline = content.endsWith('\n');
  const rawLines = content.split('\n');
  if (trailingNewline) rawLines.pop();
  const output: string[] = [];
  const ids = new Set<string>();
  let changedReferences = 0;

  for (const raw of rawLines) {
    if (!raw.trim()) {
      output.push(raw);
      continue;
    }
    let block: ChatBlock;
    try {
      block = JSON.parse(raw) as ChatBlock;
    } catch {
      output.push(raw);
      continue;
    }
    if (typeof block.id === 'string') ids.add(block.id);
    if (block.kind !== 'assistant' || typeof block.text !== 'string') {
      output.push(raw);
      continue;
    }
    const legacy = splitLegacyAssistantThinkingReference(block.text);
    if (!legacy) {
      output.push(raw);
      continue;
    }

    let thinkingId = `${block.id}:migrated-thinking`;
    let suffix = 2;
    while (ids.has(thinkingId)) {
      thinkingId = `${block.id}:migrated-thinking-${suffix}`;
      suffix += 1;
    }
    ids.add(thinkingId);
    output.push(JSON.stringify({
      id: thinkingId,
      kind: 'thinking',
      text: legacy.thinking,
      streaming: false,
      ts: block.ts,
    }));
    output.push(JSON.stringify({ ...block, text: legacy.text, streaming: false }));
    changedReferences += 1;
  }

  if (!changedReferences) return { content, changedReferences };
  const rewritten = output.join('\n');
  return {
    content: trailingNewline ? `${rewritten}\n` : rewritten,
    changedReferences,
  };
}

const INTERNAL_PREFIXES = ['<command-name>', '<local-command-stdout>', '<command-message>', 'Caveat:'];

function isInternal(text: string): boolean {
  const t = text.trimStart();
  return !t || INTERNAL_PREFIXES.some((p) => t.startsWith(p));
}

function toMs(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function textOf(content: unknown[] | undefined, kind: string): string | null {
  let out: string | null = null;
  for (const part of (Array.isArray(content) ? content : []) as any[]) {
    if (part?.type === kind && typeof part.text === 'string' && part.text && !isInternal(part.text)) {
      out = part.text;
      break;
    }
  }
  return out;
}

/**
 * Parse native CodeBuddy JSONL content into normalized blocks. Tool results
 * fold into their function_call block by callId. Shared by the local reader
 * and the remote (gzip-over-SSH) reader.
 */
export function parseCodebuddyBlocks(content: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const toolByCallId = new Map<string, ToolBlock>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e: NativeEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = toMs(e.timestamp);
    const baseId = e.id ?? `cb_${blocks.length}`;
    if (e.type === 'message' && e.role === 'user') {
      const text = textOf(e.content, 'input_text');
      if (text) blocks.push({ id: baseId, kind: 'user', text, ts });
    } else if (e.type === 'message' && e.role === 'assistant') {
      const text = textOf(e.content, 'output_text');
      if (text) blocks.push({ id: baseId, kind: 'assistant', text, streaming: false, ts });
    } else if (e.type === 'reasoning') {
      const text = textOf(e.rawContent ?? e.content, 'reasoning_text');
      if (text) blocks.push({ id: baseId, kind: 'thinking', text, streaming: false, ts });
    } else if (e.type === 'function_call') {
      const callId = String(e.callId ?? baseId);
      let input: unknown = {};
      try {
        input = JSON.parse(e.arguments ?? '{}');
      } catch {
        input = { raw: e.arguments };
      }
      const block: ToolBlock = {
        id: callId,
        kind: 'tool',
        toolUseId: callId,
        name: String(e.name ?? 'tool'),
        input,
        status: 'running',
        ts,
      };
      toolByCallId.set(callId, block);
      blocks.push(block);
    } else if (e.type === 'function_call_result') {
      const callId = String(e.callId ?? '');
      const text = typeof e.output === 'string' ? e.output : e.output?.text;
      const target = toolByCallId.get(callId);
      if (target) {
        target.result = text ?? '';
        target.status = e.status === 'failed' ? 'error' : 'done';
        target.isError = e.status === 'failed';
      }
    } else if (e.type === 'turn-metrics') {
      blocks.push({
        id: baseId,
        kind: 'result',
        durationMs: Number.isFinite(Number(e.durationMs)) ? Number(e.durationMs) : undefined,
        isError: false,
        ts,
      });
    }
  }
  return migrateLegacyThinkingBlocks(blocks).blocks;
}

export interface NativeHeadMeta {
  cwd: string;
  title: string;
  model: string;
  createdAt: number;
  messageCount: number;
}

/** Derive a session's display metadata from the head of its native transcript. */
export function parseCodebuddyHeadMeta(lines: Iterable<string>): NativeHeadMeta | null {
  let cwd = '';
  let title = '';
  let model = '';
  let createdAt = 0;
  let messageCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: NativeEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (!createdAt && Number.isFinite(Number(e.timestamp))) createdAt = Number(e.timestamp);
    if (!model && e.type === 'message' && e.providerData?.model) model = e.providerData.model;
    if (!model && e.type === 'reasoning' && e.providerData?.model) model = e.providerData.model;
    if (e.type === 'message' && (e.role === 'user' || e.role === 'assistant')) {
      messageCount += 1;
      if (!title && e.role === 'user') {
        const text = textOf(e.content, 'input_text');
        if (text) title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
    }
  }
  if (messageCount === 0) return null; // no real conversation (e.g. a phantom session)
  return { cwd, title: title || 'CodeBuddy session', model, createdAt, messageCount };
}

/** Locate a native transcript by session id (scan project dirs — the cwd
 *  encoding in the directory name is lossy, like Claude's). */
export function findCodebuddyTranscriptFile(sessionId: string): string | null {
  const root = config.codebuddyProjectsDir;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = `${sessionId}.jsonl`;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, target);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function atomicReplaceText(file: string, content: string): void {
  const tmp = `${file}.vibe-thinking-migration-${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // The caller only uses existing files; retain a private fallback mode.
  }
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export interface LegacyCodebuddyRepairResult {
  nativeReferences: number;
  vibeReferences: number;
}

export interface LegacyCodebuddyRepairFiles {
  /** Test/recovery override; production normally resolves by native id. */
  nativeFile?: string;
  /** Test/recovery override; production normally uses Vibe's transcript path. */
  vibeFile?: string;
}

/**
 * One-time, idempotent repair for sessions built by the assistant-side
 * thinking-carry implementation. It is called immediately before a stored
 * local CodeBuddy runtime resumes, while no runner is writing either file.
 */
export function repairLegacyCodebuddyThinkingCarry(
  vibeSessionId: string,
  nativeSessionId: string,
  files: LegacyCodebuddyRepairFiles = {},
): LegacyCodebuddyRepairResult {
  let nativeReferences = 0;
  let vibeReferences = 0;

  const nativeFile = files.nativeFile ?? findCodebuddyTranscriptFile(nativeSessionId);
  if (nativeFile) {
    try {
      const raw = fs.readFileSync(nativeFile, 'utf8');
      const migrated = migrateLegacyCodebuddyNativeJsonl(raw);
      if (migrated.changedReferences) {
        atomicReplaceText(nativeFile, migrated.content);
        nativeReferences = migrated.changedReferences;
      }
    } catch (error) {
      log.warn('failed to repair legacy CodeBuddy native thinking references', nativeSessionId, error);
    }
  }

  const vibeFile = files.vibeFile ?? transcriptFile(vibeSessionId);
  try {
    const raw = fs.readFileSync(vibeFile, 'utf8');
    const migrated = migrateLegacyCodebuddyVibeJsonl(raw);
    if (migrated.changedReferences) {
      atomicReplaceText(vibeFile, migrated.content);
      vibeReferences = migrated.changedReferences;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('failed to repair legacy Vibe CodeBuddy transcript', vibeSessionId, error);
    }
  }

  if (nativeReferences || vibeReferences) {
    log.info(
      `repaired legacy CodeBuddy thinking carry session=${vibeSessionId}`,
      `native=${nativeReferences} vibe=${vibeReferences}`,
    );
  }
  return { nativeReferences, vibeReferences };
}

/** Read a native CodeBuddy session's transcript into normalized blocks. */
export function readCodebuddyNativeTranscript(sessionId: string): ChatBlock[] {
  const file = findCodebuddyTranscriptFile(sessionId);
  if (!file) return [];
  try {
    return parseCodebuddyBlocks(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.warn('failed to read codebuddy transcript', sessionId, error);
    return [];
  }
}
