/**
 * QA-3 — the smoke test *is* the demo script.
 *
 * One serial spec that walks docs/archive/PLAN.md "Demo script (~2 minutes)" steps 1-10 in order as alice,
 * asserting the "They should see" column of each row, with bob driven through the raw-HTTP helper
 * for the live typing/incoming-message step. A full-page screenshot is written for every step even
 * when the step passes: the set in `e2e/results/demo/` is the stakeholder pre-read.
 *
 * Serial and single-page on purpose — the demo is one continuous session, and a step that depends
 * on the previous step's state (badge cleared, reply banner gone) is exactly what we want to catch.
 * The independent per-criterion coverage lives in navigation.spec.ts / conversation.spec.ts.
 *
 * This spec must be green before the Wave 3 dry run.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import * as E2 from './fixtures/e2ee.ts';
import * as E2API from './fixtures/e2ee-api.ts';
import * as C from './fixtures/call.ts';
import { requireFreshSeed } from './fixtures/fresh.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { BODIES, DISPLAY_NAMES, NAMES, eventId, resolveRoom, uniqueName, userId } from './fixtures/seed.ts';
import { workerOrigin } from './fixtures/pool.ts';
import { annotate, childRoomIds, ensureUnread, noteSeedDrift, revokePendingInvite } from './fixtures/state.ts';
import {
  composerGif,
  expectGifPlaying,
  expectGridIds,
  gifAttribution,
  gifHeading,
  gifPending,
  gifPicker,
  gifRowById,
  gifSearch,
  GIF_PROVIDER_STORAGE_KEY,
  guardGifNetwork,
  MOCK_IDS,
  mockSearch,
  openGifPicker,
  openGifPickerBySlash,
  pickGif,
  queryMatching,
  searchInPicker,
  selectedGifId,
  sendGifMessage,
} from './fixtures/gif.ts';
import {
  atBottom,
  byName,
  channelItem,
  composer,
  hoverActions,
  itemNames,
  messageList,
  openHome,
  openSpace,
  paginateToTop,
  railOrder,
  row,
  rowByText,
  scrollListToBottom,
  scrollListToTop,
  settledEventId,
  spaceItem,
  stepShot,
  typeAndSend,
} from './fixtures/ui.ts';

// Serial inside each describe (steps 1-12 share one page); step 13 (Phase 5) is its own group so a seed-dependent
// red step above cannot skip it.
const ALICE = userId('alice');
const BOB = userId('bob');
const CAROL = userId('carol');

let page: Page;
let bob: ApiUser;
let aliceApi: ApiUser;

const R = {
  acme: '',
  gaming: '',
  general: '',
  random: '',
  dev: '',
  lobby: '',
  dmBob: '',
};

/** Event ids resolved from the live room (not in seed-output.json). */
let snacksEventId = '';
/** The channel this run creates in step 10. */
let memesName = '';
/** The thread root step 11a creates, reused by step 11b (Phase 3 demo rows 2-7). */
let demoThreadRootId = '';

/** The app's origin, as the mock GIF provider builds its fixture URLs from `location.origin`. */
const ORIGIN = workerOrigin();
/** Demo rows 2 and 5 queries, derived so a fixture-catalogue change cannot break the demo step. */
const DEMO_QUERY = queryMatching(3, ['tacos', 'taco', 'cat', 'party']) ?? 'cat';
const SECOND_QUERY = queryMatching(2, ['party', 'cat', 'taco']) ?? 'party';

test.describe('demo script (QA-3 smoke)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ browser }) => {
    R.acme = await resolveRoom('acme-hq');
    R.gaming = await resolveRoom('gaming');
    R.general = await resolveRoom('general');
    R.random = await resolveRoom('random');
    R.dev = await resolveRoom('dev');
    R.lobby = await resolveRoom('lobby');
    R.dmBob = await resolveRoom('dm-alice-bob');

    bob = await asUser('bob');
    aliceApi = await asUser('alice');

    // Demo step 2 shows an unread badge on #random and an unread dot on the Gaming rail icon.
    // Both are seeded but consumed by the first run that opens those rooms — see fixtures/state.ts.
    await ensureUnread(R.random, 3);
    await ensureUnread(R.lobby, 1);

    // Demo step 10 invites carol to Gaming; withdraw a leftover invite so it can be replayed.
    await revokePendingInvite(aliceApi, [R.gaming, ...(await childRoomIds(aliceApi, R.gaming))], CAROL);

    const snacks = await bob.findMessage(R.general, BODIES.general34, CAROL);
    expect(snacks, `seeded #general message "${BODIES.general34}" from carol not found`).toBeTruthy();
    snacksEventId = snacks!.event_id;

    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('step 1 — log in as alice: shell, space rail, Acme HQ selected, #general open', async () => {
    const started = Date.now();
    await loginAs(page, 'alice');
    const elapsed = Date.now() - started;
    annotate('timing', `login -> shell painted in ${elapsed} ms (docs/archive/PLAN.md wants < 3000 ms)`);
    expect(elapsed, 'AC-SH-2 budget').toBeLessThan(10_000);

    const rail = page.getByTestId('space-rail');
    await expect(page.getByTestId('space-item-home')).toBeVisible();
    await expect(byName(rail, NAMES.acme)).toBeVisible();
    await expect(byName(rail, NAMES.gaming)).toBeVisible();

    // Home, then Acme HQ, then Gaming, in that order (AC-A1-1).
    expect(await railOrder(page)).toEqual([
      'space-item-home',
      `space-item-${R.acme}`,
      `space-item-${R.gaming}`,
    ]);

    await expect(spaceItem(page, R.acme)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('space-header-name')).toHaveText(NAMES.acme);
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.general);
    await expect(messageList(page)).toBeVisible();

    await stepShot(page, 1, 'login-shell');
  });

  test('step 2 — channel list, #random badge, Gaming unread dot, member list', async () => {
    // The demo script is written against a fresh seed: this step shows the seeded 3 on #random.
    await requireFreshSeed(test);
    const list = page.getByTestId('channel-list');
    expect(await itemNames(list, 'channel-item-')).toEqual([NAMES.general, NAMES.random, NAMES.dev, NAMES.vault]);

    // Badge must match the count derived from receipts + timeline; on a fresh seed that is 3.
    const derived = (await bob.unreadFor(R.random, ALICE)).count;
    noteSeedDrift('demo step 2 (#random badge)', 3, derived);
    const badge = page.getByTestId(`channel-unread-${R.random}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-count', String(derived));
    await expect(badge).toContainText(String(derived));

    // #general and #dev are read, so they carry no badge.
    await expect(page.getByTestId(`channel-unread-${R.general}`)).toHaveCount(0);
    await expect(page.getByTestId(`channel-unread-${R.dev}`)).toHaveCount(0);

    // Gaming rail icon shows an unread dot (its #lobby has unread).
    await expect(page.getByTestId(`space-unread-${R.gaming}`)).toBeVisible();

    const joined = Object.keys(await bob.joinedMembers(R.general));
    noteSeedDrift('demo step 2 (member-count)', 4, joined.length);
    await expect(page.getByTestId('member-count')).toContainText(String(joined.length));
    for (const id of [ALICE, BOB, CAROL, userId('dave')]) {
      await expect(page.getByTestId(`member-item-${id}`)).toBeVisible();
    }

    await stepShot(page, 2, 'channel-list-badges-members');
  });

  test('step 3 — scroll #general: grouping, rich bodies, pagination to the beginning', async () => {
    test.setTimeout(90_000);
    // The step opens on the bottom of the *seeded* room: #40, #31 and #18 must be in the initial
    // window, which only holds while nothing newer has been posted into #general.
    await requireFreshSeed(test);

    // Bottom of the room: the newest seeded message is on screen and rows are grouped by sender.
    await expect(row(page, eventId('general.last'))).toBeVisible();
    await expect(page.getByTestId('message-group-start').first()).toBeVisible();

    // Content from the newest part of the room, inside the initial ~30-event window.
    await expect(row(page, eventId('general.code')).locator('pre code')).toContainText('npm run build');
    await expect(row(page, eventId('general.edited')).getByTestId('message-edited')).toBeVisible();
    await stepShot(page, 3, 'general-scrolled');

    // Scrolling to the top pages in history until the beginning banner appears.
    const start = page.getByTestId('timeline-start');
    const reachedStart = await paginateToTop(page, async () => (await start.count()) > 0);
    expect(reachedStart, 'scrolling to the top must eventually reach the beginning of #general').toBe(true);
    await expect(start).toBeVisible();
    await expect(start).toContainText(`This is the beginning of #${NAMES.general}`);
    await expect(row(page, eventId('general.first'))).toBeVisible();
    await stepShot(page, 3, 'general-timeline-start');

    // The rest of the rich-content sampler lives in the paginated-in history
    // (#8, #17, #22 and the pills on #1/#11 are all older than the initial window).
    await expect(row(page, eventId('general.bold')).locator('strong')).toContainText('Q4 planning meeting');
    await expect(row(page, eventId('general.link')).locator('a[href="https://status.example.com"]')).toBeVisible();
    await expect(row(page, eventId('general.image')).getByTestId('message-image')).toBeVisible();
    await expect(row(page, eventId('general.reply')).getByTestId('message-reply-quote')).toBeVisible();

    const thumbs = row(page, eventId('general.reacted')).getByTestId('reaction-👍');
    await expect(thumbs).toBeVisible();
    await expect(thumbs).toHaveAttribute('data-count', '2');

    await scrollListToBottom(page);
    await expect.poll(() => atBottom(page, 40), { timeout: 10_000 }).toBe(true);
  });

  test('step 4 — send "Hello from the demo", then Shift+Enter makes a newline', async () => {
    const text = `Hello from the demo ${Date.now()}`;
    await typeAndSend(page, text);

    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 5_000 });
    await expect(sent).toHaveAttribute('data-sender', ALICE);
    await expect(composer(page)).toHaveValue('');

    // Shift+Enter inserts a newline and sends nothing.
    const before = await messageList(page).getByTestId(/^message-[$~]/).count();
    await composer(page).click();
    await composer(page).pressSequentially('line one');
    await composer(page).press('Shift+Enter');
    await composer(page).pressSequentially('line two');
    await expect(composer(page)).toHaveValue('line one\nline two');
    expect(await messageList(page).getByTestId(/^message-[$~]/).count()).toBe(before);

    await stepShot(page, 4, 'composer-send-and-newline');
    await composer(page).fill('');
  });

  test('step 5 — react 🎉 to bob\'s "Lunch today?" message, then remove it', async () => {
    // #11 is only on screen because step 3 paged the room in; skipping step 3 leaves it unreachable.
    await requireFreshSeed(test);
    const target = row(page, eventId('general.reacted'));
    const mine = target.getByTestId('reaction-🎉');

    // Replay safety: a previous interrupted run may have left alice's 🎉 on this message.
    if ((await mine.count()) > 0 && (await mine.first().getAttribute('data-mine')) === 'true') {
      await mine.first().click();
      await expect(mine).toHaveCount(0, { timeout: 5_000 });
      annotate('precondition', 'step 5: removed a leftover 🎉 reaction from a previous run.');
    }

    const actions = await hoverActions(page, eventId('general.reacted'));
    await actions.getByTestId('message-action-react').click();

    const picker = page.getByTestId('reaction-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('reaction-picker-🎉').click();

    await expect(mine).toBeVisible({ timeout: 5_000 });
    await expect(mine).toHaveAttribute('data-count', '1');
    await expect(mine).toHaveAttribute('data-mine', 'true');

    await stepShot(page, 5, 'reaction-added');

    await mine.click();
    await expect(mine).toHaveCount(0, { timeout: 5_000 });
    await stepShot(page, 5, 'reaction-removed');
  });

  test('step 6 — reply to carol\'s "Will there be snacks?" with "Yes"', async () => {
    // Same as step 5: #34 is reachable in the demo session only after step 3 ran.
    await requireFreshSeed(test);
    const actions = await hoverActions(page, snacksEventId);
    await actions.getByTestId('message-action-reply').click();

    const banner = page.getByTestId('composer-reply-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Replying to');
    await expect(banner).toContainText(DISPLAY_NAMES.carol);
    await expect(composer(page)).toBeFocused();

    const text = `Yes ${Date.now()}`;
    await typeAndSend(page, text);

    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 5_000 });
    const quote = sent.getByTestId('message-reply-quote');
    await expect(quote).toBeVisible();
    await expect(quote).toContainText(BODIES.general34);
    await expect(page.getByTestId('composer-reply-banner')).toHaveCount(0);

    await stepShot(page, 6, 'reply-sent');
  });

  test('step 7 — attach a PNG: image bubble, thumbnail at most 400 px', async () => {
    await page.getByTestId('composer-file-input').setInputFiles('e2e/fixtures/test-image.png');

    const image = messageList(page).getByTestId('message-image').last();
    await expect(image).toBeVisible({ timeout: 15_000 });
    const src = await image.getAttribute('src');
    expect(src, 'thumbnail must come from the homeserver media API').toContain('/_matrix/');

    // Polled: the bubble can re-render right after it first shows (local echo -> sent), and a read in between
    // finds no box (BUG-22).
    let width = Number.NaN;
    await expect
      .poll(async () => (width = (await image.boundingBox())?.width ?? Number.NaN), {
        message: 'the image must have a rendered box',
      })
      .toBeGreaterThan(0);
    expect(width, 'thumbnail wider than the 400 px budget').toBeLessThanOrEqual(400);

    await stepShot(page, 7, 'image-uploaded');
  });

  test('step 8 — open #random: the badge clears and stays cleared after a reload', async () => {
    await channelItem(page, R.random).click();
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);

    await expect(page.getByTestId(`channel-unread-${R.random}`)).toHaveCount(0, { timeout: 5_000 });
    await stepShot(page, 8, 'random-read');

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`channel-unread-${R.random}`)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('channel-header-name')).toContainText(NAMES.random);
    await stepShot(page, 8, 'random-read-after-reload');
  });

  test('step 9 — open the bob DM: bob types, then his message arrives live', async () => {
    await openHome(page);
    await page.getByTestId(`dm-item-${R.dmBob}`).click();
    await expect(page.getByTestId('channel-header-name')).toContainText(DISPLAY_NAMES.bob);
    await expect(messageList(page)).toBeVisible();

    await bob.typing(R.dmBob, true, 20_000);
    const indicator = page.getByTestId('typing-indicator');
    await expect(indicator).toBeVisible({ timeout: 5_000 });
    await expect(indicator).toContainText(`${DISPLAY_NAMES.bob} is typing`);
    await stepShot(page, 9, 'bob-typing');

    const text = `On my way ${Date.now()}`;
    await bob.typing(R.dmBob, false);
    await bob.send(R.dmBob, text);

    const arrived = rowByText(page, text);
    await expect(arrived).toBeVisible({ timeout: 10_000 });
    await expect(arrived).toHaveAttribute('data-sender', BOB);
    await expect(page.getByTestId('typing-indicator')).toHaveCount(0, { timeout: 8_000 });

    await stepShot(page, 9, 'bob-message-live');
  });

  test('step 10 — Gaming: create a channel, then invite carol to the space', async () => {
    test.setTimeout(60_000);

    await openSpace(page, R.gaming);
    await expect(page.getByTestId('space-header-name')).toHaveText(NAMES.gaming);

    memesName = uniqueName('memes');
    await page.getByTestId('channel-add').click();
    const dialog = page.getByTestId('create-channel-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('create-channel-name').fill(memesName);
    await page.getByTestId('create-channel-topic').fill('Only the dankest');
    await page.getByTestId('create-channel-submit').click();

    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    const created = byName(page.getByTestId('channel-list'), memesName);
    await expect(created).toBeVisible({ timeout: 15_000 });
    await expect(created).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('channel-header-name')).toContainText(memesName);
    await expect(page.getByTestId('channel-header-topic')).toContainText('Only the dankest');
    await stepShot(page, 10, 'channel-created');

    await page.getByTestId('space-menu').click();
    await page.getByTestId('space-menu-invite').click();
    const invite = page.getByTestId('invite-dialog');
    await expect(invite).toBeVisible();
    await page.getByTestId('invite-user-id').fill(CAROL);
    await page.getByTestId('invite-submit').click();
    await expect(invite).toHaveCount(0, { timeout: 15_000 });

    const invited = page.getByTestId('member-section-invited');
    await expect(invited).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`member-item-${CAROL}`)).toBeVisible({ timeout: 10_000 });
    await stepShot(page, 10, 'carol-invited');
  });

  /**
   * Step 11 is the Phase 3 thread walk-through (QA-17, AC-T11-1): docs/archive/PHASE3_PLAN.md "Desktop demo
   * script" rows 2-7, with bob's `npm run thread:sample` replaced by `sendThreadReply` so the step
   * needs no terminal. Screenshots land in `e2e/results/demo/11-*`, one per demo sub-step.
   *
   * It is split in two tests because the two halves depend on different owners: rows 2-4 and 8 need
   * Dev B's panel (DEV-B-19/20), rows 5-7 need Dev A's Threads button and list (DEV-A-17). Each half
   * skips with a `not-built` annotation while its half of Wave 8 is still in progress, so the demo
   * set is as complete as the build is — and the *other* half still produces its screenshots.
   *
   * No `requireThreadUi` here on purpose: its probe opens a second page in this context and then
   * clears the origin's storage, which would log this spec's long-lived shared `page` out mid-demo.
   */
  /**
   * Is this piece of thread UI in the DOM?
   *
   * `waitFor`, not `count()`: the summary row renders on a `threadVersion` bump a moment *after* the
   * panel's divider has already ticked, so an instant count would often read 0 and write a false
   * `not-built` annotation — and screenshot the timeline without the row the demo is about.
   */
  async function threadUiPresent(locator: Locator, timeout = 10_000): Promise<boolean> {
    return locator
      .waitFor({ state: 'attached', timeout })
      .then(() => true)
      .catch(() => false);
  }

  test('step 11 — Reply in thread: panel, two replies, live summary, bob replies (demo 2-4, 8)', async () => {
    test.setTimeout(120_000);

    // Back to where the thread demo starts: Acme HQ / #general, at the bottom.
    await openSpace(page, R.acme);
    await channelItem(page, R.general).click();
    await expect(messageList(page)).toBeVisible();
    await scrollListToBottom(page);

    // Demo row 2 hovers "Lunch today? Thinking tacos." — a root of our own keeps the step replayable
    // on a dirty homeserver (the seeded message may already carry threads from earlier runs).
    const rootBody = `[demo] Lunch today? Thinking tacos. ${Date.now().toString(36)}`;
    const rootId = await bob.send(R.general, rootBody);
    const rootRow = row(page, rootId);
    await expect(rootRow).toBeVisible({ timeout: 20_000 });
    await rootRow.scrollIntoViewIfNeeded();

    const actions = await hoverActions(page, rootId);
    const threadAction = actions.getByTestId('message-action-thread');
    test.skip(
      !(await threadUiPresent(threadAction, 3_000)),
      'demo step 11a: `message-action-thread` is not built yet (DEV-B-19)',
    );

    // --- demo row 2: the member column becomes the thread panel
    await threadAction.click();
    const panel = page.getByTestId('thread-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-root', rootId);
    await expect(page.getByTestId('thread-root')).toContainText(rootBody);
    await expect(page.getByTestId('thread-replies-divider')).toHaveText('No replies yet');
    await expect(page.getByTestId('thread-composer-input')).toHaveAttribute(
      'placeholder',
      'Replying in thread',
    );
    await expect(page.getByTestId('thread-composer-input')).toBeFocused();
    await expect(page.getByTestId('member-list')).toBeHidden();
    await stepShot(page, 11, 'thread-opened');

    // --- demo row 3: two replies in the panel, no new rows in the channel, summary "2 replies"
    const roomRowsBefore = await page
      .getByTestId('message-list')
      .locator('[data-testid^="message-$"], [data-testid^="message-~"]')
      .count();
    for (const text of ['Tacos work for me', 'Noon?']) {
      const composerInput = page.getByTestId('thread-composer-input');
      await composerInput.click();
      await composerInput.fill(text);
      await composerInput.press('Enter');
      await expect(
        page.getByTestId('thread-message-list').getByTestId(/^message-[$~]/).filter({ hasText: text }),
      ).toBeVisible({ timeout: 15_000 });
    }
    await expect(page.getByTestId('thread-replies-divider')).toHaveText('2 replies', { timeout: 10_000 });
    const roomRowsAfter = await page
      .getByTestId('message-list')
      .locator('[data-testid^="message-$"], [data-testid^="message-~"]')
      .count();
    expect(roomRowsAfter, 'the channel timeline gains no rows from thread replies').toBe(roomRowsBefore);

    const summary = page.getByTestId(`thread-summary-${rootId}`);
    if (await threadUiPresent(summary)) {
      await expect(summary.getByTestId('thread-summary-count')).toHaveText('2 replies', {
        timeout: 10_000,
      });
      await expect(summary.getByTestId('thread-summary-time')).toHaveText('just now');
    } else {
      annotate('not-built', 'demo step 11a: `thread-summary-{rootId}` is not rendered yet (DEV-B-18)');
    }
    await stepShot(page, 11, 'two-replies-and-summary');

    // --- demo row 4: bob replies (the demo runs `npm run thread:sample -- --root <id>` here)
    const bobReply = await bob.sendThreadReply(R.general, rootId, '[demo] Noon works, see you there');
    await expect(page.getByTestId('thread-message-list').getByTestId(`message-${bobReply}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('thread-replies-divider')).toHaveText('3 replies', { timeout: 10_000 });
    if (await threadUiPresent(summary)) {
      await expect(summary.getByTestId('thread-summary-count')).toHaveText('3 replies', {
        timeout: 10_000,
      });
    }
    await stepShot(page, 11, 'bob-replied-live');

    // --- demo row 5 (first half) and row 8: close the panel, the member column returns, and the
    // summary row reopens the same thread.
    await page.getByTestId('thread-close').click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('member-list')).toBeVisible();
    await stepShot(page, 11, 'panel-closed-members-back');

    if (await threadUiPresent(summary)) {
      await summary.scrollIntoViewIfNeeded();
      await summary.click();
      await expect(page.getByTestId('thread-panel')).toHaveAttribute('data-root', rootId);
      await stepShot(page, 11, 'reopened-from-summary');
      await page.getByTestId('thread-close').click();
    }

    // Leave the thread on the board for step 11b.
    demoThreadRootId = rootId;
  });

  test('step 11 — the Threads button: unread dot, list, reopen from the list (demo 5-7)', async () => {
    test.setTimeout(90_000);

    const threadsBtn = page.getByTestId('header-threads');
    test.skip(
      !(await threadUiPresent(threadsBtn, 3_000)),
      'demo step 11b: `header-threads` is not built yet (DEV-A-17)',
    );
    test.skip(!demoThreadRootId, 'demo step 11b needs the thread step 11a created');

    // The Threads dot is room-wide: clear every leftover unread thread first with an *unthreaded*
    // m.read on the newest event (earlier runs leave unread threads behind on a dirty seed), so
    // the only unread thread after bob's reply is the demo one and opening it clears the dot.
    const newest = await aliceApi.lastMessage(R.general);
    if (newest) await aliceApi.receipt(R.general, newest.event_id);
    await expect.poll(async () => (await aliceApi.unreadFor(R.general)).count, { timeout: 15_000 }).toBe(0);
    await expect(page.getByTestId('header-threads-unread')).toHaveCount(0, { timeout: 15_000 });

    // --- demo row 5 (second half): bob replies again while the panel is closed -> the dot appears
    await bob.sendThreadReply(R.general, demoThreadRootId, '[demo] Bringing the guacamole');
    await expect(page.getByTestId('header-threads-unread')).toBeVisible({ timeout: 10_000 });
    const summary = page.getByTestId(`thread-summary-${demoThreadRootId}`);
    if (await threadUiPresent(summary)) {
      await expect(summary.getByTestId('thread-summary-count')).toHaveText('4 replies', {
        timeout: 10_000,
      });
    }
    await stepShot(page, 11, 'threads-dot');

    // --- demo row 6: the list, with our thread at the top
    await threadsBtn.click();
    const list = page.getByTestId('thread-list');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('data-variant', 'popover');
    const item = page.getByTestId(`thread-list-item-${demoThreadRootId}`);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.getByTestId('thread-list-item-author')).toContainText(DISPLAY_NAMES.bob);
    await expect(item.getByTestId('thread-list-item-count')).toHaveText('4 replies');
    await expect(item.getByTestId('thread-list-item-time')).toHaveText(/just now|min ago/);
    const order = await list
      .locator('[data-testid^="thread-list-item-$"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    expect(order[0], 'our thread has the newest activity, so it is listed first').toBe(
      `thread-list-item-${demoThreadRootId}`,
    );
    await stepShot(page, 11, 'threads-list');

    // --- demo row 7: the item reopens the thread with all four replies and clears the dot
    await item.click();
    await expect(list).toBeHidden();
    await expect(page.getByTestId('thread-panel')).toHaveAttribute('data-root', demoThreadRootId);
    await expect(page.getByTestId('thread-replies-divider')).toHaveText('4 replies', { timeout: 10_000 });
    await expect(page.getByTestId('header-threads-unread')).toHaveCount(0, { timeout: 10_000 });
    await stepShot(page, 11, 'reopened-from-list');
  });
  test('step 12 — the GIF picker: /gif, arrows, the badge, offscreen, trending, bob posts one (demo 2-7)', async () => {
    test.setTimeout(120_000);

    // Phase 4 demo rows 2-7. The plan walks them in #general; this step uses **#dev** instead, so the
    // GIF traffic stays in the room the GIF suites own and #general's demo history stays clean.
    // Forced onto `mock` at runtime (`getGifProvider()` re-reads localStorage on every call) so the
    // step is deterministic even when a Klipy key is sitting in .env, and guarded so no image request
    // can leave the machine (AC-G11-3).
    const guard = guardGifNetwork(page);
    await page.evaluate((key) => {
      try {
        window.localStorage.setItem(key, 'mock');
      } catch {
        /* private mode */
      }
    }, GIF_PROVIDER_STORAGE_KEY);

    await openSpace(page, R.acme);
    await channelItem(page, R.dev).click();
    await expect(messageList(page)).toBeVisible();
    await scrollListToBottom(page);

    if ((await composerGif(page).count()) === 0) {
      annotate('not-built', 'demo step 12: `composer-gif` is not built yet (DEV-B-23)');
      test.skip(true, 'demo step 12: the GIF button is not built yet');
    }

    // --- demo row 2: `/gif <q>`, Enter -> a pre-searched picker, composer cleared
    await openGifPickerBySlash(page, `/gif ${DEMO_QUERY}`);
    await expect(gifPicker(page)).toHaveAttribute('data-variant', 'popover');
    await expect(gifPicker(page)).toHaveAttribute('data-provider', 'mock');
    await expect(gifSearch(page)).toHaveValue(DEMO_QUERY);
    await expect(gifHeading(page)).toHaveText(`Results for "${DEMO_QUERY}"`);
    await expectGridIds(page, mockSearch(DEMO_QUERY).map((g) => g.id));
    await expect(gifAttribution(page)).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    await stepShot(page, 12, 'picker-prefilled');

    // --- demo row 3: two ArrowRights, Enter -> the picker closes, the chip shows, the GIF lands
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    // The demo text assumes three results; the selection clamps when the catalogue has fewer, so the
    // assertion follows whatever is actually selected rather than a hard-coded id.
    const picked = await selectedGifId(page);
    expect(picked, 'a tile is selected before Enter').toBeTruthy();
    await page.keyboard.press('Enter');
    await expect(gifPicker(page)).toBeHidden();

    const firstRow = gifRowById(page, picked!);
    await expect(firstRow.first()).toBeVisible({ timeout: 15_000 });
    await expect(gifPending(page), 'the Sending GIF... chip clears once the event is acked').toBeHidden({
      timeout: 10_000,
    });
    const firstGifRow = row(page, await settledEventId(firstRow.first()));
    await expectGifPlaying(firstGifRow);
    await expect(firstGifRow.getByTestId('message-gif-badge')).toHaveText('GIF');
    await stepShot(page, 12, 'gif-sent');

    // --- demo row 4: scrolled out of view the image unmounts, scrolled back it animates again
    await scrollListToTop(page);
    const offscreen = await expect
      .poll(() => firstGifRow.getByTestId('message-gif').getAttribute('data-state'), { timeout: 8_000 })
      .toBe('offscreen')
      .then(() => true)
      .catch(() => false);
    if (offscreen) {
      await expect(firstGifRow.getByTestId('message-gif-placeholder')).toBeVisible();
      await stepShot(page, 12, 'gif-offscreen');
    } else {
      annotate(
        'note',
        'demo step 12 row 4: the row stayed inside the IntersectionObserver margin after scrolling to the top of the loaded window, so the placeholder was not observed here (AC-G8-3 covers it in gif.spec.ts).',
      );
    }
    await scrollListToBottom(page);
    await expectGifPlaying(firstGifRow);
    await stepShot(page, 12, 'gif-back-in-view');

    // --- demo row 5: the GIF button opens Trending; typing updates the results live
    await openGifPicker(page);
    await expect(gifHeading(page)).toHaveText('Trending');
    await expectGridIds(page, MOCK_IDS);
    await stepShot(page, 12, 'trending');

    await searchInPicker(page, SECOND_QUERY);
    const secondHits = mockSearch(SECOND_QUERY);
    await expectGridIds(page, secondHits.map((g) => g.id));
    await stepShot(page, 12, 'search-results');

    // --- demo row 6: clicking a tile sends it, same as row 3
    const chosen = secondHits[0];
    await pickGif(page, chosen.id);
    const secondRow = gifRowById(page, chosen.id);
    await expect(secondRow.first()).toBeVisible({ timeout: 15_000 });
    await expectGifPlaying(row(page, await settledEventId(secondRow.first())));
    await stepShot(page, 12, 'second-gif-sent');

    // --- demo row 7: `npm run gif:sample` — bob posts one and it arrives live, animating
    const bobGif = await sendGifMessage(bob, R.dev, {
      id: MOCK_IDS[MOCK_IDS.length - 1],
      origin: ORIGIN,
    });
    const bobRow = row(page, bobGif.eventId);
    await expect(bobRow).toBeVisible({ timeout: 20_000 });
    await expectGifPlaying(bobRow);
    await expect(bobRow.getByTestId('message-gif-badge')).toHaveText('GIF');
    await stepShot(page, 12, 'bob-gif');

    guard.assertClean();
  });
});

/* ================================================================== step 13: Phase 5 desktop demo (QA-28, AC-E8-2) */

/**
 * docs/archive/PHASE5_PLAN.md "Desktop demo script" rows 1-11, one screenshot per row into `e2e/results/demo/13-*`.
 * Window 1 / window 3 = the "alice" of the script, window 2 = the "bob". Played by two **throwaway accounts**
 * (owner + peer) in their own space with an encrypted `vault` room: row 2 sets up cross-signing for good, which
 * must never happen to the shared seeded alice. At most two contexts are open (window 2 closes before window 3).
 */
test.describe('step 13 — Phase 5 E2EE demo (rows 1-11)', () => {
  test('step 13 — set up, encrypted send, UTD for a newcomer, media, verify + unlock a new session, encrypted by default', async ({ browser }) => {
    test.setTimeout(420_000);
    const owner = await E2API.freshUser('demoowner');
    const peer = await E2API.freshUser('demopeer');
    const spaceId = await E2API.createRoom(owner.token, { name: 'Demo HQ', space: true, invite: [peer.userId] });
    const vault = await E2API.createRoom(owner.token, { name: 'vault', encrypted: true, spaceId, invite: [peer.userId] });
    await E2API.joinRoom(peer.token, spaceId);
    await E2API.joinRoom(peer.token, vault);
    const O: E2.Account = { username: owner.username, password: owner.password, displayName: owner.username };
    const P: E2.Account = { username: peer.username, password: peer.password, displayName: peer.username };
    annotate('demo-accounts', `owner ${owner.userId} plays alice, peer ${peer.userId} plays bob`);
    const openVault = async (p: Page): Promise<void> => {
      if (!(await channelItem(p, vault).isVisible().catch(() => false))) await openSpace(p, spaceId);
      await channelItem(p, vault).click();
      await expect(messageList(p)).toBeVisible();
    };

    // 1. log in: crypto stage, setup banner, lock on vault
    const w1 = await E2.secondContext(browser, O, { login: false });
    const stages = await E2.traceLoadingStages(w1.page);
    await E2.loginWith(w1.page, O);
    expect(await stages.stages()).toContain('crypto');
    await expect(E2.banner(w1.page)).toHaveAttribute('data-need', 'setup', { timeout: 20_000 });
    await expect(w1.page.getByTestId('security-banner-action')).toHaveText(/Set up/);
    await openVault(w1.page);
    await expect(w1.page.getByTestId('channel-header-lock')).toBeVisible();
    await stepShot(w1.page, 13, '01-setup-banner');

    // 2. set up: key shown once, banner gone, Verified pill
    const key = await E2.setUpEncryption(w1.page, owner.password);
    expect(key).toMatch(E2.RECOVERY_KEY_RE);
    await expect(E2.banner(w1.page)).toHaveCount(0, { timeout: 15_000 });
    await expect(w1.page.getByTestId('current-user')).toHaveAttribute('data-verified', 'true', { timeout: 15_000 });
    await stepShot(w1.page, 13, '02-verified');

    // 3. send, encrypted on the wire
    await typeAndSend(w1.page, 'hello from codec');
    const hello = await settledEventId(rowByText(w1.page, 'hello from codec'), 20_000);
    E2API.expectEncryptedOnWire(await E2API.rawEvent(owner.token, vault, hello));
    await stepShot(w1.page, 13, '03-hello-sent');

    // 4. window 2: the peer sees a no-backup placeholder for the message sent before his device existed
    const w2 = await E2.secondContext(browser, P);
    await E2.waitForStatus(w2.page);
    await expect(E2.banner(w2.page)).toHaveAttribute('data-need', 'setup', { timeout: 20_000 });
    await openVault(w2.page);
    const ph = await E2.expectUtd(w2.page, hello, 'no-backup', 20_000);
    await expect(ph).toContainText(/key backup/);
    await stepShot(w2.page, 13, '04-peer-placeholder');

    // 5. live message decrypts in window 2
    await typeAndSend(w1.page, 'second message');
    await E2.expectDecryptedRow(w2.page, 'second message', 5_000);
    await stepShot(w2.page, 13, '05-peer-live');

    // 6. image + voice note, decrypted in window 2; the server holds ciphertext
    await w1.page.getByTestId('composer-file-input').setInputFiles('e2e/fixtures/test-image.png');
    const imgRow = messageList(w1.page).locator('[data-testid^="message-$"]').filter({ has: w1.page.getByTestId('message-image') }).last();
    const imgId = await settledEventId(imgRow, 30_000);
    await w1.page.getByTestId('composer-mic').click();
    await expect(w1.page.getByTestId('recording-timer')).toHaveText('0:02', { timeout: 10_000 });
    await w1.page.getByTestId('recording-send').click();
    const voiceRow = messageList(w1.page).locator('[data-testid^="message-$"]').filter({ has: w1.page.getByTestId('voice-message') }).last();
    const voiceId = await settledEventId(voiceRow, 30_000);
    await expect(row(w2.page, imgId).getByTestId('message-image')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    const voice = row(w2.page, voiceId).getByTestId('voice-message');
    await expect(voice).toHaveAttribute('data-encrypted', 'true', { timeout: 20_000 });
    await voice.getByTestId('voice-play').click();
    await expect(voice.getByTestId('voice-pause')).toBeVisible({ timeout: 10_000 });
    const imgState = await E2.eventState(w1.page, vault, imgId);
    const bytes = await E2API.rawMediaBytes(owner.token, imgState.content!.file.url);
    expect(E2API.startsWith(bytes, E2API.PNG_SIGNATURE), 'the server returns ciphertext').toBe(false);
    await stepShot(w2.page, 13, '06-peer-media');
    await w2.close();

    // 7. window 3: the owner again (new device): verify banner, locked history with Unlock
    const w3 = await E2.secondContext(browser, O);
    await E2.waitForStatus(w3.page);
    await expect(E2.banner(w3.page)).toHaveAttribute('data-need', 'verify', { timeout: 20_000 });
    await openVault(w3.page);
    await E2.expectUtd(w3.page, hello, 'locked-backup', 20_000);
    await expect(row(w3.page, hello).getByTestId('message-undecryptable-action')).toHaveText(/Unlock/);
    await stepShot(w3.page, 13, '07-new-session-locked');

    // 8. verify with window 1: same emoji, both match
    await E2.verifyBetween(w1.page, w3.page);
    await expect(w3.page.getByTestId('current-user')).toHaveAttribute('data-verified', 'true', { timeout: 20_000 });
    await stepShot(w3.page, 13, '08-verified-by-emoji');

    // 9. unlock with the key (unless SAS already handed over the backup key): every placeholder flips, no reload
    // Window 1 holds the backup key, so the SAS usually hands it over and the restore runs by itself (the banner
    // shows `unlock` for a moment, then nothing). Only unlock by hand when the hint stays `unlock`.
    const settled = await E2.waitForCrypto(w3.page, (st) => st.hint === null && !st.recovery.busy, 'auto-restore after SAS', 15_000).catch(() => null);
    if (settled) {
      annotate('demo-row-9', 'after SAS the backup key came over with the verification; no manual Unlock was needed (docs/archive/PHASE5_PLAN.md rows 8-9 expect one)');
    } else {
      await E2.unlockWith(w3.page, key);
      await E2.closeDialog(w3.page, 'recovery-dialog');
    }
    await expect(row(w3.page, hello).getByTestId('message-body')).toHaveText('hello from codec', { timeout: 20_000 });
    await expect(row(w3.page, imgId).getByTestId('message-image')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(row(w3.page, voiceId).getByTestId('voice-message')).toBeVisible();
    await expect(messageList(w3.page).getByTestId('message-undecryptable')).toHaveCount(0);
    await stepShot(w3.page, 13, '09-unlocked');

    // 10. reload: still verified and decrypted, no banner; log out + in: banner back
    await w3.page.reload();
    await expect(w3.page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await E2.waitForStatus(w3.page);
    await expect(w3.page.getByTestId('current-user')).toHaveAttribute('data-verified', 'true', { timeout: 20_000 });
    await expect(E2.banner(w3.page)).toHaveCount(0, { timeout: 15_000 });
    await openVault(w3.page);
    await expect(row(w3.page, hello).getByTestId('message-body')).toHaveText('hello from codec', { timeout: 20_000 });
    await stepShot(w3.page, 13, '10-reloaded');
    await w3.page.getByTestId('logout-button').click();
    await E2.loginWith(w3.page, O);
    await expect(E2.banner(w3.page)).toBeVisible({ timeout: 20_000 });
    await stepShot(w3.page, 13, '10-new-device-banner');
    await w3.close();

    // 11. window 1: new channel and a DM with dave, both locked
    await openSpace(w1.page, spaceId);
    await w1.page.getByTestId('channel-add').click();
    await expect(w1.page.getByTestId('create-channel-encrypted-note')).toBeVisible();
    await w1.page.getByTestId('create-channel-name').fill('secrets');
    await w1.page.getByTestId('create-channel-submit').click();
    await expect(w1.page.getByTestId('create-channel-dialog')).toHaveCount(0, { timeout: 30_000 });
    await expect(w1.page.getByTestId('channel-header-name')).toContainText('secrets', { timeout: 20_000 });
    await expect(w1.page.getByTestId('channel-header-lock')).toBeVisible();
    await stepShot(w1.page, 13, '11-channel-locked');
    await openHome(w1.page);
    await w1.page.getByTestId('dm-new').click();
    await expect(w1.page.getByTestId('new-dm-encrypted-note')).toBeVisible();
    await w1.page.getByTestId('new-dm-user-id').fill(userId('dave'));
    await w1.page.getByTestId('new-dm-submit').click();
    await expect(w1.page.getByTestId('new-dm-dialog')).toHaveCount(0, { timeout: 30_000 });
    await expect(w1.page.getByTestId('channel-header-name')).toContainText(DISPLAY_NAMES.dave, { timeout: 20_000 });
    await expect(w1.page.getByTestId('channel-header-lock')).toBeVisible();
    await stepShot(w1.page, 13, '11-dm-locked');
    await w1.close();
  });

  test.afterEach(async ({ page }, info) => {
    await E2.e2eeAfterEach(page, info);
  });
});

/* ================================================================== step 14: Phase 7 desktop demo (QA-37, AC-R10-3) */

/**
 * docs/archive/PHASE7_PLAN.md "Desktop demo script" rows 1-7, one screenshot per sub-step into `e2e/results/demo/14-*`.
 * Window 1 = alice (`page` of the test), window 2 = dave in a second context: the seed's only encrypted DM is
 * `dm-alice-dave` (the script's "bob"). The 60 s ring of row 7 is shortened with `setRingTimeoutMs`. Rows 8-9 are
 * covered by call-room.spec.ts / call-dm.spec.ts (AC-R4-2, AC-R6-6, AC-R8).
 */
test.describe('step 14 — Phase 7 voice call demo (rows 1-7)', () => {
  test('step 14 — call, accept, mute, chat + bar, leave, decline, no answer + missed + call back', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await C.requireRtc(test);
    E2.requireUi('Dev B', 'header-call', 'call-screen', 'incoming-call', 'in-call-bar', 'message-call', 'call-back');
    const dm = await resolveRoom('dm-alice-dave');
    await C.cleanupCalls([dm]);
    const ALICE = userId('alice');
    const DAVE = userId('dave');
    await E2.loginWith(page, 'alice');
    await E2.waitForStatus(page);
    const w2 = await E2.secondContext(browser, 'dave');
    await E2.waitForStatus(w2.page);
    try {
      for (const p of [page, w2.page]) {
        await p.getByTestId('space-item-home').click();
        await p.getByTestId(`dm-item-${dm}`).click();
        await expect(messageList(p)).toBeVisible();
      }
      // 1. alice calls; dave's card
      await page.getByTestId('header-call').click();
      await expect(C.callScreen(page)).toHaveAttribute('data-state', 'calling');
      await expect(page.getByTestId('call-lock')).toBeVisible();
      await expect(C.incomingCard(w2.page)).toBeVisible({ timeout: 10_000 });
      await stepShot(page, 14, '01-calling');
      await stepShot(w2.page, 14, '01-incoming-card');
      // 2. accept: connected on both, two tiles, timer
      await w2.page.getByTestId('incoming-call-accept').click();
      for (const p of [page, w2.page]) await expect(C.callScreen(p)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
      await C.waitForCallState(page, C.connectedWith(DAVE), 'alice connected with dave', 30_000);
      await expect(C.participantTile(page, DAVE)).toBeVisible();
      await stepShot(page, 14, '02-connected');
      // 3. mute: crossed mic on both sides
      await page.getByTestId('call-mute').click();
      await expect(C.participantTile(w2.page, ALICE)).toHaveAttribute('data-muted', 'true', { timeout: 5_000 });
      await stepShot(w2.page, 14, '03-alice-muted');
      // 4. dave chats behind the minimised call; the bar reopens the screen
      await w2.page.getByTestId('call-minimise').click();
      await expect(w2.page.getByTestId('in-call-bar')).toContainText(/In call \d{2}:\d{2}/);
      const text = `demo 14 chat ${Date.now()}`;
      await typeAndSend(w2.page, text);
      await expect(rowByText(page, text)).toBeVisible({ timeout: 15_000 });
      await stepShot(w2.page, 14, '04-in-call-bar');
      await w2.page.getByTestId('in-call-bar').click();
      await expect(C.callScreen(w2.page)).toBeVisible();
      // 5. alice leaves: both close, started + ended lines
      await page.getByTestId('call-leave').click();
      for (const p of [page, w2.page]) await expect(C.callScreen(p)).toHaveCount(0, { timeout: 10_000 });
      for (const p of [page, w2.page]) {
        await expect(C.callLines(p, 'ended').last()).toContainText('Call ended', { timeout: 15_000 });
        await expect(C.callLines(p, 'started').last()).toContainText('started a voice call');
      }
      await stepShot(page, 14, '05-call-ended');
      // 6. dave calls, alice declines
      await w2.page.getByTestId('header-call').click();
      await expect(C.incomingCard(page)).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('incoming-call-decline').click();
      await expect(w2.page.getByTestId('call-status')).toHaveText(`${DISPLAY_NAMES.alice} declined`, { timeout: 10_000 });
      await expect(C.callLines(w2.page, 'declined').last()).toContainText(`${DISPLAY_NAMES.alice} declined`);
      await expect(C.callLines(page, 'declined').last()).toContainText('You declined');
      await stepShot(w2.page, 14, '06-declined');
      await expect(C.callScreen(w2.page)).toHaveCount(0, { timeout: 6_000 });
      // 7. dave calls, nobody answers (ring shortened): no answer, missed + call back, sidebar preview
      const ring = await C.ringTimeoutOverride(w2.page, 8_000);
      await openSpaceOrStay(page); // alice leaves the DM for #general...
      await page.getByTestId('space-item-home').click(); // ...and watches the DM row from Home
      await w2.page.getByTestId('header-call').click();
      await expect(C.incomingCard(page)).toBeVisible({ timeout: 10_000 });
      await expect(C.callScreen(w2.page)).toHaveAttribute('data-state', 'no-answer', { timeout: ring + 15_000 });
      await stepShot(w2.page, 14, '07-no-answer');
      await w2.page.getByTestId('call-close').click();
      await expect(page.getByTestId(`dm-item-${dm}`)).toHaveAttribute('data-preview', 'missed-call', { timeout: 15_000 });
      await stepShot(page, 14, '07-sidebar-missed');
      await page.getByTestId(`dm-item-${dm}`).click();
      const missed = page.locator('[data-testid="message-call"][data-kind="missed"][data-missed="true"]').last();
      await expect(missed).toContainText(`Missed call from ${DISPLAY_NAMES.dave}`);
      await stepShot(page, 14, '07-missed-line');
      await missed.getByTestId('call-back').click();
      await expect(C.callScreen(page)).toHaveAttribute('data-state', 'calling');
      await expect(C.incomingCard(w2.page)).toBeVisible({ timeout: 10_000 });
      await stepShot(page, 14, '07-call-back');
      await page.getByTestId('call-leave').click();
    } finally {
      await C.cleanupCalls([dm], [page, w2.page]);
      await w2.close();
    }
  });

  test.afterEach(async ({ page }, info) => {
    await E2.e2eeAfterEach(page, info);
  });
});

/** Row 7: alice must not be inside the DM when the missed line lands (the sidebar preview is the point). */
async function openSpaceOrStay(page: Page): Promise<void> {
  const acme = await resolveRoom('acme-hq');
  await openSpace(page, acme);
}
