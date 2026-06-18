import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/**
 * Markdown for chat content. Memoized on the raw text so that while one block
 * streams, already-rendered blocks don't re-parse.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-vibe">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
