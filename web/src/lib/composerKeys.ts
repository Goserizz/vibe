import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/**
 * Keydown affordances shared by the coding Composer and VibotComposer:
 *
 *  - Ctrl-U is readline's unix-line-discard: delete from the start of the
 *    current line up to the caret (text after the caret on that line and all
 *    other lines survive), leaving the caret at the line start. On a
 *    single-line input with the caret at the end that reads as "clear the
 *    field". An empty span (caret already at the line start) only prevents the
 *    browser default. Never touches the clipboard.
 *  - ↑/↓ page through the persisted prompt history. ↑ from the first line (or
 *    an empty field) stashes the current draft and recalls the previous entry;
 *    ↓ walks back toward the newest entry and finally restores the draft, like
 *    a shell. The caret lands at the end of the recalled text, and arrows keep
 *    their normal caret-moving behavior whenever the caret sits inside
 *    multi-line text. ↑ with no history yet reports back via onEmptyHistory
 *    instead of being a dead key.
 *  - Escape stops a running turn, exactly like the Stop button. It only fires
 *    on the focused composer, and overlays that own Escape (file preview…)
 *    win first.
 *
 * History is isolated per session: each composer buckets its entries under
 * `bucketId` (the session / conversation id), so ↑ in one conversation never
 * recalls another's prompts. All buckets live in one localStorage key as an
 * ordered [bucketId, entries][] array (least-recently-used first — an array,
 * not an object, because JSON object key order is not stable for numeric-looking
 * ids). Only the most recent BUCKET_LIMIT buckets are kept, each capped at
 * LIMIT entries with consecutive duplicates dropped, so the payload stays
 * bounded. Nothing is seeded from old transcripts (stored user blocks carry
 * attachment-folded prompts and replay semantics), and the pre-isolation
 * format — one flat global string[] — is simply discarded, not migrated, so
 * old shared entries can never leak into a session bucket.
 */

const LIMIT = 100;
/** Sessions whose history buckets survive in localStorage (LRU). */
const BUCKET_LIMIT = 50;
/** Stable bucket for the (theoretical) case of a composer without a session id. */
const FALLBACK_BUCKET = '_none';

/** v2 store shape: buckets ordered least-recently-used first. */
type Bucket = [id: string, entries: string[]];

function parseEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, LIMIT);
}

function loadBuckets(storageKey: string): Bucket[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // v1 was a flat string[] shared across every session — dropped rather
    // than migrated (see the header comment).
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { buckets?: unknown }).buckets)) return [];
    return ((parsed as { buckets: unknown[] }).buckets as unknown[])
      .filter((pair): pair is [string, unknown] => Array.isArray(pair) && typeof pair[0] === 'string')
      .map((pair) => [pair[0], parseEntries(pair[1])] as Bucket)
      .slice(-BUCKET_LIMIT);
  } catch {
    return []; // corrupt or unavailable storage — start fresh
  }
}

function saveBuckets(storageKey: string, buckets: Bucket[]): void {
  try {
    const store: { v: 2; buckets: Bucket[] } = { v: 2, buckets: buckets.slice(-BUCKET_LIMIT) };
    localStorage.setItem(storageKey, JSON.stringify(store));
  } catch {
    /* quota exceeded / private mode — keep the in-memory copy only */
  }
}

export interface ComposerKeysOptions {
  /** Latest composer text, read lazily so keydown never sees a stale closure. */
  getText: () => string;
  setText: (value: string) => void;
  /** The composer's textarea (auto-grow ref); used for caret placement. */
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** True while the turn is generating — gates Escape-to-stop. */
  isRunning: () => boolean;
  /** The Stop button's handler. */
  onStop: () => void;
  /** True when an overlay (file preview, dialog…) owns Escape instead. */
  escapeSuppressed?: () => boolean;
  /** Notified when ↑ is pressed with no recorded history yet, so the key
   *  gives feedback instead of silently doing nothing. */
  onEmptyHistory?: () => void;
  /** localStorage key holding the per-session history store. */
  storageKey: string;
  /** Session/conversation id whose bucket the history is isolated to. */
  bucketId: string;
}

/** Position inside the history while paging; null = not paging. */
type Nav = { index: number; draft: string } | null;

export function useComposerKeys(options: ComposerKeysOptions) {
  // Handlers stay stable across renders; live values (running, text, session)
  // arrive through the ref so the callbacks never go stale.
  const opts = useRef(options);
  opts.current = options;

  const bucketRef = useRef<string | null>(null);
  const entriesRef = useRef<string[] | null>(null); // entries of bucketRef
  const navRef = useRef<Nav>(null);
  const pendingCaretRef = useRef<number | null>(null);
  // Bumped on every programmatic edit so the layout effect below runs after
  // the new text has been committed to the DOM (React never fires onChange
  // for it, and setting the selection before the commit would clamp to the
  // old length).
  const [caretTick, setCaretTick] = useState(0);

  /** Resolve the active session's bucket, loading its entries on first use
   *  and on every session switch. A switch also drops any paging position —
   *  it belongs to the previous conversation, not this one. */
  const activeBucket = useCallback((): [string, string[]] => {
    const id = opts.current.bucketId || FALLBACK_BUCKET;
    if (bucketRef.current !== id || entriesRef.current === null) {
      navRef.current = null;
      bucketRef.current = id;
      entriesRef.current = loadBuckets(opts.current.storageKey).find(([b]) => b === id)?.[1] ?? [];
    }
    return [bucketRef.current, entriesRef.current!];
  }, []);

  /** Replace the text and park the caret after React has flushed the value. */
  const applyText = useCallback((value: string, caret: number) => {
    opts.current.setText(value);
    pendingCaretRef.current = caret;
    setCaretTick((t) => t + 1);
  }, []);

  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const el = opts.current.textareaRef.current;
    if (!el) return;
    // A recalled entry can be long — keep the caret end scrolled into view.
    if (caret >= el.value.length) el.scrollTop = el.scrollHeight;
    el.setSelectionRange(caret, caret);
  }, [caretTick]);

  /** Record a sent prompt; call once the send has actually gone out. */
  const commit = useCallback((text: string) => {
    navRef.current = null;
    const value = text.trim();
    const [id, list] = activeBucket();
    if (!value || list[list.length - 1] === value) return; // empty / consecutive duplicate
    list.push(value);
    if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
    // Rewrite the store with this bucket refreshed and moved to the
    // most-recently-used end; older buckets beyond BUCKET_LIMIT fall off.
    const buckets = loadBuckets(opts.current.storageKey).filter(([b]) => b !== id);
    buckets.push([id, list]);
    saveBuckets(opts.current.storageKey, buckets);
  }, [activeBucket]);

  /** Route user edits through here — typing resets history paging. */
  const onChange = useCallback((value: string) => {
    navRef.current = null;
    opts.current.setText(value);
  }, []);

  /** Handle a composer keydown. Returns true when the key was consumed. */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const { getText, isRunning, onStop, escapeSuppressed, onEmptyHistory } = opts.current;

      // Nothing here may fire mid-IME composition (the candidate window owns
      // the keyboard while it is up).
      if (e.nativeEvent.isComposing) return false;

      // Ctrl-U: readline unix-line-discard — kill from the line start up to
      // the caret, keep the rest, park the caret at the line start.
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === 'KeyU' || e.key === 'u')) {
        e.preventDefault();
        navRef.current = null;
        const el = e.currentTarget;
        const value = getText();
        const caret = el.selectionEnd ?? value.length;
        // Start of the line holding the caret: just after the last newline
        // strictly before it (caret 0 → 0; value[0] === '\n' must not count).
        const lineStart = caret > 0 ? value.lastIndexOf('\n', caret - 1) + 1 : 0;
        if (lineStart < caret) applyText(value.slice(0, lineStart) + value.slice(caret), lineStart);
        return true; // empty span: nothing deleted, only the default prevented
      }

      if (e.key === 'Escape') {
        if (!isRunning() || escapeSuppressed?.()) return false;
        e.preventDefault();
        onStop();
        return true;
      }

      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
      const up = e.key === 'ArrowUp';
      const el = e.currentTarget;
      const value = getText();
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? start;
      const firstLine = !value.slice(0, start).includes('\n');
      const lastLine = !value.slice(end).includes('\n');
      const nav = navRef.current;

      if (up) {
        // Paging starts from the first line (an empty field counts); once
        // paging, the caret sits at the end of the recalled entry so ↑ keeps
        // going from there. A caret deliberately moved inside the text keeps
        // normal editing.
        const canPage = nav !== null ? firstLine || end === value.length : firstLine;
        if (!canPage) return false;
        const [, list] = activeBucket();
        if (!list.length) {
          // Nothing sent from this session yet (history only records from
          // this build onward) — ↑ would otherwise be a dead key.
          e.preventDefault();
          onEmptyHistory?.();
          return true;
        }
        e.preventDefault();
        const index = nav === null ? list.length - 1 : Math.max(0, nav.index - 1);
        navRef.current = { index, draft: nav === null ? value : nav.draft };
        applyText(list[index], list[index].length);
        return true;
      }

      // ↓ walks back toward the newest entry, then restores the stashed draft.
      if (nav === null || !lastLine) return false;
      e.preventDefault();
      const [, list] = activeBucket();
      if (nav.index < list.length - 1) {
        const index = nav.index + 1;
        const recalled = list[index];
        navRef.current = { index, draft: nav.draft };
        applyText(recalled, recalled.length);
      } else {
        navRef.current = null;
        applyText(nav.draft, nav.draft.length);
      }
      return true;
    },
    [activeBucket, applyText],
  );

  return { commit, onChange, onKeyDown };
}
