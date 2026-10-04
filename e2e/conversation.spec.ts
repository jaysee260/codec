/**
 * QA-5 — conversation suite, AC-B1-1 .. AC-B10-3 (docs/ACCEPTANCE.md).
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
import { requireFreshSeed } from './fixtures/fresh.ts';
import { asUser, type ApiUser, type MatrixEventJson } from './fixtures/matrix-api.ts';
import {
  BODIES,
  DISPLAY_NAMES,
  NAMES,
  PICKER_KEYS,
  eventId,
  resolveRoom,
  userId,
} from './fixtures/seed.ts';
import { annotate, ensureUnread } from './fixtures/state.ts';
import {
  atBottom,
  composer,
  hoverActions,
  messageList,
  openChannel,
  openHome,
  paginateToTop,
  row,
  rowByText,
  scrollListToBottom,
  scrollListToTop,
  scrollMetrics,
  settledEventId,
} from './fixtures/ui.ts';

const ALICE = userId('alice');
const BOB = userId('bob');
const CAROL = userId('carol');
const DAVE = userId('dave');

let bob: ApiUser;
let dave: ApiUser;
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
  dave = await asUser('dave');
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

/** Visible body text of a row, with the reply-quote prefix removed. */
async function bodyText(page: Page, id: string): Promise<string> {
  return (await row(page, id).getByTestId('message-body').innerText()).trim();
}

test.describe('DEV-B-1 timeline rendering and grouping', () => {
  test('AC-B1-1 the newest seeded message is rendered and the list opens at the bottom', async ({ page }) => {
    // The criterion *is* "the initial window ends at the last seeded message", so it can only be
    // judged on a pristine seed: anything posted into #general afterwards pushes #40 out of it.
    await requireFreshSeed(test);
    await expect(row(page, eventId('general.last'))).toBeVisible();
    expect(await atBottom(page, 40), 'the list must open scrolled to the bottom').toBe(true);

    // Oldest-to-newest: the last seeded message sits below an earlier one in the DOM.
    const order = await messageList(page)
      .locator('[data-testid^="message-$"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    const lastIdx = order.indexOf(`message-${eventId('general.last')}`);
    const codeIdx = order.indexOf(`message-${eventId('general.code')}`);
    expect(codeIdx, '#31 must be in the initial window').toBeGreaterThanOrEqual(0);
    expect(lastIdx, '#40 must come after #31 (oldest first)').toBeGreaterThan(codeIdx);
  });

  test('AC-B1-2 consecutive messages from one sender are grouped under the first', async ({ page }) => {
    await withFullHistory(page);
    const first = row(page, eventId('general.first'));
    const second = row(page, E.general2);
    await expect(first.getByTestId('message-group-start')).toHaveCount(1);
    await expect(first.getByTestId('message-avatar')).toBeVisible();
    await expect(first.getByTestId('message-author')).toContainText(DISPLAY_NAMES.alice);
    await expect(second.getByTestId('message-group-start')).toHaveCount(0);
    await expect(second.getByTestId('message-avatar')).toHaveCount(0);
    await expect(second.getByTestId('message-author')).toHaveCount(0);
  });

  test('AC-B1-3 a change of sender starts a new group', async ({ page }) => {
    await withFullHistory(page);
    const third = row(page, E.general3);
    await expect(third.getByTestId('message-group-start')).toHaveCount(1);
    await expect(third.getByTestId('message-author')).toContainText(DISPLAY_NAMES.bob);
  });

  test('AC-B1-4 an edited message shows the new body plus (edited) and no fallback row', async ({ page }) => {
    // Freshness-independent: #18 only has to be *rendered*, so page back to it when the room has
    // grown past the initial window instead of demanding a fresh seed.
    await withFullHistory(page);
    await expect(row(page, eventId('general.edited'))).toBeVisible();
    expect(await bodyText(page, eventId('general.edited'))).toBe(BODIES.general18);
    await expect(row(page, eventId('general.edited')).getByTestId('message-edited')).toBeVisible();
    // The `* Looks great...` fallback body of the m.replace must never be its own row.
    await expect(messageList(page).getByText(`* ${BODIES.general18}`)).toHaveCount(0);
  });

  test('AC-B1-5 m.reaction and m.replace events do not render as rows', async ({ page }) => {
    await withFullHistory(page);
    const events = await bob.messagesDeep(R.general);
    const hidden = events.filter(
      (e) =>
        e.type === 'm.reaction' ||
        (e.type === 'm.room.message' &&
          (e.content?.['m.relates_to'] as { rel_type?: string } | undefined)?.rel_type === 'm.replace'),
    );
    expect(hidden.length, 'the seed must contain reactions and an edit to make this meaningful').toBeGreaterThan(0);
    for (const e of hidden) {
      await expect(page.getByTestId(`message-${e.event_id}`), `${e.type} ${e.event_id} must not be a row`).toHaveCount(0);
    }
  });

  test('AC-B1-6 a redacted message renders as "Message deleted" with no body', async ({ page }) => {
    const victim = await bob.send(R.general, `[qa] AC-B1-6 redact me ${Date.now()}`);
    await expect(row(page, victim)).toBeVisible({ timeout: 10_000 });

    await bob.redact(R.general, victim);

    const redacted = row(page, victim).getByTestId('message-redacted');
    await expect(redacted).toBeVisible({ timeout: 10_000 });
    await expect(redacted).toContainText('Message deleted');
    await expect(row(page, victim).getByTestId('message-body')).toHaveCount(0);
  });

  test('AC-B1-7 a day divider appears above the first message of the room', async ({ page }) => {
    await withFullHistory(page);
    const dividers = page.getByTestId('day-divider');
    await expect(dividers.first()).toBeVisible();

    const positions = await messageList(page)
      .locator('[data-testid="day-divider"], [data-testid^="message-$"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    const firstDivider = positions.indexOf('day-divider');
    const firstMessage = positions.findIndex((t) => t.startsWith('message-$'));
    expect(firstDivider, 'a day divider must precede the first message row').toBeGreaterThanOrEqual(0);
    expect(firstDivider).toBeLessThan(firstMessage);
  });

  test('AC-B1-8 timestamps use HH:MM for messages sent today', async ({ page }) => {
    // Freshness-independent: the assertion is on the *format* of a seeded row's timestamp, and the
    // same-day/other-day branch below already adapts, so paging back to #40 is enough.
    await withFullHistory(page);
    const stamp = row(page, eventId('general.last')).getByTestId('message-timestamp').first();
    await expect(stamp).toBeVisible();
    const seeded = await bob.getEvent(R.general, eventId('general.last'));
    const sameDay = new Date(seeded.origin_server_ts).toDateString() === new Date().toDateString();
    if (!sameDay) {
      annotate(
        'not-verifiable',
        'AC-B1-8: the seeded messages are no longer from today, so the HH:MM branch cannot be asserted; the DD/MM/YYYY HH:MM branch is checked instead.',
      );
      await expect(stamp).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    } else {
      await expect(stamp).toHaveText(/^\d{2}:\d{2}$/);
      annotate(
        'not-verifiable',
        'AC-B1-8: the DD/MM/YYYY HH:MM branch needs a room with messages from a previous day; the seed only produces same-day messages.',
      );
    }
  });
});

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

test.describe('DEV-B-3 backwards pagination', () => {
  test('AC-B3-1 the first message of the room is not in the initial window', async ({ page }) => {
    // Needs the seeded room shape: "the window holds the newest seeded messages but not #1".
    // On a grown room the second half passes vacuously, which would not prove anything.
    await requireFreshSeed(test);
    await expect(row(page, eventId('general.last'))).toBeVisible();
    await expect(row(page, eventId('general.first'))).toHaveCount(0);
  });

  test('AC-B3-2 scrolling to the top loads older messages without jumping', async ({ page }) => {
    test.setTimeout(60_000);
    const ids = await messageList(page)
      .locator('[data-testid^="message-$"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    const topId = ids[0];
    expect(topId, 'the list must already contain rows').toBeTruthy();
    const anchor = page.getByTestId(topId);

    const sawLoading = page
      .getByTestId('timeline-loading')
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    // Baseline is taken *after* the scroll, in the same evaluate so no commit can interleave:
    // scrolling to the top is the action under test, not part of the jump being measured.
    const beforeY = await messageList(page).evaluate((el, id) => {
      el.scrollTop = 0;
      return el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top;
    }, topId);
    const before = { y: beforeY };
    const loadingSeen = await sawLoading;

    await expect
      .poll(
        async () =>
          messageList(page)
            .locator('[data-testid^="message-$"]')
            .count(),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(ids.length);

    const after = (await anchor.boundingBox())!;
    expect(
      Math.abs(after.y - before.y),
      'the previously top-most message must stay at the same viewport position',
    ).toBeLessThanOrEqual(5);

    expect(loadingSeen, 'timeline-loading must be shown while the page request is in flight').toBe(true);
  });

  test('AC-B3-3 at the beginning of the room the banner shows and no further paging happens', async ({ page }) => {
    test.setTimeout(90_000);
    await withFullHistory(page);

    const start = page.getByTestId('timeline-start');
    await expect(start).toBeVisible();
    await expect(start).toContainText(`This is the beginning of #${NAMES.general}`);

    const paged: string[] = [];
    const listener = (url: string): void => {
      if (url.includes(`/rooms/${encodeURIComponent(R.general)}/messages`)) paged.push(url);
    };
    page.on('request', (req) => listener(req.url()));

    await scrollListToTop(page);
    await expect(start).toBeVisible();
    await expect
      .poll(() => paged.length, { timeout: 4_000, intervals: [500, 1_000] })
      .toBe(0);
    await expect(page.getByTestId('timeline-loading')).toHaveCount(0);
  });

  test('AC-B3-4 a new message auto-scrolls only when the list is already at the bottom', async ({ page }) => {
    test.setTimeout(60_000);
    // Scrolled up: the view must stay put.
    await scrollListToTop(page);
    const scrolledUp = await scrollMetrics(page);
    const away = `[qa] AC-B3-4 while scrolled up ${Date.now()}`;
    await bob.send(R.general, away);
    await expect(rowByText(page, away)).toHaveCount(1, { timeout: 15_000 });
    const afterAway = await scrollMetrics(page);
    expect(
      afterAway.top,
      'the list must not jump to the bottom while the user is reading history',
    ).toBeLessThan(scrolledUp.top + afterAway.height);
    expect(await atBottom(page, 40), 'must not have auto-scrolled to the bottom').toBe(false);

    // At the bottom: the new message must be brought into view.
    await scrollListToBottom(page);
    await expect.poll(() => atBottom(page, 40), { timeout: 10_000 }).toBe(true);
    const near = `[qa] AC-B3-4 while at the bottom ${Date.now()}`;
    await bob.send(R.general, near);
    await expect(rowByText(page, near)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => atBottom(page, 40), { timeout: 10_000 }).toBe(true);
  });
});

test.describe('DEV-B-4 formatted bodies and images', () => {
  test('AC-B4-1 the bold message renders a <strong>', async ({ page }) => {
    await withFullHistory(page);
    await expect(row(page, eventId('general.bold')).locator('strong')).toContainText('Q4 planning meeting');
  });

  test('AC-B4-2 the code block renders as a monospace pre/code block', async ({ page }) => {
    // Freshness-independent: page back until #31 is in the DOM (it starts inside the initial window
    // on a fresh seed, and drops out of it as the room grows).
    await withFullHistory(page);
    const code = row(page, eventId('general.code')).locator('pre code');
    await expect(code).toBeVisible();
    await expect(code).toContainText('npm run build && npm run deploy -- --env=prod');

    const font = await code.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase());
    expect(font, 'the code block must be monospace').toMatch(/mono|consolas|courier|menlo/);

    const pre = row(page, eventId('general.code')).locator('pre');
    const bg = await pre.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, 'the code block must have its own (dark) background').not.toBe('rgba(0, 0, 0, 0)');
  });

  test('AC-B4-3 links open in a new tab with noopener noreferrer', async ({ page }) => {
    await withFullHistory(page);
    const link = row(page, eventId('general.link')).locator('a[href="https://status.example.com"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  });

  test('AC-B4-4 a hostile formatted_body is sanitised', async ({ page }) => {
    const marker = `xss-${Date.now()}`;
    const html = `<img src=x onerror=alert(1)><script>alert(2)</script>hi ${marker}`;
    let alerted = false;
    page.on('dialog', async (d) => {
      alerted = true;
      await d.dismiss();
    });

    const sentId = await bob.sendHtml(R.general, `hi ${marker}`, html);
    const sent = row(page, sentId);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    await expect(sent.getByTestId('message-body')).toContainText(`hi ${marker}`);

    const inner = await sent.getByTestId('message-body').innerHTML();
    expect(inner.toLowerCase(), 'no script tag may survive sanitising').not.toContain('<script');
    expect(inner.toLowerCase(), 'no onerror handler may survive sanitising').not.toContain('onerror');
    expect(alerted, 'the payload must not execute').toBe(false);
  });

  test('AC-B4-5 the seeded image renders a homeserver thumbnail at most 400 px wide and opens full size', async ({
    page,
  }) => {
    await withFullHistory(page);
    const image = row(page, eventId('general.image')).getByTestId('message-image');
    await expect(image).toBeVisible();

    const src = (await image.getAttribute('src')) ?? '';
    expect(src, 'must be a homeserver media URL').toMatch(/^https?:\/\/[^/]+\/_matrix\//);
    const box = (await image.boundingBox())!;
    expect(box.width, 'thumbnail must be at most 400 px wide').toBeLessThanOrEqual(400);

    // A full-size link (new tab) or a lightbox on click satisfies the criterion.
    const anchor = row(page, eventId('general.image')).locator('a[target="_blank"]');
    if ((await anchor.count()) > 0) {
      await expect(anchor.first()).toHaveAttribute('href', /\/_matrix\//);
      return;
    }
    const popup = page.waitForEvent('popup', { timeout: 5_000 }).catch(() => null);
    await image.click();
    const opened = await popup;
    if (!opened) {
      await expect(page.getByTestId('image-lightbox')).toBeVisible({ timeout: 3_000 });
    } else {
      expect(opened.url()).toContain('/_matrix/');
      await opened.close();
    }
  });

  test('AC-B4-6 a URL in a plain-text body is auto-linkified', async ({ page }) => {
    const marker = `link-${Date.now()}`;
    const sentId = await bob.send(R.general, `see https://example.com/${marker} for details`);
    const sent = row(page, sentId);
    await expect(sent).toBeVisible({ timeout: 10_000 });
    const link = sent.locator(`a[href="https://example.com/${marker}"]`);
    await expect(link).toBeVisible();
  });

  test('AC-B4-7 a matrix.to user link renders as a mention pill with the display name', async ({ page }) => {
    await withFullHistory(page);
    const mention = row(page, eventId('general.mention')).getByTestId('message-mention');
    await expect(mention).toBeVisible();
    await expect(mention).toContainText(`@${DISPLAY_NAMES.carol}`);
    await expect(row(page, eventId('general.mention'))).not.toContainText('matrix.to');
  });
});

test.describe('DEV-B-5 reactions', () => {
  /** Removes alice's reaction with `key` from `targetId` so a re-run starts clean. */
  async function clearMyReaction(targetId: string, key: string): Promise<void> {
    const events = await admin.messagesDeep(R.general);
    for (const e of events) {
      const rel = e.content?.['m.relates_to'] as { rel_type?: string; event_id?: string; key?: string } | undefined;
      if (
        e.type === 'm.reaction' &&
        e.sender === ALICE &&
        rel?.event_id === targetId &&
        rel?.key === key &&
        !(e.unsigned as { redacted_because?: unknown } | undefined)?.redacted_because
      ) {
        await admin.redact(R.general, e.event_id).catch(() => undefined);
      }
    }
  }

  test('AC-B5-1 seeded reaction pills show their counts and highlight mine', async ({ page }) => {
    await withFullHistory(page);
    const party = row(page, eventId('general.first')).getByTestId('reaction-🎉');
    await expect(party).toBeVisible();
    await expect(party).toHaveAttribute('data-count', '3');
    await expect(party).toHaveAttribute('data-mine', 'false');

    const thumbs = row(page, eventId('general.reacted')).getByTestId('reaction-👍');
    await expect(thumbs).toBeVisible();
    await expect(thumbs).toHaveAttribute('data-count', '2');
    await expect(thumbs).toHaveAttribute('data-mine', 'true');
  });

  test('AC-B5-2 the react action opens a picker with the six hardcoded keys', async ({ page }) => {
    await withFullHistory(page);
    const actions = await hoverActions(page, eventId('general.reacted'));
    await actions.getByTestId('message-action-react').click();

    const picker = page.getByTestId('reaction-picker');
    await expect(picker).toBeVisible();
    for (const key of PICKER_KEYS) {
      await expect(picker.getByTestId(`reaction-picker-${key}`), `picker must offer ${key}`).toBeVisible();
    }
    await expect(picker.locator('[data-testid^="reaction-picker-"]')).toHaveCount(PICKER_KEYS.length);
  });

  test('AC-B5-3/AC-B5-4 picking a reaction adds mine, clicking it again removes it', async ({ page }) => {
    await clearMyReaction(eventId('general.reacted'), '🎉');
    await withFullHistory(page);

    const target = row(page, eventId('general.reacted'));
    const pill = target.getByTestId('reaction-🎉');
    await expect(pill).toHaveCount(0);

    const actions = await hoverActions(page, eventId('general.reacted'));
    await actions.getByTestId('message-action-react').click();
    await page.getByTestId('reaction-picker').getByTestId('reaction-picker-🎉').click();

    await expect(pill).toBeVisible({ timeout: 3_000 });
    await expect(pill).toHaveAttribute('data-count', '1');
    await expect(pill).toHaveAttribute('data-mine', 'true');

    await pill.click();
    await expect(pill).toHaveCount(0, { timeout: 3_000 });
  });

  test('AC-B5-4 clicking a pill that is not mine adds my reaction and increments it', async ({ page }) => {
    await clearMyReaction(eventId('general.first'), '🎉');
    await withFullHistory(page);

    const pill = row(page, eventId('general.first')).getByTestId('reaction-🎉');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('data-mine', 'false');
    const before = Number(await pill.getAttribute('data-count'));

    await pill.click();
    await expect(pill).toHaveAttribute('data-count', String(before + 1), { timeout: 5_000 });
    await expect(pill).toHaveAttribute('data-mine', 'true');

    // Put the seeded state back.
    await pill.click();
    await expect(pill).toHaveAttribute('data-count', String(before), { timeout: 5_000 });
    await expect(pill).toHaveAttribute('data-mine', 'false');
  });

  test('AC-B5-5 a reaction from bob appears live without a reload', async ({ page }) => {
    await withFullHistory(page);
    const target = row(page, eventId('general.reacted'));
    const laugh = target.getByTestId('reaction-😂');
    const before = (await laugh.count()) > 0 ? Number(await laugh.getAttribute('data-count')) : 0;

    const reactionId = await bob.react(R.general, eventId('general.reacted'), '😂');
    try {
      await expect(laugh).toBeVisible({ timeout: 10_000 });
      await expect(laugh).toHaveAttribute('data-count', String(before + 1));
    } finally {
      await bob.redact(R.general, reactionId).catch(() => undefined);
    }
  });

  test('AC-B5-6 a pill title lists the reactor display names', async ({ page }) => {
    await withFullHistory(page);
    const party = row(page, eventId('general.first')).getByTestId('reaction-🎉');
    await expect(party).toBeVisible();
    const title = (await party.getAttribute('title')) ?? '';
    expect(title, 'the pill tooltip must name the reactors').toContain(DISPLAY_NAMES.bob);
    expect(title).toContain(DISPLAY_NAMES.carol);
    expect(title).toContain(DISPLAY_NAMES.dave);
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

test.describe('DEV-B-7 typing indicator and read receipts', () => {
  test('AC-B7-1 bob typing shows and clears the indicator in the DM', async ({ page }) => {
    await openHome(page);
    await page.getByTestId(`dm-item-${R.dmBob}`).click();
    await expect(messageList(page)).toBeVisible();

    await bob.typing(R.dmBob, true, 20_000);
    const indicator = page.getByTestId('typing-indicator');
    await expect(indicator).toBeVisible({ timeout: 3_500 });
    await expect(indicator).toContainText(`${DISPLAY_NAMES.bob} is typing`);

    await bob.typing(R.dmBob, false);
    await expect(indicator).toHaveCount(0, { timeout: 8_000 });
  });

  test('AC-B7-2 two typists are listed by name and alice is never listed', async ({ page }) => {
    await bob.typing(R.general, true, 20_000);
    await dave.typing(R.general, true, 20_000);
    try {
      const indicator = page.getByTestId('typing-indicator');
      await expect(indicator).toBeVisible({ timeout: 5_000 });
      await expect(indicator).toContainText(DISPLAY_NAMES.bob, { timeout: 5_000 });
      await expect(indicator).toContainText(DISPLAY_NAMES.dave, { timeout: 5_000 });
      await expect(indicator).toContainText('are typing');
      await expect(indicator).not.toContainText(DISPLAY_NAMES.alice);
    } finally {
      await bob.typing(R.general, false).catch(() => undefined);
      await dave.typing(R.general, false).catch(() => undefined);
    }
  });

  test('AC-B7-3 opening a room at the bottom sends a read receipt for its last event', async ({ page }) => {
    const ensured = await ensureUnread(R.random, 1);
    expect(ensured.count).toBeGreaterThan(0);
    const last = await bob.lastMessage(R.random);
    expect(last, '#random must contain messages').toBeTruthy();

    await openChannel(page, R.random);
    await expect(messageList(page)).toBeVisible();

    // Verified through a second user: bob can see alice's m.read receipt.
    await expect
      .poll(() => bob.readReceiptOf(R.random, ALICE), { timeout: 8_000, intervals: [300, 500, 1_000] })
      .toBe(last!.event_id);
  });

  test('AC-B7-4 a message that arrives while the room is open is receipted', async ({ page }) => {
    await openChannel(page, R.dev);
    await expect(messageList(page)).toBeVisible();
    await scrollListToBottom(page);

    const sentId = await bob.send(R.dev, `[qa] AC-B7-4 ${Date.now()}`);
    await expect(row(page, sentId)).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(() => bob.readReceiptOf(R.dev, ALICE), { timeout: 10_000, intervals: [300, 500, 1_000] })
      .toBe(sentId);
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

