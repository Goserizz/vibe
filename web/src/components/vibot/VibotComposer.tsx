import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X } from '../../lib/icons';
import { useStore } from '../../store/store';
import { useVibotStore } from '../../store/vibot';
import { cn } from '../../lib/format';
import { Glass } from '../LiquidGlass';
import { CliPromptTextarea } from '../CliPromptTextarea';
import { useComposerKeys } from '../../lib/composerKeys';
import { fileToDataUrl, vibotImageError, VIBOT_MAX_IMAGES } from '../../lib/vibotImages';

interface PendingImage {
  id: string;
  dataUrl: string;
  name: string;
}

/** Vibot composer: text + optional vision images (paste / file pick / drop). */
export function VibotComposer({ convId }: { convId: string }) {
  const running = useVibotStore((s) => s.views[convId]?.running ?? false);
  const sendMessage = useVibotStore((s) => s.sendMessage);
  const abort = useVibotStore((s) => s.abort);
  const setToast = useVibotStore((s) => s.setToast);
  const cli = useStore((s) => s.viewMode) === 'cli';
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const endedAtRef = useRef(0);

  // Ctrl-U discards to line start, ↑/↓ walk the persisted prompt history, Esc
  // stops a running turn (same logic as the Stop button). Vibot keeps its own
  // store, bucketed per conversation — ↑ only recalls this conversation's
  // prompts, never the coding side's or another conversation's.
  const keys = useComposerKeys({
    getText: () => text,
    setText,
    textareaRef: ref,
    isRunning: () => running,
    onStop: abort,
    onEmptyHistory: () => setToast('No input history yet — send a message first'),
    storageKey: 'vibe.vibotPromptHistory',
    bucketId: convId,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cli ? 220 : 200)}px`;
  }, [text, cli]);

  useEffect(() => {
    ref.current?.focus();
  }, [convId, cli]);

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const err = vibotImageError(files, images.length);
    if (err) {
      setToast(err);
      return;
    }
    try {
      const next: PendingImage[] = [];
      for (const f of files.slice(0, VIBOT_MAX_IMAGES - images.length)) {
        next.push({ id: crypto.randomUUID(), dataUrl: await fileToDataUrl(f), name: f.name });
      }
      setImages((prev) => [...prev, ...next].slice(0, VIBOT_MAX_IMAGES));
    } catch {
      setToast('Failed to read image');
    }
  };

  const submit = () => {
    const v = text.trim();
    if ((!v && !images.length) || running) return;
    sendMessage(
      v,
      images.map((i) => i.dataUrl),
    );
    keys.commit(v);
    setText('');
    setImages([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (keys.onKeyDown(e)) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    const justEnded = endedAtRef.current > 0 && Date.now() - endedAtRef.current < 10;
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229 || justEnded) return;
    e.preventDefault();
    submit();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };

  const compositionHandlers = {
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      endedAtRef.current = Date.now();
    },
  };

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes('Files') && !running) {
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
      if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
    },
  };

  const canSend = Boolean(text.trim() || images.length) && !running;

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
      onClick={submit}
      disabled={!canSend}
      title="Send"
      className={cn(
        'flex shrink-0 items-center justify-center text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500',
        cli ? 'h-8 bg-accent px-2 font-mono text-[11px]' : 'h-9 w-9 rounded-xl bg-accent',
      )}
    >
      {cli ? 'send' : <ArrowUp className="h-4 w-4" />}
    </button>
  );

  const attachButton = (
    <button
      type="button"
      title="Attach image"
      disabled={running || images.length >= VIBOT_MAX_IMAGES}
      onClick={() => fileInputRef.current?.click()}
      className={cn(
        'flex shrink-0 items-center justify-center text-slate-400 transition hover:bg-ink-800 hover:text-slate-200 disabled:opacity-40',
        cli ? 'h-8 w-8' : 'h-9 w-9 rounded-xl',
      )}
    >
      <Paperclip className="h-4 w-4" />
    </button>
  );

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      className="hidden"
      onChange={(e) => {
        if (e.target.files) void addFiles(e.target.files);
        e.target.value = '';
      }}
    />
  );

  const thumbnails = images.length > 0 && (
    <div className={cn('flex flex-wrap gap-2', cli ? 'pb-1.5 pl-6' : 'px-3 pt-2.5')}>
      {images.map((img) => (
        <div key={img.id} className="group relative h-14 w-14 overflow-hidden rounded-lg border border-white/10 bg-ink-900">
          <img src={img.dataUrl} alt={img.name} className="h-full w-full object-cover" />
          <button
            type="button"
            title="Remove"
            onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
            className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-slate-200 opacity-0 transition group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );

  if (cli) {
    return (
      <div className="shrink-0 bg-ink-950 px-4 pb-5 pt-2 md:px-6" {...dragHandlers}>
        <div className={cn('mx-auto max-w-4xl', dragging && 'outline outline-1 outline-accent/40')}>
          {thumbnails}
          <div className="flex items-end gap-2">
            <span className="select-none pb-2 font-mono text-[14px] text-accent">❯</span>
            <CliPromptTextarea
              textareaRef={ref}
              value={text}
              onChange={keys.onChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={running ? 'vibot working…' : 'vibot › enter to send'}
              {...compositionHandlers}
            />
            {attachButton}
            {actionButton}
          </div>
          {fileInput}
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pb-6 pt-1 md:px-6" {...dragHandlers}>
      <div className="mx-auto max-w-3xl">
        <Glass
          className={cn(
            'relative',
            !running && 'focus-within:ring-2 focus-within:ring-accent/15',
            running && 'composer-running',
            dragging && 'ring-2 ring-accent/30',
          )}
          cornerRadius={16}
          thin
        >
          {thumbnails}
          <div className="flex items-end gap-2 px-3 py-2.5">
            <textarea
              ref={ref}
              value={text}
              onChange={(e) => keys.onChange(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              placeholder={running ? 'Vibot is working…' : 'Message Vibot…'}
              className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 outline-none"
              {...compositionHandlers}
            />
            {attachButton}
            {actionButton}
          </div>
          {fileInput}
        </Glass>
      </div>
    </div>
  );
}
