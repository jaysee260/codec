/**
 * QA-10 — phone shell and navigation (AC-M1 .. AC-M6) plus the layout half of Dev B's rows
 * (AC-V6-2/3/4/5/6). `mobile` project; the four "Given desktop" criteria live in the
 * `desktop regressions` describe, which re-declares the desktop *context* options (1280x720, no
 * touch, `isMobile: false`) — a phone context resized to 1280 px still reports `isMobile` and a
 * coarse pointer, so it cannot stand in for a real desktop context. (`devices['Desktop Chrome']`
 * cannot be spread wholesale into a describe: its `defaultBrowserType` is a launch-level option.)
 *
 * ## Not automatable here (stakeholder / device pass)
 *  - **AC-M2-8** edge swipe opens/closes the drawer, Android back closes it. The Shell implements
 *    both (docs/ARCHITECTURE.md), but Playwright's synthetic touch cannot reproduce the gesture
 *    stream reliably and `@capacitor/app` backButton only exists on the device.
 *  - **AC-M6-4 / AC-M6-5** soft keyboard, status bar, overscroll bounce.
 *
 * ## Freshness
 * Freshness-independent throughout: seeded rooms are resolved by alias, unread is *created* by bob
 * during the test rather than read from the seed, and the one room this spec creates has a unique
 * name. AC-M5-2 creates exactly one room per run — `rc_room_creation` on this homeserver is a burst
 * of 10 then 1/min per user, so do not loop this spec.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { DISPLAY_NAMES, NAMES, resolveRoom, uniqueName } from './fixtures/seed.ts';
import { itemNames, messageList, openChannel, row } from './fixtures/ui.ts';
import { banner, waitForStatus } from './fixtures/e2ee.ts';
import {
  backdrop,
  box,
  closeMemberDrawer,
  computed,
  cssVar,
  drawerState,
  expectTapTarget,
  headerMenu,
  longPress,
  memberDrawer,
  navDrawer,
  openMemberDrawer,
  openNavDrawer,
  pageScroll,
  TAP_TARGET,
  settleAnimations,
  tapBackdrop,
  tapRoom,
  tapSpace,
  tapTargetsIn,
  touchDrag,
} from './fixtures/mobile.ts';

const R: Record<'acme' | 'gaming' | 'general' | 'random' | 'dev' | 'lobby' | 'dmBob', string> = {
  acme: '',
  gaming: '',
  general: '',
  random: '',
  dev: '',
  lobby: '',
  dmBob: '',
};

let bob: ApiUser;

test.beforeAll(async () => {
  R.acme = await resolveRoom('acme-hq');
  R.gaming = await resolveRoom('gaming');
  R.general = await resolveRoom('general');
  R.random = await resolveRoom('random');
  R.dev = await resolveRoom('dev');
  R.lobby = await resolveRoom('lobby');
  R.dmBob = await resolveRoom('dm-alice-bob');
  bob = await asUser('bob');
});

/** Logs in as alice with `#general` pre-selected (the state every AC-M criterion starts from). */
async function phoneGeneral(page: Page): Promise<void> {
  await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.general } });
  await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
  await expect(messageList(page)).toBeVisible();
  // BUG-19: the 44 px phone security banner mounts ~1 s after the shell (first /sync + /keys/query) and
  // resizes the column. Let it land before any test measures geometry or scroll positions.
  const crypto = await waitForStatus(page);
  if (crypto.hint) await expect(banner(page)).toBeVisible();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/* ================================================================== AC-M1 breakpoint + layout */

test('AC-M1-1 — phone layout: data-layout=phone, drawers closed, rail/sidebar hidden, wide list, composer visible', async ({
  page,
}) => {
  await phoneGeneral(page);

  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'phone');
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('space-rail')).toBeHidden();
  await expect(page.getByTestId('channel-sidebar')).toBeHidden();

  const list = await box(messageList(page), 'message-list');
  expect(Math.round(list.width), 'message-list >= 400 px wide').toBeGreaterThanOrEqual(400);
  await expect(page.getByTestId('composer')).toBeVisible();
});

test('AC-M1-3 — resizing 1280 -> 412 -> 1280 flips data-layout without a reload and keeps the room open', async ({
  page,
}) => {
  await phoneGeneral(page);
  await tapRoom(page, R.random);
  await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);

  const shell = page.getByTestId('app-shell');

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(shell).toHaveAttribute('data-layout', 'desktop', { timeout: 500 });
  await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);
  await expect(page.getByTestId('space-rail')).toBeVisible();

  await page.setViewportSize({ width: 412, height: 839 });
  await expect(shell).toHaveAttribute('data-layout', 'phone', { timeout: 500 });
  await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);
  await expect(headerMenu(page)).toBeVisible();
});

test('AC-M1-4 — nothing but message-list scrolls (no page scroll in either axis)', async ({ page }) => {
  await phoneGeneral(page);
  const m = await pageScroll(page);
  expect(m.scrollWidth, `documentElement.scrollWidth ${m.scrollWidth} <= innerWidth ${m.innerWidth}`).toBeLessThanOrEqual(
    m.innerWidth,
  );
  expect(
    m.bodyScrollHeight,
    `body.scrollHeight ${m.bodyScrollHeight} <= innerHeight ${m.innerHeight}`,
  ).toBeLessThanOrEqual(m.innerHeight);
});

/* ================================================================== AC-M2 navigation drawer */

test('AC-M2-1 — header-menu opens the drawer with the rail, the channel list, current-user and a backdrop', async ({
  page,
}) => {
  await phoneGeneral(page);

  const started = Date.now();
  await headerMenu(page).tap();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'true', { timeout: 300 });
  test.info().annotations.push({
    type: 'timing',
    description: `nav-drawer reported data-open="true" ${Date.now() - started} ms after the tap (AC-M2-1 budget 300 ms)`,
  });

  const drawer = navDrawer(page);
  const rail = drawer.getByTestId('space-rail');
  const sidebar = drawer.getByTestId('channel-sidebar');
  await expect(rail).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(drawer.getByTestId('space-item-home')).toBeVisible();
  await expect(drawer.getByTestId(`space-item-${R.acme}`)).toBeVisible();
  await expect(drawer.getByTestId(`space-item-${R.gaming}`)).toBeVisible();

  const channels = drawer.getByTestId('channel-list');
  await expect(channels).toBeVisible();
  // The three seeded channels, in order. Rooms created by earlier runs (AC-M5-2's `memes-*`) are
  // expected on this homeserver, so the assertion is a subsequence, never an exact list.
  const names = await itemNames(channels, 'channel-item-');
  const seeded = [NAMES.general, NAMES.random, NAMES.dev];
  expect(
    names.filter((n) => n && seeded.includes(n as (typeof seeded)[number])),
    `seeded channels in order (full list: ${names.join(', ')})`,
  ).toEqual(seeded);

  await expect(drawer.getByTestId('current-user')).toBeVisible();
  await expect(backdrop(page)).toBeVisible();

  // Rail on the left of the list.
  const railBox = await box(rail, 'space-rail');
  const sidebarBox = await box(sidebar, 'channel-sidebar');
  expect(railBox.x, 'the rail sits left of the channel sidebar').toBeLessThan(sidebarBox.x);
});

test('AC-M2-2 — tapping a channel in the drawer closes it and opens that room', async ({ page }) => {
  await phoneGeneral(page);
  await tapRoom(page, R.random);

  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('channel-header-name')).toHaveText(NAMES.random);
  await expect(messageList(page).locator('[data-testid^="message-$"]').first()).toBeVisible({
    timeout: 15_000,
  });
});

test('AC-M2-3 — tapping drawer-backdrop closes the drawer and leaves the room unchanged', async ({
  page,
}) => {
  await phoneGeneral(page);
  await openNavDrawer(page);
  await tapBackdrop(page);

  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await expect(backdrop(page)).toBeHidden();
  await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
});

test('AC-M2-3b — Escape closes the drawer (keyboards exist in Playwright; same close path)', async ({
  page,
}) => {
  await phoneGeneral(page);
  await openNavDrawer(page);
  await page.keyboard.press('Escape');
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
});

test('AC-M2-4 — tapping a space in the drawer keeps it open and swaps the channel list', async ({
  page,
}) => {
  await phoneGeneral(page);
  await tapSpace(page, R.gaming);

  await expect(navDrawer(page)).toHaveAttribute('data-open', 'true');
  const channels = navDrawer(page).getByTestId('channel-list');
  await expect(channels).toBeVisible();
  // Gaming's seeded channel is `lobby`; #general/#random/#dev must be gone. Extra rooms created in
  // Gaming by earlier runs are tolerated (dirty homeserver rule).
  await expect
    .poll(() => itemNames(channels, 'channel-item-'), { timeout: 10_000 })
    .toContain(NAMES.lobby);
  const names = await itemNames(channels, 'channel-item-');
  for (const gone of [NAMES.general, NAMES.random, NAMES.dev]) {
    expect(names, `${gone} belongs to Acme HQ, not Gaming`).not.toContain(gone);
  }
});

test('AC-M2-5 — Home then a DM closes the drawer, names the other user and hides member-toggle', async ({
  page,
}) => {
  await phoneGeneral(page);
  await openNavDrawer(page);
  await navDrawer(page).getByTestId('space-item-home').tap();
  await expect(navDrawer(page).getByTestId('dm-list')).toBeVisible();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'true');

  await navDrawer(page).getByTestId(`dm-item-${R.dmBob}`).tap();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('channel-header-name')).toHaveText(DISPLAY_NAMES.bob);
  await expect(page.getByTestId('member-toggle')).toHaveCount(0);
});

test('AC-M2-6 — the open drawer is 75-90 % of the viewport, the rail is 72 px, rows are >= 44 px tall', async ({
  page,
}) => {
  await phoneGeneral(page);
  await openNavDrawer(page);

  const viewport = page.viewportSize()!;
  const drawerBox = await box(navDrawer(page), 'nav-drawer');
  const pct = (drawerBox.width / viewport.width) * 100;
  expect(pct, `drawer width ${drawerBox.width}px = ${pct.toFixed(1)} % of ${viewport.width}px`).toBeGreaterThanOrEqual(75);
  expect(pct, `drawer width ${drawerBox.width}px = ${pct.toFixed(1)} % of ${viewport.width}px`).toBeLessThanOrEqual(90);

  const railBox = await box(navDrawer(page).getByTestId('space-rail'), 'space-rail');
  expect(Math.round(railBox.width), 'space-rail is 72 px wide').toBe(72);

  const rows = await navDrawer(page)
    .locator('[data-testid^="channel-item-"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-testid') ?? '',
        height: Math.round(el.getBoundingClientRect().height),
      })),
    );
  expect(rows.length, 'the drawer must list channels').toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.height, `${r.id} height >= ${TAP_TARGET} px`).toBeGreaterThanOrEqual(TAP_TARGET);
  }

  // DM rows too (AC-M2-6 names dm-item-*).
  await navDrawer(page).getByTestId('space-item-home').tap();
  await expect(navDrawer(page).getByTestId('dm-list')).toBeVisible();
  const dms = await navDrawer(page)
    .locator('[data-testid^="dm-item-"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-testid') ?? '',
        height: Math.round(el.getBoundingClientRect().height),
      })),
    );
  for (const d of dms) {
    expect(d.height, `${d.id} height >= ${TAP_TARGET} px`).toBeGreaterThanOrEqual(TAP_TARGET);
  }
});

test('AC-M2-7 — unread raised while the drawer is closed shows on channel-unread-{random} when it opens', async ({
  page,
}) => {
  await phoneGeneral(page);
  // Freshness-independent: the unread is created now, not read from the seed.
  await bob.send(R.random, `qa-unread-${Date.now().toString(36)}`);

  await openNavDrawer(page);
  const badge = navDrawer(page).getByTestId(`channel-unread-${R.random}`);
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => Number(await badge.getAttribute('data-count')), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
});

/* ================================================================== AC-M3 phone header */

test('AC-M3-1 — the phone header is <= 56 px with a 44 px menu left, the name, and a 44 px member toggle right', async ({
  page,
}) => {
  await phoneGeneral(page);

  const header = page.getByTestId('channel-header');
  const headerBox = await box(header, 'channel-header');
  expect(Math.round(headerBox.height), 'channel-header <= 56 px tall').toBeLessThanOrEqual(56);

  const menuBox = await expectTapTarget(headerMenu(page), 'header-menu');
  const toggleBox = await expectTapTarget(page.getByTestId('member-toggle'), 'member-toggle');
  await expect(page.getByTestId('channel-header-name')).toHaveText(NAMES.general);

  expect(menuBox.x, 'header-menu is the left-most control').toBeLessThan(toggleBox.x);
  expect(
    toggleBox.x + toggleBox.width,
    'member-toggle sits at the right edge of the header',
  ).toBeGreaterThan(headerBox.x + headerBox.width - 64);

  // Topic: hidden, or one line that is clipped (never a second line).
  const topic = page.getByTestId('channel-header-topic');
  if ((await topic.count()) > 0 && (await topic.isVisible())) {
    const topicBox = await box(topic, 'channel-header-topic');
    const lineHeight = parseFloat(await computed(topic, 'line-height')) || 20;
    expect(topicBox.height, 'channel-header-topic is at most one line').toBeLessThanOrEqual(
      lineHeight * 1.6,
    );
    expect(['hidden', 'clip', 'ellipsis'], 'the topic is truncated, not wrapped').toContain(
      (await computed(topic, 'text-overflow')) || 'ellipsis',
    );
  }
});

test('AC-M3-3 — in a DM the header shows the other user and no member-toggle', async ({ page }) => {
  await phoneGeneral(page);
  await openNavDrawer(page);
  await navDrawer(page).getByTestId('space-item-home').tap();
  await navDrawer(page).getByTestId(`dm-item-${R.dmBob}`).tap();

  await expect(page.getByTestId('channel-header-name')).toHaveText(DISPLAY_NAMES.bob);
  await expect(page.getByTestId('member-toggle')).toHaveCount(0);
  await expect(headerMenu(page)).toBeVisible();
});

/* ================================================================== AC-M4 member drawer */

test('AC-M4-1 — member-toggle opens the member drawer with the member list, count 4 and a backdrop', async ({
  page,
}) => {
  await phoneGeneral(page);
  await openMemberDrawer(page);

  await expect(memberDrawer(page)).toHaveAttribute('data-open', 'true');
  const list = memberDrawer(page).getByTestId('member-list');
  await expect(list).toBeVisible();
  await expect(memberDrawer(page).getByTestId('member-count')).toHaveText('4');
  expect(
    await list.locator('[data-testid^="member-item-"]').count(),
    '#general has four members',
  ).toBe(4);
  await expect(backdrop(page)).toBeVisible();
});

test('AC-M4-2 — the backdrop closes the member drawer; header-menu swaps it for the nav drawer', async ({
  page,
}) => {
  await phoneGeneral(page);

  await openMemberDrawer(page);
  await closeMemberDrawer(page);
  await expect(memberDrawer(page)).toHaveAttribute('data-open', 'false');

  // One drawer at a time.
  await openMemberDrawer(page);
  await headerMenu(page).tap();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'true', { timeout: 5_000 });
  await expect(memberDrawer(page)).toHaveAttribute('data-open', 'false');
  expect(await drawerState(page)).toEqual({ nav: 'true', members: 'false' });
});

/* ================================================================== AC-M5 touch targets + sheets */

test('AC-M5-1 — every control in the rail, lists, header and member list is >= 44 px in both dimensions', async ({
  page,
}) => {
  await phoneGeneral(page);

  const offenders: string[] = [];
  const check = async (scopeTestId: string, scope = page.getByTestId(scopeTestId)): Promise<void> => {
    for (const t of await tapTargetsIn(scope)) {
      // The rail's round items may be 48 px; everything else must clear 44 px.
      if (t.width < TAP_TARGET || t.height < TAP_TARGET) {
        offenders.push(`${scopeTestId} > ${t.id}: ${t.width}x${t.height}`);
      }
    }
  };

  await check('channel-header');

  await openNavDrawer(page);
  await check('space-rail', navDrawer(page).getByTestId('space-rail'));
  await check('channel-list', navDrawer(page).getByTestId('channel-list'));
  await navDrawer(page).getByTestId('space-item-home').tap();
  await expect(navDrawer(page).getByTestId('dm-list')).toBeVisible();
  await check('dm-list', navDrawer(page).getByTestId('dm-list'));
  await tapBackdrop(page);
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');

  // Back to a channel so the member drawer has content.
  await tapSpace(page, R.acme);
  await navDrawer(page).getByTestId(`channel-item-${R.general}`).tap();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await openMemberDrawer(page);
  await check('member-list', memberDrawer(page).getByTestId('member-list'));

  expect(offenders, `controls under ${TAP_TARGET} px:\n  ${offenders.join('\n  ')}`).toEqual([]);
});

test('AC-M5-2 — channel-add opens a bottom sheet pinned to the viewport bottom and creates the channel', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await phoneGeneral(page);
  await openNavDrawer(page);

  await navDrawer(page).getByTestId('channel-add').tap();
  const dialog = page.getByTestId('create-channel-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-variant', 'sheet');
  // The sheet animates up from translateY(100%); measure the settled position, not mid-flight.
  await settleAnimations(dialog);

  const viewport = page.viewportSize()!;
  const dialogBox = await box(dialog, 'create-channel-dialog');
  expect(Math.round(dialogBox.width), 'the sheet spans the viewport width').toBe(viewport.width);

  // Geometry snapshot: a failure here must say *why* the sheet is not flush, so the row in
  // docs/BUGS.md is actionable without opening the trace.
  const geometry = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const overlay = el.parentElement!;
    const overlayRect = overlay.getBoundingClientRect();
    const cs = getComputedStyle(overlay);
    return {
      sheet: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
      overlay: {
        top: Math.round(overlayRect.top),
        bottom: Math.round(overlayRect.bottom),
        height: Math.round(overlayRect.height),
        position: cs.position,
        alignItems: cs.alignItems,
        padding: cs.padding,
      },
      innerHeight: window.innerHeight,
      visualViewportHeight: Math.round(window.visualViewport?.height ?? 0),
      vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim(),
    };
  });
  test.info().annotations.push({ type: 'sheet geometry', description: JSON.stringify(geometry) });

  expect(
    Math.abs(dialogBox.y + dialogBox.height - viewport.height),
    `the sheet bottom edge is within 1 px of the viewport bottom — ${JSON.stringify(geometry)}`,
  ).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('create-channel-name')).toBeFocused();

  const name = uniqueName('memes');
  await page.getByTestId('create-channel-name').fill(name);
  await page.getByTestId('create-channel-submit').tap();

  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('channel-header-name')).toHaveText(name, { timeout: 30_000 });

  await openNavDrawer(page);
  await expect(navDrawer(page).locator(`[data-testid^="channel-item-"][data-name="${name}"]`)).toBeVisible();
});

test('AC-M5-3 — every input/textarea in a dialog is >= 16 px (no iOS focus zoom)', async ({ page }) => {
  await phoneGeneral(page);
  await openNavDrawer(page);
  await navDrawer(page).getByTestId('channel-add').tap();
  const dialog = page.getByTestId('create-channel-dialog');
  await expect(dialog).toBeVisible();

  const fonts = await dialog
    .locator('input, textarea, select')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-testid') ?? el.tagName,
        size: parseFloat(getComputedStyle(el).fontSize),
      })),
    );
  expect(fonts.length, 'the dialog must have fields').toBeGreaterThan(0);
  for (const f of fonts) {
    expect(f.size, `${f.id} font-size >= 16 px`).toBeGreaterThanOrEqual(16);
  }
  await page.getByTestId('dialog-close').tap();
});

/* ================================================================== AC-M6 viewport + CSS */

test('AC-M6-1 — index.html carries the Phase 2 viewport meta', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
  );
});

test('AC-M6-2 — app-shell height equals innerHeight and the safe-area / tap-target variables resolve', async ({
  page,
}) => {
  await phoneGeneral(page);

  const { shellHeight, innerHeight } = await page.evaluate(() => ({
    shellHeight: document.querySelector('[data-testid="app-shell"]')!.getBoundingClientRect().height,
    innerHeight: window.innerHeight,
  }));
  expect(
    Math.abs(shellHeight - innerHeight),
    `app-shell ${shellHeight}px vs innerHeight ${innerHeight}px`,
  ).toBeLessThanOrEqual(1);

  for (const name of ['--safe-top', '--safe-right', '--safe-bottom', '--safe-left']) {
    expect(await cssVar(page, name), `${name} resolves on :root`).toMatch(/^-?[\d.]+px$/);
  }
  expect(await cssVar(page, '--tap-target')).toBe('44px');
});

test('AC-M6-3 — touch CSS: manipulation on the shell, overscroll none on html/body, transparent tap highlight', async ({
  page,
}) => {
  await phoneGeneral(page);

  expect(await computed(page.getByTestId('app-shell'), 'touch-action')).toBe('manipulation');
  for (const selector of ['html', 'body']) {
    expect(
      await computed(page.locator(selector), 'overscroll-behavior-y'),
      `${selector} overscroll-behavior`,
    ).toBe('none');
  }
  const highlight = await computed(page.getByTestId('app-shell'), '-webkit-tap-highlight-color');
  expect(highlight, `-webkit-tap-highlight-color is transparent (got ${highlight})`).toMatch(
    /rgba\(0,\s*0,\s*0,\s*0\)|transparent/,
  );
});

/* ================================================================== AC-V6 (layout half) */

test('AC-V6-2 — tapping a row does not reveal message-actions; reaction pills stay >= 32 px', async ({
  page,
}) => {
  await phoneGeneral(page);
  const firstRow = messageList(page).locator('[data-testid^="message-$"]').last();
  await expect(firstRow).toBeVisible({ timeout: 15_000 });

  await firstRow.tap();
  await expect(firstRow.getByTestId('message-actions')).toBeHidden();

  // Pills: react to a message of our own so there is one to measure, then check the height.
  const target = await firstRow.getAttribute('data-testid');
  const eventId = target!.replace('message-', '');
  await bob.react(R.general, eventId, '🎉').catch(() => undefined);
  const pill = row(page, eventId).getByTestId('reaction-🎉');
  await expect(pill).toBeVisible({ timeout: 20_000 });
  const pillBox = await box(pill, 'reaction-🎉');
  expect(Math.round(pillBox.height), 'reaction pill >= 32 px tall').toBeGreaterThanOrEqual(32);
  await expect(pill).toBeEnabled();
});

test('AC-V6-3 — a 500 ms long-press opens message-action-sheet; reply closes it; the backdrop closes it', async ({
  page,
}) => {
  await phoneGeneral(page);
  const target = messageList(page).locator('[data-testid^="message-$"]').last();
  await expect(target).toBeVisible({ timeout: 15_000 });

  await longPress(target, 600);
  const sheet = page.getByTestId('message-action-sheet');
  await expect(sheet).toBeVisible({ timeout: 5_000 });
  await expect(sheet.getByTestId('message-action-react')).toBeVisible();
  await expect(sheet.getByTestId('message-action-reply')).toBeVisible();

  await sheet.getByTestId('message-action-reply').tap();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('composer-reply-banner')).toBeVisible();
  await page.getByTestId('composer-reply-cancel').tap();

  await longPress(target, 600);
  await expect(page.getByTestId('message-action-sheet')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('message-action-sheet-backdrop').tap();
  await expect(page.getByTestId('message-action-sheet')).toHaveCount(0);
});

test('AC-V6-4 — a touch that moves more than 10 px before 500 ms opens no sheet', async ({ page }) => {
  await phoneGeneral(page);
  const target = messageList(page).locator('[data-testid^="message-$"]').last();
  await expect(target).toBeVisible({ timeout: 15_000 });

  await touchDrag(target, 0, -60);
  await expect(page.getByTestId('message-action-sheet')).toHaveCount(0);
});

test('AC-V6-5 — images fit the viewport, pre blocks scroll inside themselves, the page does not scroll sideways', async ({
  page,
}) => {
  await phoneGeneral(page);
  const viewport = page.viewportSize()!;

  // Page-level: no horizontal scroll at all.
  const metrics = await pageScroll(page);
  expect(metrics.scrollWidth, 'no horizontal page scroll').toBeLessThanOrEqual(metrics.innerWidth);

  const images = await messageList(page)
    .getByTestId('message-image')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  for (const w of images) {
    expect(w, `message-image ${w}px <= viewport ${viewport.width}px`).toBeLessThanOrEqual(viewport.width);
  }

  const pres = await messageList(page)
    .locator('pre')
    .evaluateAll((els) =>
      els.map((el) => ({
        overflowX: getComputedStyle(el).overflowX,
        width: Math.round(el.getBoundingClientRect().width),
      })),
    );
  for (const p of pres) {
    expect(['auto', 'scroll'], `pre overflow-x (got ${p.overflowX})`).toContain(p.overflowX);
    expect(p.width, 'pre fits the viewport').toBeLessThanOrEqual(viewport.width);
  }
  test.info().annotations.push({
    type: 'coverage',
    description: `measured ${images.length} message-image and ${pres.length} pre element(s) in the opening window of #general`,
  });
});

test('AC-V6-6 — pagination keeps its anchor (<= 5 px) and the list sticks to the bottom on phone', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await phoneGeneral(page);

  // AC-B3-2 on phone: the previously top-most row must not move when older events are prepended.
  const ids = await messageList(page)
    .locator('[data-testid^="message-$"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
  expect(ids.length, 'the list must already hold rows').toBeGreaterThan(0);
  const topId = ids[0];
  const anchor = page.getByTestId(topId);

  // Measured against message-list, not the viewport: the phone security banner (44 px, an account without
  // encryption set up) can mount ~1 s after the shell and shift the whole column (BUG-19).
  const offsetInList = (id: string, scrollToTop = false): Promise<number> =>
    messageList(page).evaluate(
      (el, [rowId, toTop]) => {
        if (toTop) el.scrollTop = 0; // same tick as the read, before pagination can prepend
        return el.querySelector(`[data-testid="${rowId}"]`)!.getBoundingClientRect().top - el.getBoundingClientRect().top;
      },
      [id, scrollToTop] as const,
    );
  const beforeY = await offsetInList(topId, true);

  await expect
    .poll(
      async () => messageList(page).locator('[data-testid^="message-$"]').count(),
      { timeout: 20_000, message: 'backwards pagination did not add rows' },
    )
    .toBeGreaterThan(ids.length);

  await expect(anchor).toBeAttached();
  const afterY = await offsetInList(topId);
  expect(Math.abs(afterY - beforeY), 'anchor drift <= 5 px').toBeLessThanOrEqual(5);

  // AC-B3-4 on phone: a new message while at the bottom keeps the list pinned.
  await messageList(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const marker = `qa-stick-${Date.now().toString(36)}`;
  await bob.send(R.general, marker);
  await expect(messageList(page).getByText(marker)).toBeVisible({ timeout: 20_000 });
  const stuck = await messageList(page).evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
  );
  expect(stuck, 'the list stays within 8 px of the bottom').toBeLessThanOrEqual(8);
});

/* ================================================================== desktop regressions */

test.describe('desktop regressions (AC-M1-2, AC-M3-2, AC-M4-3, AC-M5-4)', () => {
  // `devices['Desktop Chrome']` carries `defaultBrowserType`, and Playwright refuses launch-level
  // options inside a describe ("forces a new worker"). These are the *context* options that make the
  // difference: fine pointer, no touch, 1280x720 — enough for `isPhone` to be false.
  test.use({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: devices['Desktop Chrome'].userAgent,
  });

  test('AC-M1-2 — desktop renders no drawers, no backdrop and no header-menu', async ({ page }) => {
    await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.general } });

    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'desktop');
    for (const id of ['nav-drawer', 'member-drawer', 'drawer-backdrop', 'header-menu']) {
      await expect(page.getByTestId(id), `${id} must not be in the desktop DOM`).toHaveCount(0);
    }
    await expect(page.getByTestId('space-rail')).toBeVisible();
    await expect(page.getByTestId('channel-sidebar')).toBeVisible();
    test.info().annotations.push({
      type: 'see also',
      description: '"the Phase 1 suite passes unchanged" is the `desktop` project run (npm run test:e2e:desktop).',
    });
  });

  test('AC-M3-2 — the desktop header is unchanged: no header-menu, topic visible', async ({ page }) => {
    await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.general } });
    await expect(page.getByTestId('header-menu')).toHaveCount(0);
    await expect(page.getByTestId('channel-header-topic')).toBeVisible();
    await expect(page.getByTestId('member-toggle')).toBeVisible();
  });

  test('AC-M4-3 — desktop member-toggle still toggles the inline panel', async ({ page }) => {
    await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.general } });
    const list = page.getByTestId('member-list');
    await expect(list).toBeVisible();
    await page.getByTestId('member-toggle').click();
    await expect(list).toBeHidden();
    await page.getByTestId('member-toggle').click();
    await expect(list).toBeVisible();
    await expect(page.getByTestId('member-count')).toHaveText('4');
  });

  test('AC-M5-4 — desktop dialogs carry data-variant="modal"', async ({ page }) => {
    await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.general } });
    await openChannel(page, R.general);
    await page.getByTestId('channel-add').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-variant', 'modal');
    await page.getByTestId('dialog-close').click();
    await expect(dialog).toHaveCount(0);
    test.info().annotations.push({
      type: 'see also',
      description: 'AC-A6..A9 themselves are the `desktop` project run (npm run test:e2e:desktop).',
    });
  });
});

test.afterAll(() => {
  test.info().annotations.push({
    type: 'not run here',
    description:
      'AC-M2-8 (edge swipe, Android back), AC-M6-4 and AC-M6-5 (soft keyboard, status bar, overscroll bounce) are manual device criteria — docs/BUGS.md "Phase 2 device report".',
  });
});
