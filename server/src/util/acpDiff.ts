/**
 * Render an ACP `{type:'diff', path, oldText, newText}` tool-call content item
 * as pseudo-unified-diff text (`--- path` / `+++ path` / `-old` / `+new`) —
 * the shape web's editChangeLines/writeChangeLines already parse into +/- lines.
 *
 * ACP sends whole-file old/new states, while typical LLM edits touch one
 * contiguous block, so common prefix/suffix lines are trimmed to recover the
 * minimal changed region without a diff library; whole-file rewrites degrade
 * to full -/+ . Items without any text fields (or with identical texts) fall
 * back to the historical `diff <path>` placeholder.
 */
export function acpDiffText(item: unknown): string {
  const it = (item ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const path = str(it.path) ?? '';
  const fallback = `diff ${path}`;

  const oldS = str(it.oldText) ?? str(it.old_string);
  const newS = str(it.newText) ?? str(it.new_string);
  if (oldS == null && newS == null) return fallback;

  const oldLines = (oldS ?? '').split('\n');
  const newLines = (newS ?? '').split('\n');

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }

  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);
  if (!removed.length && !added.length) return fallback;

  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);
  return lines.join('\n');
}
