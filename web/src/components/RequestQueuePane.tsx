import { CirclePause, Clock, Loader2, Play, X } from '../lib/icons';
import { cn } from '../lib/format';
import { stripAttachments } from '../lib/attachments';
import { useStore } from '../store/store';
import type { RequestQueuePauseReason } from '@shared/protocol';
import { interruptedContinuationPrompt } from '@shared/interruptedContinuation';

const REASONS: Record<RequestQueuePauseReason, string> = {
  manual: 'Queue paused. The current response is not interrupted.',
  stopped: 'Queue paused after Stop. Resume when you are ready.',
  error: 'Queue paused because the previous response failed.',
  restart: 'Service restarted. Interrupted work will continue from prior progress, not resend the original request. Review before continuing.',
  unavailable: 'Queue paused because the session or connection is unavailable.',
};

export function RequestQueuePane({ sessionId }: { sessionId: string }) {
  const queue = useStore((store) => store.requestQueues[sessionId]);
  const outbox = useStore((store) => store.requestOutbox[sessionId]);
  const connected = useStore((store) => store.status === 'open');
  const cli = useStore((store) => store.viewMode === 'cli');
  const control = useStore((store) => store.controlRequestQueue);
  const remove = useStore((store) => store.removeQueuedRequest);
  const retry = useStore((store) => store.retryPendingRequest);
  const items = queue?.items ?? [];
  const ids = new Set(items.map((item) => item.id));
  const sending = (outbox ?? []).filter((item) => !ids.has(item.id));
  if (!items.length && !sending.length && !queue?.error) return null;

  const interrupted = items.some((item) => item.interrupted);
  const rows = [
    ...items.map((item) => ({ ...item, state: 'queued' as const, error: undefined })),
    ...sending,
  ];
  return (
    <section aria-label="Queued requests" className={cn('mx-4 mb-2 overflow-hidden rounded-xl border border-white/10 bg-ink-900/90 text-[11px] md:mx-6', cli && 'font-mono')}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Clock className="h-4 w-4 text-accent-soft" />
        <span className="text-slate-300">Next requests</span>
        <span className="text-slate-500">{items.length} queued{sending.length ? ` · ${sending.length} unconfirmed` : ''}</span>
        {items.length > 0 && (
          <button
            type="button"
            disabled={!connected}
            onClick={() => control(sessionId, queue?.paused ? 'resume' : 'pause')}
            className="ml-auto inline-flex items-center gap-1 text-accent-soft hover:underline disabled:opacity-40"
          >
            {queue?.paused ? <Play className="h-3 w-3" /> : <CirclePause className="h-3 w-3" />}
            {queue?.paused ? interrupted ? 'Continue interrupted & resume queue' : 'Resume queue' : 'Pause queue'}
          </button>
        )}
      </div>
      {(queue?.paused || queue?.error || !connected) && (
        <div role="status" className="border-t border-white/5 px-3 py-1.5 text-amber-600 dark:text-amber-300">
          {queue?.error || (queue?.reason ? REASONS[queue.reason] : '')}
          {!connected && <p>Disconnected. Unconfirmed sends will retry on reconnect.</p>}
        </div>
      )}
      <ol className="max-h-48 overflow-y-auto border-t border-white/5 px-2 py-1">
        {rows.map((item, index) => {
          const continuation = Boolean(item.interrupted || item.continuation);
          const { text, files } = stripAttachments(item.text);
          const preview = continuation ? interruptedContinuationPrompt(item.text)
            : text.trim() || (files.length ? `${files.length} attached file(s)` : item.text);
          return (
            <li key={item.id} data-request-id={item.id} className="flex items-start gap-2 rounded px-1 py-1.5">
              <span className="mt-px shrink-0 text-slate-600">{index + 1}.</span>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 break-words text-slate-300" title={continuation ? preview : undefined}>{preview.slice(0,240)}</div>
                {item.interrupted && <div className="text-amber-600 dark:text-amber-300">Interrupted — review before continuing</div>}
                {item.continuation && !item.interrupted && <div className="text-slate-500">Continue from saved progress</div>}
                {item.state === 'sending' && <div className="mt-0.5 inline-flex items-center gap-1 text-slate-500"><Loader2 className="h-3 w-3 animate-spin" /> Sending…</div>}
                {item.error && <div className="mt-0.5 break-words text-rose-500">Not sent: {item.error}</div>}
              </div>
              {item.state === 'failed' && (
                <button type="button" disabled={!connected} onClick={() => retry(sessionId, item.id)} className="text-accent-soft hover:underline disabled:opacity-40">Retry</button>
              )}
              <button
                type="button"
                aria-label={`Remove queued request ${index + 1}`}
                title={item.state === 'sending' ? 'Waiting for server acknowledgement' : 'Remove request'}
                disabled={item.state === 'sending' || (item.state !== 'failed' && !connected)}
                onClick={() => remove(sessionId, item.id)}
                className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
              ><X className="h-3.5 w-3.5" /></button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
