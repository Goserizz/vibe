import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';

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
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
