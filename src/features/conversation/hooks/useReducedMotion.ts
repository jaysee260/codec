/**
 * `prefers-reduced-motion: reduce`, live (Dev B, Phase 4).
 *
 * A GIF cannot be paused, so a reduced-motion row shows the sized placeholder plus a play control and
 * only loads the animated image once the reader asks for it (AC-G8-4). The `change` listener matters:
 * Playwright's `page.emulateMedia({ reducedMotion: 'reduce' })` is usually applied *after* the page has
 * loaded, so a value read once at mount would be stale for every already-rendered row.
 */
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function read(): boolean {
  return typeof matchMedia === 'function' ? matchMedia(QUERY).matches : false;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(read);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mql = matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent | MediaQueryList): void => setReduced(e.matches);
    onChange(mql); // in case it flipped between the initial render and this effect
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
