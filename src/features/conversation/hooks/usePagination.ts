/**
 * Backwards pagination trigger (DEV-B-3): an IntersectionObserver on a sentinel at the top of the
 * scroll container. Also re-arms itself after a load that did not move the sentinel out of view
 * (a short page of history would otherwise leave the observer silent).
 */
import { useEffect, type RefObject } from 'react';

export interface PaginationOptions {
  containerRef: RefObject<HTMLElement | null>;
  sentinelRef: RefObject<HTMLElement | null>;
  /** False when there is nothing more to load, while a load is in flight, or before first paint. */
  enabled: boolean;
  load(): void;
  /** Changes whenever the timeline changed, so we can re-check after a load. */
  revision: number;
}

export function usePagination({ containerRef, sentinelRef, enabled, load, revision }: PaginationOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel || !enabled) return;

    // Already near the top after a commit (e.g. the loaded page was shorter than the viewport).
    if (container.scrollTop < 150) {
      load();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) load();
      },
      { root: container, rootMargin: '200px 0px 0px 0px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [containerRef, sentinelRef, enabled, load, revision]);
}
