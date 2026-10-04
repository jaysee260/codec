/**
 * Long-press detector for touch rows (DEV-B-16). Hover does not exist on a phone, so the message
 * actions open from a 500 ms press instead of the desktop toolbar.
 *
 * Why both pointer *and* touch listeners: a real Android WebView delivers `pointerdown` (pointerType
 * `touch`) before `touchstart`, but a test driving the page through CDP `Input.dispatchTouchEvent`
 * may deliver only the touch pair. A `pressing` guard means whichever arrives first starts the timer
 * and the other is ignored.
 *
 * Cancels on: > `moveTolerance` px of movement (the user is scrolling), `pointercancel`/`touchcancel`,
 * any scroll of an ancestor, a second touch point, and unmount. After a press has fired, the trailing
 * `click` is swallowed once so a long-press on a link or an image does not also activate it.
 *
 * Returns props to spread on the row plus `pressing` for the pressed-state styling. `touch-action`
 * must stay `pan-y` on the element so vertical scrolling still works while we watch the press.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';

export const LONG_PRESS_MS = 500;
/** AC-V6-4: a touch that travels more than this before the timer fires is a scroll, not a press. */
export const MOVE_TOLERANCE_PX = 10;

export interface LongPressOptions {
  onLongPress(): void;
  delayMs?: number;
  moveTolerancePx?: number;
  /** Set false on desktop: no listeners are attached at all. */
  enabled?: boolean;
}

export interface LongPressHandlers {
  pressing: boolean;
  handlers: {
    onPointerDown?(e: ReactPointerEvent): void;
    onPointerMove?(e: ReactPointerEvent): void;
    onPointerUp?(): void;
    onPointerCancel?(): void;
    onTouchStart?(e: ReactTouchEvent): void;
    onTouchMove?(e: ReactTouchEvent): void;
    onTouchEnd?(): void;
    onTouchCancel?(): void;
    onContextMenu?(e: ReactMouseEvent): void;
    onClickCapture?(e: ReactMouseEvent): void;
  };
}

const EMPTY_HANDLERS: LongPressHandlers = { pressing: false, handlers: {} };

export function useLongPress({ onLongPress, delayMs = LONG_PRESS_MS, moveTolerancePx = MOVE_TOLERANCE_PX, enabled = true }: LongPressOptions): LongPressHandlers {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  /** True between a fired long-press and the trailing click we swallow. */
  const firedRef = useRef(false);
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const clear = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
    setPressing(false);
  }, []);

  useEffect(() => clear, [clear]);

  const begin = useCallback(
    (x: number, y: number): void => {
      if (timerRef.current) return; // already watching this press
      originRef.current = { x, y };
      firedRef.current = false;
      setPressing(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        originRef.current = null;
        setPressing(false);
        firedRef.current = true;
        onLongPressRef.current();
      }, delayMs);
    },
    [delayMs],
  );

  const move = useCallback(
    (x: number, y: number): void => {
      const origin = originRef.current;
      if (!origin || !timerRef.current) return;
      if (Math.abs(x - origin.x) > moveTolerancePx || Math.abs(y - origin.y) > moveTolerancePx) clear();
    },
    [clear, moveTolerancePx],
  );

  // A scroll anywhere up the tree cancels the press (capture: the list scrolls, not the row).
  useEffect(() => {
    if (!pressing) return;
    const onScroll = (): void => clear();
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [pressing, clear]);

  if (!enabled) return EMPTY_HANDLERS;

  return {
    pressing,
    handlers: {
      // Mouse presses count too: a desktop window narrowed under 768 px is the phone layout, where
      // the hover toolbar is not rendered - press-and-hold must still reach the actions.
      onPointerDown: (e) => begin(e.clientX, e.clientY),
      onPointerMove: (e) => move(e.clientX, e.clientY),
      onPointerUp: clear,
      onPointerCancel: clear,
      onTouchStart: (e) => {
        if (e.touches.length > 1) {
          clear();
          return;
        }
        const t = e.touches[0];
        if (t) begin(t.clientX, t.clientY);
      },
      onTouchMove: (e) => {
        const t = e.touches[0];
        if (t) move(t.clientX, t.clientY);
      },
      onTouchEnd: clear,
      onTouchCancel: clear,
      // Android's WebView would otherwise pop its own text-selection menu on a long press.
      onContextMenu: (e) => e.preventDefault(),
      onClickCapture: (e) => {
        if (!firedRef.current) return;
        firedRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}
