/**
 * QA-5 — conversation suite, part timeline: AC-B1, AC-B3, AC-B7 (docs/ACCEPTANCE.md).
 *
 * Split out of the former `conversation.spec.ts` (issue #2, docs/archive/PERF_PLAN.md) so its parts can run on
 * different Playwright workers; the tests were moved verbatim (same titles, bodies, assertions, timeouts).
 * The three files are `conversation-timeline`, `conversation-compose` and `conversation-messages`.
 *
 *
 * Every test logs in fresh. Seeded messages are located by event id from `seed/seed-output.json`;
 * anything this run creates is located by its unique text inside `message-list`. Messages #1-#15
 * of #general are older than the initial ~30-event sync window, so tests that touch them call
 * `withFullHistory()` first to page the room in (see docs/GOTCHAS.md, "Initial window").
 *
 * Nothing here asserts an exact message count: the devs post into the same rooms while this runs.
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { requireFreshSeed } from './fixtures/fresh.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import {
  BODIES,
  DISPLAY_NAMES,
  NAMES,
  eventId,
  resolveRoom,
  userId,
} from './fixtures/seed.ts';
import { annotate, ensureUnread } from './fixtures/state.ts';
import {
  atBottom,
  messageList,
  openChannel,
  openHome,
  paginateToTop,
  row,
  rowByText,
  scrollListToBottom,
  scrollListToTop,
  scrollMetrics,
} from './fixtures/ui.ts';

const ALICE = userId('alice');
const BOB = userId('bob');
const CAROL = userId('carol');

let bob: ApiUser;
let dave: ApiUser;

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

    // On a freshly restored homeserver the page request takes ~80 ms, so `timeline-loading` is mounted for well under
    // a polling interval and a `waitFor` can miss it (BUG-29). A MutationObserver installed in the same evaluate as the
    // scroll records it however briefly it is shown, as a rendered (visible) element.
    // Baseline is taken *after* the scroll, in the same evaluate so no commit can interleave:
    // scrolling to the top is the action under test, not part of the jump being measured.
    const beforeY = await messageList(page).evaluate((el, id) => {
      const w = window as unknown as { __sawTimelineLoading?: boolean };
      w.__sawTimelineLoading = false;
      const check = () => {
        const loading = document.querySelector<HTMLElement>('[data-testid="timeline-loading"]');
        if (loading && loading.getClientRects().length > 0 && getComputedStyle(loading).visibility !== 'hidden') {
          w.__sawTimelineLoading = true;
        }
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true });
      el.scrollTop = 0;
      check();
      return el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top;
    }, topId);
    const before = { y: beforeY };

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

    const loadingSeen = await page.evaluate(() => (window as unknown as { __sawTimelineLoading?: boolean }).__sawTimelineLoading);
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

test.describe('BUG-28 the list stays pinned to the bottom when its box shrinks', () => {
  /** Bottom edge of the newest rendered row relative to the list's bottom edge (<= 0 means fully visible). */
  async function lastRowOverflow(page: Page): Promise<number> {
    return messageList(page).evaluate((list) => {
      const rows = list.querySelectorAll<HTMLElement>('[data-event-id]');
      const last = rows[rows.length - 1];
      if (!last) return Number.NaN;
      return last.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
    });
  }

  test('a 48 px element mounting above the list, then a shorter viewport, both keep the newest message in view', async ({ page }) => {
    // #general is open at the bottom (beforeEach); make sure of it and read the list's height.
    await scrollListToBottom(page);
    expect(await atBottom(page, 8)).toBe(true);
    const { client: before } = await scrollMetrics(page);
    expect(await lastRowOverflow(page)).toBeLessThanOrEqual(0);

    // The banner's situation: a block appears above the channel header and takes 48 px from the list.
    await page.getByTestId('security-banner-host').evaluate((host) => {
      const block = document.createElement('div');
      block.setAttribute('data-testid', 'bug-28-probe');
      block.style.height = '48px';
      block.style.flex = '0 0 48px';
      host.appendChild(block);
    });
    await expect.poll(async () => (await scrollMetrics(page)).client, { timeout: 5_000 }).toBeLessThan(before);
    await expect.poll(() => atBottom(page, 8), { message: 'the list must re-pin after it shrank' }).toBe(true);
    expect(await lastRowOverflow(page), 'the newest message must still be fully visible').toBeLessThanOrEqual(0);

    // Same with a shorter viewport.
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 100 });
    await expect.poll(() => atBottom(page, 8), { message: 'the list must re-pin after a viewport resize' }).toBe(true);
    expect(await lastRowOverflow(page)).toBeLessThanOrEqual(0);

    // A reader who scrolled up is left alone: no re-pin on a size change while reading history.
    await scrollListToTop(page);
    await expect(page.getByTestId('scroll-to-bottom')).toBeVisible(); // the list knows it is not at the bottom
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    expect(await atBottom(page, 8), 'a reader scrolled up must not be yanked to the bottom').toBe(false);
    await expect(page.getByTestId('scroll-to-bottom')).toBeVisible();
  });
});
