/**
 * Layout store (Phase 2, PRIN-3): phone vs desktop, the two phone drawers, and the visual viewport.
 *
 *  - `isPhone` is true for narrow viewports (<= 767 px) or coarse-pointer devices up to 1023 px wide,
 *    and is kept in sync with `matchMedia` (AC-M1-3: follows a resize without reload). Desktop Playwright
 *    (1280x720, fine pointer) is never a phone, so the Phase 1 suite is unaffected.
 *  - On phone the Shell renders the conversation full-screen; navigation (space rail + channel sidebar)
 *    lives in the left drawer (`navOpen`, testid `nav-drawer`) and the member panel in the right drawer
 *    (`membersOpen`, testid `member-drawer`). The Shell owns the containers, backdrop and animation;
 *    feature code only calls the actions: `header-menu` -> `openNav()`, `member-toggle` -> `openMembers()`.
 *  - One drawer at a time: opening one closes the other (AC-M4-2).
 *  - The nav drawer closes by itself on an explicit `selectRoom()` (tap a channel/DM) and stays open on
 *    `selectSpace()` (AC-M2-2 / AC-M2-4). Wired through `onRoomSelected` from rooms.ts, so feature code
 *    never has to remember it.
 *  - Leaving phone mode (rotation, window resize) closes both drawers.
 *  - `viewportWidth/Height` follow `window.visualViewport` (the shell also keeps `--vvh` on :root current);
 *    `keyboardOpen` is true when the native Keyboard plugin reports a height, or when the visual viewport is
 *    more than 150 px shorter than the tallest one seen at this width (phone browsers).
 *
 * Ownership rule: desktop member-panel visibility stays Dev A's `useNavUiStore.membersOpen`; this store's
 * `membersOpen` only means "the phone right drawer is open".
 *
 * Phase 4: `registerBackHandler(fn)` lets a feature (the GIF sheet) consume the Android back press before the
 * thread panel and the drawers. App.tsx runs `runBackHandlers() || closeThread() || closeDrawers()`.
 */
import { create } from 'zustand';
import { onRoomSelected } from './rooms.ts';

/** Primary phone signal. Mirrors `:root[data-layout='phone']` which the store stamps on <html>. */
export const PHONE_MEDIA_QUERY = '(max-width: 767px)';
/** Touch devices up to tablet-portrait width count as phones too; the width cap keeps touch laptops on desktop. */
export const COARSE_PHONE_MEDIA_QUERY = '(pointer: coarse) and (max-width: 1023px)';
/** Visual-viewport shrink (px) that counts as "the soft keyboard is open" in a browser. */
export const KEYBOARD_SHRINK_PX = 150;

export type Layout = 'phone' | 'desktop';

export interface LayoutState {
  isPhone: boolean;
  /** Left drawer (space rail + channel sidebar + user footer). Phone only. */
  navOpen: boolean;
  /** Right drawer (member panel). Phone only. */
  membersOpen: boolean;
  /** Soft keyboard height in px as reported by @capacitor/keyboard (0 on the web and when hidden). */
  keyboardHeight: number;
  /** `window.visualViewport` size in CSS px (falls back to `innerWidth/innerHeight`). */
  viewportWidth: number;
  viewportHeight: number;
  /** Native keyboard height > 0, or the visual viewport shrank by more than KEYBOARD_SHRINK_PX. */
  keyboardOpen: boolean;
  openNav(): void;
  closeNav(): void;
  toggleNav(): void;
  openMembers(): void;
  closeMembers(): void;
  toggleMembers(): void;
  /** Close whichever drawer is open (backdrop tap, Escape, Android back). Returns true if one was open. */
  closeDrawers(): boolean;
  /** Same as `closeDrawers()` (name used in docs/PHASE2_TICKETS.md). */
  closeAll(): boolean;
  /** Internal: matchMedia listeners (and tests) call this. */
  setIsPhone(isPhone: boolean): void;
  /** Internal: src/lib/native.ts keyboard listeners call this (via App.tsx). */
  setKeyboardHeight(px: number): void;
  /** Internal: visualViewport listeners call this. */
  setViewport(width: number, height: number): void;
}

function queryMatches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

// ---------------------------------------------------------------------------
// Android back handlers (Phase 4)
// ---------------------------------------------------------------------------

const backHandlers: Array<() => boolean> = [];

/**
 * Register a handler for the Android hardware/gesture back press. Handlers run most-recently-registered first;
 * a handler returns true when it consumed the press (closed its sheet/overlay), which stops the chain. After all
 * handlers decline, App.tsx closes an open thread, then an open drawer, then minimises the app. Returns the
 * unregister function (call it on unmount / close). Typical use: register while an overlay is open.
 */
export function registerBackHandler(handler: () => boolean): () => void {
  backHandlers.push(handler);
  return () => {
    const i = backHandlers.lastIndexOf(handler);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}

/** Run the registered back handlers (newest first) until one returns true. Exposed for App.tsx and tests. */
export function runBackHandlers(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    try {
      if (backHandlers[i]!()) return true;
    } catch (e) {
      console.error('[layout] back handler threw', e);
    }
  }
  return false;
}

/** Evaluate the phone media queries right now (no React, no store). */
export function detectIsPhone(): boolean {
  return queryMatches(PHONE_MEDIA_QUERY) || queryMatches(COARSE_PHONE_MEDIA_QUERY);
}

function readViewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const vv = window.visualViewport;
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight),
  };
}

/** Tallest visual viewport seen per width (orientation changes reset it). */
let tallestAtWidth = { width: 0, height: 0 };

function keyboardOpenFor(keyboardHeight: number, width: number, height: number): boolean {
  if (keyboardHeight > 0) return true;
  if (tallestAtWidth.width !== width || height > tallestAtWidth.height) tallestAtWidth = { width, height };
  return tallestAtWidth.height - height > KEYBOARD_SHRINK_PX;
}

const initialViewport = readViewport();

export const useLayoutStore = create<LayoutState>((set, get) => ({
  isPhone: detectIsPhone(),
  navOpen: false,
  membersOpen: false,
  keyboardHeight: 0,
  viewportWidth: initialViewport.width,
  viewportHeight: initialViewport.height,
  keyboardOpen: false,

  openNav: () => set({ navOpen: true, membersOpen: false }),
  closeNav: () => set({ navOpen: false }),
  toggleNav: () => (get().navOpen ? get().closeNav() : get().openNav()),
  openMembers: () => set({ membersOpen: true, navOpen: false }),
  closeMembers: () => set({ membersOpen: false }),
  toggleMembers: () => (get().membersOpen ? get().closeMembers() : get().openMembers()),
  closeDrawers: () => {
    const { navOpen, membersOpen } = get();
    if (!navOpen && !membersOpen) return false;
    set({ navOpen: false, membersOpen: false });
    return true;
  },
  closeAll: () => get().closeDrawers(),
  setIsPhone: (isPhone) => {
    if (isPhone === get().isPhone) return;
    // Drawers are a phone-only concept; never leave one "open" on desktop.
    set(isPhone ? { isPhone } : { isPhone, navOpen: false, membersOpen: false });
  },
  setKeyboardHeight: (px) => {
    const keyboardHeight = Math.max(0, Math.round(px));
    const { viewportWidth, viewportHeight } = get();
    set({ keyboardHeight, keyboardOpen: keyboardOpenFor(keyboardHeight, viewportWidth, viewportHeight) });
  },
  setViewport: (width, height) => {
    const s = get();
    const keyboardOpen = keyboardOpenFor(s.keyboardHeight, width, height);
    if (width === s.viewportWidth && height === s.viewportHeight && keyboardOpen === s.keyboardOpen) return;
    set({ viewportWidth: width, viewportHeight: height, keyboardOpen });
  },
}));

/** `() => boolean` selector over the layout store (docs/PHASE2_TICKETS.md Shared API). */
export function useIsPhone(): boolean {
  return useLayoutStore((s) => s.isPhone);
}

export interface Viewport {
  isPhone: boolean;
  isDesktop: boolean;
  layout: Layout;
  /** Visual viewport in CSS px. */
  width: number;
  height: number;
  keyboardOpen: boolean;
  /** Native keyboard height (0 in browsers). */
  keyboardHeight: number;
}

/** `{ isPhone, width, height, keyboardOpen, ... }` from the visual viewport (docs/PHASE2_TICKETS.md Shared API). */
export function useViewport(): Viewport {
  const isPhone = useLayoutStore((s) => s.isPhone);
  const width = useLayoutStore((s) => s.viewportWidth);
  const height = useLayoutStore((s) => s.viewportHeight);
  const keyboardOpen = useLayoutStore((s) => s.keyboardOpen);
  const keyboardHeight = useLayoutStore((s) => s.keyboardHeight);
  return { isPhone, isDesktop: !isPhone, layout: isPhone ? 'phone' : 'desktop', width, height, keyboardOpen, keyboardHeight };
}

// ---------------------------------------------------------------------------
// Wiring (module level, browser only)
// ---------------------------------------------------------------------------

function stampLayout(isPhone: boolean): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.layout = isPhone ? 'phone' : 'desktop';
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (typeof window.matchMedia === 'function') {
    const update = (): void => useLayoutStore.getState().setIsPhone(detectIsPhone());
    for (const query of [PHONE_MEDIA_QUERY, COARSE_PHONE_MEDIA_QUERY]) {
      const mq = window.matchMedia(query);
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', update);
      else mq.addListener(update); // older WebViews
    }
  }
  stampLayout(useLayoutStore.getState().isPhone);
  useLayoutStore.subscribe((s, prev) => {
    if (s.isPhone !== prev.isPhone) stampLayout(s.isPhone);
  });

  // Visual viewport -> store + `--vvh` (px) on :root, coalesced to one update per frame.
  let frame = 0;
  const applyViewport = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const { width, height } = readViewport();
      document.documentElement.style.setProperty('--vvh', `${height}px`);
      useLayoutStore.getState().setViewport(width, height);
    });
  };
  window.visualViewport?.addEventListener('resize', applyViewport);
  window.addEventListener('resize', applyViewport);
  window.addEventListener('orientationchange', applyViewport);
  document.documentElement.style.setProperty('--vvh', `${initialViewport.height}px`);
}

// Picking a room from the drawer closes it (phone only). Space switches do not go through here.
onRoomSelected(() => {
  const layout = useLayoutStore.getState();
  if (layout.isPhone && layout.navOpen) layout.closeNav();
});
