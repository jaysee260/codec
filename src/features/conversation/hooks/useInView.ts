/**
 * "Has this element been near the viewport yet?" (DEV-B-28, AC-E3-6). Latches to true the first time the
 * element comes within `rootMargin` of the viewport and never goes back: encrypted media is downloaded and
 * decrypted once a row has been seen, not for every row in the loaded window, and a row that was seen keeps
 * its decrypted image when it scrolls away (the blob URL is cached for the session anyway).
 */
import { useEffect, useState, type RefObject } from 'react';

export function useInViewOnce(ref: RefObject<Element | null>, enabled = true, rootMargin = '200px 0px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!enabled || seen) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver !== 'function') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, enabled, seen, rootMargin]);
  return seen;
}
