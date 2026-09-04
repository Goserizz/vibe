/**
 * Normalize model-emitted LaTeX so remark-math / rehype-katex can render it.
 *
 * Converts:
 *   \(…\)  → $…$
 *   \[…\]  → $$…$$
 *   bare whitelisted-command formulas (e.g. `\alpha = a/\text{scale}`) → $…$
 *
 * Skips fenced/inline code and regions already wrapped in $ / $$.
 */

/** Commands that may start (or continue) a bare math span. Keep tight to avoid `\n`, paths, etc. */
const LATEX_CMDS = new Set([
  // Greek
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma',
  'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  // Structures / fonts
  'frac', 'dfrac', 'tfrac', 'binom', 'sqrt', 'text', 'mathrm', 'mathbf', 'mathit', 'mathbb',
  'mathcal', 'mathfrak', 'mathsf', 'operatorname',
  // Big operators
  'sum', 'prod', 'int', 'iint', 'iiint', 'oint', 'lim', 'infty',
  // Relations / operators
  'cdot', 'times', 'div', 'pm', 'mp', 'ast', 'star', 'circ', 'bullet',
  'partial', 'nabla', 'approx', 'equiv', 'sim', 'simeq', 'cong',
  'leq', 'geq', 'le', 'ge', 'neq', 'ne', 'lt', 'gt', 'll', 'gg',
  'subset', 'supset', 'subseteq', 'supseteq', 'in', 'notin', 'ni',
  'forall', 'exists', 'neg', 'land', 'lor', 'wedge', 'vee',
  'to', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow', 'leftrightarrow', 'Leftrightarrow',
  'mapsto', 'implies', 'iff',
  // Trig / log
  'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh',
  // Accents / decoration
  'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widehat', 'widetilde', 'overline', 'underline',
  'overbrace', 'underbrace',
  // Delimiters / sizing
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
  // Dots / spacing / misc
  'cdots', 'ldots', 'dots', 'vdots', 'ddots', 'quad', 'qquad',
  'hbar', 'ell', 'Re', 'Im', 'wp', 'angle', 'triangle', 'square', 'diamond',
  'binom', 'overset', 'underset', 'stackrel',
  // Single-char spacing: \, \; \! \:
  ',', ';', '!', ':',
]);

const PLACEHOLDER_PREFIX = '\uE000MATHPROT';
const PLACEHOLDER_SUFFIX = '\uE001';

function isCmdChar(c: string): boolean {
  return /[A-Za-z]/.test(c);
}

/** Parse `\command` or `\,` / `\;` / `\!` / `\:` at `i`. Returns [name, indexAfter] or null. */
function readCommand(s: string, i: number): { name: string; end: number } | null {
  if (s[i] !== '\\') return null;
  if (i + 1 >= s.length) return null;
  const next = s[i + 1];
  // Single-char spacing / specials: \, \; \! \: \quad is multi-letter
  if (',;!: '.includes(next)) {
    return { name: next === ' ' ? ' ' : next, end: i + 2 };
  }
  if (!isCmdChar(next)) return null;
  let j = i + 1;
  while (j < s.length && isCmdChar(s[j])) j++;
  return { name: s.slice(i + 1, j), end: j };
}

/** Consume a balanced `{…}` starting at `i` (must be `{`). */
function consumeBraceGroup(s: string, i: number): number {
  if (s[i] !== '{') return i;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++; // skip escaped char
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return s.length; // unclosed — take rest
}

/** After a command name, consume optional brace args (`\frac{a}{b}`, `\text{…}`). */
function consumeCommandArgs(s: string, i: number): number {
  let j = i;
  // Optional ^ or _ with a brace or single token is handled by the main loop;
  // here only gobble consecutive `{…}` groups attached to the command.
  while (j < s.length && s[j] === '{') {
    j = consumeBraceGroup(s, j);
  }
  return j;
}

/**
 * Try to match a bare LaTeX formula starting at `start` (`\` + whitelist cmd).
 * Returns the exclusive end index, or -1.
 */
function matchBareLatex(s: string, start: number): number {
  if (s[start] !== '\\') return -1;
  // Don't start mid-identifier / path fragment.
  if (start > 0 && /[A-Za-z0-9_]/.test(s[start - 1])) return -1;

  const first = readCommand(s, start);
  if (!first || !LATEX_CMDS.has(first.name)) return -1;

  let i = consumeCommandArgs(s, first.end);
  let end = i; // last committed end (excludes trailing spaces)

  const commit = (n: number) => {
    i = n;
    end = n;
  };

  while (i < s.length) {
    // Allow whitespace between math tokens, but don't keep it if nothing follows.
    if (/\s/.test(s[i])) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      i = j;
      continue;
    }

    if (s[i] === '\\') {
      const cmd = readCommand(s, i);
      if (!cmd || !LATEX_CMDS.has(cmd.name)) break;
      commit(consumeCommandArgs(s, cmd.end));
      continue;
    }

    // Operators / punctuation common in math prose.
    if ('+-*/=^_().,|/<>!~'.includes(s[i])) {
      commit(i + 1);
      continue;
    }

    // Balanced […] (optional args / intervals) or continue after `[`.
    if (s[i] === '[') {
      const close = s.indexOf(']', i + 1);
      if (close === -1) {
        commit(i + 1);
      } else {
        commit(close + 1);
      }
      continue;
    }

    // Numbers (including decimals).
    if (/[0-9]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      if (s[j] === '.' && j + 1 < s.length && /[0-9]/.test(s[j + 1])) {
        j++;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      commit(j);
      continue;
    }

    // Single-letter variables only (avoid swallowing English words like "and").
    if (/[A-Za-z]/.test(s[i])) {
      const next = s[i + 1];
      if (next && /[A-Za-z]/.test(next)) break;
      commit(i + 1);
      continue;
    }

    break;
  }

  return end > start ? end : -1;
}

/** Replace ranges in `s` with placeholders; `ranges` must be non-overlapping, sorted. */
function protectRanges(s: string, ranges: Array<{ start: number; end: number }>): { text: string; slots: string[] } {
  if (!ranges.length) return { text: s, slots: [] };
  const slots: string[] = [];
  let out = '';
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start < cursor) continue;
    out += s.slice(cursor, start);
    const slot = `${PLACEHOLDER_PREFIX}${slots.length}${PLACEHOLDER_SUFFIX}`;
    slots.push(s.slice(start, end));
    out += slot;
    cursor = end;
  }
  out += s.slice(cursor);
  return { text: out, slots };
}

function restoreSlots(s: string, slots: string[]): string {
  let out = s;
  for (let i = 0; i < slots.length; i++) {
    const token = `${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`;
    const at = out.indexOf(token);
    if (at === -1) continue;
    // Avoid String.replaceAll: replacement strings treat `$$` as a single `$`.
    out = out.slice(0, at) + slots[i] + out.slice(at + token.length);
  }
  return out;
}

/** Collect [start, end) ranges for fenced code, inline code, and existing math. */
function findProtectedRanges(s: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    // Fenced code: ``` … ```
    if (s.startsWith('```', i)) {
      const close = s.indexOf('```', i + 3);
      const end = close === -1 ? n : close + 3;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    // Inline code: `…` (no unescaped nesting)
    if (s[i] === '`') {
      let j = i + 1;
      while (j < n && s[j] !== '`' && s[j] !== '\n') j++;
      const end = j < n && s[j] === '`' ? j + 1 : j;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    // Display math $$…$$
    if (s.startsWith('$$', i)) {
      const close = s.indexOf('$$', i + 2);
      const end = close === -1 ? n : close + 2;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    // Inline math $…$ (single dollars; not $$)
    if (s[i] === '$') {
      let j = i + 1;
      while (j < n && s[j] !== '$' && s[j] !== '\n') j++;
      const end = j < n && s[j] === '$' ? j + 1 : j;
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    i++;
  }
  return ranges;
}

function convertDelimiters(s: string): string {
  // \[…\] → $$…$$  then  \(…\) → $…$
  // Use string concat — in template literals `$$${x}` is `$` + ${x}, not `$$` + x.
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('\\[', i)) {
      const close = s.indexOf('\\]', i + 2);
      if (close !== -1) {
        out += '$$' + s.slice(i + 2, close) + '$$';
        i = close + 2;
        continue;
      }
    }
    if (s.startsWith('\\(', i)) {
      const close = s.indexOf('\\)', i + 2);
      if (close !== -1) {
        out += '$' + s.slice(i + 2, close) + '$';
        i = close + 2;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

function wrapBareLatex(s: string): string {
  // Re-protect $ / $$ that may have been introduced by delimiter conversion,
  // plus any placeholders already present (they contain no `\`).
  const { text, slots } = protectRanges(s, findProtectedRanges(s));
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      const end = matchBareLatex(text, i);
      if (end !== -1) {
        out += '$' + text.slice(i, end) + '$';
        i = end;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return restoreSlots(out, slots);
}

/**
 * Preprocess markdown source so common model-emitted LaTeX forms render via
 * remark-math. Idempotent on already-wrapped `$…$` / `$$…$$` and a no-op inside
 * code spans/fences.
 */
export function preprocessMath(source: string): string {
  if (!source || !source.includes('\\')) return source;

  const { text: shielded, slots } = protectRanges(source, findProtectedRanges(source));
  const withDelims = convertDelimiters(shielded);
  const withBare = wrapBareLatex(withDelims);
  return restoreSlots(withBare, slots);
}
