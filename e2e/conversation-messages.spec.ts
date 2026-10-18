/**
 * QA-5 — conversation suite, part messages: AC-B4, AC-B5 (docs/ACCEPTANCE.md).
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
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import {
  BODIES,
  DISPLAY_NAMES,
  PICKER_KEYS,
  eventId,
  resolveRoom,
  userId,
} from './fixtures/seed.ts';
import {
  hoverActions,
  messageList,
  paginateToTop,
  row,
} from './fixtures/ui.ts';

const ALICE = userId('alice');
const BOB = userId('bob');
const CAROL = userId('carol');

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
