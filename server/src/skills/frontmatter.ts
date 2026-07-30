/**
 * Minimal, round-trip-safe parser/serializer for SKILL.md frontmatter.
 *
 * Claude Code skills are `SKILL.md` files with a YAML frontmatter block
 * (between `---` fences) followed by a markdown body. We only ever *manage*
 * three scalar keys — `name`, `description`, `whenToUse` — so we hand-roll the
 * parsing instead of pulling in a YAML dependency. Any other frontmatter key
 * the original file carries (`version`, `allowed-tools` lists, `user-invocable`,
 * …) is preserved verbatim and re-emitted in its original position, so editing
 * a skill through the UI never clobbers fields we don't understand.
 *
 * Known limitation: multi-line block scalars (`|` / `>`) and multi-line quoted
 * strings are read as a single line. The official Claude Code skill schema only
 * uses single-line scalars + simple lists, so this is fine in practice.
 */

export interface ParsedSkill {
  /** Frontmatter `name` (independent of the directory key). */
  name?: string;
  description: string;
  whenToUse?: string;
  /** Markdown below the closing `---` fence. */
  body: string;
  /** Frontmatter key order (managed + extra), for faithful re-serialization. */
  order: string[];
  /** Raw lines (incl. the key line + continuations) for non-managed keys. */
  extra: Record<string, string[]>;
}

/** Strip one surrounding pair of quotes (YAML double or single). */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Serialize a scalar value: bare when it's safe, double-quoted otherwise. */
function scalar(v: string): string {
  if (v === '') return '""';
  // Quote if it has newlines, a colon/hash (YAML mapping/comment hazards),
  // surrounding spaces, or a leading char YAML treats specially.
  if (
    /[\n\r]/.test(v) ||
    /[:#]/.test(v) ||
    /^\s|\s$/.test(v) ||
    /^[!&*?>|@%[\]{},"'#`-]/.test(v)
  ) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return v;
}

/** A YAML block-scalar indicator on a managed key (`>`, `|-`, `>+`, …). */
function isBlockIndicator(rest: string): boolean {
  return /^[>|][+-]?$/.test(rest.trim());
}

/**
 * Fold a block scalar's continuation lines into a string. Folded (`>`) joins
 * lines with spaces; literal (`|`) keeps newlines. Chomping and exact YAML
 * whitespace rules are approximated — this only needs to produce a readable
 * value for display of read-only skills (we never re-serialize these).
 */
function foldBlock(indicator: string, block: string[]): string {
  const nonEmpty = block.filter((l) => l.trim() !== '');
  if (!nonEmpty.length) return '';
  const indent = Math.min(...nonEmpty.map((l) => l.match(/^ */)![0].length));
  const dedented = block.map((l) => l.slice(indent));
  let body = dedented.slice();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return indicator[0] === '>' ? body.map((l) => l.trim()).filter(Boolean).join(' ') : body.join('\n');
}

/** Detect a top-level frontmatter key line: `key: …` (not indented). */
const TOP_KEY = /^([A-Za-z][\w-]*):[ \t]*(.*)$/;

/**
 * Parse a SKILL.md file. If there is no opening `---` fence, the whole file is
 * treated as body with empty frontmatter.
 */
export function parseSkill(raw: string): ParsedSkill {
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++; // skip leading blanks

  let frontmatter: string[] = [];
  let bodyStart = 0;
  let hasFm = false;

  if (i < lines.length && lines[i].trim() === '---') {
    hasFm = true;
    const fmStart = i + 1;
    let end = fmStart;
    while (end < lines.length && lines[end].trim() !== '---' && lines[end].trim() !== '...') end++;
    frontmatter = lines.slice(fmStart, end);
    bodyStart = end < lines.length ? end + 1 : end;
    // Drop exactly one blank line between the closing fence and the body.
    if (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++;
  }

  const result: ParsedSkill = { description: '', body: lines.slice(bodyStart).join('\n'), order: [], extra: {} };

  if (hasFm) {
    let idx = 0;
    while (idx < frontmatter.length) {
      const line = frontmatter[idx];
      const m = line.match(TOP_KEY);
      if (!m) {
        idx++; // stray line (blank or malformed) — ignore
        continue;
      }
      const [, key, rest] = m;
      result.order.push(key);
      if (key === 'name' || key === 'description' || key === 'whenToUse') {
        let value: string;
        if (isBlockIndicator(rest)) {
          const block: string[] = [];
          let j = idx + 1;
          while (j < frontmatter.length && (frontmatter[j].startsWith(' ') || frontmatter[j].trim() === '')) {
            block.push(frontmatter[j]);
            j++;
          }
          value = foldBlock(rest, block);
          idx = j;
        } else {
          value = unquote(rest);
          idx++;
        }
        if (key === 'name') result.name = value;
        else if (key === 'description') result.description = value;
        else result.whenToUse = value;
      } else {
        // Non-managed key: collect its continuation lines (indented / blank /
        // list items) verbatim until the next top-level key.
        const block = [line];
        let j = idx + 1;
        while (j < frontmatter.length && !TOP_KEY.test(frontmatter[j])) {
          block.push(frontmatter[j]);
          j++;
        }
        result.extra[key] = block;
        idx = j;
      }
    }
  }

  return result;
}

/**
 * Re-serialize. Managed keys are emitted from their (possibly edited) structured
 * values at their original positions; non-managed keys are re-emitted verbatim.
 * Any managed key absent originally but now set (e.g. a newly added `whenToUse`)
 * is appended. An empty `whenToUse` is dropped.
 */
export function serializeSkill(p: ParsedSkill): string {
  const out: string[] = ['---'];
  const emitted = new Set<string>();
  for (const key of p.order) {
    emitted.add(key);
    if (key === 'name') {
      out.push(`name: ${scalar(p.name ?? '')}`);
    } else if (key === 'description') {
      out.push(`description: ${scalar(p.description)}`);
    } else if (key === 'whenToUse') {
      if (p.whenToUse) out.push(`whenToUse: ${scalar(p.whenToUse)}`);
    } else {
      out.push(...(p.extra[key] ?? []));
    }
  }
  if (!emitted.has('name') && p.name) out.push(`name: ${scalar(p.name)}`);
  if (!emitted.has('description') && p.description) out.push(`description: ${scalar(p.description)}`);
  if (!emitted.has('whenToUse') && p.whenToUse) out.push(`whenToUse: ${scalar(p.whenToUse)}`);
  out.push('---');

  const body = p.body.replace(/^\n+/, '');
  return `${out.join('\n')}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/** Serialize a brand-new skill (no pre-existing frontmatter to preserve). */
export function buildSkillFile(
  name: string,
  description: string,
  whenToUse: string | undefined,
  body: string,
): string {
  return serializeSkill({
    name,
    description,
    whenToUse: whenToUse || undefined,
    body,
    order: ['name', 'description', ...(whenToUse ? ['whenToUse'] : [])],
    extra: {},
  });
}
