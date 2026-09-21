import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { BlockView, subagentUuidOf, taskBadgeClass, taskShortId } from './blocks';
import { CliBlockView } from './CliBlocks';
import { cn } from '../lib/format';
import { outlineRenderWindow } from '@shared/conversationOutline';
import { ConversationOutline } from './ConversationOutline';
import { useConversationIndex } from './useConversationIndex';
import type { ChatBlock } from '@shared/protocol';

/** A consecutive run of tool blocks made by the same sub-agent, kept in
 *  conversation order. Runs of ≥2 collapse into one labelled container so
 *  parallel sub-agents' calls stop interleaving into an unreadable wall. */
type ShownItem =
  | { t: 'block'; block: ChatBlock }
  | { t: 'run'; uuid: string; blocks: ChatBlock[] };

function SubagentRun({ uuid, blocks, cli }: { uuid: string; blocks: ChatBlock[]; cli: boolean }) {
  // Like the Thinking block: auto-open while any call is still running, then
  // collapse; a manual toggle always wins.
  const running = blocks.some((b) => b.kind === 'tool' && (b as { status?: string }).status === 'running');
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? running;
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [open, blocks.length]);
  return (
    <div className={cn('my-1 overflow-hidden rounded-xl border border-white/10', cli ? 'bg-transparent' : 'bg-ink-900/30')}>
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-white/[0.03]"
      >
        <span className={cn('rounded-md border px-1.5 py-px font-mono text-[11px]', taskBadgeClass(uuid))}>
          子代理 {taskShortId(uuid)}
        </span>
        <span className="text-[12px] text-slate-400">
          {blocks.length} 次调用{running ? ' · 运行中' : ''}
        </span>
        {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />}
        <span className="ml-auto text-[11px] text-slate-500">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div ref={viewportRef} className="max-h-72 space-y-1.5 overflow-y-auto overscroll-contain border-t border-white/5 px-2.5 py-2">
          {blocks.map((b) => (cli ? <CliBlockView key={b.id} block={b} /> : <BlockView key={b.id} block={b} />))}
        </div>
      )}
    </div>
  );
}

/** Blocks rendered at once. Paging keeps loaded history small; this bounds
 *  pathological sessions (thousands of blocks) so the DOM stays responsive. */
const EMPTY_BLOCKS: ChatBlock[] = [];

export function MessageList({
  sessionId,
  bottomPad,
  embedded,
}: {
  sessionId: string;
  bottomPad?: number;
  /** Vibot (and similar) embeds: solid header above, skip floating-titlebar padding. */
  embedded?: boolean;
}) {
  const blocks = useStore((s) => s.views[sessionId]?.blocks);
  const hasMore = useStore((s) => s.views[sessionId]?.hasMore ?? false);
  const loadingOlder = useStore((s) => s.views[sessionId]?.loadingOlder ?? false);
  const cursor = useStore((s) => s.views[sessionId]?.cursor);
  const loadOlder = useStore((s) => s.loadOlder);
  const viewMode = useStore((s) => s.viewMode);
  const cli = viewMode === 'cli';
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const jumpingRef = useRef(false);
  const [renderTarget, setRenderTarget] = useState<string>();
  const outline = useConversationIndex(sessionId, blocks ?? EMPTY_BLOCKS, cursor, hasMore);
  // Anchor across prepended history: keep the viewport parked on the same
  // content while content grows above it (scrollHeight jumps).
  const anchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  // When the loaded set exceeds RENDER_CAP only the newest slice renders
  // until the user expands it.
  const [renderAll, setRenderAll] = useState(false);
  useEffect(() => {
    setRenderAll(false);
    setRenderTarget(undefined);
  }, [sessionId]);
  const targetIndex = renderTarget ? blocks?.findIndex(block => block.id === renderTarget) ?? -1 : -1;
  const window = outlineRenderWindow(blocks?.length ?? 0, targetIndex, renderAll);
  const hiddenAfter = (blocks?.length ?? 0) - window.end;

  const latest = () => {
    stickRef.current = true; setRenderTarget(undefined); setRenderAll(false);
    requestAnimationFrame(() => { const el = containerRef.current; if (el) el.scrollTop = el.scrollHeight; });
  };
  const navigate = async (id: string, signal: AbortSignal) => {
    stickRef.current = false; jumpingRef.current = true;
    try {
      for (;;) {
        if (signal.aborted) return;
        const view = useStore.getState().views[sessionId];
        if (view?.index.has(id)) { setRenderAll(false); setRenderTarget(id); return; }
        if (!view?.hasMore || !view.cursor) throw new Error('这条提问已不在当前历史中，请刷新目录');
        if (view.loadingOlder) {
          await new Promise(resolve => setTimeout(resolve, 50)); continue;
        }
        const before = view.cursor;
        const el = containerRef.current;
        if (el) anchorRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop };
        await loadOlder(sessionId, signal);
        if (useStore.getState().views[sessionId]?.cursor === before) throw new Error('历史加载未能继续，请重试');
      }
    } finally { jumpingRef.current = false; }
  };

  // Track whether the user is parked at the bottom; only then do we auto-follow.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickRef.current = !renderTarget && !jumpingRef.current && hiddenAfter === 0 && el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    // Near the top with older history left: pull the previous page and keep
    // the reading position stable across the prepend.
    if (el.scrollTop < 80 && hasMore && !loadingOlder && !jumpingRef.current && window.start === 0) {
      anchorRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop };
      void loadOlder(sessionId);
    }
  };

  // Composer resize changes bottom padding in chat and the scroll viewport's
  // height in TUI. Re-anchor either layout, without moving a reader in history.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor) {
      el.scrollTop = el.scrollHeight - anchor.prevScrollHeight + anchor.prevScrollTop;
      anchorRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [blocks, bottomPad, viewMode, renderAll, renderTarget]);

  // Snap to bottom when switching sessions.
  useEffect(() => {
    stickRef.current = true;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  const hidden = window.start;
  const shown = (blocks ?? EMPTY_BLOCKS).slice(window.start, window.end);
  // Every block of a sub-agent lands in ONE container for that agent, anchored
  // at the agent's first appearance (conversation order otherwise kept; later
  // occurrences of the same agent are absorbed, main-agent blocks pass through).
  // (Above the `!blocks` early return: hooks must run on every render.)
  const items = useMemo<ShownItem[]>(() => {
    const byUuid = new Map<string, ChatBlock[]>();
    for (const b of shown) {
      const uuid = b.kind === 'tool' ? subagentUuidOf(b) : undefined;
      if (!uuid) continue;
      const list = byUuid.get(uuid);
      if (list) list.push(b);
      else byUuid.set(uuid, [b]);
    }
    const out: ShownItem[] = [];
    const emitted = new Set<string>();
    for (const b of shown) {
      const uuid = b.kind === 'tool' ? subagentUuidOf(b) : undefined;
      if (!uuid) {
        out.push({ t: 'block', block: b });
        continue;
      }
      if (emitted.has(uuid)) continue;
      emitted.add(uuid);
      out.push({ t: 'run', uuid, blocks: byUuid.get(uuid)! });
    }
    return out;
  }, [shown]);

  if (!blocks) {
    return <div className="flex-1" />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={containerRef} onScroll={onScroll} className="conversation-scroll min-h-0 flex-1 overflow-y-auto">
      <div
        ref={contentRef}
        className={cn(
          'messages-pad mx-auto flex flex-col px-4 md:px-6',
          cli ? 'max-w-4xl gap-2' : 'max-w-3xl gap-4',
          embedded ? 'pt-6 pb-8' : 'pt-28 md:pt-20',
        )}
        // TUI already reserves the composer in normal flow: no duplicate blank
        // spacer below the transcript. Chat still clears its floating stack.
        style={bottomPad !== undefined ? { paddingBottom: `${(cli ? 0 : bottomPad) + 8}px` } : undefined}
      >
        {blocks.length === 0 ? (
          <div className={cn('py-20 text-sm text-slate-600', cli ? 'font-mono text-left' : 'text-center')}>
            {cli ? '// send a message to start the conversation' : 'Send a message to start the conversation.'}
          </div>
        ) : (
          <>
            {(hasMore || hidden > 0) && (
              <div className="flex flex-col items-center gap-2 pb-2 text-xs text-slate-500">
                {hasMore &&
                  (loadingOlder ? (
                    <span className="animate-pulse">正在加载更早的消息…</span>
                  ) : (
                    <button
                      type="button"
                      className="rounded-full border border-white/10 px-3 py-1 hover:bg-white/5"
                      onClick={() => {
                        const el = containerRef.current;
                        if (el) anchorRef.current = { prevScrollHeight: el.scrollHeight, prevScrollTop: el.scrollTop };
                        void loadOlder(sessionId);
                      }}
                    >
                      加载更早的消息
                    </button>
                  ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="rounded-full border border-white/10 px-3 py-1 hover:bg-white/5"
                    onClick={() => setRenderAll(true)}
                  >
                    渲染剩余 {hidden} 条消息（共 {blocks.length} 条）
                  </button>
                )}
              </div>
            )}
            {items.map((item, i) =>
              item.t === 'run' ? (
                <SubagentRun key={`run-${item.uuid}-${i}`} uuid={item.uuid} blocks={item.blocks} cli={cli} />
              ) : (
                <Fragment key={item.block.id}>
                  {/* Turn boundary: a hairline between the previous answer and the
                      user's next question (not before the first message). Drawn
                      with border utilities so the high-contrast theme picks it
                      up like every other hairline. */}
                  {item.block.kind === 'user' && (i > 0 || hidden > 0) && (
                    <div className={cn('border-t', cli ? 'mt-2 border-ink-700' : 'mt-4 border-white/10')} />
                  )}
                  {item.block.kind === 'user' ? <div data-question-id={item.block.id} tabIndex={-1} className="question-anchor outline-none">
                    {cli ? <CliBlockView block={item.block} /> : <BlockView block={item.block} />}
                  </div> : cli ? <CliBlockView block={item.block} /> : <BlockView block={item.block} />}
                </Fragment>
              ),
            )}
            {hiddenAfter > 0 && <button type="button" onClick={latest} className="my-4 self-center rounded-full border border-ink-600 bg-ink-900 px-4 py-2 text-xs text-slate-400 hover:text-slate-100">
              下方还有 {hiddenAfter} 条消息 · 回到最新
            </button>}
          </>
        )}
      </div>
    </div>
    <ConversationOutline entries={outline.entries} viewport={containerRef} content={contentRef}
      hasMore={outline.hasMore} loading={outline.loading} error={outline.error} onOpen={() => void outline.load()} onClose={outline.stop}
      onJump={navigate} onLatest={latest} />
    </div>
  );
}
