/**
 * Shared framing for "bundle" SSH commands: one round-trip that emits, per
 * item, a marker line (a few tab-free fields) followed by that item's raw file
 * content. Control characters are used as separators because JSON escapes them,
 * so they can never appear inside the payloads we ship (transcripts, metadata).
 *
 *   RS field1 FS field2 ... RS \n <body...>
 *
 * Splitting the whole stdout on RS therefore yields
 * `["", marker0, body0, marker1, body1, …]` — pairs after the leading empty
 * segment. This mirrors `remote/discovery.ts` (Claude) and `remote/search.ts`,
 * which predate this helper.
 */

export const RS = '\x1e';
export const FS = '\x1f';

export interface BundleRecord {
  /** Marker fields, in the order the remote `printf` emitted them. */
  fields: string[];
  /** Everything until the next marker (the file head / command output). */
  body: string;
}

/** Build the remote `printf` that emits a marker for the given shell words. */
export function markerCmd(words: string[]): string {
  const fmt = words.map(() => '%s').join(FS);
  return `printf '${RS}${fmt}${RS}\\n' ${words.join(' ')}`;
}

/** Shell snippet producing a file's mtime in seconds (GNU + BSD `stat`). */
export function mtimeExpr(fileWord: string): string {
  return `$(stat -c %Y ${fileWord} 2>/dev/null || stat -f %m ${fileWord} 2>/dev/null)`;
}

/** Split a bundle's stdout back into marker/body records. */
export function parseBundle(stdout: string): BundleRecord[] {
  const parts = stdout.split(RS);
  const out: BundleRecord[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    out.push({ fields: parts[i].split(FS), body: parts[i + 1] });
  }
  return out;
}

/** Remote seconds-since-epoch → local ms, falling back to "now". */
export function bundleMtimeMs(raw: string | undefined): number {
  return (Number(raw) || 0) * 1000 || Date.now();
}
