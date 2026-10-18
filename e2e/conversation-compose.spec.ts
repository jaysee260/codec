/**
 * QA-5 — conversation suite, part compose: AC-B2, AC-B6, AC-B8, AC-B9, AC-B10 (docs/ACCEPTANCE.md).
 *
 * Split out of the former `conversation.spec.ts` (issue #2, docs/PERF_PLAN.md) so its parts can run on
 * different Playwright workers; the tests were moved verbatim (same titles, bodies, assertions, timeouts).
 * The three files are `conversation-timeline`, `conversation-compose` and `conversation-messages`.
 *
 *
 * Every test logs in fresh. Seeded messages are located by event id from `seed/seed-output.json`;
 * anything this run creates is located by its unique text inside `message-list`. Messages #1-#15
 * of #general are older than the initial ~30-event sync window, so tests that touch them call
 * `withFullHistory()` first to page the room in (see docs/ARCHITECTURE.md, "Initial window").
 *
 * Nothing here asserts an exact message count: the devs post into the same rooms while this runs.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { asUser, type ApiUser, type MatrixEventJson } from './fixtures/matrix-api.ts';
import {
  BODIES,
  DISPLAY_NAMES,
  NAMES,
  eventId,
  resolveRoom,
  userId,
} from './fixtures/seed.ts';
import {
  composer,
  hoverActions,
  messageList,
  openHome,
  paginateToTop,
  row,
  rowByText,
  scrollListToBottom,
  settledEventId,
} from './fixtures/ui.ts';

const ALICE = userId('alice');
const BOB = userId('bob');
const CAROL = userId('carol');
const DAVE = userId('dave');

let bob: ApiUser;
let admin: ApiUser;

const R = { general: '', random: '', dev: '', dmBob: '', lobby: '' };

/** #general event ids that are not in seed-output.json, resolved once from the live room. */
const E = { general2: '', general3: '', general34: '' };

test.beforeAll(async () => {
  R.general = await resolveRoom('general');
  R.random = await resolveRoom('random');
  R.dev = await resolveRoom('dev');
  R.lobby = await resolveRoom('lobby');
  R.dmBob = await resolveRoom('dm-alice-bob');
  bob = await asUser('bob');
  admin = await asUser('alice');

  E.general2 = await requireMessageId('A few ground rules', ALICE);
  E.general3 = await requireMessageId('Hey everyone', BOB);
  E.general34 = await requireMessageId(BODIES.general34, CAROL);
});

async function requireMessageId(text: string, sender: string): Promise<string> {
  const event = await bob.findMessage(R.general, text, sender);
  expect(event, `seeded #general message "${text}" from ${sender} not found on the homeserver`).toBeTruthy();
  return event!.event_id;
}

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'alice');
  await expect(messageList(page)).toBeVisible();
});

/** Pages #general all the way back so the oldest seeded messages are in the DOM. */
async function withFullHistory(page: Page): Promise<void> {
  // The round budget has to track how far #general has grown: the client pages ~30 events at a time,
  // and this homeserver's #general passed 400 events during Phase 2 (QA/dev traffic), which the old
  // 12-round default could no longer reach — the failure read "could not page back to its first
  // message", which looks like a product bug and is not one. 40 rounds covers ~1200 events; the loop
  // exits the moment `timeline-start` appears, so a fresh seed still costs the same two rounds.
  test.setTimeout(150_000);
  const start = page.getByTestId('timeline-start');
  const reached = await paginateToTop(page, async () => (await start.count()) > 0, 40);
  expect(
    reached,
    'could not page #general back to its first message (raise the round budget here if the room has grown again, or run npm run test:e2e:fresh)',
  ).toBe(true);
  await expect(row(page, eventId('general.first'))).toBeVisible();
}

test.describe('DEV-B-2 composer', () => {
  test('AC-B2-1 Enter sends the message and clears the input', async ({ page }) => {
    const text = `[qa] AC-B2-1 ${Date.now()}`;
    await composer(page).fill(text);
    await composer(page).press('Enter');

    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 5_000 });
    await expect(sent).toHaveAttribute('data-sender', ALICE);
    await expect(composer(page)).toHaveValue('');
  });

  test('AC-B2-2 Shift+Enter makes a newline, then Enter sends both lines', async ({ page }) => {
    const marker = Date.now();
    const before = await messageList(page).locator('[data-testid^="message-"]').count();

    await composer(page).click();
    await composer(page).pressSequentially(`line one ${marker}`);
    await composer(page).press('Shift+Enter');
    await composer(page).pressSequentially('line two');
    await expect(composer(page)).toHaveValue(`line one ${marker}\nline two`);
    expect(await messageList(page).locator('[data-testid^="message-"]').count()).toBe(before);

    await composer(page).press('Enter');
    const sent = rowByText(page, `line one ${marker}`);
    await expect(sent).toBeVisible({ timeout: 5_000 });
    await expect(sent).toContainText('line two');

    const bodyHtml = await sent.getByTestId('message-body').innerHTML();
    const rendered = await sent.getByTestId('message-body').innerText();
    expect(
      /<br\s*\/?>/i.test(bodyHtml) || rendered.includes('\n'),
      'the two lines must render with a line break',
    ).toBe(true);
  });

  test('AC-B2-3 the send button sends the message', async ({ page }) => {
    const text = `[qa] AC-B2-3 ${Date.now()}`;
    await composer(page).fill(text);
    await page.getByTestId('composer-send').click();
    await expect(rowByText(page, text)).toBeVisible({ timeout: 5_000 });
    await expect(composer(page)).toHaveValue('');
  });

  test('AC-B2-4 blank and whitespace-only input cannot be sent', async ({ page }) => {
    await expect(page.getByTestId('composer-send')).toBeDisabled();

    const before = await messageList(page).locator('[data-testid^="message-"]').count();
    await composer(page).fill('   ');
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    await composer(page).press('Enter');
    await expect(page.getByTestId('composer-send')).toBeDisabled();
    expect(await messageList(page).locator('[data-testid^="message-"]').count()).toBe(before);
  });

  test('AC-B2-5 typing sends a typing notification, and it stops on send', async ({ page }) => {
    const watcher = await bob.watchTyping(R.general);
    await composer(page).click();
    await composer(page).pressSequentially('typing for the notification');

    await watcher.waitForTyping([ALICE], 8_000);

    const text = `[qa] AC-B2-5 ${Date.now()}`;
    await composer(page).fill(text);
    await composer(page).press('Enter');
    await expect(rowByText(page, text)).toBeVisible({ timeout: 5_000 });

    // Sending must clear the typing state (the criterion allows up to 5 s when merely idling).
    await watcher.waitForNotTyping([ALICE], 6_000);
  });

  test('AC-B2-6 the placeholder names the channel, and the other user in a DM', async ({ page }) => {
    await expect(composer(page)).toHaveAttribute('placeholder', `Message #${NAMES.general}`);
    await openHome(page);
    await page.getByTestId(`dm-item-${R.dmBob}`).click();
    await expect(composer(page)).toHaveAttribute('placeholder', `Message @${DISPLAY_NAMES.bob}`);
  });
});

test.describe('DEV-B-6 replies', () => {
  test('AC-B6-1 the seeded reply shows a quote of its target with the author name', async ({ page }) => {
    await withFullHistory(page);
    const quote = row(page, eventId('general.reply')).getByTestId('message-reply-quote');
    await expect(quote).toBeVisible();
    await expect(quote.getByTestId('message-reply-quote-author')).toContainText(DISPLAY_NAMES.bob);
    await expect(quote).toContainText(BODIES.general6);
  });

  test('AC-B6-2/AC-B6-3 replying sets the banner and sends an m.in_reply_to relation', async ({ page }) => {
    // Freshness-independent: #34 has to be hoverable, not necessarily in the initial window.
    await withFullHistory(page);
    const actions = await hoverActions(page, E.general34);
    await actions.getByTestId('message-action-reply').click();

    const banner = page.getByTestId('composer-reply-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Replying to');
    await expect(banner).toContainText(DISPLAY_NAMES.carol);
    await expect(composer(page)).toBeFocused();

    const text = `[qa] Yes ${Date.now()}`;
    await composer(page).fill(text);
    await composer(page).press('Enter');

    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    await expect(sent.getByTestId('message-reply-quote')).toContainText(BODIES.general34);
    await expect(page.getByTestId('composer-reply-banner')).toHaveCount(0);

    // The row is keyed by the local echo id (`~...`) until the remote echo lands; polling a captured
    // string could never change, so wait for the settled `$` id before asking the server for it.
    const sentId = await settledEventId(sent);
    const event = await bob.getEvent(R.general, sentId);
    const relation = event.content['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined;
    expect(relation?.['m.in_reply_to']?.event_id, 'the event must relate to the quoted message').toBe(E.general34);
  });

  test('AC-B6-4 cancel and Escape clear reply mode, and the next send is a normal message', async ({ page }) => {
    // Freshness-independent: page back so #34 is hoverable however far the room has grown.
    await withFullHistory(page);

    // Cancel button.
    let actions = await hoverActions(page, E.general34);
    await actions.getByTestId('message-action-reply').click();
    await expect(page.getByTestId('composer-reply-banner')).toBeVisible();
    await page.getByTestId('composer-reply-cancel').click();
    await expect(page.getByTestId('composer-reply-banner')).toHaveCount(0);

    // Escape in the composer.
    actions = await hoverActions(page, E.general34);
    await actions.getByTestId('message-action-reply').click();
    await expect(page.getByTestId('composer-reply-banner')).toBeVisible();
    await composer(page).press('Escape');
    await expect(page.getByTestId('composer-reply-banner')).toHaveCount(0);

    const text = `[qa] AC-B6-4 plain ${Date.now()}`;
    await composer(page).fill(text);
    await composer(page).press('Enter');
    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    await expect(sent.getByTestId('message-reply-quote')).toHaveCount(0);
  });

  test('AC-B6-5 clicking a quote scrolls to the quoted message and highlights it', async ({ page }) => {
    await withFullHistory(page);
    const quote = row(page, eventId('general.reply')).getByTestId('message-reply-quote');
    await expect(quote).toBeVisible();

    await scrollListToBottom(page);
    await expect(quote).toBeVisible();
    await quote.scrollIntoViewIfNeeded();
    await quote.click();

    const target = row(page, eventId('general.replyTarget'));
    await expect(target).toBeInViewport({ timeout: 5_000 });
    // The flash is a transient class/animation; assert it is applied at least briefly.
    const flashed = await target.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.animationName !== 'none' || el.getAttribute('data-flash') === 'true';
    });
    expect(flashed, 'the quoted message must be highlighted briefly after the jump').toBe(true);
  });
});

test.describe('DEV-B-8 upload', () => {
  test('AC-B8-1 the attach button opens the file chooser', async ({ page }) => {
    await expect(page.getByTestId('composer-file-input')).toHaveCount(1);
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
    await page.getByTestId('composer-attach').click();
    expect(await chooser, 'clicking the paperclip must open a file chooser').toBeTruthy();
  });

  test('AC-B8-2 selecting a PNG uploads it and renders an m.image with the right dimensions', async ({ page }) => {
    test.setTimeout(60_000);
    const progress = page
      .getByTestId('upload-progress')
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    await page.getByTestId('composer-file-input').setInputFiles('e2e/fixtures/test-image.png');
    const progressSeen = await progress;

    const image = messageList(page).getByTestId('message-image').last();
    await expect(image).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(async () => (await lastImageEvent(bob, R.general))?.content?.msgtype, { timeout: 15_000 })
      .toBe('m.image');
    const event = (await lastImageEvent(bob, R.general))!;
    const info = event.content.info as { w?: number; h?: number; mimetype?: string } | undefined;
    expect(event.sender).toBe(ALICE);
    expect(info?.w, 'info.w must match the uploaded PNG').toBe(120);
    expect(info?.h, 'info.h must match the uploaded PNG').toBe(80);
    expect(info?.mimetype).toBe('image/png');

    expect(progressSeen, 'upload-progress must be shown while the upload is in flight').toBe(true);
  });

  test('AC-B8-3 selecting a text file renders an m.file download link with the filename', async ({ page }) => {
    test.setTimeout(60_000);
    await page.getByTestId('composer-file-input').setInputFiles('e2e/fixtures/test-file.txt');

    const fileRow = messageList(page).getByText('test-file.txt').last();
    await expect(fileRow).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const last = (await bob.messages(R.general, 30)).find(
            (e) => e.type === 'm.room.message' && e.content?.msgtype === 'm.file',
          );
          return last?.content?.body;
        },
        { timeout: 15_000 },
      )
      .toBe('test-file.txt');

    const link = messageList(page).locator('a[href*="/_matrix/"]', { hasText: 'test-file.txt' });
    await expect(link.last()).toBeVisible();
  });

  test.skip('AC-B8-4 pasting an image from the clipboard uploads it (manual check)', () => {
    // The criterion marks Playwright optional: a synthetic ClipboardEvent with a File in
    // `clipboardData` cannot be constructed from the page context in Chromium headless without
    // permissions that the harness does not grant. Verify by hand during the Wave 3 dry run.
  });
});

test.describe('DEV-B-9 edit and delete', () => {
  test('AC-B9-1 action availability follows power level and ownership', async ({ page }) => {
    const mine = await admin.send(R.general, `[qa] AC-B9-1 mine ${Date.now()}`);
    const theirs = await bob.send(R.general, `[qa] AC-B9-1 bob ${Date.now()}`);
    await expect(row(page, theirs)).toBeVisible({ timeout: 10_000 });

    // Alice on her own message: edit and delete.
    let actions = await hoverActions(page, mine);
    await expect(actions.getByTestId('message-action-edit')).toBeVisible();
    await expect(actions.getByTestId('message-action-delete')).toBeVisible();

    // Alice (admin, PL 100) on bob's message: delete but not edit.
    actions = await hoverActions(page, theirs);
    await expect(actions.getByTestId('message-action-delete')).toBeVisible();
    await expect(actions.getByTestId('message-action-edit')).toHaveCount(0);
  });

  test('AC-B9-1 carol (power level 0) gets neither action on other people messages', async ({ page }) => {
    const theirs = await bob.send(R.general, `[qa] AC-B9-1 carol view ${Date.now()}`);
    await loginAs(page, 'carol');
    await expect(messageList(page)).toBeVisible();
    await expect(row(page, theirs)).toBeVisible({ timeout: 15_000 });

    const actions = await hoverActions(page, theirs);
    await expect(actions.getByTestId('message-action-edit')).toHaveCount(0);
    await expect(actions.getByTestId('message-action-delete')).toHaveCount(0);
  });

  test('AC-B9-2 editing a message sends an m.replace and marks the row edited', async ({ page }) => {
    const original = `[qa] AC-B9-2 before ${Date.now()}`;
    const edited = `${original} after`;
    await composer(page).fill(original);
    await composer(page).press('Enter');
    const sent = rowByText(page, original);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    // Not `getAttribute` straight away: the row is still the local echo (`message-~...`) for a few ms.
    const sentId = await settledEventId(sent);

    const actions = await hoverActions(page, sentId);
    await actions.getByTestId('message-action-edit').click();
    await expect(page.getByTestId('composer-edit-banner')).toBeVisible();
    await expect(composer(page)).toHaveValue(original);

    await composer(page).fill(edited);
    await composer(page).press('Enter');

    await expect(row(page, sentId).getByTestId('message-body')).toContainText('after', { timeout: 10_000 });
    await expect(row(page, sentId).getByTestId('message-edited')).toBeVisible();
    await expect(page.getByTestId('composer-edit-banner')).toHaveCount(0);

    const relations = await bob.messages(R.general, 30);
    const replace = relations.find((e) => {
      const rel = e.content?.['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined;
      return rel?.rel_type === 'm.replace' && rel.event_id === sentId;
    });
    expect(replace, 'an m.replace event must have been sent').toBeTruthy();
  });

  test('AC-B9-3 ArrowUp in an empty composer edits my last message', async ({ page }) => {
    const text = `[qa] AC-B9-3 ${Date.now()}`;
    await composer(page).fill(text);
    await composer(page).press('Enter');
    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    // Wait for the remote echo: a still-pending local echo is not an editable event, so pressing
    // ArrowUp too early legitimately lands on the previous message.
    await settledEventId(sent);

    await expect(composer(page)).toHaveValue('');
    await composer(page).click();
    await composer(page).press('ArrowUp');

    await expect(page.getByTestId('composer-edit-banner')).toBeVisible();
    await expect(composer(page)).toHaveValue(text);
    await composer(page).press('Escape');
  });

  test('AC-B9-4 deleting a message through the dialog redacts the row', async ({ page }) => {
    const text = `[qa] AC-B9-4 ${Date.now()}`;
    await composer(page).fill(text);
    await composer(page).press('Enter');
    const sent = rowByText(page, text);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    // Not `getAttribute` straight away: the row is still the local echo (`message-~...`) for a few ms.
    const sentId = await settledEventId(sent);

    const actions = await hoverActions(page, sentId);
    await actions.getByTestId('message-action-delete').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();
    await page.getByTestId('delete-confirm').click();

    await expect(page.getByTestId('delete-dialog')).toHaveCount(0, { timeout: 10_000 });
    await expect(row(page, sentId).getByTestId('message-redacted')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('DEV-B-10 mention autocomplete', () => {
  test('AC-B10-1 typing @ca offers carol', async ({ page }) => {
    await composer(page).click();
    await composer(page).pressSequentially('@ca');
    const popup = page.getByTestId('mention-autocomplete');
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId(`mention-option-${CAROL}`)).toBeVisible();
    // Filtered to the current room: dave does not match "ca".
    await expect(popup.getByTestId(`mention-option-${DAVE}`)).toHaveCount(0);
  });

  test('AC-B10-2 accepting the option inserts the display name and sends a mention', async ({ page }) => {
    await composer(page).click();
    await composer(page).pressSequentially('@ca');
    await expect(page.getByTestId('mention-autocomplete')).toBeVisible();
    await page.getByTestId(`mention-option-${CAROL}`).click();

    await expect(composer(page)).toHaveValue(`@${DISPLAY_NAMES.carol} `);

    const marker = `mention ${Date.now()}`;
    await composer(page).pressSequentially(marker);
    await composer(page).press('Enter');

    const sent = rowByText(page, marker);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    await expect(sent.getByTestId('message-mention')).toBeVisible();

    const sentId = await settledEventId(sent);
    const event = await bob.getEvent(R.general, sentId);
    expect(String(event.content.formatted_body ?? '')).toContain(`matrix.to/#/${CAROL}`);
    const mentions = event.content['m.mentions'] as { user_ids?: string[] } | undefined;
    expect(mentions?.user_ids ?? []).toContain(CAROL);
  });

  test('AC-B10-3 Escape closes the popup without inserting', async ({ page }) => {
    await composer(page).click();
    await composer(page).pressSequentially('@ca');
    await expect(page.getByTestId('mention-autocomplete')).toBeVisible();
    await composer(page).press('Escape');
    await expect(page.getByTestId('mention-autocomplete')).toHaveCount(0);
    await expect(composer(page)).toHaveValue('@ca');
  });
});

/** The newest `m.image` message in a room, used to verify upload metadata. */
async function lastImageEvent(api: ApiUser, roomId: string): Promise<MatrixEventJson | undefined> {
  const chunk = await api.messages(roomId, 30);
  return chunk.find((e) => e.type === 'm.room.message' && e.content?.msgtype === 'm.image');
}
