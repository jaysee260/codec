/**
 * DEV-A-20 one result tile (`gif-item-{id}`). Internal to `GifPicker`; not exported from the feature.
 *
 * Three things make this more than an `<img>`:
 *
 * 1. **Lazy / paused previews.** A grid of 24 animated GIFs decodes continuously and is the one place
 *    in this app that can peg a CPU. The picker owns a single `IntersectionObserver` over the grid
 *    scroller and hands each tile an `observe(el, cb)`; the media element is only *mounted* while the
 *    tile is near the viewport (`rootMargin`), so scrolling away stops the decode (and pauses a
 *    `<video>`) instead of merely hiding it. Unmounting rather than toggling `src` is deliberate: a
 *    GIF keeps animating behind `display: none`.
 * 2. **`prefers-reduced-motion`** (docs/archive/PHASE4_PLAN.md "Rendering"): nothing animates unprompted. The
 *    tile shows a static plate with the title and only mounts the preview while hovered, focused or
 *    keyboard-selected.
 * 3. **mp4 previews** (AC-G4-8). Klipy can answer `sm.mp4` instead of `sm.webp`. React sets `muted`
 *    as a *property*, which leaves `<video>` without the `muted` **attribute** - so autoplay is
 *    blocked in some engines and `toHaveAttribute('muted')` fails. The ref sets both.
 *
 * Aspect ratio comes from `previewW/previewH` so the grid never reflows when an image decodes
 * (AC-G4-8 "no layout shift"); `data-w` / `data-h` expose the same numbers for QA.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { GifResult } from '@/lib/gif';
import styles from './GifPicker.module.css';

/** Registers `el` with the grid's shared observer. Returns the unsubscribe. */
export type ObserveTile = (el: Element, onVisible: (visible: boolean) => void) => () => void;

export interface GifTileProps {
  result: GifResult;
  index: number;
  selected: boolean;
  /** Suppress unprompted animation; the preview then needs hover / focus. */
  reducedMotion: boolean;
  observe: ObserveTile;
  onPick(result: GifResult): void;
  /** Pointer or focus landed on this tile: the picker makes it the selected index. */
  onActivate(index: number): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>, index: number): void;
}

export const GifTile = memo(function GifTile({
  result,
  index,
  selected,
  reducedMotion,
  observe,
  onPick,
  onActivate,
  onKeyDown,
}: GifTileProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, setNear);
  }, [observe]);

  // Under reduced motion the preview is opt-in: hover or focus only. Deliberately *not* `selected`
  // - index 0 is pre-selected as soon as results land (AC-G5-3), so including it would leave one
  //   GIF animating unprompted on every search, which is the thing the setting asks us not to do.
  const show = near && !failed && (!reducedMotion || hovered || focused);
  const isVideo = result.previewMimetype === 'video/mp4';

  const videoRef = useCallback((el: HTMLVideoElement | null): void => {
    if (!el) return;
    // Property *and* attribute: see the header comment.
    el.muted = true;
    el.setAttribute('muted', '');
    el.defaultMuted = true;
    void el.play().catch(() => {
      /* autoplay refused (no user gesture yet); the poster-less frame stays */
    });
  }, []);

  return (
    <div
      ref={ref}
      className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
      data-testid={`gif-item-${result.id}`}
      /* `aria-activedescendant` on `gif-search` / `gif-grid` points at this id (AC-G5-1). */
      id={`gif-option-${result.id}`}
      data-index={index}
      data-selected={selected ? 'true' : 'false'}
      data-w={result.previewW}
      data-h={result.previewH}
      data-provider={result.provider}
      role="option"
      aria-selected={selected}
      aria-label={result.title}
      title={result.title}
      /* Roving tabindex: only the selected tile is in the Tab order (AC-G5-4). */
      tabIndex={selected ? 0 : -1}
      onClick={() => onPick(result)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setFocused(true);
        onActivate(index);
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => onKeyDown(e, index)}
    >
      <div
        className={styles.media}
        /* Reserved before anything loads, so the grid never jumps (AC-G4-8). */
        style={{ aspectRatio: `${result.previewW} / ${result.previewH}` }}
      >
        {show && isVideo && (
          <video
            ref={videoRef}
            className={styles.preview}
            src={result.previewUrl}
            width={result.previewW}
            height={result.previewH}
            autoPlay
            loop
            playsInline
            disablePictureInPicture
            preload="auto"
            aria-label={result.title}
            onError={() => setFailed(true)}
          />
        )}
        {show && !isVideo && (
          <img
            className={styles.preview}
            src={result.previewUrl}
            width={result.previewW}
            height={result.previewH}
            alt={result.title}
            draggable={false}
            onError={() => setFailed(true)}
          />
        )}
        {!show && near && !failed && result.stillUrl && (
          /* Paused: the provider's own first frame (`sm.jpg` for Klipy, the `.png` for the mock).
           * Reduced motion gets a real picture rather than a grey box; hover or focus animates it. */
          <img className={styles.preview} src={result.stillUrl} alt={result.title} draggable={false} />
        )}
        {!show && !(near && !failed && result.stillUrl) && (
          /* Placeholder while off-screen, or when there is no still / the media failed. Carries the
           * title so the tile is never a blank box. */
          <span className={styles.plate} aria-hidden="true">
            {result.title}
          </span>
        )}
      </div>
    </div>
  );
});
