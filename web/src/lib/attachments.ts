/** Shared helpers for chat file attachments.
 *
 * Attachments are conveyed to the agent purely through the prompt text: the
 * Composer uploads each file, then folds the returned on-host paths into the
 * message via {@link buildMessage}. The exact header below is the sentinel the
 * UI strips back out ({@link stripAttachments}) when rendering the user's own
 * bubble, so the agent still sees the paths but the user doesn't see this
 * boilerplate. Keep the two in sync. */
export const ATTACHMENT_HEADER =
  'The following file(s) are attached to this message — read them with your file-reading tools before responding:';

/** Fold uploaded attachment paths into the prompt so the agent reads them with
 *  its own file tools (works for every agent, incl. SSH-remote sessions). */
export function buildMessage(text: string, paths: string[]): string {
  const clean = text.trim();
  if (!paths.length) return clean;
  const list = paths.map((p) => `- ${p}`).join('\n');
  return clean ? `${clean}\n\n${ATTACHMENT_HEADER}\n${list}` : `${ATTACHMENT_HEADER}\n${list}`;
}

/** The inverse of {@link buildMessage}: split a stored user message into the
 *  part the user actually typed and the attachment paths (if any). Used when
 *  rendering the user bubble so the boilerplate block is hidden. */
export function stripAttachments(input: string): { text: string; files: string[] } {
  const idx = input.indexOf(ATTACHMENT_HEADER);
  if (idx < 0) return { text: input, files: [] };
  const before = input.slice(0, idx).replace(/\s+$/, '');
  const rest = input.slice(idx + ATTACHMENT_HEADER.length);
  const files = rest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  return { text: before, files };
}
