/**
 * React hooks over the preview core (Phase 6). The only React-aware module in `src/lib/preview/`.
 *
 *   const { status, preview } = useLinkPreview(url, { enabled: shouldAutoPreview(roomId) || clicked });
 *   // status: 'idle' (not enabled) | 'loading' | 'ready' (preview set) | 'empty' (none / failed; render nothing or the note)
 *   const { hidden, hide, unhide } = useHiddenPreview(eventId, url);
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getLinkPreview, peekLinkPreview } from './fetch.ts';
import { hidePreview, hiddenPreviewsVersion, isPreviewHidden, subscribeHiddenPreviews, unhidePreview } from './hidden.ts';
import type { LinkPreview, LinkPreviewStatus } from './types.ts';

export interface UseLinkPreviewOptions {
  /** False = do not fetch (encrypted room before the click). A cached answer is still returned. Default true. */
  enabled?: boolean;
  /** Event timestamp for the server's `ts` parameter; default `Date.now()`. */
  ts?: number;
}

export interface UseLinkPreviewResult {
  status: LinkPreviewStatus;
  /** Set when `status === 'ready'`. */
  preview: LinkPreview | null;
}

function initial(url: string, enabled: boolean): UseLinkPreviewResult {
  const cached = peekLinkPreview(url);
  if (cached) return { status: 'ready', preview: cached };
  if (cached === null) return { status: 'empty', preview: null };
  return { status: enabled ? 'loading' : 'idle', preview: null };
}

/**
 * Fetches (through the shared cache / in-flight dedupe) once `enabled` is true. A cache hit renders synchronously
 * on first paint, so re-mounting rows while scrolling never flashes. Unmounting ignores the answer; the cache keeps it.
 */
export function useLinkPreview(url: string, opts: UseLinkPreviewOptions = {}): UseLinkPreviewResult {
  const enabled = opts.enabled ?? true;
  const ts = opts.ts;
  const [state, setState] = useState<UseLinkPreviewResult>(() => initial(url, enabled));

  useEffect(() => {
    const fresh = initial(url, enabled);
    setState((prev) => (prev.status === fresh.status && prev.preview === fresh.preview ? prev : fresh));
    if (fresh.status !== 'loading') return;
    const controller = new AbortController();
    getLinkPreview(url, { signal: controller.signal, ts }).then(
      (preview) => setState(preview ? { status: 'ready', preview } : { status: 'empty', preview: null }),
      () => {
        /* aborted (unmounted / url changed): nothing to show */
      },
    );
    return () => controller.abort();
  }, [url, enabled, ts]);

  return state;
}

export interface UseHiddenPreviewResult {
  hidden: boolean;
  hide: () => void;
  unhide: () => void;
}

/** Per-viewer hidden state of one card (localStorage, per event id + url). */
export function useHiddenPreview(eventId: string, url: string): UseHiddenPreviewResult {
  useSyncExternalStore(subscribeHiddenPreviews, hiddenPreviewsVersion, hiddenPreviewsVersion);
  const hidden = isPreviewHidden(eventId, url);
  const hide = useCallback(() => hidePreview(eventId, url), [eventId, url]);
  const unhide = useCallback(() => unhidePreview(eventId, url), [eventId, url]);
  return { hidden, hide, unhide };
}
