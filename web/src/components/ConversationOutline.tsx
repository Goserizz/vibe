import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { newestFirstConversationHeadings, outlineDropdownPlacement, outlinePlacement, type ConversationHeading } from '@shared/conversationOutline';
import { ArrowUp, ChevronDown, ClipboardList, Loader2, Search, X } from '../lib/icons';
import { cn } from '../lib/format';
import { outlineReadingBounds } from '../lib/outlineGeometry';

interface Props {
  entries: ConversationHeading[];
  viewport: RefObject<HTMLDivElement>;
  content: RefObject<HTMLDivElement>;
  hasMore?: boolean;
  loading?: boolean;
  error?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onJump: (id: string, signal: AbortSignal) => Promise<void>;
  onLatest: () => void;
}

export function ConversationOutline({ entries, viewport, content, hasMore, loading, error, onOpen, onClose, onJump, onLatest }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string>();
  const [jumping, setJumping] = useState<string>();
  const [jumpError, setJumpError] = useState<string>();
  const [layout, setLayout] = useState({ ...outlinePlacement(0, 0), top: 96, height: 0, readingTop: 96 });
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const navigation = useRef<AbortController>();
  const canShow = entries.length > 0 || Boolean(hasMore);
  const expanded = canShow && (layout.wide || open);
  const visible = useMemo(() => newestFirstConversationHeadings(entries, search), [entries, search]);

  useLayoutEffect(() => {
    const el = viewport.current, body = content.current;
    if (!el || !body) return;
    let frame = 0;
    const update = () => {
      const rect = el.getBoundingClientRect(), transcript = body.getBoundingClientRect();
      const surface = el.closest<HTMLElement>('[data-conversation-surface]') ?? el.parentElement;
      const surfaceRect = surface?.getBoundingClientRect() ?? rect;
      const composerRect = surface?.querySelector('[data-conversation-composer]')?.getBoundingClientRect();
      setSurface(surface);
      const header = el.closest('main')?.querySelector('header')?.getBoundingClientRect();
      const readingTop = Math.max(12, (header?.bottom ?? rect.top) - rect.top + 12);
      setLayout({ ...outlinePlacement(rect.width, transcript.left - rect.left),
        ...outlineReadingBounds(surfaceRect, rect, header?.bottom, composerRect?.height ? composerRect.top : undefined), readingTop });
      const main = el.closest('main');
      setSlot(['rail', 'composer'].map(kind => main?.querySelector<HTMLElement>(`[data-outline-slot="${kind}"]`))
        .find(target => target && target.getBoundingClientRect().width > 0) ?? null);
      const nodes = [...body.querySelectorAll<HTMLElement>('[data-question-id]')];
      let current = nodes[0];
      for (const node of nodes) {
        if (node.getBoundingClientRect().top > rect.top + readingTop + 28) break;
        current = node;
      }
      setActive(current?.dataset.questionId);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(el); observer.observe(body);
    const surface = el.closest('[data-conversation-surface]'); if (surface) observer.observe(surface);
    const composer = surface?.querySelector('[data-conversation-composer]'); if (composer) observer.observe(composer);
    const header = el.closest('main')?.querySelector('header'); if (header) observer.observe(header);
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); el.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [viewport, content, entries.length]);

  useLayoutEffect(() => {
    if (!open || layout.wide) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor) return;
      const visual = window.visualViewport;
      const pos = outlineDropdownPlacement(anchor, { width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight, top: visual?.offsetTop, left: visual?.offsetLeft });
      setMenuStyle({ position: 'fixed', zIndex: 50, width: pos.width, left: pos.left,
        top: pos.down ? pos.top : pos.bottom, maxHeight: pos.maxHeight,
        transform: pos.down ? undefined : 'translateY(-100%)', transformOrigin: pos.down ? 'top left' : 'bottom left' });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, layout.wide, slot]);

  useEffect(() => {
    if (!expanded) return;
    onOpen?.();
    return () => onClose?.();
    // Visibility controls I/O: wide panels load automatically; dropdowns only
    // load while open. Progress updates must not restart the page walk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  useEffect(() => { if (layout.wide) setOpen(false); }, [layout.wide]);
  const close = () => {
    setOpen(false);
    navigation.current?.abort(); setJumping(undefined);
  };
  useEffect(() => () => { navigation.current?.abort(); }, []);
  useEffect(() => {
    if (!open || layout.wide) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, layout.wide]);

  const jump = async (entry: ConversationHeading) => {
    navigation.current?.abort(); const controller = new AbortController(); navigation.current = controller;
    setJumping(entry.id); setJumpError(undefined);
    try {
      await onJump(entry.id, controller.signal);
      for (let i = 0; i < 8; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (controller.signal.aborted) return;
        const el = viewport.current;
        const target = [...(content.current?.querySelectorAll<HTMLElement>('[data-question-id]') ?? [])].find(node => node.dataset.questionId === entry.id);
        if (!el || !target) continue;
        el.scrollTo({ top: el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - layout.readingTop - 12, behavior: 'instant' });
        target.focus({ preventScroll: true });
        target.classList.remove('question-jump-highlight');
        void target.offsetWidth;
        target.classList.add('question-jump-highlight');
        setActive(entry.id); close(); return;
      }
      throw new Error('未找到该提问的位置，请重试');
    } catch (error) { if (!controller.signal.aborted) setJumpError(error instanceof Error ? error.message : '跳转失败'); }
    finally { if (navigation.current === controller) setJumping(undefined); }
  };

  if (!canShow || (layout.wide ? layout.height < 80 : !slot)) return null;
  const popup = expanded && <nav ref={panel} aria-label="历史提问" className={cn('outline-panel pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-950/95 text-slate-200 shadow-xl backdrop-blur-xl', layout.wide && 'absolute inset-0')}
    style={layout.wide ? { height: '100%' } : menuStyle}>
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-700/70 px-3 py-2.5">
          <span className="flex-1 text-[11px] font-medium tracking-wide text-slate-400">提问目录 <span className="ml-1 font-mono text-slate-500">{entries.length}{hasMore ? '+' : ''}</span></span>
          <button type="button" aria-label="回到最新消息" title="回到最新消息" onClick={() => { close(); onLatest(); }} className="rounded p-1 hover:bg-ink-800"><ArrowUp className="h-3.5 w-3.5 rotate-180" /></button>
          {!layout.wide && <button type="button" aria-label="关闭目录" onClick={close} className="rounded p-1 hover:bg-ink-800"><X className="h-3.5 w-3.5" /></button>}
        </div>
        {entries.length > 8 && <label className="mx-2 my-2 flex shrink-0 items-center gap-2 rounded-lg border border-ink-700 px-2 py-1.5 text-slate-500">
          <Search className="h-3 w-3 shrink-0" /><input aria-label="搜索历史提问" value={search} onChange={event => setSearch(event.target.value)} placeholder="查找提问…" className="min-w-0 flex-1 bg-transparent text-[12px] text-slate-200 outline-none" />
        </label>}
        <ol className="outline-items min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {visible.map((entry, i) => <li key={entry.id}>
            <button type="button" aria-current={entry.id === active ? 'location' : undefined} onClick={() => void jump(entry)} title={entry.text}
              className={cn('outline-entry group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition', entry.id === active ? 'bg-accent/10 text-slate-100' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-100')}>
              <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[10px] text-slate-500">{jumping === entry.id ? <Loader2 className="h-3 w-3 animate-spin" /> : search ? '·' : String(entries.length - i).padStart(2, '0')}</span>
              <span className="line-clamp-2 min-w-0 flex-1 break-words text-[12px] leading-relaxed">{entry.text}</span>
            </button>
          </li>)}
          {!visible.length && <li className="px-3 py-4 text-center text-xs text-slate-500">{loading ? '正在读取提问…' : '没有匹配的提问'}</li>}
        </ol>
        {(loading || error || jumpError || jumping) && <div role="status" className="shrink-0 border-t border-ink-700/60 px-3 py-2 text-[11px] text-slate-500">
          {jumping ? '正在加载并定位历史…' : jumpError || error || '正在补全更早的目录…'}
          {(error || jumpError) && <button type="button" onClick={() => { setJumpError(undefined); onOpen?.(); }} className="ml-2 text-slate-300 underline">重试</button>}
        </div>}
      </nav>;
  const view = (
    <div ref={root} className={cn('conversation-outline', layout.wide ? 'outline-wide pointer-events-none absolute z-[25]' : 'outline-dropdown')}
      data-placement={layout.wide ? 'left' : 'tasks'} style={layout.wide ? { top: layout.top, left: layout.left, width: layout.panelWidth, height: layout.height } : undefined}>
      {!layout.wide && <button ref={trigger} type="button" className="outline-trigger pointer-events-auto flex h-10 w-full items-center gap-2 rounded-xl border border-ink-700/60 bg-ink-950/90 px-3 text-left text-slate-400 transition hover:border-accent/40 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label="对话目录" aria-expanded={open}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'Tab' && open) { event.preventDefault(); setOpen(true); requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('input, .outline-entry')?.focus()); } }}
        onClick={() => { if (open) close(); else setOpen(true); }}>
        <ClipboardList className="h-4 w-4 shrink-0" /><span className="flex-1 text-[12.5px]">提问目录</span><span className="text-[11px] text-slate-500">{entries.length}{hasMore ? '+' : ''}</span><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>}
      {layout.wide ? popup : popup && createPortal(popup, document.body)}
    </div>
  );
  return layout.wide ? surface && createPortal(view, surface) : createPortal(view, slot!);
}
