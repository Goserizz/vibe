/**
 * Stale-while-revalidate cache: HTTP handlers always return immediately
 * (cached value or fallback) while a single background refresh runs per key.
 */

export interface SwrCache<T> {
  /** Return cache/fallback now; schedule refresh when missing or past TTL. */
  serve(key: string, fetch: () => Promise<T | null | undefined>): T;
  /** Force a background refresh; still returns cache/fallback immediately. */
  refresh(key: string, fetch: () => Promise<T | null | undefined>): T;
  peek(key: string): T | undefined;
  /** Mark stale (keep last value) so the next serve/refresh re-fetches. */
  invalidate(key: string): void;
  /** Drop the entry entirely. */
  delete(key: string): void;
}

export function createSwrCache<T>(opts: {
  ttlMs: number;
  fallback: T;
  /** Treat a fetched value as a miss (keep previous / fallback). */
  isEmpty?: (value: T) => boolean;
  onError?: (key: string, err: unknown) => void;
}): SwrCache<T> {
  const caches = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<void>>();

  function store(key: string, value: T): void {
    caches.set(key, { at: Date.now(), value });
  }

  function run(key: string, fetch: () => Promise<T | null | undefined>): void {
    if (inflight.has(key)) return;
    const pending = fetch()
      .then((value) => {
        if (value == null) return;
        if (opts.isEmpty?.(value)) return;
        store(key, value);
      })
      .catch((err) => opts.onError?.(key, err))
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
  }

  return {
    serve(key, fetch) {
      const hit = caches.get(key);
      const fresh = !!hit && Date.now() - hit.at < opts.ttlMs;
      if (!fresh) run(key, fetch);
      return hit?.value ?? opts.fallback;
    },
    refresh(key, fetch) {
      run(key, fetch);
      return caches.get(key)?.value ?? opts.fallback;
    },
    peek(key) {
      return caches.get(key)?.value;
    },
    invalidate(key) {
      const hit = caches.get(key);
      if (hit) hit.at = 0;
    },
    delete(key) {
      caches.delete(key);
    },
  };
}
