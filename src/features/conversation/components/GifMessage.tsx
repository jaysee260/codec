/**
 * Inline GIF row body (DEV-B-25, Phase 4).
 *
 * A sent GIF is an ordinary `m.text` whose content carries a validated `dev.matrixpoc.gif` field
 * (`src/lib/gif/message.ts`); `getDisplayBody(event).gif` hands it over already host-checked, so the
 * `<img src>` goes **straight to the provider's CDN** - never through `mxcToHttp`, because Klipy's
 * integration terms forbid re-hosting and proxying its media. Anything that fails validation never
 * reaches this component and renders as the plain text it is ("<title> <url>", auto-linked).
 *
 * Four states, on `message-gif[data-state]`:
 *
 *   playing     the animated `<img>` is in the DOM
 *   offscreen   the row is outside the viewport (+ a 200 px margin): the `<img>` is **unmounted** into
 *               `message-gif-placeholder`, so a timeline full of GIFs costs nothing to scroll past and
 *               a 4 MB GIF is not decoded for a row nobody can see. Remounting restarts the animation.
 *   paused      `prefers-reduced-motion: reduce` and the reader has not pressed `message-gif-play`.
 *               A GIF has no pause, so this state loads the single-frame `stillUrl` (Klipy `sm.jpg`,
 *               the mock's `<id>.png`) instead, and the sized placeholder when the sender's client
 *               did not send one. Pressing play swaps in the animated `url`.
 *   fallback    the image failed to load (CDN down, phone offline, QA's 404 stub): title + link.
 *               Terminal - once a URL has failed we do not retry it on every scroll.
 *
 * **No layout shift** (which the message list's scroll anchor depends on): the `<figure>` itself owns
 * the fitted box - `width` in px plus `aspect-ratio: w / h` - and the image, the placeholder and the
 * play button all fill it at 100% / 100%. The box is computed from the event's own `w`/`h` with the
 * same `fitted()` used for `m.image` thumbnails, so a 498 x 498 GIF is 300 x 300 (400 x 300 box) and
 * `message-list.scrollHeight` is identical in every state except `fallback`. `aspect-ratio` rather
 * than a px height is what keeps that true on phone, where `max-width: 100%` shrinks the width.
 *
 * Phase 5 (DEV-B-31, AC-E6-5): in an **encrypted room** the row starts in a fifth state,
 *
 *   click-to-load   no `<img>` and no request to the GIF host until the reader presses
 *                   `message-gif-load` (title + "Load GIF"): hot-linking would tell a third party
 *                   who reads which encrypted room, and when. After the click it behaves as above.
 *                   The choice is remembered per GIF URL for the page's lifetime, so scrolling the
 *                   row away and back (or opening it in the thread panel) does not ask again.
 *
 * `previewUrl` is deliberately *not* used here: it is the picker's small animated preview (`sm.webp`),
 * which animates just like the full GIF, so it is no use as a paused frame. `stillUrl` is the only
 * single-frame variant on the wire.
 */
import { useEffect, useRef, useState } from 'react';
import { ImagePlay, Play } from 'lucide-react';
import type { GifMessage as GifMessageData } from '@/lib/gif';
import { useReducedMotion } from '../hooks/useReducedMotion.ts';
import { fitted } from './ImageAttachment.tsx';
import styles from './GifMessage.module.css';

/** Load / keep rows this far outside the viewport, so a normal scroll never shows an empty box. */
const ROOT_MARGIN = '200px 0px';

export type GifState = 'playing' | 'offscreen' | 'paused' | 'fallback' | 'click-to-load';

/** GIF URLs the reader chose to load in an encrypted room (this page load only). */
const loadedInEncryptedRooms = new Set<string>();

export function GifMessage({ gif, clickToLoad = false }: { gif: GifMessageData; clickToLoad?: boolean }) {
  const figureRef = useRef<HTMLElement>(null);
  // Starts false so twenty GIFs already in the loaded window do not all fetch on mount; the observer
  // fires for the visible ones on the next frame.
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [userPlayed, setUserPlayed] = useState(false);
  const [, setLoadTick] = useState(0);
  const mustAsk = clickToLoad && !loadedInEncryptedRooms.has(gif.url);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const node = figureRef.current;
    if (!node) return;
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true); // no observer (very old WebView): behave like Phase 1 and just show it
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setVisible(last.isIntersecting);
      },
      { rootMargin: ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A new URL (an edit replacing the field, a re-render with a different event) gets a fresh chance.
  useEffect(() => {
    setFailed(false);
    setUserPlayed(false);
  }, [gif.url]);

  const state: GifState = mustAsk ? 'click-to-load' : failed ? 'fallback' : !visible ? 'offscreen' : reducedMotion && !userPlayed ? 'paused' : 'playing';
  const { width, height } = fitted(gif.w, gif.h);
  /** `playing` loads the animated GIF; `paused` the still frame, when the sender sent one. */
  const src = state === 'playing' ? gif.url : state === 'paused' ? gif.stillUrl : undefined;

  return (
    <figure
      ref={figureRef}
      className={`${styles.figure} ${state === 'fallback' ? styles.figureFallback : ''}`}
      data-testid="message-gif"
      data-provider={gif.provider}
      data-gif-id={gif.id}
      data-state={state}
      // The title is a tooltip only: a visible caption would duplicate the badge and push every row
      // taller (the reply quote and the thread list already show "[gif] <title>" via `previewText`).
      title={gif.title}
      style={state === 'fallback' ? undefined : { width, aspectRatio: `${gif.w} / ${gif.h}` }}
    >
      {state === 'fallback' ? (
        <a
          className={styles.fallback}
          data-testid="message-gif-fallback"
          href={gif.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className={styles.fallbackBadge}>GIF</span>
          <span className={`${styles.fallbackTitle} u-truncate`}>{gif.title}</span>
        </a>
      ) : (
        <>
          {state === 'click-to-load' ? (
            <button
              type="button"
              className={styles.load}
              data-testid="message-gif-load"
              title={`Load "${gif.title}" from ${gif.provider}`}
              onClick={() => {
                loadedInEncryptedRooms.add(gif.url);
                setLoadTick((n) => n + 1);
              }}
            >
              <ImagePlay size={22} aria-hidden="true" />
              <span className={`${styles.loadTitle} u-truncate`}>{gif.title}</span>
              <span className={styles.loadLabel}>Load GIF</span>
            </button>
          ) : src ? (
            <img
              className={styles.image}
              data-testid="message-gif-img"
              src={src}
              alt={gif.title}
              width={width}
              height={height}
              loading="lazy"
              decoding="async"
              draggable={false}
              // A broken still frame must not hide the GIF itself, so only the animated one is fatal.
              onError={() => setFailed(state === 'playing')}
            />
          ) : (
            <div
              className={styles.placeholder}
              data-testid="message-gif-placeholder"
              style={{ width, aspectRatio: `${gif.w} / ${gif.h}` }}
              aria-label={gif.title}
            />
          )}

          {state === 'paused' && (
            <button
              type="button"
              className={styles.play}
              data-testid="message-gif-play"
              title={`Play "${gif.title}"`}
              aria-label={`Play the GIF "${gif.title}"`}
              onClick={() => setUserPlayed(true)}
            >
              <Play size={22} aria-hidden="true" />
            </button>
          )}

          <span className={styles.badge} data-testid="message-gif-badge" aria-hidden="true">
            GIF
          </span>
        </>
      )}
    </figure>
  );
}
