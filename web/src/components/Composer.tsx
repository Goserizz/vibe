import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X, Loader2, FileText, Image as ImageIcon } from 'lucide-react';
import { useStore } from '../store/store';
import { agentLabel, cn } from '../lib/format';
import { api, ApiError } from '../lib/api';
import { buildMessage } from '../lib/attachments';
import { Glass } from './LiquidGlass';

/** crypto.randomUUID needs a secure context; on plain-http LAN URLs it's
 *  undefined, so fall back (same pattern the store uses). */
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
function isImage(name: string): boolean {
  return IMAGE_EXTS.has(name.split('.').pop()?.toLowerCase() ?? '');
}
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PendingAttachment {
  id: string;
  file: File;
}

export function Composer({ sessionId }: { sessionId: string }) {
  const running = useStore((s) => s.views[sessionId]?.running ?? false);
  const agentName = useStore((s) => agentLabel(s.sessions.find((session) => session.id === sessionId)?.agent ?? 'claude'));
  const sendMessage = useStore((s) => s.sendMessage);
  const abort = useStore((s) => s.abort);
  const setToast = useStore((s) => s.setToast);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // CJK IME (e.g. pinyin) handling. KeyboardEvent.isComposing is unreliable on
  // macOS: the Enter that confirms a candidate fires *after* compositionend with
  // isComposing === false (by then our composing flag is already clear too), so
  // that Enter would wrongly send. We record when a composition ended and also
  // ignore Enter for a short window after — that rogue Enter always lands within
  // milliseconds of compositionend, whereas a real send comes much later.
  const composingRef = useRef(false);
  const endedAtRef = useRef(0);

  // Auto-grow up to a sensible cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Refocus when switching sessions.
  useEffect(() => {
    ref.current?.focus();
  }, [sessionId]);

  // Desktop keeps the keyboard-shortcut hint in the placeholder; mobile is short.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    setAttachments((prev) => [...prev, ...incoming.map((file) => ({ id: uid(), file }))]);
  };

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const submit = async () => {
    if (running || uploading) return;
    const value = text.trim();
    if (!value && !attachments.length) return;

    // Stage attachments first, then fold the returned host paths into the prompt.
    let paths: string[] = [];
    if (attachments.length) {
      setUploading(true);
      try {
        const results = await Promise.allSettled(
          attachments.map((a) => api.uploadAttachment({ sessionId, file: a.file })),
        );
        paths = results
          .filter((r): r is PromiseFulfilledResult<{ ok: boolean; path: string }> => r.status === 'fulfilled')
          .map((r) => r.value.path);
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed) {
          const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
          const msg = first?.reason instanceof ApiError ? first.reason.message : 'Upload failed';
          setToast(paths.length ? `Uploaded ${paths.length}, ${failed} failed` : msg);
        }
      } finally {
        setUploading(false);
      }
    }

    const message = buildMessage(value, paths);
    if (!message) return; // uploads failed and there was no text — nothing to send
    sendMessage(message);
    setText('');
    setAttachments([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Ignore the Enter that confirms an IME candidate (see composingRef comment).
    const justEnded = endedAtRef.current > 0 && Date.now() - endedAtRef.current < 10;
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229 || justEnded) return;
    e.preventDefault();
    void submit();
  };

  // Paste an image (e.g. a screenshot) straight into the composer.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const hasAttachments = attachments.length > 0;
  const busy = uploading;

  return (
    <div className="shrink-0 px-4 pb-6 pt-1 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes('Files') && !uploading) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!Array.from(e.dataTransfer.types).includes('Files')) return;
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
        >
          <Glass
            className={cn(
              'relative focus-within:ring-2 focus-within:ring-accent/15',
              running && 'composer-running',
              dragging && 'ring-2 ring-accent/40',
            )}
            cornerRadius={16}
            thin
          >
            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-ink-900/70 text-[12px] text-accent-soft">
                Drop files to attach
              </div>
            )}

            {hasAttachments && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group flex max-w-[220px] items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-1 pl-2 pr-1.5 text-[12px] text-slate-200 backdrop-blur-sm"
                  >
                    {isImage(a.file.name) ? (
                      <ImageIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    )}
                    <span className="truncate">{a.file.name}</span>
                    <span className="shrink-0 text-[10px] text-slate-500">{fmtSize(a.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      disabled={uploading}
                      title="Remove"
                      className="shrink-0 rounded p-0.5 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200 disabled:opacity-40"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 px-3 py-2.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || uploading}
                title="Attach files"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-ink-700 text-slate-300 transition hover:border-ink-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                ref={ref}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  endedAtRef.current = Date.now();
                }}
                rows={1}
                placeholder={running ? `${agentName} is working…` : isDesktop ? `Message ${agentName} — Enter to send, Shift+Enter for newline` : `Message ${agentName}`}
                className="max-h-[220px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
              />
              {running ? (
                <button
                  onClick={abort}
                  title="Stop"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/90 text-[#fff] transition hover:bg-rose-500"
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              ) : (
                <button
                  onClick={() => void submit()}
                  disabled={busy || (!text.trim() && !hasAttachments)}
                  title="Send"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </button>
              )}
            </div>
          </Glass>
        </div>
      </div>
    </div>
  );
}
