import { useEffect, useState } from 'react';
import { X, Copy, Check, Download, Loader2, CircleAlert, FileText } from 'lucide-react';
import { useStore } from '../store/store';
import { api, ApiError } from '../lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; content: string };

/** Modal that fetches and shows the contents of a file path the user clicked in
 *  a reply. Reads `filePreview` from the store (path already resolved against
 *  the active session's cwd; `host` set only for remote sessions). Close on X,
 *  backdrop click, or Escape. */
export function FilePreview() {
  const file = useStore((s) => s.filePreview);
  const close = useStore((s) => s.closeFilePreview);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);

  // Re-fetch whenever the previewed path/host changes (including the first open).
  useEffect(() => {
    if (!file) return;
    setState({ status: 'loading' });
    let cancelled = false;
    api
      .readFile({ host: file.host, path: file.path })
      .then((content) => {
        if (!cancelled) setState({ status: 'done', content });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Failed to read file' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file?.path, file?.host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!file) return null;
  const path = file.path;

  const copy = async () => {
    if (state.status !== 'done') return;
    try {
      await navigator.clipboard?.writeText(state.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={close}
    >
      <div
        className="new-session-panel flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: 'calc(100dvh - 2rem)' }}
      >
        <div className="dialog-titlebar flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate font-mono text-[12.5px] text-slate-200" title={path}>
              {path}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {state.status === 'done' && (
              <>
                <button
                  type="button"
                  onClick={copy}
                  className="rounded-md p-1.5 text-slate-500 transition hover:bg-ink-800 hover:text-slate-200"
                  title={copied ? 'Copied' : 'Copy contents'}
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
                <a
                  href={api.downloadFileUrl({ host: file.host, path })}
                  download
                  className="rounded-md p-1.5 text-slate-500 transition hover:bg-ink-800 hover:text-slate-200"
                  title="Download"
                >
                  <Download className="h-4 w-4" />
                </a>
              </>
            )}
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1.5 text-slate-500 transition hover:bg-ink-800 hover:text-slate-200"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-b-2xl bg-ink-950">
          {state.status === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {state.status === 'error' && (
            <div className="flex items-start gap-2.5 px-4 py-6 text-[13px] text-rose-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="whitespace-pre-wrap">{state.message}</div>
            </div>
          )}
          {state.status === 'done' && <CodeLines content={state.content} />}
        </div>
      </div>
    </div>
  );
}

/** Monospace file body with a line-number gutter that pads to the line count. */
function CodeLines({ content }: { content: string }) {
  const lines = content.split('\n');
  const gutterWidth = `${String(lines.length).length}ch`;
  return (
    <div className="py-1.5 font-mono text-[12px] leading-relaxed">
      {lines.map((ln, i) => (
        <div key={i} className="flex px-3 hover:bg-white/[0.02]">
          <span
            className="mr-3 shrink-0 select-none text-right text-slate-600"
            style={{ width: gutterWidth }}
          >
            {i + 1}
          </span>
          <span className="whitespace-pre-wrap break-words text-slate-300">{ln || ' '}</span>
        </div>
      ))}
    </div>
  );
}
