/**
 * QA-19 — desktop GIF suite, AC-G1 .. AC-G8 (docs/archive/PHASE4_ACCEPTANCE.md).
 *
 * ## Dirty-seed contract
 * Everything happens in **#dev** (never #general, which the smoke demo owns) and every test sends
 * its own messages, locating them by the event id it just created. Nothing needs a fresh seed and
 * nothing asserts an absolute row count.
 *
 * ## Why tests can skip (Wave 11)
 * Dev A (`src/features/gif/**`) and Dev B (`src/features/conversation/**`) are implementing while
 * this suite runs, so each test declares the entry point it needs via `requireGifUi` and skips with
 * a `not-built` annotation when it is absent. A test that *runs* and fails is therefore a real bug
 * or a test defect, never "not implemented yet". The fixture-serving criterion (AC-G1-3) needs no UI
 * and always runs.
 *
 * ## Quota guard (AC-G11-3)
 * Every test installs `guardGifNetwork` first. An unstubbed request to `api.klipy.com` is aborted
 * and **fails** the test: a Klipy test key allows 100 requests an hour, so a suite that leaks would
 * burn the stakeholder's quota. Requests to `static.klipy.com` are *served* from the local fixture
 * bytes instead of failing, because the `klipy` criteria must post real messages whose url is on the
 * Klipy CDN (AC-G3-2) and every later test that opens #dev then renders those rows — see the guard's
 * own docstring. Either way nothing leaves the machine, which is what AC-G11-3 is for.
 *
 * ## Deviations from the criteria text, recorded on purpose
 *  - Mock expectations are **derived** from `src/lib/gif/mock-fixtures.ts` rather than hard-coded
 *    from the acceptance table: the two were realigned repeatedly during Wave 11 and still disagree
 *    on individual titles. The search *semantics* (case-insensitive title substring, API order) and
 *    the wire contract are asserted literally; only the data comes from the catalogue. A doc/code
 *    mismatch is reported as a `catalogue-drift` annotation by AC-G1-3.
 *  - AC-G7-1's `gif-pending` chip is transient on the mock path (a pick acks in milliseconds), so the
 *    desktop test holds the `send` request open for 800 ms with `page.route` and then hard-asserts
 *    both that the chip shows and that it clears. The phone test keeps the softer annotation form, so
 *    the chip is proven once rather than twice.
 *  - "within 3 s / 5 s" criteria poll for up to 10 s: sync delivery on this homeserver jitters under
 *    load and the criterion is about the update arriving without a reload.
 *  - AC-G2-4 (debounce) is asserted as "typing a word sends at most 2 search requests", not exactly
 *    one: `fill()` is a single input event, so a literal one-request assertion would pass even
 *    without a debounce and prove nothing.
 *  - AC-G8-3 (offscreen unmount) and AC-G8-4 (reduced motion) have **no dedicated test** in this
 *    pass — they are DEV-B-25's P1 halves and were not in the QA-19 brief. The offscreen half is
 *    exercised incidentally (`expectGifPlaying` depends on the row leaving `offscreen`, and desktop
 *    demo step 12 row 4 asserts the placeholder when the row does go out of view). Both are recorded
 *    as not-covered in docs/BUGS.md "Phase 4 criteria this pass cannot judge".
 */
import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import {
  catalogueDrift,
  composerGif,
  expectGifPlaying,
  expectGridIds,
  expectMockGifEvent,
  expectProvider,
  expectGifFieldShape,
  FAKE_KEY,
  gifAttribution,
  gifClose,
  gifEmpty,
  gifError,
  gifErrorRetry,
  gifEventFor,
  gifGrid,
  gifHeading,
  gifItem,
  gifPending,
  gifPicker,
  gifRowById,
  gifSearch,
  gridIds,
  gridIndexes,
  guardGifNetwork,
  klipyPreviewUrl,
  klipyResultId,
  klipySendUrl,
  KLIPY_CONTENT_FILTER,
  KLIPY_PER_PAGE,
  messageGif,
  messageGifBadge,
  MOCK_EMPTY_QUERY,
  MOCK_ERROR_QUERY,
  MOCK_GIFS,
  MOCK_IDS,
  mockGifUrl,
  mockSearch,
  mockStillUrl,
  NO_MATCH_QUERY,
  openGifPicker,
  openGifPickerBySlash,
  pickGif,
  queryMatching,
  requireGifFixtures,
  requireGifUi,
  resetGifSession,
  searchInPicker,
  selectedGifId,
  sendGifMessage,
  stubKlipy,
  stubKlipyCdn,
  useGifProvider,
  type KlipyItemSpec,
  type NetworkGuard,
} from './fixtures/gif.ts';
import { fixtureGifBytes, describeGif } from './fixtures/gif-assets.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { resolveRoom } from './fixtures/seed.ts';
import { workerOrigin } from './fixtures/pool.ts';
import { annotate } from './fixtures/state.ts';
import { composer, messageList, openChannel, row, rowByText, settledEventId } from './fixtures/ui.ts';

/** The app's origin, as the mock provider builds its URLs from `location.origin`. */
const ORIGIN = workerOrigin();

let DEV = '';
let bob: ApiUser;

/** The query the single-result criteria use, and the fixture it must resolve to. */
const SINGLE_QUERY = 'typing';
/** A query matching more than one fixture (derived, so a catalogue change cannot break it). */
const MULTI_QUERY = queryMatching(2, ['cat', 'party', 'taco', 'tacos']) ?? 'cat';

test.beforeAll(async () => {
  DEV = await resolveRoom('dev');
  bob = await asUser('bob');
});

/**
 * Installs the quota guard, forces a provider and lands alice in #dev. The guard is returned so the
 * test can assert it stayed clean; `stubKlipy*` calls must come *after* it (route order).
 */
async function startAs(
  provider: 'mock' | 'klipy',
  page: Parameters<typeof loginAs>[0],
  opts: { key?: string } = {},
): Promise<NetworkGuard> {
  const guard = guardGifNetwork(page);
  await useGifProvider(page, provider, opts);
  await resetGifSession(page);
  await loginAs(page, 'alice');
  await openChannel(page, DEV);
  return guard;
}

test.describe('GIF picker — mock provider (QA-19)', () => {
  test('AC-G1-3 — the mock fixtures are served as animated GIF89a with the catalogue dimensions', async ({
    request,
  }) => {
    const drift = catalogueDrift();
    if (drift) {
      annotate(
        'catalogue-drift',
        `src/lib/gif/mock-fixtures.ts and docs/archive/PHASE4_ACCEPTANCE.md disagree (${drift}). This suite derives its expectations from the code, so it is green either way — the doc needs reconciling (docs/BUGS.md).`,
      );
    }
    requireGifFixtures(test);

    expect(MOCK_GIFS.length, 'the catalogue is not empty').toBeGreaterThan(0);

    for (const gif of MOCK_GIFS) {
      const res = await request.get(`/gif-fixtures/${gif.id}.gif`);
      expect(res.status(), `/gif-fixtures/${gif.id}.gif must be served by the dev server`).toBe(200);
      expect(
        res.headers()['content-type'],
        `${gif.id}.gif must be served as image/gif so <img> animates it`,
      ).toContain('image/gif');

      const bytes = new Uint8Array(await res.body());
      const info = describeGif(bytes);
      expect(info.magic, `${gif.id}.gif must start with GIF89a`).toBe('GIF89a');
      expect(info.width, `${gif.id}.gif width must match the catalogue`).toBe(gif.w);
      expect(info.height, `${gif.id}.gif height must match the catalogue`).toBe(gif.h);
      expect(
        info.imageDescriptors,
        `${gif.id}.gif must be animated (>= 2 frames), got ${info.imageDescriptors}`,
      ).toBeGreaterThanOrEqual(2);
      // The bytes on disk are what the stubbed CDN re-serves, so they must agree.
      expect(Buffer.from(bytes).equals(fixtureGifBytes(gif.id))).toBe(true);
    }

    // `stillUrl` points at `<id>.png`; the reduced-motion row cannot work without them.
    const missingStills: string[] = [];
    for (const gif of MOCK_GIFS) {
      const res = await request.get(`/gif-fixtures/${gif.id}.png`);
      if (res.status() !== 200) missingStills.push(`${gif.id}.png`);
    }
    expect(
      missingStills,
      'the mock provider sets stillUrl to <id>.png and buildGifContent copies it onto the wire, so a 404 there means every reduced-motion row (AC-G8-4) renders a broken image. Run `npm run gif:fixtures` (PRIN-13).',
    ).toEqual([]);
  });

  test('AC-G4-1/G4-7/G6-1/G6-2 — the GIF button opens a trending popover with every fixture in order', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid']);
    const guard = await startAs('mock', page);

    // AC-G6-1: the button sits between attach and the input.
    await expect(composerGif(page)).toBeVisible();
    await expect(composerGif(page)).toHaveAttribute('title', /gif/i);
    const order = await page
      .getByTestId('composer')
      .locator('[data-testid="composer-attach"], [data-testid="composer-gif"], [data-testid="composer-input"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(order, 'composer-gif sits between composer-attach and composer-input').toEqual([
      'composer-attach',
      'composer-gif',
      'composer-input',
    ]);

    const before = await messageList(page).locator('[data-testid^="message-$"]').count();
    const picker = await openGifPicker(page);

    // AC-G6-2 / AC-G4-1
    await expect(picker).toHaveAttribute('data-variant', 'popover');
    await expectProvider(page, 'mock');
    await expect(picker).toHaveAttribute('role', 'dialog');
    await expect(picker).toHaveAttribute('aria-label', 'GIF picker');
    await expect(gifHeading(page)).toHaveText('Trending');
    await expect(gifSearch(page)).toBeFocused();
    await expect(gifSearch(page)).toHaveValue('');
    await expect(gifClose(page)).toBeVisible();

    // AC-G4-7: mock copy.
    await expect(gifSearch(page)).toHaveAttribute('placeholder', 'Search GIFs');
    await expect(gifAttribution(page)).toHaveText('Mock GIFs (no key)');

    // AC-G4-1 / AC-G4-3: every fixture, in catalogue order, with data-index following it.
    await expectGridIds(page, MOCK_IDS);
    expect(await gridIndexes(page)).toEqual(MOCK_IDS.map((_, i) => String(i)));
    for (const gif of MOCK_GIFS) {
      const tile = gifItem(page, gif.id);
      await expect(tile).toHaveAttribute('role', 'option');
      await expect(tile).toHaveAttribute('aria-label', gif.title);
      await expect(tile).toHaveAttribute('data-w', String(gif.w));
      await expect(tile).toHaveAttribute('data-h', String(gif.h));
    }

    // AC-G6-2: the popover sits above the composer, left-aligned, within 8 px.
    const pickerBox = (await picker.boundingBox())!;
    const composerBox = (await page.getByTestId('composer').boundingBox())!;
    expect(
      Math.abs(pickerBox.y + pickerBox.height - composerBox.y),
      'the popover bottom edge is within 8 px of the composer top',
    ).toBeLessThanOrEqual(8);
    expect(Math.abs(pickerBox.x - composerBox.x), 'left edges align within 8 px').toBeLessThanOrEqual(8);

    // Opening the picker sends nothing.
    expect(await messageList(page).locator('[data-testid^="message-$"]').count()).toBe(before);
    guard.assertClean();
  });

  test('AC-G6-3/G4-2/G4-4 — `/gif <q>` opens pre-searched, sends nothing, and typing re-searches', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['slash-gif', 'gif-grid']);
    const guard = await startAs('mock', page);

    const single = mockSearch(SINGLE_QUERY);
    expect(single.length, `the catalogue must have at least one "${SINGLE_QUERY}" match`).toBeGreaterThan(0);

    await openGifPickerBySlash(page, `/gif ${SINGLE_QUERY}`);
    await expect(gifSearch(page)).toHaveValue(SINGLE_QUERY);
    await expect(gifHeading(page)).toHaveText(`Results for "${SINGLE_QUERY}"`);
    await expectGridIds(page, single.map((g) => g.id));

    // Nothing was sent: no row carries the command text.
    await expect(rowByText(page, `/gif ${SINGLE_QUERY}`)).toHaveCount(0);

    // AC-G4-4: typing a different query re-searches; clearing returns to Trending.
    await searchInPicker(page, MULTI_QUERY);
    await expectGridIds(page, mockSearch(MULTI_QUERY).map((g) => g.id));
    await expect(gifHeading(page)).toHaveText(`Results for "${MULTI_QUERY}"`);
    await searchInPicker(page, '');
    await expect(gifHeading(page)).toHaveText('Trending');
    await expectGridIds(page, MOCK_IDS);
    guard.assertClean();
  });

  test('AC-G6-3 — `/giphy` and `/GIPHY` are aliases, and a bare `/gif` opens on Trending', async ({ page }) => {
    await requireGifUi(test, page, ['slash-gif', 'gif-grid']);
    const guard = await startAs('mock', page);
    const before = await messageList(page).locator('[data-testid^="message-$"]').count();

    await openGifPickerBySlash(page, `/giphy ${MULTI_QUERY}`);
    await expect(gifSearch(page)).toHaveValue(MULTI_QUERY);
    await expectGridIds(page, mockSearch(MULTI_QUERY).map((g) => g.id));
    await page.keyboard.press('Escape');
    await expect(gifPicker(page)).toBeHidden();

    // Case-insensitive.
    await openGifPickerBySlash(page, `/GIPHY ${MULTI_QUERY}`);
    await expect(gifSearch(page)).toHaveValue(MULTI_QUERY);
    await page.keyboard.press('Escape');
    await expect(gifPicker(page)).toBeHidden();

    // Bare command = trending.
    await openGifPickerBySlash(page, '/gif');
    await expect(gifHeading(page)).toHaveText('Trending');
    await expectGridIds(page, MOCK_IDS);

    // `rowByText(page, '/gif')` would be a *substring* match and #dev is dirty — the AC-G6-4 test
    // legitimately leaves `/gifs ...` and `/ gif ...` rows behind. Assert the dirty-seed-safe form:
    // three opens and three Escapes added no row at all.
    expect(
      await messageList(page).locator('[data-testid^="message-$"]').count(),
      'opening the picker through /gif and /giphy sends nothing',
    ).toBe(before);
    guard.assertClean();
  });

  test('AC-G6-4 — `/gifs`, `/giffy` and `/ gif` are ordinary text, not triggers', async ({ page }) => {
    await requireGifUi(test, page, ['slash-gif']);
    const guard = await startAs('mock', page);

    for (const text of [`/gifs ${MULTI_QUERY}`, '/giffy', `/ gif ${MULTI_QUERY}`]) {
      const body = `${text} ${Date.now().toString(36)}`;
      await composer(page).click();
      await composer(page).fill(body);
      await composer(page).press('Enter');
      const sent = rowByText(page, body);
      await expect(sent, `"${text}" must be sent as plain text`).toBeVisible({ timeout: 15_000 });
      await expect(gifPicker(page), `"${text}" must not open the picker`).toHaveCount(0);
      const id = await settledEventId(sent);
      const event = await gifEventFor(DEV, id);
      expect(event.body).toBe(body);
      expect(event.gif, 'a non-trigger message carries no GIF field').toBeUndefined();
    }
    guard.assertClean();
  });

  test('AC-G7-1/G3-1/G8-1 — picking a tile sends the contract event and renders it inline', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid', 'message-gif']);
    requireGifFixtures(test);
    const guard = await startAs('mock', page);

    // AC-G7-1 wants the `Sending GIF...` chip *observed*, not merely gone. A mock pick acks in a few
    // milliseconds, so sampling for it is a race: hold the send for 800 ms (browser-side only — the
    // homeserver never sees a delay) and the chip becomes deterministic enough to hard-assert.
    await page.route('**/_matrix/client/v3/rooms/*/send/m.room.message/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });

    await openGifPicker(page);
    await expectProvider(page, 'mock');
    const target = MOCK_GIFS.find((g) => g.id === MOCK_IDS[3]) ?? MOCK_GIFS[0]!;
    await expectGridIds(page, MOCK_IDS);
    await pickGif(page, target.id);

    // AC-G7-1: the chip shows while the send is in flight (held open by the route above).
    await expect(
      gifPending(page),
      'the `Sending GIF...` chip must show while the event is in flight',
    ).toBeVisible();
    await expect(gifPending(page)).toHaveText(/sending gif/i);
    // AC-G7-3: one GIF in flight per composer.
    await expect(composerGif(page), 'composer-gif is disabled while a GIF is in flight').toBeDisabled();

    const sent = gifRowById(page, target.id);
    await expect(sent.first()).toBeVisible({ timeout: 10_000 });
    await expect(gifPending(page), 'the chip clears once the event is acked').toBeHidden({ timeout: 10_000 });
    await expect(composer(page), 'focus returns to the composer after a pick').toBeFocused();

    const eventId = await settledEventId(sent.first());
    const gifRow = row(page, eventId);

    // AC-G8-1: the rendered row.
    await expect(messageGif(gifRow)).toHaveAttribute('data-provider', 'mock');
    await expect(messageGif(gifRow)).toHaveAttribute('data-gif-id', target.id);
    const img = await expectGifPlaying(gifRow);
    await expect(img).toHaveAttribute('src', mockGifUrl(target.id, ORIGIN));
    await expect(img).toHaveAttribute('alt', target.title);
    await expect(messageGifBadge(gifRow)).toHaveText('GIF');
    // The image really decoded (a broken <img> has naturalWidth 0). Polled: right after mount the decode may not
    // have finished yet, which a busy dev server makes visible (BUG-22).
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        message: 'the GIF must actually load from the dev server',
      })
      .toBeGreaterThan(0);
    // AC-G8-1: the raw body is not rendered as text beside the image, and `message-body` is not a
    // link (the criterion allows the element to exist — it must just not show the url).
    await expect(gifRow.locator('[data-testid="message-body"] a')).toHaveCount(0);
    expect(
      (await gifRow.innerText()).includes(mockGifUrl(target.id, ORIGIN)),
      'the GIF row must not print the url as text next to the image',
    ).toBe(false);

    // AC-G3-1: the wire contract, read back over the raw API.
    const event = await gifEventFor(DEV, eventId);
    expectMockGifEvent(event, target.id, ORIGIN);
    expectGifFieldShape(event.gif, ORIGIN);
    expect(event.gif!.stillUrl).toBe(mockStillUrl(target.id, ORIGIN));
    expect(String(event.body).split(/\s+/).pop(), 'the url is the last token so Element unfurls it').toBe(
      mockGifUrl(target.id, ORIGIN),
    );
    expect(event.relatesTo, 'a channel pick carries no thread relation').toBeUndefined();
    guard.assertClean();
  });

  test('AC-G4-5 — an unmatched query shows the empty state, a reserved query shows it too', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid']);
    const guard = await startAs('mock', page);

    await openGifPicker(page);
    await searchInPicker(page, NO_MATCH_QUERY);
    await expect(gifEmpty(page)).toBeVisible({ timeout: 10_000 });
    await expect(gifEmpty(page)).toHaveText(`No GIFs for "${NO_MATCH_QUERY}"`);
    expect(await gridIds(page), 'the grid is empty in the empty state').toEqual([]);

    await searchInPicker(page, MOCK_EMPTY_QUERY);
    await expect(gifEmpty(page)).toBeVisible({ timeout: 10_000 });
    await expect(gifEmpty(page)).toHaveText(`No GIFs for "${MOCK_EMPTY_QUERY}"`);

    // Recovering from the empty state needs no retry.
    await searchInPicker(page, MULTI_QUERY);
    await expectGridIds(page, mockSearch(MULTI_QUERY).map((g) => g.id));
    await expect(gifEmpty(page)).toHaveCount(0);
    guard.assertClean();
  });

  test('AC-G4-5 — the reserved error query shows gif-error and Retry recovers', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid']);
    const guard = await startAs('mock', page);

    await openGifPicker(page);
    await searchInPicker(page, MOCK_ERROR_QUERY);
    await expect(gifError(page), `"${MOCK_ERROR_QUERY}" must surface the error state`).toBeVisible({
      timeout: 10_000,
    });
    await expect(gifErrorRetry(page)).toBeVisible();

    // Retry re-runs the same (still failing) request, so the error stays; a *new* query recovers.
    await gifErrorRetry(page).click();
    await expect(gifError(page)).toBeVisible();
    await searchInPicker(page, MULTI_QUERY);
    await expect(gifError(page)).toHaveCount(0, { timeout: 10_000 });
    await expectGridIds(page, mockSearch(MULTI_QUERY).map((g) => g.id));
    guard.assertClean();
  });

  test('AC-G5-1/G5-2/G5-3 — arrows move the selection and Enter picks the selected tile', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['slash-gif', 'gif-grid', 'message-gif']);
    const guard = await startAs('mock', page);

    const multi = mockSearch(MULTI_QUERY);
    test.skip(multi.length < 2, `the catalogue needs >= 2 matches for "${MULTI_QUERY}" to test arrows`);

    await openGifPickerBySlash(page, `/gif ${MULTI_QUERY}`);
    await expectGridIds(page, multi.map((g) => g.id));

    // AC-G5-3: results for an initialQuery pre-select index 0, so Enter alone sends.
    await expect(gifItem(page, multi[0]!.id)).toHaveAttribute('data-selected', 'true');
    await expect(gifGrid(page)).toHaveAttribute('aria-activedescendant', /.+/);

    // AC-G5-1: ArrowRight moves by one, clamped at the end.
    await page.keyboard.press('ArrowRight');
    expect(await selectedGifId(page), 'ArrowRight selects the next tile').toBe(multi[1]!.id);
    await expect(gifItem(page, multi[0]!.id)).toHaveAttribute('data-selected', 'false');
    await page.keyboard.press('ArrowLeft');
    expect(await selectedGifId(page)).toBe(multi[0]!.id);
    await page.keyboard.press('ArrowLeft');
    expect(await selectedGifId(page), 'the selection clamps at index 0').toBe(multi[0]!.id);

    // AC-G5-2: Enter picks the selected tile.
    await page.keyboard.press('ArrowRight');
    const chosen = multi[1]!;
    await page.keyboard.press('Enter');
    await expect(gifPicker(page)).toBeHidden();

    const sent = gifRowById(page, chosen.id);
    await expect(sent.first()).toBeVisible({ timeout: 10_000 });
    const eventId = await settledEventId(sent.first());
    const event = await gifEventFor(DEV, eventId);
    expectMockGifEvent(event, chosen.id, ORIGIN);
    guard.assertClean();
  });

  test('AC-G6-5 — Escape and a click outside close the picker without sending', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker']);
    const guard = await startAs('mock', page);

    const before = await messageList(page).locator('[data-testid^="message-$"]').count();

    await openGifPicker(page);
    await page.keyboard.press('Escape');
    await expect(gifPicker(page)).toBeHidden();
    await expect(composer(page), 'the composer is empty and focused after Escape').toHaveValue('');
    await expect(composer(page)).toBeFocused();

    await openGifPicker(page);
    await expect(gifPicker(page)).toBeVisible();
    // Click well away from the picker and the composer.
    await page.getByTestId('channel-header').click({ position: { x: 5, y: 5 } });
    await expect(gifPicker(page), 'clicking outside closes the picker').toBeHidden();
    await expect(composer(page)).toHaveValue('');

    // gif-close too.
    await openGifPicker(page);
    await gifClose(page).click();
    await expect(gifPicker(page)).toBeHidden();

    expect(
      await messageList(page).locator('[data-testid^="message-$"]').count(),
      'opening and closing the picker three times sends nothing',
    ).toBe(before);
    guard.assertClean();
  });

  test('AC-G8-6 — a reply to a GIF quotes it as `[gif] <title>`', async ({ page }) => {
    await requireGifUi(test, page, ['message-gif']);
    const guard = await startAs('mock', page);

    const target = MOCK_GIFS[0]!;
    const sent = await sendGifMessage(bob, DEV, { id: target.id, origin: ORIGIN });
    const gifRow = row(page, sent.eventId);
    await expect(gifRow).toBeVisible({ timeout: 20_000 });
    await gifRow.scrollIntoViewIfNeeded();
    await expect(messageGif(gifRow)).toBeVisible();

    await gifRow.hover();
    await gifRow.getByTestId('message-actions').getByTestId('message-action-reply').click();
    await expect(page.getByTestId('composer-reply-banner')).toBeVisible();

    const replyBody = `quoting the gif ${Date.now().toString(36)}`;
    await composer(page).fill(replyBody);
    await composer(page).press('Enter');

    const replyRow = rowByText(page, replyBody);
    await expect(replyRow).toBeVisible({ timeout: 15_000 });
    await expect(
      replyRow.getByTestId('message-reply-quote'),
      'previewText renders a GIF as `[gif] <title>`',
    ).toContainText(`[gif] ${target.title}`);
    guard.assertClean();
  });

  test('AC-G3-4 — a forged `dev.matrixpoc.gif` renders as plain text, never as an image', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['message-gif']);
    const guard = await startAs('mock', page);

    const stamp = Date.now().toString(36);
    const forged: Array<{ label: string; opts: Parameters<typeof sendGifMessage>[2] }> = [
      {
        label: 'a disallowed host',
        opts: { overrides: { url: 'https://evil.example/tracker.gif' } },
      },
      {
        label: 'http on an allowed host (scheme, not host)',
        opts: { overrides: { url: `http://static.klipy.com/ii/1/hd.gif` } },
      },
      {
        label: 'a same-origin path outside /gif-fixtures/',
        opts: { overrides: { url: `${ORIGIN}/private/secret.gif` } },
      },
      { label: 'a zero dimension', opts: { overrides: { w: 0 } } },
      { label: 'the field as a string', opts: { field: 'not-an-object' } },
    ];

    for (const [i, entry] of forged.entries()) {
      const body = `forged ${i} ${stamp} ${entry.label}`;
      const sent = await sendGifMessage(bob, DEV, {
        id: MOCK_IDS[0]!,
        origin: ORIGIN,
        body,
        ...entry.opts,
      });
      const forgedRow = row(page, sent.eventId);
      await expect(forgedRow).toBeVisible({ timeout: 20_000 });
      await forgedRow.scrollIntoViewIfNeeded();
      await expect(
        messageGif(forgedRow),
        `${entry.label}: getGifContent must reject this and render the plain m.text`,
      ).toHaveCount(0);
      await expect(forgedRow, `${entry.label}: the body text is shown instead`).toContainText(body);
    }
    guard.assertClean();
  });

  test('AC-G3-3/G7-4 — the thread composer sends a GIF into the thread, not the channel (P1)', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid', 'message-gif']);
    const guard = await startAs('mock', page);

    // A root of our own so the test is replayable on a dirty homeserver.
    const rootBody = `gif thread root ${Date.now().toString(36)}`;
    const rootId = await bob.send(DEV, rootBody);
    const rootRow = row(page, rootId);
    await expect(rootRow).toBeVisible({ timeout: 20_000 });
    await rootRow.scrollIntoViewIfNeeded();
    await rootRow.hover();

    const threadAction = rootRow.getByTestId('message-actions').getByTestId('message-action-thread');
    test.skip(
      !(await threadAction
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(() => true)
        .catch(() => false)),
      '`message-action-thread` is not available in this build (Phase 3 DEV-B-19)',
    );
    await threadAction.click();
    await expect(page.getByTestId('thread-panel')).toBeVisible();

    const threadGif = composerGif(page, true);
    test.skip(
      (await threadGif.count()) === 0,
      '`thread-composer-gif` is not built yet (DEV-B-23 prefix rule)',
    );

    const roomRowsBefore = await messageList(page).locator('[data-testid^="message-$"]').count();
    await openGifPicker(page, { thread: true });
    const target = MOCK_GIFS[0]!;
    await expectGridIds(page, MOCK_IDS);
    await pickGif(page, target.id);

    const threadRow = gifRowById(page, target.id, { thread: true });
    await expect(threadRow.first()).toBeVisible({ timeout: 15_000 });
    const eventId = await settledEventId(threadRow.first());

    // AC-G3-3: the Phase 3 relation on top of the contract content.
    const event = await gifEventFor(DEV, eventId);
    expectMockGifEvent(event, target.id, ORIGIN);
    expect(event.relatesTo?.rel_type).toBe('m.thread');
    expect(event.relatesTo?.event_id).toBe(rootId);

    // AC-G7-4: nothing new in the channel timeline.
    expect(
      await messageList(page).locator('[data-testid^="message-$"]').count(),
      'a thread pick adds no row to the channel',
    ).toBe(roomRowsBefore);
    guard.assertClean();
  });
});

test.describe('GIF picker — klipy provider against stubs (QA-19)', () => {
  /** One stubbed item per criterion; `hd` is the send variant, `sm.webp` the preview. */
  const SPECS: KlipyItemSpec[] = [
    { id: 8041071659142944, title: 'Stubbed tacos', w: 498, h: 498 },
    { id: 8041071659142945, title: 'Stubbed cat', w: 400, h: 300, previewW: 220, previewH: 165 },
    { id: 8041071659142946, title: 'Stubbed party', w: 360, h: 360, omitHd: true },
  ];

  test('AC-G2-1/G2-2/G3-2/G4-7 — the key is a path segment, items keep API order, a pick sends the CDN url', async ({
    page,
  }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid', 'message-gif']);
    requireGifFixtures(test);

    const guard = guardGifNetwork(page);
    const api = await stubKlipy(page, { items: SPECS });
    const cdn = await stubKlipyCdn(page);
    await useGifProvider(page, 'klipy', { key: FAKE_KEY });
    await resetGifSession(page);
    await loginAs(page, 'alice');
    await openChannel(page, DEV);

    await openGifPicker(page);
    await expectProvider(page, 'klipy');

    // AC-G4-7: Klipy's required copy.
    await expect(gifSearch(page)).toHaveAttribute('placeholder', 'Search KLIPY');
    await expect(gifAttribution(page)).toHaveText('Powered by KLIPY');

    // AC-G2-1 (trending on open).
    await expect
      .poll(() => api.trendingRequests().length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const trending = api.trendingRequests()[0]!;
    expect(trending.key, 'the app key is a URL path segment, not a header or query param').toBe(FAKE_KEY);
    expect(new URL(trending.url).pathname).toBe(`/api/v1/${FAKE_KEY}/gifs/trending`);
    expect(trending.params.page).toBe('1');
    expect(Number(trending.params.per_page)).toBe(KLIPY_PER_PAGE);
    expect(trending.params.content_filter).toBe(KLIPY_CONTENT_FILTER);
    expect(
      trending.headers.authorization,
      'Klipy authenticates by path segment; an Authorization header would be wrong',
    ).toBeUndefined();
    // AC-G6-1's `customer_id` half (orchestrator's 2026-10-09 ruling): a stable per-browser id rides
    // along on every request. Asserted as "present and non-trivial" — the value is a random uuid
    // generated on first use, so pinning it would only pin `crypto.randomUUID`.
    expect(
      trending.params.customer_id,
      'AC-G2-1: every Klipy request carries a customer_id (matrix-poc.gifCustomerId)',
    ).toBeTruthy();
    expect(String(trending.params.customer_id).length).toBeGreaterThanOrEqual(8);

    // AC-G2-2 / AC-G4-3: the stub's order, unfiltered, with the mapped preview urls.
    await expectGridIds(page, SPECS.map(klipyResultId));
    for (const [i, spec] of SPECS.entries()) {
      const tile = gifItem(page, String(spec.id));
      await expect(tile).toHaveAttribute('data-index', String(i));
      await expect(tile).toHaveAttribute('aria-label', spec.title);
      await expect(
        tile.locator('img, video'),
        `tile ${spec.id} shows the sm preview variant`,
      ).toHaveAttribute('src', klipyPreviewUrl(spec));
    }

    // AC-G2-1 (search): `q` plus the same page/per_page/content_filter.
    await searchInPicker(page, 'tacos');
    await expect
      .poll(() => api.searchRequests().length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const search = api.searchRequests()[0]!;
    expect(new URL(search.url).pathname).toBe(`/api/v1/${FAKE_KEY}/gifs/search`);
    expect(search.params.q).toBe('tacos');
    expect(search.params.page).toBe('1');
    expect(Number(search.params.per_page)).toBe(KLIPY_PER_PAGE);
    expect(search.params.content_filter).toBe(KLIPY_CONTENT_FILTER);
    expect(
      search.params.customer_id,
      'the customer_id is stable across requests in one browser profile, not regenerated per call',
    ).toBe(trending.params.customer_id);
    // AC-G2-4: a debounced box must not fire a request per keystroke.
    expect(
      api.searchRequests().length,
      'typing one query must not fan out into a request per keystroke (300 ms debounce)',
    ).toBeLessThanOrEqual(2);

    // AC-G3-2: picking sends the `hd` gif on static.klipy.com with that variant's dimensions.
    const chosen = SPECS[0]!;
    await pickGif(page, String(chosen.id));
    const sent = gifRowById(page, klipyResultId(chosen));
    await expect(sent.first()).toBeVisible({ timeout: 15_000 });
    const eventId = await settledEventId(sent.first());

    const event = await gifEventFor(DEV, eventId);
    expect(event.msgtype).toBe('m.text');
    expectGifFieldShape(event.gif, ORIGIN);
    expect(event.gif!.provider).toBe('klipy');
    expect(event.gif!.id, 'the Klipy id reaches the wire as a stable string').toBe(klipyResultId(chosen));
    expect(event.gif!.url).toBe(klipySendUrl(chosen));
    expect(new URL(String(event.gif!.url)).host).toBe('static.klipy.com');
    expect(event.gif!.w).toBe(chosen.w);
    expect(event.gif!.h).toBe(chosen.h);
    expect(event.gif!.previewUrl).toBe(klipyPreviewUrl(chosen));
    expect(event.body).toBe(`${chosen.title} ${klipySendUrl(chosen)}`);

    // The row renders from the stubbed CDN.
    await expect(await expectGifPlaying(row(page, eventId))).toHaveAttribute('src', klipySendUrl(chosen));
    expect(cdn.requests.length, 'the timeline loaded the GIF from the stubbed CDN').toBeGreaterThan(0);
    guard.assertClean();
  });

  test('AC-G2-3 — an invalid key (404) shows gif-error with the service message', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker']);

    const guard = guardGifNetwork(page);
    const api = await stubKlipy(page, { status: 404 });
    await stubKlipyCdn(page);
    await useGifProvider(page, 'klipy', { key: FAKE_KEY });
    await resetGifSession(page);
    await loginAs(page, 'alice');
    await openChannel(page, DEV);

    await composerGif(page).click();
    await expect(gifPicker(page)).toBeVisible();
    await expectProvider(page, 'klipy');

    await expect(gifError(page), 'a 404 from Klipy must surface the error state').toBeVisible({
      timeout: 10_000,
    });
    await expect(gifErrorRetry(page)).toBeVisible();
    await expect(
      gifError(page),
      'the error copy should mention the key or at least that GIFs could not load',
    ).toHaveText(/key|invalid|could not load/i);
    expect(await gridIds(page), 'no tiles in the error state').toEqual([]);
    expect(api.requests.length).toBeGreaterThanOrEqual(1);
    expect(api.requests[0]!.key).toBe(FAKE_KEY);
    guard.assertClean();
  });

  test('AC-G2-3 — a 429 shows gif-error and Retry recovers once the service answers', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid']);

    const guard = guardGifNetwork(page);
    // `retry-after: 0` keeps the provider's single internal retry instant.
    const api = await stubKlipy(page, { status: 429, headers: { 'retry-after': '0' } });
    await stubKlipyCdn(page);
    await useGifProvider(page, 'klipy', { key: FAKE_KEY });
    await resetGifSession(page);
    await loginAs(page, 'alice');
    await openChannel(page, DEV);

    await composerGif(page).click();
    await expect(gifPicker(page)).toBeVisible();
    await expect(gifError(page), 'a rate-limited Klipy must surface the error state').toBeVisible({
      timeout: 15_000,
    });
    expect(
      api.requests.length,
      'the provider retries a 429 once honouring Retry-After before giving up',
    ).toBeGreaterThanOrEqual(2);

    // Retry under a now-working stub shows results.
    api.update({ status: 200, items: SPECS });
    api.reset();
    await gifErrorRetry(page).click();
    await expect(gifError(page)).toHaveCount(0, { timeout: 10_000 });
    await expectGridIds(page, SPECS.map(klipyResultId));
    expect(api.requests.length, 'Retry re-runs the last request').toBeGreaterThanOrEqual(1);
    guard.assertClean();
  });

  test('BUG — a full page of mixed-size GIFs lays out as a grid, tiles never overlap', async ({ page }) => {
    await requireGifUi(test, page, ['composer-gif', 'gif-picker', 'gif-grid']);

    // A real Klipy page: more tiles than the scroller holds, every aspect ratio different. The 8 mock
    // GIFs always fit, which is why the squashed rows (tiles piled on top of each other) only showed
    // with a real key.
    const page24: KlipyItemSpec[] = Array.from({ length: KLIPY_PER_PAGE }, (_, i) => ({
      id: 8041071659143000 + i,
      title: `Stubbed mixed ${i}`,
      w: 480,
      h: 480,
      previewW: 200 + ((i * 37) % 140),
      previewH: 110 + ((i * 53) % 190),
    }));
    const guard = guardGifNetwork(page);
    await stubKlipy(page, { items: page24 });
    await stubKlipyCdn(page);
    await useGifProvider(page, 'klipy', { key: FAKE_KEY });
    await resetGifSession(page);
    await loginAs(page, 'alice');
    await openChannel(page, DEV);

    await openGifPicker(page);
    await expectGridIds(page, page24.map(klipyResultId));

    const columns = Number(await gifGrid(page).getAttribute('data-columns'));
    const boxes = await gifGrid(page)
      .locator('[role="option"]')
      .evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      }));
    expect(boxes).toHaveLength(page24.length);
    for (const [i, box] of boxes.entries()) {
      const spec = page24[i]!;
      // Each tile keeps its own aspect ratio (the 44 px tap-target floor never applies at these sizes).
      expect(box.height, `tile ${i} keeps its aspect ratio`).toBeCloseTo((box.width * spec.previewH!) / spec.previewW!, 0);
      if (i >= columns) {
        const above = boxes[i - columns]!;
        expect(box.top, `tile ${i} starts below tile ${i - columns}, not on top of it`).toBeGreaterThanOrEqual(above.bottom);
      }
    }
    guard.assertClean();
  });
});
