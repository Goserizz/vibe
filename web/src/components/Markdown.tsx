import { memo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import 'katex/dist/katex.min.css';

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

/**
 * Markdown for chat content. Memoized on the raw text so that while one block
 * streams, already-rendered blocks don't re-parse.
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { strict: false, throwOnError: false }],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={{ pre: CodeBlock }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
