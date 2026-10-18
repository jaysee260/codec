/**
 * Phase 7 QA-37: calls on the phone (`mobile` project, Pixel 7; AC-R8-3 at 393 px). docs/PHASE7_ACCEPTANCE.md
 * AC-R5-6, AC-R6-4 (phone), AC-R8-3, AC-R9-1. Android back (AC-R5-6 / R9-2) is device-only: docs/BUGS.md "Phase 7".
 *
 * alice is the phone (`page`, taps only); dave is a desktop second context or an API caller (`ringAlice`: a fake
 * membership + the Codec ring), in the seed's encrypted DM `dm-alice-dave`. `navigator.vibrate` is stubbed before the
 * first navigation; the speakerphone shim is stubbed through `__matrixPoc.call.rtc.setSpeakerphone` (assignable).
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { resolveRoom, userId } from './fixtures/seed.ts';
import { e2eeAfterEach, requireUi, secondContext, waitForStatus, type SecondContext } from './fixtures/e2ee.ts';
import { box, expectTapTarget, navDrawer, openNavDrawer, closeNavDrawer, settleAnimations } from './fixtures/mobile.ts';
import {
  callHook,
  callScreen,
  cleanupCalls,
  connectedWith,
  incomingCard,
  requireRtc,
  ringAlice,
  speakerCalls,
  stubSpeakerphone,
  stubVibrate,
  vibrateCalls,
  waitForCallState,
} from './fixtures/call.ts';

test.describe.configure({ mode: 'default', timeout: 120_000 }); // one worker, file order (fullyParallel: false); a failure does not skip the rest

const DAVE = userId('dave');
const R = { dm: '' };
const contexts: SecondContext[] = [];
const BIG = 56;

test.beforeAll(async () => {
  R.dm = await resolveRoom('dm-alice-dave');
});

test.beforeEach(async () => {
  await requireRtc(test);
  await cleanupCalls([R.dm]);
});

test.afterEach(async ({ page }, info) => {
  await cleanupCalls([R.dm], [page, ...contexts.map((c) => c.page)]);
  contexts.length = 0;
  await e2eeAfterEach(page, info);
});

async function phoneDm(page: Page): Promise<void> {
  await stubVibrate(page);
  await loginAs(page, 'alice');
  await waitForStatus(page);
  await openNavDrawer(page);
  await navDrawer(page).getByTestId('space-item-home').tap();
  await expect(navDrawer(page).getByTestId('dm-list')).toBeVisible();
  await navDrawer(page).getByTestId(`dm-item-${R.dm}`).tap();
  await expect(navDrawer(page)).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('message-list')).toBeVisible();
}

async function daveDesktop(browser: import('@playwright/test').Browser): Promise<SecondContext> {
  const c = await secondContext(browser, 'dave');
  contexts.push(c);
  await waitForStatus(c.page);
  return c;
}

const viewportOf = (page: Page): { width: number; height: number } => page.viewportSize()!;

test('AC-R5-6: the incoming card covers the viewport, 56 px Accept / Decline at the bottom, vibration with a repeating pattern', async ({ page }) => {
  requireUi('Dev B', 'incoming-call', 'incoming-call-accept', 'incoming-call-decline');
  await phoneDm(page);
  const ring = await ringAlice(R.dm, { from: 'dave' });
  const card = incomingCard(page);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await settleAnimations(card);
  const vp = viewportOf(page);
  const b = await box(card, 'incoming-call');
  expect(b.x).toBeLessThanOrEqual(1);
  expect(b.y).toBeLessThanOrEqual(1);
  expect(b.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(b.height).toBeGreaterThanOrEqual(vp.height - 1);
  for (const id of ['incoming-call-accept', 'incoming-call-decline']) {
    const t = await expectTapTarget(page.getByTestId(id), id, BIG);
    expect(t.y + t.height, `${id} sits in the bottom third`).toBeGreaterThan(vp.height * (2 / 3));
    expect(t.y + t.height, `${id} stays inside the viewport (safe area)`).toBeLessThanOrEqual(vp.height);
  }
  await expect.poll(async () => (await vibrateCalls(page)).length, { timeout: 5_000, message: 'navigator.vibrate was called' }).toBeGreaterThan(0);
  const calls = await vibrateCalls(page);
  const patterned = calls.some((c) => Array.isArray(c) && c.length >= 2) || calls.length >= 2;
  expect(patterned, `a repeating vibration pattern (calls: ${JSON.stringify(calls)})`).toBe(true);

  await page.getByTestId('incoming-call-decline').tap();
  await expect(card).toHaveCount(0, { timeout: 5_000 });
  await ring.hangUp();
});

test('AC-R9-1, R6-4 (phone): full-screen call, 56 px bottom controls, speaker toggles the shim, minimise -> bar at the top of main', async ({ page, browser }) => {
  requireUi('Dev B', 'header-call', 'call-screen', 'call-mute', 'call-speaker', 'call-leave', 'call-minimise', 'in-call-bar');
  await phoneDm(page);
  const dave = await daveDesktop(browser);
  await page.getByTestId('header-call').tap();
  await expect(incomingCard(dave.page)).toBeVisible({ timeout: 10_000 });
  await dave.page.getByTestId('incoming-call-accept').click();
  await expect(callScreen(page)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
  await waitForCallState(page, connectedWith(DAVE), 'phone connected with dave', 30_000);

  const screen = callScreen(page);
  await settleAnimations(screen);
  const shell = await box(page.getByTestId('app-shell'), 'app-shell');
  const s = await box(screen, 'call-screen');
  expect(s.x).toBeLessThanOrEqual(shell.x + 1);
  expect(s.y).toBeLessThanOrEqual(shell.y + 1);
  expect(s.width).toBeGreaterThanOrEqual(shell.width - 1);
  expect(s.height).toBeGreaterThanOrEqual(shell.height - 1);
  const vp = viewportOf(page);
  for (const id of ['call-mute', 'call-speaker', 'call-leave']) {
    const t = await expectTapTarget(page.getByTestId(id), id, BIG);
    expect(t.y, `${id} is in the bottom bar`).toBeGreaterThan(vp.height / 2);
  }

  const stubbed = await stubSpeakerphone(page);
  const speaker = page.getByTestId('call-speaker');
  const before = await speaker.getAttribute('aria-pressed');
  await speaker.tap();
  await expect(speaker).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  if (stubbed) expect((await speakerCalls(page)).length, 'the speakerphone shim was called').toBeGreaterThan(0);
  else test.info().annotations.push({ type: 'core-pending', description: 'no assignable rtc.setSpeakerphone: shim call not asserted' });

  await page.getByTestId('call-minimise').tap();
  await expect(screen).toBeHidden();
  const bar = page.getByTestId('in-call-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/In call \d{2}:\d{2}, tap to return/);
  const header = await box(page.getByTestId('channel-header'), 'channel-header').catch(() => null);
  const barBox = await box(bar, 'in-call-bar');
  const composer = await box(page.getByTestId('composer-input'), 'composer-input');
  expect(barBox.y, 'the phone bar is at the top of main, above the conversation').toBeLessThan(composer.y);
  if (header) expect(barBox.y, 'right under the header').toBeLessThanOrEqual(header.y + header.height + 8);
  // The composer focused (keyboard up on a device) never covers the bar: the bar stays in the viewport.
  await page.getByTestId('composer-input').tap();
  const barAfter = await box(bar, 'in-call-bar');
  expect(barAfter.y).toBeGreaterThanOrEqual(0);
  expect(barAfter.y + barAfter.height).toBeLessThanOrEqual(vp.height);
  await bar.tap();
  await expect(screen).toBeVisible();
  await page.getByTestId('call-leave').tap();
  await expect(screen).toHaveCount(0, { timeout: 5_000 });
});

test.describe('393 px', () => {
  test.use({ viewport: { width: 393, height: 851 } });

  test('AC-R8-3: "Join voice (1)" fits the phone header (>= 44 px, no overflow); the drawer row shows the indicator', async ({ page, browser }) => {
    requireUi('Dev A', 'header-join-call', 'room-call-indicator');
    await phoneDm(page);
    const dave = await daveDesktop(browser);
    await callHook(dave.page).join(R.dm);
    const chip = page.getByTestId('header-join-call');
    await expect(chip).toHaveAttribute('data-count', '1', { timeout: 15_000 });
    const c = await expectTapTarget(chip, 'header-join-call', 44);
    expect(c.x + c.width, 'the chip ends inside the 393 px viewport').toBeLessThanOrEqual(393);
    const overflow = await page.getByTestId('channel-header').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, 'the header does not overflow horizontally').toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);

    await openNavDrawer(page);
    await navDrawer(page).getByTestId('space-item-home').tap();
    await expect(navDrawer(page).getByTestId(`dm-item-${R.dm}`).getByTestId('room-call-indicator')).toBeVisible();
    await closeNavDrawer(page);
  });
});
