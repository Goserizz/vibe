import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conversationHeadings, mergeConversationHeadings, type ConversationHeading } from '@shared/conversationOutline';
import type { ChatBlock } from '@shared/protocol';
import { api } from '../lib/api';

/** Fetch while visible: automatically for docked wide panels, on opening for
 * dropdowns. Hiding or switching session aborts the walk; headings are reusable. */
export function useConversationIndex(sessionId: string, blocks: readonly ChatBlock[], cursor?: string, hasMore = false) {
  const [older, setOlder] = useState<ConversationHeading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [complete, setComplete] = useState(false);
  const remaining = useRef<string>();
  const initialized = useRef(false);
  const request = useRef<AbortController>();
  const current = useMemo(() => conversationHeadings(blocks), [blocks]);
  const entries = useMemo(() => mergeConversationHeadings(older, current), [older, current]);

  const stop = useCallback(() => { request.current?.abort(); request.current = undefined; setLoading(false); }, []);
  useEffect(() => () => { request.current?.abort(); }, [sessionId]);
  const load = useCallback(async () => {
    if (request.current || complete) return;
    if (!initialized.current) {
      initialized.current = true; remaining.current = cursor;
      if (!hasMore) { setComplete(true); return; }
    }
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(undefined);
    try {
      for (let pages = 0; pages < 100; pages++) {
        const before = remaining.current;
        const page = await api.getConversationOutline(sessionId, before, controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(page.entries)) throw new Error('目录接口暂不可用，请刷新后重试');
        setOlder(previous => mergeConversationHeadings(page.entries, previous));
        if (!page.hasMore) { setComplete(true); return; }
        if (!page.cursor || page.cursor === before) throw new Error('历史索引未能继续，请重试');
        remaining.current = page.cursor;
      }
      setError('历史较长，点击继续加载目录');
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '目录加载失败');
    } finally {
      if (request.current === controller) { request.current = undefined; setLoading(false); }
    }
  }, [sessionId, cursor, hasMore, complete]);
  return { entries, loading, error, hasMore: !complete && hasMore, load, stop };
}
