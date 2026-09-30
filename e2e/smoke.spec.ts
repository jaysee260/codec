/**
 * QA-3 — the smoke test *is* the demo script.
 *
 * One serial spec that walks docs/PLAN.md "Demo script (~2 minutes)" steps 1-10 in order as alice,
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
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { BODIES, DISPLAY_NAMES, NAMES, eventId, resolveRoom, uniqueName, userId } from './fixtures/seed.ts';
import { annotate, childRoomIds, ensureUnread, noteSeedDrift, revokePendingInvite } from './fixtures/state.ts';
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
  spaceItem,
  stepShot,
  typeAndSend,
} from './fixtures/ui.ts';

test.describe.configure({ mode: 'serial' });

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

test.describe('demo script (QA-3 smoke)', () => {
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
    annotate('timing', `login -> shell painted in ${elapsed} ms (docs/PLAN.md wants < 3000 ms)`);
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
    const list = page.getByTestId('channel-list');
    expect(await itemNames(list, 'channel-item-')).toEqual([NAMES.general, NAMES.random, NAMES.dev]);

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

    const box = await image.boundingBox();
    expect(box, 'the image must have a rendered box').toBeTruthy();
    expect(box!.width, 'thumbnail wider than the 400 px budget').toBeLessThanOrEqual(400);

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
});
