import { log } from '../log.js';
import { isClaudeSessionId } from '../sessions/discovery.js';
import type { RemoteHost } from '../../../shared/protocol.js';
import { loginShellCommand, shQuote, sshExec } from './ssh.js';

// Record/field separators (control chars) keep the bundle unambiguous vs JSON,
// matching remote/discovery.ts. JSON escapes control chars, so RS/FS never
// appear inside field data.
const RS = '\x1e';
const FS = '\x1f';

export interface RemoteSearchHit {
  claudeSessionId: string;
  mtime: number;
  /** First ~40 lines of the transcript (for cwd/model/title metadata). */
  head: string;
  /** Raw JSONL lines that matched the query (for snippet extraction). */
  matches: string;
}

/**
 * Build the remote bundle command. Each term gets its own `Q<n>` variable,
 * single-quoted via `shQuote`, so the remote shell treats them literally and
 * `grep -F` matches them as fixed strings (regex metacharacters in the query
 * are inert). Used directly with `sshExec` — like `BUNDLE_CMD`, it relies only
 * on POSIX utilities (`ls`, `grep`, `stat`, `head`, `basename`, `printf`) that
 * exist without sourcing the login shell.
 *
 * The greps take one `-e <term>` per term (OR): the prefilter only nominates
 * files that might satisfy the AND of all terms — the caller's findHits does
 * the precise per-term filtering on the pulled-back lines, so one SSH
 * round-trip still suffices.
 *
 * Each matching file emits three RS-separated segments: marker(id\x1fmtime),
 * the file head, and the matching lines. Splitting on RS yields records in
 * groups of three (the leading "" + per-group marker/head/matches).
 */
function bundleCmd(terms: string[]): string {
  const pats = terms.map((_, i) => `-e "$Q${i}"`).join(' ');
  return [
    ...terms.map((t, i) => `Q${i}=${shQuote(t)}`),
    'cd ~/.claude/projects 2>/dev/null || exit 0',
    // `./*/*.jsonl` (not `*/*.jsonl`) so project dirs starting with "-" aren't
    // read as `ls` flags. Most-recent first, bounded so a huge history stays
    // responsive.
    'ls -1t ./*/*.jsonl 2>/dev/null | head -200 | while IFS= read -r f; do',
    `  if grep -iqF ${pats} -- "$f" 2>/dev/null; then`,
    '    id=$(basename "$f" .jsonl)',
    '    m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)',
    `    printf '${RS}%s${FS}%s${RS}\\n' "$id" "$m"`,
    '    head -n 40 "$f"',
    `    printf '${RS}\\n'`,
    `    grep -iF ${pats} -- "$f" 2>/dev/null | head -n 15 | head -c 65536`,
    '  fi',
    'done',
  ].join('\n');
}

/**
 * Find conversations on a remote host whose message text contains every term
 * (the AND is enforced by the caller's findHits; here grep only narrows the
 * transfer to files containing at least one term). One SSH round-trip: `grep`
 * filters files on the remote side (cheap), so only matching files contribute
 * any content to the transfer.
 */
export async function searchRemoteHost(host: RemoteHost, terms: string[]): Promise<RemoteSearchHit[]> {
  if (terms.length === 0) return [];
  const res = await sshExec(host.ssh, loginShellCommand(bundleCmd(terms)), { timeoutMs: 20_000 });
  if (res.code !== 0) {
    log.debug(`remote search failed for ${host.name}`, res.stderr.trim().slice(0, 120));
    return [];
  }

  const hits: RemoteSearchHit[] = [];
  const parts = res.stdout.split(RS);
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const [idStr, mtimeStr] = parts[i].split(FS);
    if (!idStr || !isClaudeSessionId(idStr)) continue;
    const mtime = (Number(mtimeStr) || 0) * 1000 || Date.now();
    hits.push({ claudeSessionId: idStr, mtime, head: parts[i + 1], matches: parts[i + 2] });
  }
  return hits;
}
