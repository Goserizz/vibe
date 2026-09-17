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

import type { DiscoveredSession } from '../sessions/discovery.js';

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

// ---------------------------------------------------------------------------
// Incremental bundles
//
// The bundle commands stream every listed item's body on every probe, which on
// transcript-heavy hosts meant tens of MB per 60s discovery cycle. Incremental
// mode passes the previously seen `|key:mtime|…` set to the remote command on
// stdin (`KNOWN=$(cat)` first line) and the loop skips the body for items whose
// mtime is already known — the parser then reuses the cached session for the
// empty bodies. State lives here, deliberately OUTSIDE the per-cycle discovery
// caches (which are wiped every refresh).
// ---------------------------------------------------------------------------

const knownMtimes = new Map<string, Map<string, string>>();
const sessionByFile = new Map<string, Map<string, DiscoveredSession>>();

/** KNOWN set for a scope, in the `|key:mtime|…` form the skip guard matches. */
export function bundleKnownStdin(scope: string): string {
  const known = knownMtimes.get(scope);
  return known ? [...known].map(([k, m]) => `|${k}:${m}|`).join('') : '';
}

/** First line every incremental bundle command needs: capture the known-set. */
export const BUNDLE_KNOWN_HEADER = 'KNOWN=$(cat)';

/** Skip the body when the item's key+mtime is already known (shell vars
 *  `$f`/`$m` by default; pass the item's path variable if it differs). */
export function bundleSkipGuard(fileVar: string, headCmd: string): string {
  return `case "$KNOWN" in *"|${fileVar}:$m|"*) ;; *) ${headCmd} ;; esac`;
}

/** Cached session for an unchanged item (empty body), if we have one. */
export function cachedBundleSession(scope: string, key: string): DiscoveredSession | undefined {
  return sessionByFile.get(scope)?.get(key);
}

/** Record a parsed session (and its mtime) for future incremental reuse. */
export function noteBundleSession(scope: string, key: string, mtime: string, session: DiscoveredSession): void {
  let known = knownMtimes.get(scope);
  if (!known) knownMtimes.set(scope, (known = new Map()));
  known.set(key, mtime);
  let metas = sessionByFile.get(scope);
  if (!metas) sessionByFile.set(scope, (metas = new Map()));
  metas.set(key, session);
}

/** Record the mtime of an item whose body arrived but yielded no session. */
export function noteBundleKey(scope: string, key: string, mtime: string): void {
  let known = knownMtimes.get(scope);
  if (!known) knownMtimes.set(scope, (known = new Map()));
  known.set(key, mtime);
}
