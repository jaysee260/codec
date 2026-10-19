/**
 * Phone helpers (QA-8). Everything here assumes the `mobile` Playwright project
 * (`devices['Pixel 7']`: 412x839 CSS px, `hasTouch`, `isMobile`) and the fake-microphone launch
 * flags from `playwright.config.ts`.
 *
 * Rules kept from Phase 1 (`e2e/fixtures/ui.ts`):
 *  - selectors come from the testid registry in docs/archive/PHASE2_ACCEPTANCE.md only;
 *  - **no `waitForTimeout`**. The one documented exception is `longPress`, which has to *hold* a
 *    synthetic touch for a wall-clock duration — there is nothing to auto-wait for between
 *    `touchStart` and `touchEnd`. It uses a Node-side `sleep`, not `page.waitForTimeout`.
 *  - taps go through `locator.tap()`, not `click()`: the device descriptor has `hasTouch`, the app
 *    styles touch affordances off `@media (hover: none)`, and AC-V6-2 is *about* the difference.
 *
 * Drawer state is read from `data-open` on `nav-drawer` / `member-drawer` as well as from
 * visibility: both the drawers and `drawer-backdrop` toggle `visibility` (src/app/Drawer.module.css,
 * Shell.module.css), so `toBeVisible()`/`toBeHidden()` are reliable — but `data-open` is the contract.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** QA-11 phone demo screenshots. Deliberately *outside* every project `outputDir` so runs do not wipe them. */
export const MOBILE_SHOT_DIR = resolve(HERE, '../demo-mobile');

/** Minimum touch target in CSS px (AC-M5-1, `--tap-target`). */
export const TAP_TARGET = 44;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ locators */

export const navDrawer = (page: Page): Locator => page.getByTestId('nav-drawer');
export const memberDrawer = (page: Page): Locator => page.getByTestId('member-drawer');
export const backdrop = (page: Page): Locator => page.getByTestId('drawer-backdrop');
export const headerMenu = (page: Page): Locator => page.getByTestId('header-menu');

/** True when the app rendered its phone branch (`app-shell[data-layout="phone"]`). */
export async function isPhoneLayout(page: Page): Promise<boolean> {
  return (await page.getByTestId('app-shell').getAttribute('data-layout')) === 'phone';
}

/* ------------------------------------------------------------------ taps */

/** Taps a testid (touch, not mouse). */
export async function tap(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).tap();
}

/* ------------------------------------------------------------------ animation */

/**
 * Waits until every CSS animation/transition on `locator` (and its subtree) has finished, so a
 * geometry assertion measures the settled layout.
 *
 * Needed because the phone chrome slides: the drawer transitions `transform` over 250 ms and the
 * bottom sheet animates `slide-up` from `translateY(100%)` over 200 ms. Measuring straight after
 * `toBeVisible()` catches the element mid-flight — AC-M5-2 reported the sheet 136 px and then 229 px
 * below the viewport bottom on two runs of the same build, which is the animation, not a defect.
 *
 * Sleep-free: it awaits the Web Animations `finished` promises, so it costs exactly the remaining
 * animation time.
 */
export async function settleAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (el) => {
    const animations = (el as Element).getAnimations?.({ subtree: true }) ?? [];
    await Promise.all(animations.map((a) => a.finished.catch(() => undefined)));
  });
}

/* ------------------------------------------------------------------ drawers */

/**
 * Taps `drawer-backdrop` **where it is actually exposed**.
 *
 * The backdrop is `inset: 0` at `z-index: 20` and the drawer sits over it at `z-index: 30` covering
 * 85 % of the width (src/app/Shell.module.css, Drawer.module.css), so `locator.tap()` — which aims at
 * the element's centre — is intercepted by the drawer and times out. A real thumb lands on the
 * uncovered strip, which is what this does: it measures whichever drawer is open and taps the strip
 * beside it with an absolute touch.
 */
export async function tapBackdrop(page: Page): Promise<void> {
  const overlay = backdrop(page);
  await expect(overlay).toBeVisible();
  await settleAnimations(overlay);
  const overlayBox = await box(overlay, 'drawer-backdrop');

  const open = [navDrawer(page), memberDrawer(page)];
  let x = overlayBox.x + overlayBox.width / 2;
  for (const drawer of open) {
    if ((await drawer.getAttribute('data-open')) !== 'true') continue;
    const d = await box(drawer, 'open drawer');
    const side = await drawer.getAttribute('data-side');
    // Aim 12 px inside the exposed strip on the far side of the drawer.
    x = side === 'right' ? Math.max(overlayBox.x + 4, d.x - 12) : Math.min(overlayBox.x + overlayBox.width - 4, d.x + d.width + 12);
    break;
  }
  const y = Math.round(overlayBox.y + overlayBox.height / 2);
  await page.touchscreen.tap(Math.round(x), y);
}

/**
 * Opens the left navigation drawer via `header-menu` (AC-M2-1) and waits for `data-open="true"`.
 * Idempotent: returns straight away when it is already open.
 */
export async function openNavDrawer(page: Page): Promise<void> {
  const drawer = navDrawer(page);
  if ((await drawer.getAttribute('data-open')) === 'true') return;
  await headerMenu(page).tap();
  await expect(drawer).toHaveAttribute('data-open', 'true', { timeout: 5_000 });
  await expect(drawer).toBeVisible();
  await settleAnimations(drawer);
}

/** Closes whichever drawer is open by tapping `drawer-backdrop` (AC-M2-3) and waits for both to report closed. */
export async function closeNavDrawer(page: Page): Promise<void> {
  if ((await navDrawer(page).getAttribute('data-open')) !== 'true') return;
  await tapBackdrop(page);
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false', { timeout: 5_000 });
}

/** Opens the right member drawer via `member-toggle` (AC-M4-1). Idempotent. */
export async function openMemberDrawer(page: Page): Promise<void> {
  const drawer = memberDrawer(page);
  if ((await drawer.getAttribute('data-open')) === 'true') return;
  await page.getByTestId('member-toggle').tap();
  await expect(drawer).toHaveAttribute('data-open', 'true', { timeout: 5_000 });
  await expect(drawer).toBeVisible();
  await settleAnimations(drawer);
}

/** Closes the member drawer by tapping the backdrop. Idempotent. */
export async function closeMemberDrawer(page: Page): Promise<void> {
  if ((await memberDrawer(page).getAttribute('data-open')) !== 'true') return;
  await tapBackdrop(page);
  await expect(memberDrawer(page)).toHaveAttribute('data-open', 'false', { timeout: 5_000 });
}

/** `data-open` of both drawers, for the "one drawer at a time" criterion (AC-M4-2). */
export async function drawerState(page: Page): Promise<{ nav: string | null; members: string | null }> {
  return {
    nav: await navDrawer(page).getAttribute('data-open'),
    members: await memberDrawer(page).getAttribute('data-open'),
  };
}

/**
 * Opens the drawer, taps a channel/DM row and waits for the drawer to close itself
 * (`selectRoom()` -> `closeNav()`, AC-M2-2) and for the conversation to be mounted.
 */
export async function tapRoom(page: Page, roomId: string, kind: 'channel' | 'dm' = 'channel'): Promise<void> {
  await openNavDrawer(page);
  const item = page.getByTestId(`${kind}-item-${roomId}`);
  await item.scrollIntoViewIfNeeded();
  await item.tap();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false', { timeout: 5_000 });
  await expect(page.getByTestId('message-list')).toBeVisible();
}

/** Opens the drawer and taps a space in the rail. The drawer must stay open (AC-M2-4). */
export async function tapSpace(page: Page, spaceId: string): Promise<void> {
  await openNavDrawer(page);
  const item = page.getByTestId(`space-item-${spaceId}`);
  await item.tap();
  await expect(item).toHaveAttribute('data-selected', 'true');
}

/* ------------------------------------------------------------------ gestures */

/**
 * Long-press a locator with real touch events (AC-V6-3). CDP `Input.dispatchTouchEvent` is the only
 * way to *hold* a touch down: `locator.tap()` dispatches start+end back to back, which the 500 ms
 * timer in `useLongPress` correctly ignores.
 *
 * Documented exception to the no-sleep rule — see the module header.
 */
export async function longPress(locator: Locator, ms = 600): Promise<void> {
  const page = locator.page();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('longPress: target has no bounding box (not rendered?)');
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await sleep(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * A touch that moves more than `dx` px before the long-press timer fires (AC-V6-4: scrolling must
 * not open the action sheet).
 */
export async function touchDrag(locator: Locator, dx = 0, dy = -40): Promise<void> {
  const page = locator.page();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('touchDrag: target has no bounding box');
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }],
    });
    for (const step of [0.34, 0.67, 1]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: Math.round(x + dx * step), y: Math.round(y + dy * step), radiusX: 8, radiusY: 8, force: 1 },
        ],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ microphone */

/**
 * Makes `getUserMedia` reject with `NotAllowedError` for *audio* requests (AC-V5-1).
 * Must be installed **before** the first navigation — i.e. before `loginAs`.
 */
export async function denyMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = ((constraints?: MediaStreamConstraints) => {
      if (constraints?.audio) {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return original(constraints);
    }) as MediaDevices['getUserMedia'];
  });
}

/** Removes `navigator.mediaDevices` entirely (insecure-context simulation; not an AC, used for triage). */
export async function removeMediaDevices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  });
}

/* ------------------------------------------------------------------ measurement */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `boundingBox()` that throws a readable error instead of returning null. */
export async function box(locator: Locator, label = 'element'): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`${label}: no bounding box (hidden or not rendered)`);
  return b;
}

/** Asserts a tap target is at least `min` px in both dimensions (AC-M5-1). */
export async function expectTapTarget(locator: Locator, label: string, min = TAP_TARGET): Promise<Box> {
  const b = await box(locator, label);
  expect(Math.round(b.width), `${label} width >= ${min} px`).toBeGreaterThanOrEqual(min);
  expect(Math.round(b.height), `${label} height >= ${min} px`).toBeGreaterThanOrEqual(min);
  return b;
}

/**
 * Every `button` / `[role=button]` / `a` inside `scope` that is visible and has a box, with its
 * testid (or text) and size. Used by AC-M5-1 so a failure names the offending control.
 */
export async function tapTargetsIn(scope: Locator): Promise<{ id: string; width: number; height: number }[]> {
  return scope.locator('button, [role="button"], a').evaluateAll((els) =>
    els
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id:
            el.getAttribute('data-testid') ??
            el.getAttribute('aria-label') ??
            (el.textContent ?? '').trim().slice(0, 24) ??
            el.tagName,
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })
      // Invisible / unrendered controls (a closed menu) carry no tap-target obligation.
      .filter((t) => t.width > 0 && t.height > 0),
  );
}

/** Page-level scroll metrics for AC-M1-4 / AC-V6-5 (nothing but `message-list` may scroll). */
export async function pageScroll(page: Page): Promise<{
  scrollWidth: number;
  innerWidth: number;
  bodyScrollHeight: number;
  innerHeight: number;
}> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyScrollHeight: document.body.scrollHeight,
    innerHeight: window.innerHeight,
  }));
}

/** A CSS custom property resolved on `:root`, e.g. `cssVar(page, '--tap-target')` -> `'44px'`. */
export async function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/** A computed style property of a locator. */
export function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p as string).trim(),
    property,
  );
}

/* ------------------------------------------------------------------ screenshots */

/**
 * Full-page screenshot for the phone demo walk-through (QA-11): written on success as well as
 * failure, into `e2e/demo-mobile/` (outside every `outputDir`, so it survives the next run).
 */
export async function phoneShot(page: Page, step: number, slug: string): Promise<string> {
  mkdirSync(MOBILE_SHOT_DIR, { recursive: true });
  const file = resolve(MOBILE_SHOT_DIR, `${String(step).padStart(2, '0')}-${slug}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
