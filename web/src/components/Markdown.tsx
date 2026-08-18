import { memo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from '../lib/icons';
import 'katex/dist/katex.min.css';
import { useStore } from '../store/store';
import { looksLikeFilePath } from '../lib/paths';

/** Copy text to the clipboard, with an execCommand fallback for non-secure
 *  contexts (HTTP) where navigator.clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Fenced code block with a copy button. Reads the rendered `<code>` text so it
 *  works regardless of how highlight.js tokenized the source. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const text = preRef.current?.querySelector('code')?.textContent ?? '';
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <div className="code-block">
      <button
        type="button"
        onClick={onCopy}
        className={`code-copy${copied ? ' code-copy--done' : ''}`}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

/** An inline-code-styled path that opens the file-content preview on click.
 *  Rendered for any inline code (backticked or chipped from prose by the remark
 *  plugin below) whose text reads like a file path. */
function FilePathCode({ text }: { text: string }) {
  const openPathPreview = useStore((s) => s.openPathPreview);
  const open = () => openPathPreview(text);
  return (
    <code
      role="button"
      tabIndex={0}
      title={`View ${text}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className="cursor-pointer rounded bg-ink-750 px-1.5 py-0.5 font-mono text-[0.85em] text-accent-soft underline decoration-dotted decoration-accent/40 underline-offset-2 transition hover:bg-accent/15 hover:text-accent hover:decoration-accent"
    >
      {text}
    </code>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: CodeBlock,
  code({ className, children }) {
    // Fenced code blocks carry `language-*` / `hljs` classes (added by
    // rehype-highlight) and stay plain <code> inside CodeBlock. Untyped inline
    // code is what we check for a clickable path.
    const isInline = !/language-|hljs/.test(className || '');
    if (isInline) {
      const text = String(children ?? '');
      if (looksLikeFilePath(text)) return <FilePathCode text={text} />;
      return <code>{children}</code>;
    }
    return <code className={className}>{children}</code>;
  },
};

// Minimal mdast shapes — enough to walk text nodes and splice in inline code.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}
// Node types whose text we must not scan for paths: code (block/inline), math
// (raw TeX), and links (their text is the label, not a path to open).
const SKIP_NODE_TYPES = new Set(['code', 'inlineCode', 'inlineMath', 'math', 'link', 'linkReference']);

/** A path-looking token inside running text: ≥1 slash-separated segment ending
 *  in a short extension. Boundary validation (prev/next char, no `://`) and the
 *  `looksLikeFilePath` gate happen in `splitText`, so this stays a coarse net. */
const PATH_TOKEN = /(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~-]+\.[A-Za-z][A-Za-z0-9]{0,11}/g;

/** Split a text node's value into text + inlineCode segments, turning every
 *  standalone file path into an inline-code node so it renders as a clickable
 *  `FilePathCode` via the `code` component above. Returns `null` when nothing
 *  changed, so the caller can keep the original node untouched. */
function splitText(value: string): MdNode[] | null {
  const re = new RegExp(PATH_TOKEN.source, 'g');
  const out: MdNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    const prev = value[start - 1];
    const next = value[end];
    // Reject when the match is a continuation of a larger token (URL scheme,
    // dotted package ref, …) rather than a free-standing path.
    if (prev && /[A-Za-z0-9._~:@/-]/.test(prev)) continue;
    if (next && /[A-Za-z0-9_~-]/.test(next)) continue;
    if (tok.includes('://') || !looksLikeFilePath(tok)) continue;
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
    out.push({ type: 'inlineCode', value: tok });
    last = end;
  }
  if (last === 0) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

/** remark plugin: chip file paths in prose (non-code) text so they're clickable.
 *  Runs after remark-math so TeX is already converted (and skipped). Paths in
 *  backticks need no help — they're `inlineCode` already and handled at render. */
function remarkFilePaths() {
  return (tree: MdNode) => {
    const walk = (node: MdNode): void => {
      const kids = node.children;
      if (!Array.isArray(kids)) return;
      const next: MdNode[] = [];
      for (const child of kids) {
        if (child.type === 'text' && typeof child.value === 'string') {
          const parts = splitText(child.value);
          next.push(...(parts ?? [child]));
        } else {
          if (!SKIP_NODE_TYPES.has(child.type)) walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}

/**
 * Markdown for chat content. Memoized on the raw text so that while one block
 * streams, already-rendered blocks don't re-parse.
 *
 * File paths in the text (whether backticked or bare in prose) render as
 * clickable inline-code chips that open a content preview — see `FilePathCode`
 * and the `remarkFilePaths` plugin.
 *
 * Math: inline `$...$` and display `$$...$$` via remark-math → rehype-katex.
 * `strict: false` keeps rendering when KaTeX hits an unsupported macro, and
 * `throwOnError: false` renders the bad input inline in red instead of crashing
 * the whole message (important while a formula is mid-stream).
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-vibe">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkFilePaths]}
        rehypePlugins={[
          [rehypeKatex, { strict: false, throwOnError: false }],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
