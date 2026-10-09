/**
 * QA-20 — phone GIF suite, the `mobile` Playwright project (Pixel 7, 412x839, touch).
 *
 * Covers the phone-only Phase 4 criteria — AC-G9-1..4 (the bottom sheet: variant, geometry, two
 * columns, backdrop, 44 px targets, 16 px input font), the AC-G7-1 send flow through a tap, and the
 * `klipy` path once on touch — plus the phone halves of AC-G4-1 and AC-G4-7.
 *
 * Conventions from `e2e/fixtures/mobile.ts` (QA-8): taps go through `locator.tap()`, geometry is
 * measured only after `settleAnimations`. Dirty-seed safe exactly as `gif.spec.ts`: everything is in
 * **#dev**, every test sends its own messages and asserts on ids it created.
 *
 * AC-G9-2's Android-back half (back closes the sheet before the drawers) is **device-only** —
 * `@capacitor/app` back-button events are not dispatched in Chromium. It is on the docs/BUGS.md
 * stakeholder checklist.
 *
 * Wave 11: each test declares the UI entry point it needs (`requireGifUi`, probed in touch mode) and
 * skips with a `not-built` annotation rather than failing while Dev A / Dev B are implementing. The
 * quota guard (AC-G11-3) is installed in every test, as on desktop.
 */
import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { resolveRoom } from './fixtures/seed.ts';
import { annotate } from './fixtures/state.ts';
import { messageList } from './fixtures/ui.ts';
import {
  TAP_TARGET,
  box,
  computed,
  drawerState,
  expectTapTarget,
  isPhoneLayout,
  settleAnimations,
  tapRoom,
} from './fixtures/mobile.ts';
import {
  composerGif,
  expectGifPlaying,
  expectGridIds,
  expectGifFieldShape,
  expectMockGifEvent,
  expectProvider,
  FAKE_KEY,
  gifAttribution,
  gifBackdrop,
  gifClose,
  gifError,
  gifEventFor,
  gifGrid,
  gifHeading,
  gifItem,
  gifPending,
  gifPicker,
  gifRowById,
  gifSearch,
  gridIds,
  guardGifNetwork,
  klipyPreviewUrl,
  klipyResultId,
  klipySendUrl,
  messageGif,
  messageGifBadge,
  messageGifImg,
  MOCK_GIFS,
  MOCK_IDS,
  mockGifUrl,
  mockSearch,
  queryMatching,
  requireGifFixtures,
  requireGifUi,
  resetGifSession,
  stubKlipy,
  stubKlipyCdn,
  useGifProvider,
  type KlipyItemSpec,
  type NetworkGuard,
} from './fixtures/gif.ts';
import { settledEventId, row } from './fixtures/ui.ts';

const ORIGIN = 'http://localhost:5173';

let DEV = '';

/** Derived so a catalogue change cannot break the spec (see `e2e/fixtures/gif.ts`). */
const MULTI_QUERY = queryMatching(2, ['cat', 'party', 'taco', 'tacos']) ?? 'cat';

test.beforeAll(async () => {
  DEV = await resolveRoom('dev');
});

/** Quota guard + provider override + alice in #dev on the phone layout. */
async function startPhone(
  provider: 'mock' | 'klipy',
  page: Parameters<typeof loginAs>[0],
  opts: { key?: string; stub?: boolean } = {},
): Promise<NetworkGuard> {
  const guard = guardGifNetwork(page);
  await useGifProvider(page, provider, opts);
  await resetGifSession(page);
  await loginAs(page, 'alice');
  expect(await isPhoneLayout(page), 'this spec only runs in the mobile project').toBe(true);
  // #general opens by default; move to #dev through the drawer, as a user would
  // (`tapRoom` opens the drawer, taps the row and waits for it to close itself).
  await tapRoom(page, DEV);
  await expect(messageList(page)).toBeVisible();
  return guard;
}

/** Taps `composer-gif` and waits for the sheet. */
async function openSheet(page: Parameters<typeof loginAs>[0]): Promise<void> {
  await expect(composerGif(page)).toBeVisible();
  await composerGif(page).tap();
  await expect(gifPicker(page)).toBeVisible();
  await settleAnimations(gifPicker(page));
}

test.describe('GIF sheet — mock provider (QA-20)', () => {
  test('AC-G9-1/G4-1/G4-7 — the GIF button opens a bottom sheet: variant, geometry, 2 columns, backdrop', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid'], { touch: true });
    const guard = await startPhone('mock', page);

    // AC-G6-1 / AC-V6-1: the button is a real tap target.
    await expectTapTarget(composerGif(page), 'composer-gif');

    await openSheet(page);
    const picker = gifPicker(page);

    // AC-G9-1: the sheet variant, full width, anchored to the shell's bottom.
    await expect(picker).toHaveAttribute('data-variant', 'sheet');
    await expectProvider(page, 'mock');
    await expect(picker).toHaveAttribute('role', 'dialog');
    await expect(gifBackdrop(page), 'the phone sheet has a backdrop behind it').toBeVisible();

    const sheetBox = await box(picker, 'gif-picker');
    const shellBox = await box(page.getByTestId('app-shell'), 'app-shell');
    const viewport = page.viewportSize()!;
    expect(
      Math.abs(sheetBox.width - viewport.width),
      'the sheet spans the viewport width',
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(sheetBox.y + sheetBox.height - (shellBox.y + shellBox.height)),
      "the sheet's bottom edge sits on the shell's bottom edge (safe area)",
    ).toBeLessThanOrEqual(4);
    const heightPct = (sheetBox.height / viewport.height) * 100;
    expect(heightPct, `the sheet is 55-85 % of the viewport, got ${heightPct.toFixed(1)} %`).toBeGreaterThanOrEqual(55);
    expect(heightPct).toBeLessThanOrEqual(85);

    // AC-G4-1 phone half: trending, every fixture, catalogue order.
    await expect(gifHeading(page)).toHaveText('Trending');
    await expectGridIds(page, MOCK_IDS);
    await expect(gifAttribution(page)).toHaveText('Mock GIFs (no key)');
    await expect(gifSearch(page)).toHaveAttribute('placeholder', 'Search GIFs');

    // AC-G9-1: two columns. Measured from the tiles' x positions, not from CSS.
    const columns = await gifGrid(page)
      .locator('[data-testid^="gif-item-"]')
      .evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().x))).size);
    expect(columns, 'the sheet grid is 2 columns wide').toBe(2);

    // AC-G9-1 / AC-G9-3: tap targets and the no-zoom input font.
    await expectTapTarget(gifClose(page), 'gif-close');
    await expectTapTarget(gifItem(page, MOCK_IDS[0]!), `gif-item-${MOCK_IDS[0]}`);
    const fontSize = Number.parseFloat(await computed(gifSearch(page), 'font-size'));
    expect(fontSize, 'gif-search needs a >= 16 px font so iOS/Android do not zoom in').toBeGreaterThanOrEqual(16);

    guard.assertClean();
  });

  test('AC-G9-2 — the backdrop and gif-close both dismiss the sheet without sending', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker'], { touch: true });
    const guard = await startPhone('mock', page);

    const before = await messageList(page).locator('[data-testid^="message-$"]').count();

    await openSheet(page);
    await gifBackdrop(page).tap();
    await expect(gifPicker(page), 'tapping the backdrop closes the sheet').toBeHidden();

    await openSheet(page);
    await gifClose(page).tap();
    await expect(gifPicker(page), 'gif-close closes the sheet').toBeHidden();

    // AC-G9-2: opening the sheet leaves no drawer open behind it.
    await openSheet(page);
    expect(
      await drawerState(page),
      'opening the GIF sheet leaves no drawer open behind it',
    ).toEqual({ nav: 'false', members: 'false' });
    await gifClose(page).tap();
    await expect(gifPicker(page)).toBeHidden();

    expect(
      await messageList(page).locator('[data-testid^="message-$"]').count(),
      'opening and dismissing the sheet sends nothing',
    ).toBe(before);
    annotate(
      'manual',
      'AC-G9-2 Android back (the sheet closes before the drawers) is device-only: @capacitor/app back events are not dispatched in Chromium. On the docs/BUGS.md checklist.',
    );
    guard.assertClean();
  });

  test('AC-G9-3/G7-1/G8-1 — tapping a tile sends the GIF and renders it inline', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid', 'message-gif'], {
      touch: true,
    });
    requireGifFixtures(test);
    const guard = await startPhone('mock', page);

    await openSheet(page);
    await expectGridIds(page, MOCK_IDS);
    const target = MOCK_GIFS[0]!;
    await gifItem(page, target.id).tap();
    await expect(gifPicker(page), 'the sheet closes as soon as a tile is tapped').toBeHidden();

    const sawPending = await gifPending(page)
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    annotate(
      'gif-pending',
      sawPending ? 'the `Sending GIF...` chip was observed' : 'the chip acked faster than Playwright could sample it',
    );

    const sent = gifRowById(page, target.id);
    await expect(sent.first()).toBeVisible({ timeout: 15_000 });
    await expect(gifPending(page), 'the chip clears once the event is acked').toBeHidden({ timeout: 10_000 });

    const eventId = await settledEventId(sent.first());
    const gifRow = row(page, eventId);
    await expect(messageGif(gifRow)).toHaveAttribute('data-gif-id', target.id);
    await expect(await expectGifPlaying(gifRow)).toHaveAttribute('src', mockGifUrl(target.id, ORIGIN));
    await expect(messageGifBadge(gifRow)).toHaveText('GIF');
    expect(
      await messageGifImg(gifRow).evaluate((el) => (el as HTMLImageElement).naturalWidth),
      'the GIF must actually load on the phone layout',
    ).toBeGreaterThan(0);

    // The image must not overflow the phone viewport (AC-B4 / AC-V6-1 spirit).
    const imgBox = await box(messageGifImg(gifRow), 'message-gif-img');
    expect(imgBox.width, 'the GIF fits the phone width').toBeLessThanOrEqual(page.viewportSize()!.width);

    const event = await gifEventFor(DEV, eventId);
    expectMockGifEvent(event, target.id, ORIGIN);
    guard.assertClean();
  });

  test('AC-G9-4 — `/giphy <q>` + send opens the sheet pre-searched and sends nothing', async ({ page }) => {
    await requireGifUi(test, page, ['slash-gif', 'gif-grid'], { touch: true });
    const guard = await startPhone('mock', page);

    const expected = mockSearch(MULTI_QUERY).map((g) => g.id);
    const before = await messageList(page).locator('[data-testid^="message-$"]').count();
    const input = page.getByTestId('composer-input');
    await input.tap();
    await input.fill(`/giphy ${MULTI_QUERY}`);

    // On the phone the send button is the natural gesture (AC-G9-4 says "tap send").
    const send = page.getByTestId('composer-send');
    if (await send.isVisible()) await send.tap();
    else await input.press('Enter');

    await expect(gifPicker(page)).toBeVisible();
    await expect(gifPicker(page)).toHaveAttribute('data-variant', 'sheet');
    await expect(gifSearch(page)).toHaveValue(MULTI_QUERY);
    await expect(gifHeading(page)).toHaveText(`Results for "${MULTI_QUERY}"`);
    await expectGridIds(page, expected);
    await expect(input, 'the slash command is consumed').toHaveValue('');
    // A `getByText('/giphy …')` check would be a *substring* match in a dirty room (the trap filed as
    // fixture defect #4 on desktop). Assert the dirty-seed-safe form instead: no row was added.
    expect(
      await messageList(page).locator('[data-testid^="message-$"]').count(),
      'the command itself is never sent',
    ).toBe(before);
    guard.assertClean();
  });
});

test.describe('GIF sheet — klipy provider against stubs (QA-20)', () => {
  /**
   * Ids stay **below `Number.MAX_SAFE_INTEGER`** (9007199254740991) on purpose. Klipy ids are JSON
   * numbers, so two ids that differ only above 2^53 (`9041071659142944` / `...945`) are the *same*
   * float after `JSON.parse` — two tiles then share one id and one preview url. That cost a debugging
   * round here; it is also a real (if unlikely) client limit, filed in docs/BUGS.md.
   */
  const SPECS: KlipyItemSpec[] = [
    { id: 8141071659142944, title: 'Phone stub one', w: 498, h: 498 },
    { id: 8141071659142945, title: 'Phone stub two', w: 300, h: 300 },
  ];

  test('AC-G2-1/G2-2/G3-2 — the stubbed search is hit with the key in the path and a pick sends the CDN url', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid', 'message-gif'], {
      touch: true,
    });
    requireGifFixtures(test);

    const guard = guardGifNetwork(page);
    const api = await stubKlipy(page, { items: SPECS });
    const cdn = await stubKlipyCdn(page);
    await useGifProvider(page, 'klipy', { key: FAKE_KEY });
    await resetGifSession(page);
    await loginAs(page, 'alice');
    expect(await isPhoneLayout(page)).toBe(true);
    await tapRoom(page, DEV);

    await openSheet(page);
    await expectProvider(page, 'klipy');
    await expect(gifSearch(page)).toHaveAttribute('placeholder', 'Search KLIPY');
    await expect(gifAttribution(page)).toHaveText('Powered by KLIPY');

    await gifSearch(page).tap();
    await gifSearch(page).fill('tacos');
    await expect.poll(() => api.searchRequests().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const search = api.searchRequests()[0]!;
    expect(search.key, 'the key travels as a path segment').toBe(FAKE_KEY);
    expect(new URL(search.url).pathname).toBe(`/api/v1/${FAKE_KEY}/gifs/search`);
    expect(search.params.q).toBe('tacos');

    // Stub order preserved, previews mapped to sm.webp.
    await expectGridIds(page, SPECS.map(klipyResultId));
    await expect(gifItem(page, klipyResultId(SPECS[0]!)).locator('img, video')).toHaveAttribute(
      'src',
      klipyPreviewUrl(SPECS[0]!),
    );
    await expectTapTarget(gifItem(page, klipyResultId(SPECS[0]!)), 'gif-item (klipy)', TAP_TARGET);

    const chosen = SPECS[0]!;
    await gifItem(page, klipyResultId(chosen)).tap();
    await expect(gifPicker(page)).toBeHidden();

    const sent = gifRowById(page, klipyResultId(chosen));
    await expect(sent.first()).toBeVisible({ timeout: 15_000 });
    const eventId = await settledEventId(sent.first());

    const event = await gifEventFor(DEV, eventId);
    expectGifFieldShape(event.gif, ORIGIN);
    expect(event.gif!.provider).toBe('klipy');
    expect(event.gif!.url).toBe(klipySendUrl(chosen));
    expect(new URL(String(event.gif!.url)).host).toBe('static.klipy.com');
    expect(event.gif!.w).toBe(chosen.w);
    expect(event.gif!.h).toBe(chosen.h);
    expect(event.body).toBe(`${chosen.title} ${klipySendUrl(chosen)}`);
    expect(cdn.requests.length, 'the row loaded its image from the stubbed CDN').toBeGreaterThan(0);
    guard.assertClean();
  });

  test('AC-G2-3 — an invalid key (404) shows gif-error in the sheet', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker'], { touch: true });

    const guard = guardGifNetwork(page);
    const api = await stubKlipy(page, { status: 404 });
    await stubKlipyCdn(page);
    await useGifProvider(page, 'klipy', { key: FAKE_KEY });
    await resetGifSession(page);
    await loginAs(page, 'alice');
    expect(await isPhoneLayout(page)).toBe(true);
    await tapRoom(page, DEV);

    await composerGif(page).tap();
    await expect(gifPicker(page)).toBeVisible();
    await expect(gifError(page)).toBeVisible({ timeout: 10_000 });
    await expect(gifError(page)).toHaveText(/key|invalid|could not load/i);
    expect(await gridIds(page)).toEqual([]);
    expect(api.requests[0]!.key).toBe(FAKE_KEY);

    // The sheet is still dismissible in the error state.
    await gifClose(page).tap();
    await expect(gifPicker(page)).toBeHidden();
    guard.assertClean();
  });
});
