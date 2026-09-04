import path from 'node:path';

// Mirrored from CodeBuddy 2.141.0's `compressWorkspacePathName`. Session
// lookup derives this key from `process.cwd()` (after realpath), so a trailing
// slash mismatch alone is enough to make `codebuddy -r` miss a transcript.
const PROJECT_KEY_MAX_BYTES = 255;
const PROJECT_KEY_PREFIX_BYTES = 180;

function djb2Base36(value: string): string {
  let hash = 5381;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash = ((hash * 33) ^ byte) >>> 0;
  }
  return hash.toString(36);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += codePoint;
  }
  return result;
}

/** CodeBuddy's native project-directory key for a cwd. */
export function codebuddyProjectKey(cwd: string): string {
  const normalized = cwd
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
  if (Buffer.byteLength(normalized, 'utf8') <= PROJECT_KEY_MAX_BYTES) return normalized;
  return `${truncateUtf8(normalized, PROJECT_KEY_PREFIX_BYTES)}-${djb2Base36(normalized)}`;
}

/** Directory key emitted by Vibe before the trailing-slash fix. Used only to
 * recover already-converted sessions; new writes must use `codebuddyProjectKey`. */
export function legacyCodebuddyProjectKey(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/\//g, '-');
}

/** Match the CLI's cwd equality semantics on POSIX SSH hosts. */
export function comparableCodebuddyCwd(cwd: string): string {
  const normalized = path.posix.normalize(cwd.trim().replace(/\\/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}
