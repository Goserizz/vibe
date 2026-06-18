/**
 * Vibe session ids are namespaced by host so local and remote sessions can
 * coexist in one list and route correctly. Local ids are the bare Claude
 * session id; remote ids are `<host>::<claudeSessionId>`.
 */
const SEP = '::';

export function encodeRemoteId(host: string, claudeSessionId: string): string {
  return `${host}${SEP}${claudeSessionId}`;
}

export function parseSessionId(id: string): { host?: string; claudeSessionId: string } {
  const i = id.indexOf(SEP);
  if (i < 0) return { claudeSessionId: id };
  return { host: id.slice(0, i), claudeSessionId: id.slice(i + SEP.length) };
}
