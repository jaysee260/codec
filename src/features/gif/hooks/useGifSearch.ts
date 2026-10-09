/**
 * DEV-A-20 GIF search state: the data half of `<GifPicker>`, kept out of the component so the
 * component is only markup + keyboard.
 *
 *   const s = useGifSearch(query);   // '' -> trending, anything else -> search
 *
 * Behaviour the acceptance criteria pin down (docs/PHASE4_ACCEPTANCE.md):
 *  - **Debounce 300 ms** (AC-G2-4): a query typed in bursts fires one request. The *first* run of a
 *    mount is immediate, so `initialQuery` (`/gif tacos`, Enter) searches without a 300 ms stall.
 *  - **Abort** (AC-G2-4): the in-flight request is aborted when the query changes or the picker
 *    unmounts; `GifProviderError('aborted')` is swallowed, never shown.
 *  - **Cache of the last 20 queries** (AC-G2-4): keyed by `provider|query|page`, so re-typing a
 *    query - or reopening the picker on `Trending` - sends no request at all. A cache hit also skips
 *    the debounce (the grid repaints instantly). Rejections are never cached, so `retry()` works.
 *  - **Order** (AC-G4-3): results are passed through exactly as the provider returned them. No
 *    filtering, no sorting, no de-duplication - Klipy's integration terms require it.
 *  - **Pagination** (`gif-load-more`, P1): `loadMore()` appends `nextPage`'s results.
 *
 * The provider comes from `searchGifs` / `trendingGifs` (`src/lib/gif/provider.ts`), which resolve
 * `mock` / `klipy` from the Klipy key and memoises per key, so this hook never has to know which.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gifProviderName, searchGifs, trendingGifs, GifProviderError, type GifPage, type GifProviderName, type GifResult } from '@/lib/gif';

/** Debounce for keystrokes (docs/PHASE4_PLAN.md: >= 300 ms, the Klipy Test key allows 100 req/hour). */
export const GIF_SEARCH_DEBOUNCE_MS = 300;
/** Results requested per page (Klipy clamps to 8..50; the mock ignores it). */
export const GIF_PAGE_SIZE = 24;
/** How many (query, page) responses are remembered per mount. */
const CACHE_LIMIT = 20;

export interface UseGifSearchOptions {
  /** `false` parks the hook: no request, no state change (e.g. a picker rendered but hidden). */
  enabled?: boolean;
  /** Results per page. Default 24. */
  limit?: number;
  /** Debounce in ms. Default 300. `0` for tests. */
  debounceMs?: number;
}

export interface GifSearchState {
  /** Provider order, unfiltered. Appended to by `loadMore()`. */
  results: GifResult[];
  /** A first page is in flight (the grid may still be showing the previous query's results). */
  loading: boolean;
  /** `loadMore()` is in flight. */
  loadingMore: boolean;
  /** Human-readable failure for `gif-error`; `null` when the last request succeeded. */
  error: string | null;
  /** `true` when `nextPage` is set, i.e. `loadMore()` would fetch something. */
  hasMore: boolean;
  /**
   * Bumped only when `results` is *replaced* by a new first page - never when `loadMore()` appends.
   * The picker resets its selection (and its "focus the first result" rule) on this rather than on
   * `results` identity, so paginating at the bottom of the grid does not jump the cursor back to
   * tile 0 and scroll the user to the top.
   */
  epoch: number;
  /** Which provider answered (`gif-picker[data-provider]`, attribution line, placeholder). */
  provider: GifProviderName;
  /** Re-run the last request, bypassing the cache (`gif-error-retry`). */
  retry(): void;
  /** Append the next page (`gif-load-more`). No-op while loading or when `hasMore` is false. */
  loadMore(): void;
}

/** `aborted` is the one kind that must never reach the UI; the rest are shown verbatim in `gif-error`. */
function isAbort(e: unknown): boolean {
  if (e instanceof GifProviderError) return e.kind === 'aborted';
  return (e as { name?: string } | null)?.name === 'AbortError';
}

function messageOf(e: unknown): string {
  if (e instanceof GifProviderError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Unknown error';
}

export function useGifSearch(query: string, opts: UseGifSearchOptions = {}): GifSearchState {
  const { enabled = true, limit = GIF_PAGE_SIZE, debounceMs = GIF_SEARCH_DEBOUNCE_MS } = opts;

  // Resolved once per mount so the grid, the placeholder and `gif-picker[data-provider]` can never
  // disagree mid-session; `searchGifs` / `trendingGifs` re-resolve per call, so a key pasted into
  // DevTools takes effect the next time the picker is opened (AC-G1-1).
  const provider = useMemo<GifProviderName>(() => gifProviderName(), []);

  const [results, setResults] = useState<GifResult[]>([]);
  const [nextPage, setNextPage] = useState<string | number | null | undefined>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `retry()`; part of the first-page effect's dependency list.
  const [generation, setGeneration] = useState(0);
  // Bumped whenever the first page replaces `results` (see `GifSearchState.epoch`).
  const [epoch, setEpoch] = useState(0);

  const cache = useRef(new Map<string, GifPage>());
  const abortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  // The first run of a mount must not wait 300 ms (`initialQuery` / trending on open).
  const immediate = useRef(true);

  const trimmed = query.trim();
  const cacheKey = useCallback(
    (q: string, page: string | number | null | undefined): string => `${provider}|${q}|${page ?? 1}`,
    [provider],
  );

  const remember = useCallback((key: string, page: GifPage): void => {
    const map = cache.current;
    // Re-insert so the most recently used key is last, then drop from the front (LRU of 20).
    map.delete(key);
    map.set(key, page);
    while (map.size > CACHE_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }, []);

  /** First page for `trimmed`: cache hit paints synchronously, otherwise debounce -> fetch. */
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const key = cacheKey(trimmed, 1);
    const hit = cache.current.get(key);
    if (hit) {
      // Same session, same query: no request at all (AC-G2-4). `retry()` deletes the entry first,
      // so it always reaches the network.
      remember(key, hit);
      setResults(hit.results);
      setEpoch((e) => e + 1);
      setNextPage(hit.nextPage ?? null);
      setError(null);
      setLoading(false);
      immediate.current = false;
      return;
    }

    // `immediate` is cleared inside the timer, not here. Under `<React.StrictMode>` (src/main.tsx)
    // every effect runs, is cleaned up, and runs again on mount: clearing it up front would mean the
    // second run no longer counts as "first", and trending-on-open / `initialQuery` would sit through
    // the 300 ms debounce. Clearing it where the request is actually issued survives that.
    const wait = immediate.current ? 0 : debounceMs;
    setLoading(true);
    // Keep the previous results on screen while the new ones load: `gif-loading` only replaces the
    // grid when it is empty, so a refetch does not flash.
    let cancelled = false;

    const timer = window.setTimeout(() => {
      immediate.current = false;
      const ctrl = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ctrl;
      const request = trimmed
        ? searchGifs(trimmed, { limit, signal: ctrl.signal })
        : trendingGifs({ limit, signal: ctrl.signal });

      request.then(
        (page) => {
          if (cancelled || ctrl.signal.aborted) return;
          remember(key, page);
          setResults(page.results);
          setEpoch((n) => n + 1);
          setNextPage(page.nextPage ?? null);
          setError(null);
          setLoading(false);
        },
        (e: unknown) => {
          if (cancelled || isAbort(e)) return;
          setResults([]);
          setEpoch((n) => n + 1);
          setNextPage(null);
          setError(messageOf(e));
          setLoading(false);
        },
      );
    }, wait);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // Stale request: cancel it so a slow answer can never overwrite a newer query (and so the
      // Klipy Test quota is not spent on characters the user already deleted).
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, trimmed, generation, debounceMs, limit, cacheKey, remember]);

  // Nothing is paginated across a query change.
  useEffect(() => {
    moreAbortRef.current?.abort();
    moreAbortRef.current = null;
    setLoadingMore(false);
  }, [trimmed, generation]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      moreAbortRef.current?.abort();
    },
    [],
  );

  const retry = useCallback((): void => {
    cache.current.delete(cacheKey(trimmed, 1));
    setError(null);
    immediate.current = true;
    setGeneration((g) => g + 1);
  }, [cacheKey, trimmed]);

  const loadMore = useCallback((): void => {
    if (!enabled || loading || loadingMore) return;
    const page = nextPage;
    if (page === null || page === undefined) return;

    const key = cacheKey(trimmed, page);
    const hit = cache.current.get(key);
    if (hit) {
      setResults((prev) => [...prev, ...hit.results]);
      setNextPage(hit.nextPage ?? null);
      return;
    }

    const ctrl = new AbortController();
    moreAbortRef.current?.abort();
    moreAbortRef.current = ctrl;
    setLoadingMore(true);
    const request = trimmed
      ? searchGifs(trimmed, { page, limit, signal: ctrl.signal })
      : trendingGifs({ page, limit, signal: ctrl.signal });

    request.then(
      (next) => {
        if (ctrl.signal.aborted) return;
        remember(key, next);
        setResults((prev) => [...prev, ...next.results]);
        setNextPage(next.nextPage ?? null);
        setLoadingMore(false);
      },
      (e: unknown) => {
        if (isAbort(e)) return;
        // A failed *extra* page keeps the results it already has; the message still surfaces.
        setError(messageOf(e));
        setNextPage(null);
        setLoadingMore(false);
      },
    );
  }, [enabled, loading, loadingMore, nextPage, cacheKey, trimmed, limit, remember]);

  return {
    results,
    loading,
    loadingMore,
    error,
    hasMore: nextPage !== null && nextPage !== undefined,
    epoch,
    provider,
    retry,
    loadMore,
  };
}
