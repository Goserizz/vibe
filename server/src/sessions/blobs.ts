import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { ChatBlock } from '../../../shared/protocol.js';

/**
 * Persist-time externalization of oversized tool results.
 *
 * Normalized transcripts are append-only JSONL, and a single huge tool result
 * (a Read of a 10MB file, say) used to be appended verbatim — sessions grew to
 * 60MB+ and every later read paid for it. Above RESULT_EXTERNALIZE_LIMIT the
 * full text goes to a sidecar blob under ~/.vibe/blobs/<session>/<block>.txt
 * and the transcript line keeps a preview plus a `blob:` resultRef, so the
 * on-demand full-text endpoint can still serve the original bytes.
 */

/** Tool results longer than this are externalized at persist time. */
export const RESULT_EXTERNALIZE_LIMIT = 1024 * 1024;
/** Preview kept in the transcript line when a result is externalized. */
const PERSIST_PREVIEW_LIMIT = 200 * 1024;

/** Filesystem-safe, collision-resistant-enough slug for dir/file names. */
function slug(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(-80) || 'x'
  );
}

/** Blob sidecar path for one externalized result. */
export function blobFileFor(sessionId: string, blockId: string): string {
  return path.join(config.blobsDir, slug(sessionId), `${slug(blockId)}.txt`);
}

/** Validate + resolve a `blob:<session>/<block>` ref to a path (no traversal:
 *  the charset was already restricted by slug(), re-check it here). */
export function resolveBlobRef(ref: string): string | null {
  if (!ref.startsWith('blob:')) return null;
  const rest = ref.slice('blob:'.length);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(rest)) return null;
  return path.join(config.blobsDir, rest + '.txt');
}

/** Read a blob's full text (bounded by the same cap as raw file downloads). */
export function readBlobText(ref: string): string | null {
  const file = resolveBlobRef(ref);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (stat.size > 25 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Replace oversized tool results with preview + blob ref, writing the full
 * text to its sidecar. Returns the input array (same identity) when nothing
 * crossed the threshold. Failures to write a blob keep the full result in the
 * transcript line — persistence must never lose data.
 */
export function externalizeResults(sessionId: string, blocks: ChatBlock[]): ChatBlock[] {
  let changed = false;
  const out = blocks.map((block) => {
    if (block.kind !== 'tool' || typeof block.result !== 'string') return block;
    const result = block.result;
    if (result.length <= RESULT_EXTERNALIZE_LIMIT) return block;
    try {
      const file = blobFileFor(sessionId, block.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, result, 'utf8');
    } catch (err) {
      log.warn('failed to externalize tool result; keeping full text in transcript', err);
      return block;
    }
    changed = true;
    return {
      ...block,
      result: result.slice(0, PERSIST_PREVIEW_LIMIT),
      resultTruncated: true,
      resultSize: result.length,
      resultRef: `blob:${slug(sessionId)}/${slug(block.id)}`,
    };
  });
  return changed ? out : blocks;
}
