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
import { checkFreshSeed } from './fixtures/fresh.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { DISPLAY_NAMES, NAMES, resolveRoom, userId } from './fixtures/seed.ts';
import { annotate, ensureUnread, noteSeedDrift } from './fixtures/state.ts';
import { messageList, settledEventId } from './fixtures/ui.ts';
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
} from './fixtures/mobile.ts';

test.describe.configure({ mode: 'serial' });

const ALICE = userId('alice');
const BOB = userId('bob');
/** The seeded unread the demo script shows on `#random` (docs/SEED_DATA.md). */
const RANDOM_BADGE_ON_FRESH_SEED = 3;

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
});
