import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X, Loader2, FileText, Image as ImageIcon } from '../lib/icons';
import { useStore } from '../store/store';
import { agentLabel, cn } from '../lib/format';
import { api, ApiError } from '../lib/api';
import { buildMessage } from '../lib/attachments';
import { useComposerKeys } from '../lib/composerKeys';
import { Glass } from './LiquidGlass';
import { CliPromptTextarea } from './CliPromptTextarea';

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
  const activeTaskCount = useStore((s) => (s.tasks[sessionId] ?? []).filter((task) => (
    task.status === 'pending' || task.status === 'running' || task.status === 'paused'
  )).length);
  const agentName = useStore((s) => agentLabel(s.sessions.find((session) => session.id === sessionId)?.agent ?? 'claude'));
  const sendMessage = useStore((s) => s.sendMessage);
  const abort = useStore((s) => s.abort);
  const setToast = useStore((s) => s.setToast);
  const cli = useStore((s) => s.viewMode) === 'cli';
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

  // Ctrl-U discards to line start, ↑/↓ walk the persisted prompt history, Esc
  // stops a running turn (same logic as the Stop button). History is bucketed
  // per session — ↑ only ever recalls this session's prompts. Esc defers to
  // the file preview modal when one is open — it owns Escape while visible.
  const keys = useComposerKeys({
    getText: () => text,
    setText,
    textareaRef: ref,
    isRunning: () => running,
    onStop: abort,
    escapeSuppressed: () => useStore.getState().filePreview !== null,
    onEmptyHistory: () => setToast('No input history yet — send a message first'),
    storageKey: 'vibe.promptHistory',
    bucketId: sessionId,
  });

  // Auto-grow up to a sensible cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Refocus when switching sessions or flipping chat/CLI chrome (the textarea remounts).
  useEffect(() => {
    ref.current?.focus();
  }, [sessionId, cli]);

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
    keys.commit(value);
    setText('');
    setAttachments([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (keys.onKeyDown(e)) return;
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

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes('Files') && !uploading) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
  };

  const fileInput = (
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
  );

  const attachmentChips = hasAttachments && (
    <div className={cn('flex flex-wrap gap-1.5', cli ? 'pb-1.5 pl-6' : 'px-3 pt-2.5')}>
      {attachments.map((a) => (
        <div
          key={a.id}
          className={cn(
            'group flex max-w-[220px] items-center gap-1.5 py-1 pl-2 pr-1.5 text-[12px] text-slate-200',
            cli
              ? 'border border-white/10 font-mono'
              : 'rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm',
          )}
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
  );

  const actionButton = running ? (
    <button
      onClick={abort}
      title="Stop current response"
      aria-label="Stop current response"
      className={cn(
        'flex shrink-0 items-center justify-center text-[#fff] transition hover:bg-rose-500',
        cli ? 'h-8 bg-rose-500/90 px-2 font-mono text-[11px]' : 'h-9 w-9 rounded-xl bg-rose-500/90',
      )}
    >
      {cli ? 'stop' : <Square className="h-4 w-4 fill-current" />}
    </button>
  ) : (
    <button
      onClick={() => void submit()}
      disabled={busy || (!text.trim() && !hasAttachments)}
      title="Send"
      className={cn(
        'flex shrink-0 items-center justify-center text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500',
        cli ? 'h-8 bg-accent px-2 font-mono text-[11px]' : 'h-9 w-9 rounded-xl bg-accent',
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : cli ? 'send' : <ArrowUp className="h-4 w-4" />}
    </button>
  );

  const placeholder = running
    ? `${agentName} is working…`
    : activeTaskCount
      ? `Message ${agentName} — ${activeTaskCount} background task${activeTaskCount === 1 ? '' : 's'} still running`
      : isDesktop
        ? cli
          ? `${agentName} › enter to send`
          : `Message ${agentName} — Enter to send, Shift+Enter for newline`
        : `Message ${agentName}`;

  const compositionHandlers = {
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      endedAtRef.current = Date.now();
    },
  };

  if (cli) {
    return (
      <div className="shrink-0 bg-ink-950 px-4 pb-5 pt-2 md:px-6">
        <div className="mx-auto max-w-4xl">
          <div {...dragHandlers} className="relative">
            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink-900/70 font-mono text-[12px] text-accent-soft">
                drop files to attach
              </div>
            )}
            {fileInput}
            {attachmentChips}
            <div className={cn('flex items-end gap-2', dragging && 'ring-1 ring-accent/40')}>
              <span className="select-none pb-2 font-mono text-[14px] text-accent">❯</span>
              <CliPromptTextarea
                textareaRef={ref}
                value={text}
                onChange={keys.onChange}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={placeholder}
                {...compositionHandlers}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || uploading}
                title="Attach files"
                className="flex h-8 w-8 shrink-0 items-center justify-center text-slate-400 transition hover:bg-ink-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              {actionButton}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pb-6 pt-1 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div {...dragHandlers}>
          <Glass
            className={cn(
              'relative',
              // While a turn is running the border already glows/breathes, so skip the
              // focus ring to avoid stacking two accent outlines on top of each other.
              !running && 'focus-within:ring-2 focus-within:ring-accent/15',
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
            {fileInput}
            {attachmentChips}
            <div className="flex items-end gap-2 px-3 py-2.5">
              <textarea
                ref={ref}
                value={text}
                onChange={(e) => keys.onChange(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                {...compositionHandlers}
                rows={1}
                placeholder={placeholder}
                className="max-h-[220px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={running || uploading}
                title="Attach files"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-ink-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              {actionButton}
            </div>
          </Glass>
        </div>
      </div>
    </div>
  );
}
