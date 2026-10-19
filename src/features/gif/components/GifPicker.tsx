/**
 * DEV-A-20 / DEV-A-21 GIF picker (`gif-picker`). The Slack-style panel behind `composer-gif` and the
 * `/gif` / `/giphy` commands. Criteria: docs/archive/PHASE4_ACCEPTANCE.md AC-G4 (UI), AC-G5 (keyboard),
 * AC-G9-1/3 (phone sheet).
 *
 * One component, two presentations - the same split as `Dialog` / `ThreadList`:
 *  - `variant="popover"` (desktop): a 420 x 420 panel **rendered inline, with no positioning of its
 *    own**. Dev B's mount anchors it above the composer; it only promises to be a flex column whose
 *    grid scrolls internally.
 *  - `variant="sheet"` (phone): `position: fixed` to the bottom of the viewport, full width, grab
 *    handle, `min-height: 55vh` / `max-height: 70vh` (AC-G9-1 wants 55-85 %), `padding-bottom:
 *    var(--safe-bottom)`, 16 px input font so iOS does not zoom (AC-G9-3). It positions itself, so it
 *    works whether or not Dev B wraps it in `gif-backdrop`.
 *
 * **Ownership split agreed with Dev B** (coordinator, 2026-10-09): the picker does **not** render a
 * backdrop and does **not** listen for clicks outside itself. `gif-backdrop`, click-outside and any
 * document-level Escape belong to the mount, which also owns focus return to `composer-input`. The
 * picker calls `onClose()` from exactly two places: Escape pressed inside it, and `gif-close`. Escape
 * is handled on the picker root with `stopPropagation()` so the composer's own Escape (cancel reply /
 * cancel edit, AC-B6-4) does not also fire while the picker is in front.
 *
 * Keyboard (AC-G5). One `selectedIndex`, reset to 0 whenever a new result set lands, so
 * `/gif tacos` + Enter + Enter sends the first hit with no arrow keys (AC-G5-3):
 *  | focus        | key                     | effect |
 *  |--------------|-------------------------|--------|
 *  | `gif-search` | Left / Right            | selection -/+ 1, caret untouched, focus stays in the input |
 *  | `gif-search` | Down                    | move DOM focus onto the *already selected* tile (so the first Down selects index 0, AC-G5-1) |
 *  | `gif-search` | Enter                   | pick the selected result |
 *  | tile         | Left / Right / Up / Down| -/+ 1 and -/+ one row (3 columns in the popover, 2 in the sheet), clamped |
 *  | tile         | Enter / Space           | pick |
 *  | tile         | a printable character   | focus `gif-search` and append it |
 *  | anywhere     | Escape                  | `onClose()` |
 *  | anywhere     | Tab / Shift+Tab         | cycles inside the picker only: search -> selected tile -> load more -> retry -> close -> search |
 * The selected tile is scrolled into view by adjusting the grid's own `scrollTop` (never
 * `scrollIntoView`, which would also scroll the page / the timeline behind the popover).
 *
 * Accessibility: `role="dialog"` + `aria-label="GIF picker"` on the root; the input is a
 * `combobox` whose `aria-activedescendant` names the selected tile; the grid is a `listbox` of
 * `option`s with a roving tabindex.
 *
 * Data, debounce, abort and the 20-query cache live in `../hooks/useGifSearch.ts`. Results are
 * rendered in provider order, never filtered or sorted (AC-G4-3 - a Klipy integration term).
 *
 * testids: gif-picker, gif-search, gif-heading, gif-grid, gif-item-{id}, gif-loading, gif-empty,
 *          gif-error, gif-error-retry, gif-attribution, gif-close, gif-load-more
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { GifResult } from '@/lib/gif';
import { GifTile, type ObserveTile } from './GifTile.tsx';
import { useGifSearch } from '../hooks/useGifSearch.ts';
import styles from './GifPicker.module.css';

export type GifPickerVariant = 'popover' | 'sheet';

export interface GifPickerProps {
  /** Pre-fill the search box and search on mount with no debounce (`/gif tacos`). Empty = trending. */
  initialQuery?: string;
  /** A tile was clicked or Enter-ed. The mount closes the picker and sends; called at most once. */
  onPick(gif: GifResult): void;
  /** Escape inside the picker, or `gif-close`. The mount owns backdrop / outside clicks. */
  onClose(): void;
  /** `popover` = inline panel positioned by the parent; `sheet` = self-positioning phone bottom sheet. */
  variant: GifPickerVariant;
  /** Focus `gif-search` on mount (registry: "autofocused on open"). Default `true`. */
  autoFocus?: boolean;
}

/** Columns per variant. Must match `grid-template-columns` in the stylesheet (AC-G4-1 / AC-G9-1). */
const COLUMNS: Record<GifPickerVariant, number> = { popover: 3, sheet: 2 };
/** How far outside the grid a tile may be before its preview is mounted (prefetch, see GifTile). */
const PREFETCH_MARGIN = '200px';
/** Keep the selected tile this far from the scroller's edges. */
const SCROLL_PADDING = 8;

/** Live `prefers-reduced-motion`. Media-query listener so toggling the OS setting takes effect at once. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    setReduced(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function GifPicker({ initialQuery = '', onPick, onClose, variant, autoFocus = true }: GifPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const reducedMotion = useReducedMotion();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLButtonElement | null>(null);

  const gridId = useId();
  const columns = COLUMNS[variant];
  const { results, loading, loadingMore, error, hasMore, epoch, provider, retry, loadMore } = useGifSearch(query);

  const trimmed = query.trim();
  const isKlipy = provider === 'klipy';
  const selected: GifResult | undefined = results[selectedIndex];

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  // A fresh result set always starts at index 0, so Enter can never pick a tile from the previous
  // query (AC-G5-3 relies on the pre-selection; the reset is what makes it safe). Keyed on `epoch`,
  // not on `results` identity: `loadMore()` also produces a new array, and resetting there would
  // throw the cursor back to tile 0 and scroll to the top just as the user reached the bottom.
  useEffect(() => {
    setSelectedIndex(0);
  }, [epoch]);

  const tileAt = useCallback((index: number): HTMLElement | null =>
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null, []);

  /** Nudge the grid's own scrollTop; never `scrollIntoView` (that would scroll the timeline too). */
  const revealTile = useCallback((index: number): void => {
    const grid = gridRef.current;
    const el = tileAt(index);
    if (!grid || !el) return;
    const g = grid.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    if (t.top < g.top) grid.scrollTop -= g.top - t.top + SCROLL_PADDING;
    else if (t.bottom > g.bottom) grid.scrollTop += t.bottom - g.bottom + SCROLL_PADDING;
  }, [tileAt]);

  useEffect(() => {
    if (results.length > 0) revealTile(selectedIndex);
  }, [selectedIndex, results, revealTile]);

  /** Clamped selection change; `focusTile` also moves DOM focus (arrow keys inside the grid). */
  const moveSelection = useCallback(
    (delta: number, focusTile: boolean): void => {
      if (results.length === 0) return;
      const next = Math.min(results.length - 1, Math.max(0, selectedIndex + delta));
      setSelectedIndex(next);
      if (focusTile) {
        // The tile's tabindex flips to 0 on the same commit, so focus after paint.
        requestAnimationFrame(() => tileAt(next)?.focus());
      }
    },
    [results.length, selectedIndex, tileAt],
  );

  // ---------------------------------------------------------------------------
  // Focus
  // ---------------------------------------------------------------------------

  // Registry: `gif-search` is autofocused on open (AC-G4-1 asserts focus + an empty value).
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    // Mount only: re-focusing when a prop changes would fight the user's typing.
  }, []);

  // After a *new* search, put focus on the first result - but only when focus is already inside the
  // picker and not in the search box. Typing must never be interrupted, and focus must never be
  // yanked out of the composer behind us.
  // Keyed on `epoch` for the same reason as the selection reset: appending a page must not move focus.
  useEffect(() => {
    if (!autoFocus || results.length === 0) return;
    const active = document.activeElement;
    if (!active || active === inputRef.current) return;
    if (!rootRef.current?.contains(active)) return;
    tileAt(0)?.focus();
    // `results.length` is read but deliberately not a dependency - only a new first page retriggers.
  }, [epoch, autoFocus, tileAt]);

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const pick = useCallback(
    (gif: GifResult | undefined): void => {
      if (gif) onPick(gif);
    },
    [onPick],
  );

  /** Everything Tab may land on, in visual order. Filtered for what is actually rendered. */
  const focusables = useCallback((): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    const list: Array<HTMLElement | null> = [
      inputRef.current,
      tileAt(selectedIndex),
      sentinelRef.current,
      root.querySelector<HTMLElement>('[data-testid="gif-error-retry"]'),
      root.querySelector<HTMLElement>('[data-testid="gif-close"]'),
    ];
    return list.filter((el): el is HTMLElement => !!el && !el.hasAttribute('disabled'));
  }, [selectedIndex, tileAt]);

  /** Root handler: Escape and the Tab trap, whichever child has focus (AC-G5-2 / AC-G5-4). */
  const onRootKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // The composer behind us also listens for Escape (cancel reply / edit): ours wins and stops.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const step = e.shiftKey ? -1 : 1;
      const next = (current + step + items.length) % items.length;
      items[next]?.focus();
    },
    [focusables, onClose],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          pick(selected);
          return;
        case 'ArrowRight':
          // No caret movement: the arrows drive the grid while the box has focus (demo step 3 -
          // `/gif tacos`, Enter, ArrowRight, ArrowRight, Enter - never leaves the input).
          e.preventDefault();
          moveSelection(1, false);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          moveSelection(-1, false);
          return;
        case 'ArrowDown':
          // Step *into* the grid at the current selection, without moving it (AC-G5-1: the first
          // ArrowDown selects index 0 even though index 0 is already pre-selected).
          e.preventDefault();
          if (results.length > 0) tileAt(selectedIndex)?.focus();
          return;
        default:
      }
    },
    [pick, selected, moveSelection, results.length, selectedIndex, tileAt],
  );

  const onTileKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, index: number): void => {
      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          pick(results[index]);
          return;
        case 'ArrowRight':
          e.preventDefault();
          moveSelection(1, true);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          moveSelection(-1, true);
          return;
        case 'ArrowDown':
          e.preventDefault();
          moveSelection(columns, true);
          return;
        case 'ArrowUp':
          e.preventDefault();
          // From the top row, Up goes back to the search box rather than nowhere.
          if (index < columns) inputRef.current?.focus();
          else moveSelection(-columns, true);
          return;
        case 'Home':
          e.preventDefault();
          moveSelection(-index, true);
          return;
        case 'End':
          e.preventDefault();
          moveSelection(results.length - 1 - index, true);
          return;
        default:
      }
      // AC-G5-2: typing a printable character while a tile has focus returns to the search box and
      // appends it (so the user never has to notice where focus was).
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setQuery((q) => q + e.key);
        inputRef.current?.focus();
      }
    },
    [pick, results, moveSelection, columns],
  );

  // ---------------------------------------------------------------------------
  // Lazy previews: one observer for the whole grid, shared by every tile
  // ---------------------------------------------------------------------------

  const watchers = useRef(new Map<Element, (visible: boolean) => void>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) watchers.current.get(entry.target)?.(entry.isIntersecting);
      },
      { root: gridRef.current, rootMargin: PREFETCH_MARGIN },
    );
    observerRef.current = io;
    // Tiles that registered before this effect ran (first paint) are still in the map.
    for (const el of watchers.current.keys()) io.observe(el);
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, []);

  const observe = useCallback<ObserveTile>((el, onVisible) => {
    watchers.current.set(el, onVisible);
    observerRef.current?.observe(el);
    if (typeof IntersectionObserver === 'undefined') {
      // No IntersectionObserver at all (jsdom, an ancient WebView): show everything rather than
      // nothing. Deliberately *not* when the observer merely has not been created yet - child
      // effects run before the parent's, and decoding all 24 previews for one tick is exactly what
      // this machinery exists to avoid.
      onVisible(true);
    }
    return () => {
      watchers.current.delete(el);
      observerRef.current?.unobserve(el);
    };
  }, []);

  // `gif-load-more` doubles as the scroll sentinel (P1): visible + `hasMore` appends the next page.
  //
  // The guard matters. In a grid that is not scrollable yet the sentinel is on screen the moment it
  // renders, so a provider that keeps answering `hasNext` would be paginated in a tight loop the
  // instant the picker opens - no scroll, no intent, and (for Klipy) quota spent. Auto-loading only
  // once the grid actually overflows makes this "paginate as you reach the bottom", which is what
  // the criterion means; the button itself stays clickable for the short-grid and keyboard cases.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const grid = gridRef.current;
        if (!grid || grid.scrollHeight <= grid.clientHeight + 8) return;
        loadMore();
      },
      { root: gridRef.current, rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, results.length]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const activeDescendant = selected ? `gif-option-${selected.id}` : undefined;
  const showLoading = loading && results.length === 0;
  const showEmpty = !loading && !error && results.length === 0;
  const heading = trimmed ? `Results for "${trimmed}"` : 'Trending';
  const tiles = useMemo(
    () =>
      results.map((result, index) => (
        <GifTile
          key={`${result.provider}-${result.id}-${index}`}
          result={result}
          index={index}
          selected={index === selectedIndex}
          reducedMotion={reducedMotion}
          observe={observe}
          onPick={onPick}
          onActivate={setSelectedIndex}
          onKeyDown={onTileKeyDown}
        />
      )),
    [results, selectedIndex, reducedMotion, observe, onPick, onTileKeyDown],
  );

  return (
    <div
      ref={rootRef}
      className={`${styles.picker} ${variant === 'sheet' ? styles.sheet : styles.popover}`}
      data-testid="gif-picker"
      data-variant={variant}
      data-provider={provider}
      data-loading={loading ? 'true' : 'false'}
      data-count={results.length}
      data-columns={columns}
      role="dialog"
      aria-label="GIF picker"
      aria-modal={variant === 'sheet' ? true : undefined}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
    >
      {variant === 'sheet' && <span className={styles.handle} aria-hidden="true" />}

      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden="true">
          <Search size={15} />
        </span>
        <input
          ref={inputRef}
          type="text"
          className={`u-input ${styles.search}`}
          data-testid="gif-search"
          /* Exactly `Search KLIPY` under klipy - a Klipy attribution requirement (AC-G4-7). */
          placeholder={isKlipy ? 'Search KLIPY' : 'Search GIFs'}
          aria-label={isKlipy ? 'Search KLIPY' : 'Search GIFs'}
          value={query}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={gridId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <button
          type="button"
          className={styles.close}
          data-testid="gif-close"
          title="Close"
          aria-label="Close GIF picker"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>

      <div className={styles.headingRow}>
        <span className={styles.heading} data-testid="gif-heading">
          {heading}
        </span>
        {loading && results.length > 0 && <span className={styles.headingNote}>Updating...</span>}
      </div>

      <div
        ref={gridRef}
        id={gridId}
        className={styles.grid}
        data-testid="gif-grid"
        data-columns={columns}
        role="listbox"
        aria-label="GIF results"
        aria-activedescendant={activeDescendant}
        aria-busy={loading}
        tabIndex={-1}
      >
        {tiles}

        {showLoading && (
          <div className={styles.state} data-testid="gif-loading" role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <span>Loading GIFs...</span>
          </div>
        )}

        {showEmpty && (
          <div className={styles.state} data-testid="gif-empty">
            {trimmed ? `No GIFs for "${trimmed}"` : 'No GIFs found'}
          </div>
        )}

        {error && (
          <div className={styles.state} data-testid="gif-error" role="alert">
            <span className={styles.errorTitle}>Could not load GIFs</span>
            <span className={styles.errorText}>{error}</span>
            <button type="button" className={styles.retry} data-testid="gif-error-retry" onClick={retry}>
              Retry
            </button>
          </div>
        )}

        {hasMore && (
          /* Sentinel *and* a real button, so pagination works with the keyboard and without an
           * IntersectionObserver. */
          <button
            ref={sentinelRef}
            type="button"
            className={styles.loadMore}
            data-testid="gif-load-more"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.attribution} data-testid="gif-attribution">
          {isKlipy ? 'Powered by KLIPY' : 'Mock GIFs (no key)'}
        </span>
      </div>
    </div>
  );
}
