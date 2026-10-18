/**
 * QA-11 — the phone smoke test *is* the phone demo script.
 *
 * One serial spec that walks docs/PHASE2_PLAN.md "Phone demo script" steps 1-10 in order as alice on
 * `devices['Pixel 7']`, asserting the "They should see" column of each row. A **full-page screenshot
 * is written for every step even when it passes** into `e2e/demo-mobile/` — that set is the
 * stakeholder's pre-read of the phone look, so it deliberately lives outside every project
 * `outputDir` (Playwright wipes those on start).
 *
 * Serial and single-page on purpose: the demo is one continuous session, and a step that depends on
 * the previous step's state (badge cleared, drawer closed, the note recorded in step 6 being the one
 * played in step 7) is exactly what we want to catch. Per-criterion coverage is in voice.spec.ts and
 * mobile-nav.spec.ts.
 *
 * The context is created explicitly with the Pixel 7 descriptor and `permissions: ['microphone']`:
 * `browser.newContext()` does **not** inherit the project's `use` block, so a bare `newPage()` here
 * would silently run the phone demo at desktop size with no microphone.
 *
 * Freshness: every step works on a dirty homeserver. Step 2's seeded `3` badge is topped up by
 * `ensureUnread` and the literal number is only asserted on a pristine seed (`noteSeedDrift` records
 * the drift otherwise), exactly as the Phase 1 smoke does.
 *
 * Device-only steps of the real demo that cannot run here, listed in the report as "not run here":
 * the keyboard rising in step 5, the microphone permission prompt in step 6, and the swipe
 * alternative in step 2.
 */
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import * as C from './fixtures/call.ts';
import { requireUi, secondContext, waitForStatus } from './fixtures/e2ee.ts';
import { checkFreshSeed } from './fixtures/fresh.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { DISPLAY_NAMES, NAMES, resolveRoom, userId } from './fixtures/seed.ts';
import { annotate, ensureUnread, noteSeedDrift } from './fixtures/state.ts';
import { messageList, row, settledEventId } from './fixtures/ui.ts';
// `stableRow` only (the `requireThreadUi` probe is deliberately not used in this serial spec — it
// would clear the shared page's session; see the step 11 header).
import { openActionSheet } from './fixtures/threads.ts';
import {
  composerGif,
  expectGifPlaying,
  expectGridIds,
  gifAttribution,
  gifClose,
  gifHeading,
  gifItem,
  gifPending,
  gifPicker,
  gifRowById,
  gifSearch,
  GIF_PROVIDER_STORAGE_KEY,
  guardGifNetwork,
  MOCK_IDS,
  mockSearch,
  queryMatching,
  searchInPicker,
} from './fixtures/gif.ts';
import {
  backdrop,
  box,
  expectTapTarget,
  headerMenu,
  memberDrawer,
  navDrawer,
  openMemberDrawer,
  openNavDrawer,
  pageScroll,
  phoneShot,
  tapBackdrop,
  tapRoom,
  settleAnimations,
} from './fixtures/mobile.ts';

test.describe.configure({ mode: 'serial' });

const ALICE = userId('alice');
const BOB = userId('bob');
/** The seeded unread the demo script shows on `#random` (docs/SEED_DATA.md). */
const RANDOM_BADGE_ON_FRESH_SEED = 3;
/** The thread root phone step 11a creates, reused by step 11b (Phase 3 phone demo rows 2-6). */
let demoThreadRootId = '';

const R: Record<'acme' | 'gaming' | 'general' | 'random' | 'dev' | 'dmBob', string> = {
  acme: '',
  gaming: '',
  general: '',
  random: '',
  dev: '',
  dmBob: '',
};

let context: BrowserContext;
let page: Page;

let bob: ApiUser;

/** Event id of the note bob posts in beforeAll (demo step 8: something alice did not record). */
let bobNoteId = '';

/** Phone demo rows 3 and 5 queries, derived so a fixture-catalogue change cannot break the step. */
const DEMO_QUERY = queryMatching(3, ['tacos', 'taco', 'cat', 'party']) ?? 'cat';
const SECOND_QUERY = queryMatching(2, ['cat', 'party', 'taco']) ?? 'cat';
/** Event id of the note alice records in step 6 (played in step 7). */
let aliceNoteId = '';

test.describe('phone demo script (QA-11 mobile smoke)', () => {
  test.beforeAll(async ({ browser, baseURL }) => {
    R.acme = await resolveRoom('acme-hq');
    R.gaming = await resolveRoom('gaming');
    R.general = await resolveRoom('general');
    R.random = await resolveRoom('random');
    R.dev = await resolveRoom('dev');
    R.dmBob = await resolveRoom('dm-alice-bob');

    bob = await asUser('bob');

    // Demo prep (docs/PHASE2_PLAN.md): a bob voice note in #general so step 8 has something to play.
    const sent = await bob.sendVoice(R.general, {
      file: 'e2e/fixtures/test-voice.wav',
      durationMs: 1500,
      mimetype: 'audio/wav',
    });
    bobNoteId = sent.eventId;

    // Step 2 shows an unread badge on #random; the seeded 3 is consumed by any earlier run.
    await ensureUnread(R.random, RANDOM_BADGE_ON_FRESH_SEED);

    // The project `use` block is not inherited by an explicit context — pass the phone descriptor.
    context = await browser.newContext({
      ...devices['Pixel 7'],
      permissions: ['microphone'],
      baseURL: baseURL ?? undefined,
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
    annotate(
      'not run here',
      'Device-only parts of the demo: the soft keyboard rising in step 5 (AC-M6-4), the Android microphone prompt in step 6 (AC-V5-3), the edge swipe in step 2 (AC-M2-8) and the status-bar/gesture-bar look (AC-M6-5).',
    );
  });

  test('step 1 — log in as alice: #general full-screen, compact header, composer with a mic', async () => {
    const started = Date.now();
    await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.general } });
    const elapsed = Date.now() - started;
    annotate('timing', `login -> phone shell painted in ${elapsed} ms (demo script wants < 3000 ms)`);

    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'phone');
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
    await expect(messageList(page)).toBeVisible();
    await expect(messageList(page).locator('[data-testid^="message-$"]').last()).toBeVisible({
      timeout: 20_000,
    });

    // Compact header: menu, name, members. Composer pinned to the bottom with a mic.
    await expectTapTarget(headerMenu(page), 'header-menu');
    await expectTapTarget(page.getByTestId('member-toggle'), 'member-toggle');
    await expect(page.getByTestId('composer')).toBeVisible();
    await expect(page.getByTestId('composer-mic')).toBeVisible();

    // Nothing hidden under the status bar / gesture bar: the shell fills exactly the viewport.
    const { shellHeight, innerHeight } = await page.evaluate(() => ({
      shellHeight: document.querySelector('[data-testid="app-shell"]')!.getBoundingClientRect().height,
      innerHeight: window.innerHeight,
    }));
    expect(Math.abs(shellHeight - innerHeight), 'app-shell fills the viewport').toBeLessThanOrEqual(1);
    const shell = await box(page.getByTestId('app-shell'), 'app-shell');
    const composer = await box(page.getByTestId('composer'), 'composer');
    expect(
      Math.abs(shell.y + shell.height - (composer.y + composer.height)),
      'the composer sits on the shell bottom edge',
    ).toBeLessThanOrEqual(1);

    await phoneShot(page, 1, 'login-general');
  });

  test('step 2 — the menu button opens the drawer: rail, channel list, #random badge; tapping outside closes it', async () => {
    await headerMenu(page).tap();
    await expect(navDrawer(page)).toHaveAttribute('data-open', 'true', { timeout: 5_000 });

    const drawer = navDrawer(page);
    await expect(drawer.getByTestId('space-item-home')).toBeVisible();
    await expect(drawer.locator(`[data-testid="space-item-${R.acme}"]`)).toBeVisible();
    await expect(drawer.locator(`[data-testid="space-item-${R.gaming}"]`)).toBeVisible();
    await expect(drawer.getByTestId('channel-list')).toBeVisible();
    await expect(backdrop(page)).toBeVisible();

    // The drawer covers most of the screen (the demo's "covering most of the screen").
    const viewport = page.viewportSize()!;
    const drawerBox = await box(drawer, 'nav-drawer');
    expect(drawerBox.width / viewport.width, 'the drawer covers 75-90 % of the width').toBeGreaterThanOrEqual(0.75);

    const badge = drawer.getByTestId(`channel-unread-${R.random}`);
    await expect(badge).toBeVisible({ timeout: 20_000 });
    const count = Number(await badge.getAttribute('data-count'));
    const fresh = await checkFreshSeed();
    if (fresh.fresh) {
      expect(count, 'the seeded #random badge').toBe(RANDOM_BADGE_ON_FRESH_SEED);
    } else {
      noteSeedDrift('phone demo step 2 (#random badge)', RANDOM_BADGE_ON_FRESH_SEED, count);
      expect(count, 'the #random badge shows unread').toBeGreaterThanOrEqual(1);
    }

    await phoneShot(page, 2, 'nav-drawer');

    await tapBackdrop(page);
    await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  });

  test('step 3 — tapping #random closes the drawer, opens the room and clears the badge', async () => {
    await openNavDrawer(page);
    await navDrawer(page).getByTestId(`channel-item-${R.random}`).tap();

    await expect(navDrawer(page)).toHaveAttribute('data-open', 'false', { timeout: 5_000 });
    await expect(page.getByTestId('channel-header-name')).toHaveText(NAMES.random);
    await expect(messageList(page).locator('[data-testid^="message-$"]').last()).toBeVisible({
      timeout: 20_000,
    });
    await phoneShot(page, 3, 'random-open');

    // "the badge is gone the next time the drawer opens"
    await openNavDrawer(page);
    await expect
      .poll(() => navDrawer(page).getByTestId(`channel-unread-${R.random}`).count(), {
        timeout: 20_000,
        message: 'the #random badge must clear once the room has been read',
      })
      .toBe(0);
    await tapBackdrop(page);
    await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  });

  test('step 4 — back in #general, scrolling up reads well at phone width with no horizontal scroll', async () => {
    await openNavDrawer(page);
    await navDrawer(page).getByTestId(`channel-item-${R.general}`).tap();
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);

    const before = await messageList(page).locator('[data-testid^="message-$"]').count();
    await messageList(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(() => messageList(page).locator('[data-testid^="message-$"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(before);

    // Rich bodies render; nothing forces the page sideways.
    const metrics = await pageScroll(page);
    expect(metrics.scrollWidth, 'no horizontal page scroll').toBeLessThanOrEqual(metrics.innerWidth);
    const viewport = page.viewportSize()!;
    const widths = await messageList(page)
      .locator('[data-testid^="message-$"]')
      .evaluateAll((els) => els.map((el) => Math.round(el.scrollWidth)));
    for (const w of widths) {
      expect(w, `a row is ${w}px wide, viewport ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
    }
    annotate(
      'coverage',
      `paged #general back to ${await messageList(page).locator('[data-testid^="message-$"]').count()} rows and measured every one for overflow`,
    );
    await phoneShot(page, 4, 'scrolled-history');
  });

  test('step 5 — typing and sending "Hello from my phone" lands at the bottom under alice', async () => {
    await messageList(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const text = `Hello from my phone ${Date.now().toString(36)}`;
    const input = page.getByTestId('composer-input');
    await input.tap();
    await input.fill(text);
    expect(
      parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)),
      'composer-input is >= 16 px so the phone does not zoom on focus',
    ).toBeGreaterThanOrEqual(16);
    await page.getByTestId('composer-send').tap();

    const sentRow = messageList(page)
      .locator(`[data-testid^="message-"][data-sender="${ALICE}"]`)
      .filter({ hasText: text });
    await expect(sentRow).toBeVisible({ timeout: 20_000 });
    await settledEventId(sentRow);

    const stuck = await messageList(page).evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    );
    expect(stuck, 'the newest message is visible at the bottom').toBeLessThanOrEqual(8);
    await phoneShot(page, 5, 'sent-text');
  });

  test('step 6 — the mic records and sends: bar with timer and level, then a voice bubble with a waveform', async () => {
    test.setTimeout(90_000);
    await page.getByTestId('composer-mic').tap();

    const bar = page.getByTestId('composer-recording');
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toHaveAttribute('data-state', 'recording', { timeout: 10_000 });
    await expect(page.getByTestId('recording-timer')).toHaveText('0:01', { timeout: 5_000 });
    await expect(page.getByTestId('recording-level')).toBeVisible();
    await phoneShot(page, 6, 'recording-bar');

    await expect(page.getByTestId('recording-timer')).toHaveText('0:03', { timeout: 8_000 });
    await page.getByTestId('recording-send').tap();
    await expect(bar).toHaveCount(0, { timeout: 30_000 });

    const bubbleRow = messageList(page)
      .locator(`[data-testid^="message-"][data-sender="${ALICE}"]`)
      .filter({ has: page.getByTestId('voice-message') })
      .last();
    await expect(bubbleRow).toBeVisible({ timeout: 30_000 });
    aliceNoteId = await settledEventId(bubbleRow);

    const bubble = bubbleRow.getByTestId('voice-message');
    await expect(bubble.getByTestId('voice-waveform')).toBeVisible();
    await expect(bubble.getByTestId('voice-duration')).toHaveText(/^0:0[2-9]$/);
    await phoneShot(page, 6, 'voice-sent');
  });

  test('step 7 — playing my own note moves the progress across the waveform and swaps to pause', async () => {
    const r = page.getByTestId(`message-${aliceNoteId}`);
    const bubble = r.getByTestId('voice-message');
    await expect(bubble).toBeVisible();

    await r.getByTestId('voice-play').tap();
    await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    await expect(r.getByTestId('voice-pause')).toBeVisible();
    await expect
      .poll(async () => Number(await bubble.getAttribute('data-position-ms')), { timeout: 8_000 })
      .toBeGreaterThan(0);
    // AC-V3-7 is visual: this screenshot is the record of the played/unplayed bar colouring.
    await phoneShot(page, 7, 'voice-playing');
    await r.getByTestId('voice-pause').tap();
    await expect(bubble).toHaveAttribute('data-state', 'paused', { timeout: 5_000 });
  });

  test("step 8 — bob's voice note plays the same way", async () => {
    const r = page.getByTestId(`message-${bobNoteId}`);
    await r.scrollIntoViewIfNeeded();
    const bubble = r.getByTestId('voice-message');
    await expect(bubble).toBeVisible({ timeout: 20_000 });
    await expect(r).toHaveAttribute('data-sender', BOB);
    await expect(bubble.getByTestId('voice-waveform')).toBeVisible();

    await r.getByTestId('voice-play').tap();
    await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    await expect
      .poll(async () => Number(await bubble.getAttribute('data-position-ms')), { timeout: 8_000 })
      .toBeGreaterThan(0);
    await phoneShot(page, 8, 'bob-voice-playing');
    await expect(bubble).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  });

  test('step 9 — Home then Bob Ruiz opens the DM full-screen with no member button', async () => {
    await openNavDrawer(page);
    await navDrawer(page).getByTestId('space-item-home').tap();
    await expect(navDrawer(page).getByTestId('dm-list')).toBeVisible();
    await navDrawer(page).getByTestId(`dm-item-${R.dmBob}`).tap();

    await expect(navDrawer(page)).toHaveAttribute('data-open', 'false', { timeout: 5_000 });
    await expect(page.getByTestId('channel-header-name')).toHaveText(DISPLAY_NAMES.bob);
    await expect(page.getByTestId('member-toggle')).toHaveCount(0);
    await expect(messageList(page)).toBeVisible();
    await phoneShot(page, 9, 'dm-bob');
  });

  test('step 10 — the members button opens a right-hand drawer listing the members; tapping outside closes it', async () => {
    // Back to a channel (the member button is hidden in DMs).
    await openNavDrawer(page);
    await navDrawer(page).locator(`[data-testid="space-item-${R.acme}"]`).tap();
    await navDrawer(page).getByTestId(`channel-item-${R.general}`).tap();
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);

    await openMemberDrawer(page);
    const list = memberDrawer(page).getByTestId('member-list');
    await expect(list).toBeVisible();
    expect(await list.locator('[data-testid^="member-item-"]').count()).toBe(4);
    await expect(memberDrawer(page).getByTestId('member-count')).toHaveText('4');
    await phoneShot(page, 10, 'member-drawer');

    await tapBackdrop(page);
    await expect(memberDrawer(page)).toHaveAttribute('data-open', 'false');
  });

  /**
   * Step 11 is the Phase 3 phone thread walk-through (QA-17, AC-T11-2): docs/PHASE3_PLAN.md "Phone
   * demo script" rows 2-6, with bob's `npm run thread:sample` replaced by `sendThreadReply`.
   * Screenshots land in `e2e/demo-mobile/11-*`, one per demo sub-step.
   *
   * Split like the desktop step 11: rows 2-4 are Dev B's panel (DEV-B-19/20) and rows 5-6 are Dev A's
   * Threads sheet and `header-back` (DEV-A-17/18), so each half skips on its own while Wave 8 runs.
   * The `requireThreadUi` probe is deliberately not used here — it would clear this long-lived shared
   * page's session (see the note in `e2e/smoke.spec.ts` step 11).
   */
  test('step 11 — long-press to Reply in thread, send from the phone, back to the channel (demo 2-4)', async () => {
    test.setTimeout(120_000);

    const rootBody = `[demo] Phone thread root ${Date.now().toString(36)}`;
    const rootId = await bob.send(R.general, rootBody);
    // --- demo row 2: long-press -> the sheet -> Reply in thread -> the full-screen thread.
    // `openActionSheet` rather than a bare `longPress`: step 10 closed the member drawer by tapping
    // outside, and the fading `drawer-backdrop` swallows the next synthetic touch (see the helper).
    const sheet = await openActionSheet(page, rootId);
    const sheetItem = sheet.getByTestId('message-action-thread');
    if ((await sheetItem.count()) === 0) {
      await tapBackdrop(page).catch(() => undefined);
      annotate('not-built', 'phone demo step 11a: `message-action-thread` in the sheet (DEV-B-19)');
      test.skip(true, 'phone demo step 11a: `message-action-thread` is not built yet (DEV-B-19)');
    }
    await phoneShot(page, 11, 'action-sheet');

    await sheetItem.tap();
    await expect(sheet).toBeHidden();
    const panel = page.getByTestId('thread-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-root', rootId);
    await expect(page.getByTestId('thread-root')).toContainText(rootBody);
    await expect(page.getByTestId('thread-composer-input')).toHaveAttribute(
      'placeholder',
      'Replying in thread',
    );
    // The thread fills the screen under the header.
    const shell = await box(page.getByTestId('app-shell'), 'app-shell');
    const panelBox = await box(panel, 'thread-panel');
    expect(Math.round(panelBox.width), 'the thread is full-screen').toBe(Math.round(shell.width));
    await phoneShot(page, 11, 'thread-fullscreen');

    // --- demo row 3: "From my phone"
    const input = page.getByTestId('thread-composer-input');
    await input.tap();
    await input.fill('From my phone');
    await input.press('Enter');
    await expect(
      page
        .getByTestId('thread-message-list')
        .getByTestId(/^message-[$~]/)
        .filter({ hasText: 'From my phone' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('thread-replies-divider')).toHaveText('1 reply', { timeout: 10_000 });
    await phoneShot(page, 11, 'phone-reply-sent');

    // --- demo row 4: the back arrow returns to #general with a "1 reply" summary under the root
    const back = page.getByTestId('header-back');
    if ((await back.count()) === 0) {
      annotate('not-built', 'phone demo step 11a: `header-back` is not built yet (DEV-A-18)');
    } else {
      await back.tap();
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
    }
    // `waitFor`, not `count()`: the summary row renders on a `threadVersion` bump a moment after the
    // panel's divider has ticked, so an instant count would write a false `not-built` annotation and
    // screenshot the timeline without the row this demo step is about.
    const summary = page.getByTestId(`thread-summary-${rootId}`);
    const summaryShown = await summary
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (summaryShown) {
      await summary.scrollIntoViewIfNeeded();
      await expect(summary.getByTestId('thread-summary-count')).toHaveText('1 reply', { timeout: 10_000 });
    } else {
      annotate('not-built', 'phone demo step 11a: `thread-summary-{rootId}` (DEV-B-18)');
    }
    await phoneShot(page, 11, 'back-in-channel-with-summary');

    demoThreadRootId = rootId;
  });

  test('step 11 — bob replies: the Threads dot, the bottom sheet and reopening the thread (demo 5-6)', async () => {
    test.setTimeout(90_000);

    const threadsBtn = page.getByTestId('header-threads');
    test.skip(
      (await threadsBtn.count()) === 0,
      'phone demo step 11b: `header-threads` is not built yet (DEV-A-17)',
    );
    test.skip(!demoThreadRootId, 'phone demo step 11b needs the thread step 11a created');

    // --- demo row 5: bob's reply ticks the summary and lights the dot
    await bob.sendThreadReply(R.general, demoThreadRootId, '[demo] Replying from my laptop');
    await expect(page.getByTestId('header-threads-unread')).toBeVisible({ timeout: 10_000 });
    const summary = page.getByTestId(`thread-summary-${demoThreadRootId}`);
    const summaryShown = await summary
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (summaryShown) {
      await expect(summary.getByTestId('thread-summary-count')).toHaveText('2 replies', {
        timeout: 10_000,
      });
    }
    await phoneShot(page, 11, 'threads-dot');

    // --- demo row 6: the bottom sheet lists it; tapping opens the full-screen thread; back returns
    await threadsBtn.tap();
    const list = page.getByTestId('thread-list');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('data-variant', 'sheet');
    const item = page.getByTestId(`thread-list-item-${demoThreadRootId}`);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.getByTestId('thread-list-item-count')).toHaveText('2 replies');
    await expectTapTarget(item, `thread-list-item-${demoThreadRootId}`);
    await phoneShot(page, 11, 'threads-sheet');

    await item.tap();
    await expect(list).toBeHidden();
    await expect(page.getByTestId('thread-panel')).toHaveAttribute('data-root', demoThreadRootId);
    await expect(page.getByTestId('thread-replies-divider')).toHaveText('2 replies', { timeout: 10_000 });
    await phoneShot(page, 11, 'thread-from-sheet');

    const back = page.getByTestId('header-back');
    if ((await back.count()) === 0) {
      annotate('not-built', 'phone demo step 11b: `header-back` is not built yet (DEV-A-18)');
    } else {
      await back.tap();
      await expect(page.getByTestId('thread-panel')).toHaveCount(0);
      await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
      await phoneShot(page, 11, 'back-to-channel');
    }
  });
  test('step 12 — the GIF sheet: tap GIF, Trending, search, tap a tile, /giphy (phone demo 2-5)', async () => {
    test.setTimeout(120_000);

    // Phase 4 phone demo rows 2-5, in **#dev** (the room the GIF suites own) rather than #general, so
    // the stakeholder's #general demo history stays clean. Forced onto `mock` at runtime so the step
    // is deterministic even with a Klipy key in .env, and guarded so no image request leaves the
    // machine (AC-G11-3).
    const guard = guardGifNetwork(page);
    await page.evaluate((key) => {
      try {
        window.localStorage.setItem(key, 'mock');
      } catch {
        /* private mode */
      }
    }, GIF_PROVIDER_STORAGE_KEY);

    await tapRoom(page, R.dev);
    await expect(messageList(page)).toBeVisible();

    if ((await composerGif(page).count()) === 0) {
      annotate('not-built', 'phone demo step 12: `composer-gif` is not built yet (DEV-B-23/26)');
      test.skip(true, 'phone demo step 12: the GIF button is not built yet');
    }

    // --- demo row 2: tap GIF -> a bottom sheet on Trending, 2 columns, attribution, a close button
    await expectTapTarget(composerGif(page), 'composer-gif');
    await composerGif(page).tap();
    await expect(gifPicker(page)).toBeVisible();
    await settleAnimations(gifPicker(page));
    await expect(gifPicker(page)).toHaveAttribute('data-variant', 'sheet');
    await expect(gifPicker(page)).toHaveAttribute('data-provider', 'mock');
    await expect(gifHeading(page)).toHaveText('Trending');
    await expectGridIds(page, MOCK_IDS);
    await expect(gifAttribution(page)).toBeVisible();
    await expectTapTarget(gifClose(page), 'gif-close');
    const columns = await page
      .getByTestId('gif-grid')
      .locator('[data-testid^="gif-item-"]')
      .evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().x))).size);
    expect(columns, 'the phone sheet shows the grid in 2 columns').toBe(2);
    await phoneShot(page, 12, 'gif-sheet-trending');

    // --- demo row 3: typing updates the results, and the sheet stays put
    await searchInPicker(page, DEMO_QUERY);
    const hits = mockSearch(DEMO_QUERY);
    await expectGridIds(page, hits.map((g) => g.id));
    await phoneShot(page, 12, 'gif-sheet-search');

    // --- demo row 4: tap a tile -> the sheet closes, the chip shows, the GIF arrives with the badge
    const chosen = hits[0];
    await gifItem(page, chosen.id).tap();
    await expect(gifPicker(page)).toBeHidden();
    const sentRow = gifRowById(page, chosen.id);
    await expect(sentRow.first()).toBeVisible({ timeout: 15_000 });
    await expect(gifPending(page)).toBeHidden({ timeout: 10_000 });
    const gifRow = row(page, await settledEventId(sentRow.first()));
    await expectGifPlaying(gifRow);
    await expect(gifRow.getByTestId('message-gif-badge')).toHaveText('GIF');
    const imgBox = await box(gifRow.getByTestId('message-gif-img'), 'message-gif-img');
    expect(imgBox.width, 'the GIF fits the phone width').toBeLessThanOrEqual(page.viewportSize()!.width);
    await phoneShot(page, 12, 'gif-sent');

    // --- demo row 5: `/giphy <q>` + send opens the sheet pre-searched; tapping a tile sends as above
    const input = page.getByTestId('composer-input');
    await input.tap();
    await input.fill(`/giphy ${SECOND_QUERY}`);
    const send = page.getByTestId('composer-send');
    if (await send.isVisible()) await send.tap();
    else await input.press('Enter');

    await expect(gifPicker(page)).toBeVisible();
    await expect(gifSearch(page)).toHaveValue(SECOND_QUERY);
    await expect(input, 'the slash command is consumed, never sent').toHaveValue('');
    const secondHits = mockSearch(SECOND_QUERY);
    await expectGridIds(page, secondHits.map((g) => g.id));
    await phoneShot(page, 12, 'giphy-prefilled');

    const second = secondHits[secondHits.length - 1];
    await gifItem(page, second.id).tap();
    await expect(gifPicker(page)).toBeHidden();
    const secondRow = gifRowById(page, second.id);
    await expect(secondRow.first()).toBeVisible({ timeout: 15_000 });
    await expectGifPlaying(row(page, await settledEventId(secondRow.first())));
    await phoneShot(page, 12, 'giphy-sent');

    guard.assertClean();
  });
});

/* ================================================================== step 14: Phase 7 phone call (QA-37, AC-R10-3 / AC-R9-1) */

test.describe('step 14 — Phase 7 phone call (AC-R9-1)', () => {
  test('step 14 — the phone calls dave: full-screen call, 56 px controls, minimise to the bar, leave', async ({ page, browser }) => {
    test.setTimeout(150_000);
    await C.requireRtc(test);
    requireUi('Dev B', 'header-call', 'call-screen', 'call-mute', 'call-speaker', 'call-leave', 'in-call-bar');
    const dm = await resolveRoom('dm-alice-dave');
    await C.cleanupCalls([dm]);
    await loginAs(page, 'alice');
    await openNavDrawer(page);
    await navDrawer(page).getByTestId('space-item-home').tap();
    await navDrawer(page).getByTestId(`dm-item-${dm}`).tap();
    await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
    const dave = await secondContext(browser, 'dave');
    try {
      await waitForStatus(dave.page);
      await page.getByTestId('header-call').tap();
      await expect(C.callScreen(page)).toHaveAttribute('data-state', 'calling');
      await expect(C.incomingCard(dave.page)).toBeVisible({ timeout: 10_000 });
      await phoneShot(page, 14, 'calling');
      await dave.page.getByTestId('incoming-call-accept').click();
      await expect(C.callScreen(page)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
      const vp = page.viewportSize()!;
      const screen = await box(C.callScreen(page), 'call-screen');
      expect(screen.width).toBeGreaterThanOrEqual(vp.width - 1);
      for (const id of ['call-mute', 'call-speaker', 'call-leave']) await expectTapTarget(page.getByTestId(id), id, 56);
      await phoneShot(page, 14, 'connected');
      await page.getByTestId('call-minimise').tap();
      await expect(page.getByTestId('in-call-bar')).toContainText(/In call \d{2}:\d{2}/);
      await phoneShot(page, 14, 'in-call-bar');
      await page.getByTestId('in-call-bar').tap();
      await page.getByTestId('call-leave').tap();
      await expect(C.callScreen(page)).toHaveCount(0, { timeout: 10_000 });
      await expect(C.callLines(page, 'ended').last()).toContainText('Call ended', { timeout: 15_000 });
      await phoneShot(page, 14, 'call-ended');
    } finally {
      await C.cleanupCalls([dm], [page, dave.page]);
      await dave.close();
    }
  });
});
