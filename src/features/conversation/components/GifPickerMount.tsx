/**
 * Where Dev A's `<GifPicker />` is put on the screen (DEV-B-23 / DEV-B-26, Phase 4).
 *
 * The picker renders the panel only - search box, grid, states, attribution, its own close button.
 * Everything around it is here, and it differs completely between the two layouts:
 *
 *  - **desktop** (`variant="popover"`): an absolutely positioned `gif-popover` inside the composer
 *    (which is already `position: relative`), anchored `bottom: 100%` so the panel sits directly above
 *    the composer, left-aligned with it, above the message list (AC-G6-2). No portal: staying inside
 *    the composer is what keeps it anchored while the window resizes and the textarea auto-grows.
 *  - **phone** (`variant="sheet"`): a bottom sheet portalled to `document.body` over `gif-backdrop`
 *    (AC-G9-1). The portal is deliberate - the phone thread layer and the drawers use `transform`, and
 *    a transformed ancestor would re-anchor `position: fixed` to it instead of the viewport.
 *
 * This component owns **dismissal** (decision relayed by the coordinator, 2026-10-09): outside
 * mousedown, Escape, the phone backdrop tap and the Android back button all call `onClose` from here;
 * Dev A's picker only closes from `gif-close` and from Escape while the focus is inside it. The
 * `trigger` ref is excluded from the outside-click test, otherwise `composer-gif` could never close
 * the picker: mousedown would close it and the click that follows would see it closed and re-open it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GifPicker } from '@/features/gif';
import type { GifResult } from '@/lib/gif';
import { registerBackHandler, useLayoutStore } from '@/store/layout.ts';
import styles from './GifPickerMount.module.css';

export interface GifPickerMountProps {
  /** Pre-filled query; '' opens on trending. */
  initialQuery: string;
  /** 'sheet' on phone, 'popover' on desktop. */
  variant: 'popover' | 'sheet';
  /** The button that opened it: excluded from the outside-click test so the toggle works. */
  trigger: React.RefObject<HTMLElement | null>;
  onPick(gif: GifResult): void;
  onClose(): void;
}

export function GifPickerMount({ initialQuery, variant, trigger, onPick, onClose }: GifPickerMountProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** Height of the sheet, so the backdrop stops where the sheet starts (see below). */
  const [sheetHeight, setSheetHeight] = useState(0);

  /*
   * The backdrop dims only the part of the screen the sheet does not cover. A full-viewport backdrop
   * would look identical (the sheet is opaque) but its *centre* would sit underneath the sheet, and a
   * centre that another element owns makes `gif-backdrop.tap()` un-actionable for Playwright - exactly
   * what AC-G9-2 taps. `offsetHeight` rather than `getBoundingClientRect()` so the slide-up transform
   * does not report a height of its own mid-animation.
   */
  useEffect(() => {
    if (variant !== 'sheet') return;
    const panel = panelRef.current?.querySelector('[data-testid="gif-picker"]');
    if (!(panel instanceof HTMLElement)) return;
    const update = (): void => setSheetHeight(panel.offsetHeight);
    update();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [variant]);

  // Opening the sheet closes whatever drawer is open, and Android back closes the sheet before the
  // thread panel and the drawers (AC-G9-2); `registerBackHandler` runs the newest handler first.
  useEffect(() => {
    if (variant !== 'sheet') return;
    useLayoutStore.getState().closeDrawers();
  }, [variant]);

  useEffect(
    () =>
      registerBackHandler(() => {
        closeRef.current();
        return true;
      }),
    [],
  );

  // Escape anywhere, and mousedown outside both the panel and the trigger. `mousedown` rather than
  // `click` so a drag that starts outside dismisses it like every other overlay in the app; `capture`
  // so a stopPropagation inside the picker cannot swallow it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    const onPointerDown = (e: MouseEvent | TouchEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (trigger.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    // Popover only. The sheet dismisses from `gif-backdrop`'s own `click`: closing on `touchstart`
    // would unmount the backdrop before the browser synthesises the `click`, which would then land on
    // whatever is underneath (the phone header's buttons, a message row).
    if (variant === 'popover') {
      document.addEventListener('mousedown', onPointerDown, true);
      document.addEventListener('touchstart', onPointerDown, true);
    }
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
    };
  }, [trigger, variant]);

  const picker = (
    <GifPicker initialQuery={initialQuery} onPick={onPick} onClose={onClose} variant={variant} autoFocus />
  );

  if (variant === 'popover') {
    return (
      <div ref={panelRef} className={styles.popover} data-testid="gif-popover">
        {picker}
      </div>
    );
  }

  return createPortal(
    <>
      {/*
       * Tap-to-close is also covered by the document listener above; the explicit handler is what makes
       * `gif-backdrop` work for a synthetic `click()` in a test, which never fires `mousedown`.
       */}
      <div
        className={styles.backdrop}
        data-testid="gif-backdrop"
        style={{ bottom: sheetHeight }}
        onClick={() => closeRef.current()}
      />
      <div ref={panelRef} className={styles.sheet} data-testid="gif-sheet">
        {picker}
      </div>
    </>,
    document.body,
  );
}
