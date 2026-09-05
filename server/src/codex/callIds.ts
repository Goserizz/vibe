import { createHash } from 'node:crypto';

/** Responses rejects replayed tool call IDs longer than 64 characters. Source
 * engines may use composite IDs (for example, two UUIDs and a tool index). */
export const CODEX_CALL_ID_MAX_LENGTH = 64;

/** Allocate aliases for oversized IDs, reserving every unchanged source ID
 * first. A plain substring could merge calls with the same prefix; a digest
 * plus collision resolution keeps both calls and their outputs distinct. */
export function codexCallIdAliases(sourceIds: Iterable<string>): Map<string, string> {
  const ids = [...new Set(sourceIds)].sort();
  const reserved = new Set(ids.filter((id) => id.length <= CODEX_CALL_ID_MAX_LENGTH));
  const aliases = new Map<string, string>();
  for (const id of ids) {
    if (id.length <= CODEX_CALL_ID_MAX_LENGTH) continue;
    let attempt = 0;
    let alias: string;
    do {
      const digest = createHash('sha256').update(JSON.stringify([id, attempt++])).digest('hex');
      alias = `call_vibe_${digest.slice(0, CODEX_CALL_ID_MAX_LENGTH - 'call_vibe_'.length)}`;
    } while (reserved.has(alias));
    reserved.add(alias);
    aliases.set(id, alias);
  }
  return aliases;
}
