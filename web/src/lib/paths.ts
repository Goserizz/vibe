/** Spotting file paths inside agent replies so they can be clicked open in a
 *  preview. Precision matters far more than recall here: a false positive turns
 *  an ordinary word into a misleading "click to view" chip, while a missed path
 *  is simply not clickable. So a path must contain a slash AND end in a short
 *  extension, and anything URL-shaped is refused. */

const EXT_RE = /(?:^|\/)[^\s/]+\.[A-Za-z][A-Za-z0-9]{0,11}$/;

/** True when `input` reads like a single file path worth of clicking open —
 *  e.g. `src/components/Foo.tsx`, `~/notes.txt`, `/etc/hosts.conf`,
 *  `web/src/index.css`. Rejects `useState`, `npm run build`, bare `a/b`,
 *  version strings, and URLs. */
export function looksLikeFilePath(input: string): boolean {
  const t = input.trim();
  if (t.length < 3 || t.length > 512) return false;
  if (!t.includes('/')) return false;
  if (/\s/.test(t)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t) || t.includes('://')) return false;
  return EXT_RE.test(t);
}

/** Resolve a path that appeared in a reply against the session's cwd before
 *  asking the server to read it. Absolute (`/`) and home (`~`) paths are passed
 *  through unchanged (the server expands `~`); relative paths are joined onto
 *  the cwd so `web/src/foo.ts` opens from the right project root. */
export function resolveFilePath(input: string, cwd: string): string {
  const p = input.trim();
  if (!p) return p;
  if (p.startsWith('~') || p.startsWith('/')) return p;
  const base = cwd.replace(/\/+$/, '');
  return base ? `${base}/${p.replace(/^\.?\//, '')}` : p;
}
