/**
 * QA-15 — desktop thread suite, AC-T1 .. AC-T9 (docs/PHASE3_ACCEPTANCE.md).
 *
 * ## Dirty-seed contract
 * Every test creates **its own** thread root (bob via the API, so alice can use "Reply in thread" on
 * someone else's message) with a unique body, and asserts only on ids it created or on *relative*
 * deltas. Nothing here needs a fresh seed, nothing asserts an absolute row or thread count, and the
 * Threads list criteria assert the relative order of this run's own threads — other runs' threads are
 * expected to be in the list.
 *
 * ## Wave 8 note (why tests can skip)
 * Dev A (DEV-A-17/18) and Dev B (DEV-B-18..22) are implementing while this suite runs, so each test
 * declares the UI entry point it needs via `requireThreadUi` and skips with a `not-built` annotation
 * when that entry point is absent (`e2e/fixtures/threads.ts` documents the probes). A test that runs
 * and fails is therefore a real bug or a test defect, never "not implemented yet". Pure-API criteria
 * (the wire contract, the sync filter, main-timeline hygiene) declare nothing and always run.
 *
 * ## Deviations from the criteria text, recorded on purpose
 *  - AC-T2-4 / AC-T6-4 say "35 API replies"; this suite builds **40** (the stakeholder's QA brief
 *    asks for a 40-reply thread). 40 > 35 is strictly harder: more pages, same assertions.
 *  - "within 3 s" criteria poll for 5 s. Sync delivery on this homeserver jitters by a second or so
 *    under load and the criterion is about live updates arriving without a reload, not about 3 000 ms;
 *    anything slower than 5 s is reported as a failure.
 *  - AC-T2-6 wants a local echo "within 200 ms". Playwright's own press -> locator round trip is
 *    ~100 ms, so the measured value is recorded as an annotation and the assertion is the practical
 *    bound (1 s): a lost echo fails, a 250 ms echo does not.
 *  - AC-T3-5 (Android back closes the thread) is **manual, device only** — see docs/BUGS.md.
 *  - AC-T1-1's first half ("`startClient` passes `threadSupport: true`") is a source review; it is
 *    asserted here by reading `src/lib/matrix/client.ts`, which is cheap and catches a revert.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAs } from './fixtures/auth.ts';
import {
  asUser,
  isMainReceipt,
  threadRelationOf,
  type ApiUser,
  type MatrixEventJson,
} from './fixtures/matrix-api.ts';
import { DISPLAY_NAMES, PICKER_KEYS, resolveRoom, userId } from './fixtures/seed.ts';
import { annotate } from './fixtures/state.ts';
import {
  badgeCount,
  composer,
  hoverActions,
  messageList,
  openChannel,
  openHome,
  row,
  scrollListToBottom,
  settledEventId,
  paginateToTop,
} from './fixtures/ui.ts';
import {
  avatarNames,
  closeThread,
  isThreadOpen,
  openThreadFromList,
  openThreadFromMessage,
  openThreadFromSummary,
  openThreadsList,
  paginateThreadToTop,
  replyInThread,
  replyInThreadAndSettle,
  requireThreadUi,
  resetSession,
  roomRowIds,
  seedThread,
  stableRow,
  threadAtBottom,
  threadComposer,
  threadDivider,
  threadList,
  threadListEmpty,
  threadListItem,
  threadListOrder,
  threadMessageList,
  threadPanel,
  threadRootEl,
  threadRow,
  threadRowByText,
  threadRowIds,
  threadSummary,
  threadsButton,
  threadsUnreadDot,
  threadTyping,
  uniqueBody,
} from './fixtures/threads.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const ALICE = userId('alice');
const BOB = userId('bob');

/** A live update must arrive without a reload; the criteria say 3 s, we allow 5 (see the header). */
const LIVE = 5_000;
/** 'BR' - the initials badge shown when a user has no avatar image. */
const initialsOfBob = 'BR';
/** Replies in the big pagination thread (the criteria say 35; the QA brief says 40). */
const BIG_THREAD_REPLIES = 40;

let alice: ApiUser;
let bob: ApiUser;

const R = { general: '', random: '', dev: '', dmBob: '', dmCarol: '' };

test.beforeAll(async () => {
  R.general = await resolveRoom('general');
  R.random = await resolveRoom('random');
  R.dev = await resolveRoom('dev');
  R.dmBob = await resolveRoom('dm-alice-bob');
  R.dmCarol = await resolveRoom('dm-alice-carol');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

/* ------------------------------------------------------------------ local helpers */

/**
 * Logs alice in and opens #general. `resetSession` first because `requireThreadUi` runs its probe in
 * a second page of this same context, which shares origin storage with this one.
 */
async function openGeneral(page: Page): Promise<void> {
  await resetSession(page);
  await loginAs(page, 'alice');
  await openChannel(page, R.general);
}

/**
 * Creates a root (and optional replies) as bob **after** the page is live, so it arrives over sync
 * into the room's initial window and `message-{rootId}` renders without any pagination.
 */
async function rootInView(
  page: Page,
  opts: { replies?: number; label?: string; roomId?: string } = {},
): Promise<{ rootId: string; rootBody: string; replyIds: string[] }> {
  const roomId = opts.roomId ?? R.general;
  const seeded = await seedThread({
    roomId,
    replies: opts.replies ?? 0,
    rootBody: uniqueBody(opts.label ?? 'QA root'),
  });
  await stableRow(page, seeded.rootId);
  return seeded;
}

/** The 40-reply thread, built once per run and only when a test that needs it actually runs. */
let bigThread: Promise<{ rootId: string; rootBody: string; replyIds: string[] }> | undefined;
function theBigThread(): Promise<{ rootId: string; rootBody: string; replyIds: string[] }> {
  bigThread ??= seedThread({
    roomId: R.general,
    replies: BIG_THREAD_REPLIES,
    rootBody: uniqueBody('QA big thread root'),
    replyBody: (i) => `QA big reply ${String(i + 1).padStart(2, '0')}`,
  });
  return bigThread;
}

/** Field-by-field check of the thread reply contract (docs/PHASE3_ACCEPTANCE.md). */
function expectThreadRelation(event: MatrixEventJson, rootId: string, inReplyTo: string): void {
  const relation = threadRelationOf(event);
  expect(relation, `${event.event_id} has an m.relates_to`).toBeTruthy();
  expect(relation!.rel_type).toBe('m.thread');
  expect(relation!.event_id, 'm.relates_to.event_id is the root, never a reply').toBe(rootId);
  expect(relation!.is_falling_back).toBe(true);
  expect(relation!['m.in_reply_to']?.event_id).toBe(inReplyTo);
  // No reply fallback text in the body (the contract forbids it).
  expect(String(event.content.body ?? ''), 'body carries no "> " reply fallback').not.toMatch(/^> </);
}

/* ================================================================== AC-T1 flip + hygiene */

test.describe('AC-T1 thread support flip and main-timeline hygiene', () => {
  test('AC-T1-1 startClient passes threadSupport and the sync filter asks for unread_thread_notifications', async ({
    page,
  }) => {
    // Half 1 (review): the flip itself.
    const clientSrc = readFileSync(resolve(HERE, '../src/lib/matrix/client.ts'), 'utf8');
    expect(clientSrc, 'src/lib/matrix/client.ts passes threadSupport: true').toMatch(
      /threadSupport:\s*true/,
    );

    // Half 2: the filter the SDK registered for /sync really carries the thread-unread flag.
    const syncRequest = page.waitForRequest(
      (req) => /\/_matrix\/client\/v3\/sync\?/.test(req.url()) && req.url().includes('filter='),
      { timeout: 30_000 },
    );
    await resetSession(page);
    await loginAs(page, 'alice');
    const filterParam = new URL((await syncRequest).url()).searchParams.get('filter')!;
    annotate('sync-filter', `filter=${filterParam}`);

    let filterBody: Record<string, unknown> | undefined;
    if (filterParam.startsWith('{')) {
      filterBody = JSON.parse(filterParam) as Record<string, unknown>;
    } else {
      filterBody = await alice.getFilter(filterParam);
    }
    expect(filterBody, `filter ${filterParam} resolves`).toBeTruthy();
    const timeline = (filterBody as { room?: { timeline?: Record<string, unknown> } }).room?.timeline;
    expect(timeline?.unread_thread_notifications).toBe(true);
  });

  test('AC-T1-2 a thread reply never becomes a row in the channel timeline', async ({ page }) => {
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T1-2 root' });

    const before = await roomRowIds(page);
    const replyId = await bob.sendThreadReply(R.general, rootId, uniqueBody('QA T1-2 thread reply'));
    // Sleep-free "3 s later": a *main* message sent after the reply is the sentinel. When its row is
    // on screen, sync has delivered everything up to and including it, so a leaked reply would be
    // rendered by now.
    const sentinelBody = uniqueBody('QA T1-2 sentinel');
    const sentinelId = await bob.send(R.general, sentinelBody);
    await expect(row(page, sentinelId)).toBeVisible({ timeout: 15_000 });

    const after = await roomRowIds(page);
    expect(after, 'the channel gained exactly the sentinel row').toEqual([...before, sentinelId]);
    expect(after, 'the thread reply is not a row in message-list').not.toContain(replyId);
    await expect(messageList(page).getByTestId(`message-${replyId}`)).toHaveCount(0);
  });

  test('AC-T1-3 a falling-back thread reply renders no reply quote; a real reply still does', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, replyIds } = await rootInView(page, { replies: 1, label: 'QA T1-3 root' });

    await openThreadFromMessage(page, rootId);
    const reply = threadRow(page, replyIds[0]!);
    await expect(reply).toBeVisible({ timeout: LIVE });
    await expect(
      reply.getByTestId('message-reply-quote'),
      'is_falling_back: true is a fallback, not a quote',
    ).toHaveCount(0);
    await expect(threadPanel(page).getByTestId('message-reply-quote')).toHaveCount(0);

    // AC-B6-1 still holds: a *normal* reply in the room does show its quote.
    await closeThread(page);
    const targetBody = uniqueBody('QA T1-3 quote target');
    const targetId = await bob.send(R.general, targetBody);
    await expect(row(page, targetId)).toBeVisible({ timeout: 15_000 });
    const quoteBody = uniqueBody('QA T1-3 quoting reply');
    const quoteId = await bob.send(R.general, quoteBody, {
      'm.relates_to': { 'm.in_reply_to': { event_id: targetId } },
    });
    await expect(row(page, quoteId)).toBeVisible({ timeout: 15_000 });
    await expect(row(page, quoteId).getByTestId('message-reply-quote')).toBeVisible();
  });

  test('AC-T1-4 the room receipt is thread_id main and a thread reply does not raise the room badge', async ({
    page,
  }) => {
    // A thread root in #random that alice will have read before bob replies into it.
    const { rootId } = await seedThread({ roomId: R.random, rootBody: uniqueBody('QA T1-4 root') });

    await resetSession(page);
    await loginAs(page, 'alice');
    await openChannel(page, R.random);
    await scrollListToBottom(page);
    const lastMain = (await bob.lastMessage(R.random))!.event_id;

    // The badge clears (AC-A5 / AC-B7-3 behaviour) ...
    await expect
      .poll(() => badgeCount(page.getByTestId(`channel-unread-${R.random}`)), { timeout: 15_000 })
      .toBeNull();

    // ... and the receipt the app sent for the room timeline is the threaded "main" one.
    const mainReceipt = await expect
      .poll(() => alice.readReceiptOf(R.random, ALICE), { timeout: 15_000, intervals: [300, 500, 1_000] })
      .not.toBeUndefined()
      .then(() => alice.readReceiptOf(R.random, ALICE));
    const receipts = await alice.getReceipts(R.random);
    const data = receipts[mainReceipt!]?.[ALICE];
    annotate('main-receipt', `${mainReceipt} thread_id=${data?.thread_id ?? '(absent)'} (last main event ${lastMain})`);
    expect(isMainReceipt(data), 'the room receipt is a main-timeline receipt').toBe(true);
    expect(data?.thread_id, 'the SDK stamps thread_id: "main" once threadSupport is on').toBe('main');

    // Now alice watches #general while bob replies in #random's thread: the room badge must not move.
    await openChannel(page, R.general);
    const badgeBefore = await badgeCount(page.getByTestId(`channel-unread-${R.random}`));
    await bob.sendThreadReply(R.random, rootId, uniqueBody('QA T1-4 thread reply'));
    // Sentinel: a *thread* reply in #general's own room tells us sync ran, without touching #random.
    const marker = uniqueBody('QA T1-4 marker');
    const markerId = await bob.send(R.general, marker);
    await expect(row(page, markerId)).toBeVisible({ timeout: 15_000 });

    const badgeAfter = await badgeCount(page.getByTestId(`channel-unread-${R.random}`));
    annotate('random-badge', `before=${badgeBefore ?? 'none'} after=${badgeAfter ?? 'none'}`);
    expect(badgeAfter ?? 0, 'a thread reply must not raise the room badge').toBeLessThanOrEqual(
      badgeBefore ?? 0,
    );
  });

  test('AC-T1-6 a reaction bob adds to a thread reply shows in the panel row', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, replyIds } = await rootInView(page, { replies: 1, label: 'QA T1-6 root' });

    await openThreadFromMessage(page, rootId);
    const reply = threadRow(page, replyIds[0]!);
    await expect(reply).toBeVisible({ timeout: LIVE });

    const key = PICKER_KEYS[3]; // 🎉
    await bob.react(R.general, replyIds[0]!, key);
    const pill = reply.getByTestId(`reaction-${key}`);
    await expect(pill).toBeVisible({ timeout: LIVE });
    await expect(pill).toHaveAttribute('data-count', '1');
  });
});

/* ================================================================== AC-T2 source, sends, hooks */

test.describe('AC-T2 timeline source, sends and hooks', () => {
  test('AC-T2-1/AC-T2-2 a reply sent from the panel matches the wire contract exactly', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T2-1 root' });

    await openThreadFromMessage(page, rootId);

    // First reply: m.in_reply_to is the root.
    const firstBody = uniqueBody('QA T2 first reply');
    const firstId = await replyInThreadAndSettle(page, firstBody);
    expectThreadRelation(await alice.getEvent(R.general, firstId), rootId, rootId);

    // Second reply: m.in_reply_to is the *first reply's* server id, never a local echo.
    const secondBody = uniqueBody('QA T2 second reply');
    const secondId = await replyInThreadAndSettle(page, secondBody);
    const second = await alice.getEvent(R.general, secondId);
    expectThreadRelation(second, rootId, firstId);
    expect(
      threadRelationOf(second)!['m.in_reply_to']!.event_id,
      'm.in_reply_to must never be a ~ local echo id',
    ).toMatch(/^\$/);
  });

  test('AC-T2-3 sendText rejects replyTo together with threadRoot and sends nothing', async ({
    page,
  }) => {
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T2-3 root' });
    const body = uniqueBody('QA T2-3 must not be sent');

    // The dev-only window hook exposes the real action module (src/app/devtools.ts), so this drives
    // the product's own `sendText` rather than re-implementing its rule.
    const outcome = await page.evaluate(
      async ([roomId, text, root]) => {
        const hook = (window as unknown as { __matrixPoc?: { actions?: Record<string, unknown> } })
          .__matrixPoc;
        const sendText = hook?.actions?.sendText as
          | ((r: string, b: string, o: Record<string, unknown>) => Promise<unknown>)
          | undefined;
        if (!sendText) return { available: false, rejected: false, message: 'no dev hook' };
        try {
          await sendText(roomId as string, text as string, {
            replyTo: root as string,
            threadRoot: root as string,
          });
          return { available: true, rejected: false, message: 'resolved' };
        } catch (err) {
          return { available: true, rejected: true, message: String((err as Error)?.message ?? err) };
        }
      },
      [R.general, body, rootId] as const,
    );
    annotate('sendText-outcome', JSON.stringify(outcome));
    expect(outcome.available, 'window.__matrixPoc.actions.sendText is reachable in the dev build').toBe(
      true,
    );
    // Both halves of the criterion are reported from one run: a soft assertion on the rejection, then
    // the harder question of whether an event reached the server anyway (and in what shape).
    expect.soft(outcome.rejected, 'replyTo + threadRoot must reject').toBe(true);
    const landed = await alice.findMessage(R.general, body);
    if (landed) {
      annotate(
        'sent-anyway',
        `${landed.event_id} m.relates_to=${JSON.stringify(landed.content['m.relates_to'])}`,
      );
    }
    expect(landed, 'no event was sent').toBeUndefined();
  });

  test(`AC-T2-4 a ${BIG_THREAD_REPLIES}-reply thread pages fully in, oldest first, no duplicates`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await requireThreadUi(test, page, 'thread-panel');
    const { rootId, replyIds } = await theBigThread();
    const oldestFirst = [...replyIds];

    await openGeneral(page);
    // A thread built earlier (theBigThread is reused per worker) can fall out of #general's initial window when
    // other specs post after it: page back to the root (dirty-seed rule, e2e/README.md) instead of waiting for it.
    await paginateToTop(page, async () => (await row(page, rootId).count()) > 0, 12);
    await expect(row(page, rootId)).toBeVisible({ timeout: 20_000 });
    await openThreadFromMessage(page, rootId);
    await expect(threadMessageList(page)).toBeVisible();

    const allShown = async (): Promise<boolean> => (await threadRowIds(page)).length >= oldestFirst.length;
    const paged = await paginateThreadToTop(page, allShown, 15);
    const ids = await threadRowIds(page);
    annotate('thread-pagination', `${ids.length}/${oldestFirst.length} rows after paging (paged=${paged})`);

    expect(new Set(ids).size, 'no duplicate message ids in the panel').toBe(ids.length);
    expect(ids.filter((id) => oldestFirst.includes(id))).toEqual(oldestFirst);
    await expect(page.getByTestId('thread-timeline-start')).toBeVisible();
  });

  test('AC-T2-5 the server summary feeds the row before the thread is ever opened', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-summary');
    // Created *before* alice logs in, so the only possible source is the bundled server summary.
    const { rootId, replyIds } = await seedThread({
      roomId: R.general,
      replies: 3,
      rootBody: uniqueBody('QA T2-5 root'),
    });
    const serverSummary = await alice.getThreadSummary(R.general, rootId);
    annotate('server-summary', JSON.stringify(serverSummary));
    expect(serverSummary?.count, 'Synapse bundles the count on the root').toBe(3);
    const latest = await alice.getEvent(R.general, replyIds[2]!);

    await openGeneral(page);
    await expect(row(page, rootId)).toBeVisible({ timeout: 20_000 });

    const summary = threadSummary(page, rootId);
    await expect(summary).toBeVisible({ timeout: LIVE });
    await expect(summary).toHaveAttribute('data-count', '3');
    await expect(summary.getByTestId('thread-summary-count')).toHaveText('3 replies');
    await expect(summary.getByTestId('thread-summary-time')).toHaveText(/just now|min ago/);
    // The latest sender is represented in the avatars. An avatar is an image or an initials badge,
    // so identity is read from title/aria-label/alt, never from the stack's text (see `avatarNames`).
    const avatars = summary.getByTestId('thread-summary-avatars');
    await expect(avatars).toBeVisible();
    expect(latest.sender).toBe(BOB);
    const faces = await avatarNames(avatars);
    annotate('summary-avatars', JSON.stringify(faces));
    expect(faces.length, 'at least the latest sender has an avatar').toBeGreaterThanOrEqual(1);
    expect(
      faces.some((name) => name.includes(DISPLAY_NAMES.bob) || name.includes(initialsOfBob)),
      `the latest sender (${DISPLAY_NAMES.bob}) is among the avatars: ${JSON.stringify(faces)}`,
    ).toBe(true);

    // Opening the thread must not change the count (SDK agrees with the server).
    await requireThreadUi(test, page, 'thread-panel');
    await openThreadFromSummary(page, rootId);
    await expect(summary).toHaveAttribute('data-count', '3');
    await expect(threadDivider(page)).toHaveText('3 replies');
  });

  test('AC-T2-7 the Threads list is newest-activity first and reorders live', async ({ page }) => {
    await requireThreadUi(test, page, 'threads-list');
    const a = await seedThread({ roomId: R.general, replies: 1, rootBody: uniqueBody('QA T2-7 thread A') });
    const b = await seedThread({ roomId: R.general, replies: 1, rootBody: uniqueBody('QA T2-7 thread B') });

    await openGeneral(page);
    await openThreadsList(page);
    await expect(threadListItem(page, a.rootId)).toBeVisible({ timeout: LIVE });
    await expect(threadListItem(page, b.rootId)).toBeVisible();

    const order = await threadListOrder(page);
    const posA = order.findIndex((i) => i.rootId === a.rootId);
    const posB = order.findIndex((i) => i.rootId === b.rootId);
    annotate('list-order', `A@${posA} B@${posB} of ${order.length}`);
    expect(posB, 'B was created last, so B is above A').toBeLessThan(posA);
    // Ordered by data-ts descending overall.
    const ts = order.map((i) => i.ts);
    expect([...ts].sort((x, y) => y - x)).toEqual(ts);

    // Replying in A moves A above B, with the list open (no reopen).
    await bob.sendThreadReply(R.general, a.rootId, uniqueBody('QA T2-7 bump A'), {
      latest: a.replyIds[0],
    });
    await expect
      .poll(
        async () => {
          const now = await threadListOrder(page);
          return now.findIndex((i) => i.rootId === a.rootId) < now.findIndex((i) => i.rootId === b.rootId);
        },
        { timeout: LIVE, intervals: [200, 300, 500, 1_000] },
      )
      .toBe(true);
  });

  test('AC-T2-8 selecting another room closes the thread and coming back does not reopen it', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T2-8 root' });
    await openThreadFromMessage(page, rootId);
    expect(await isThreadOpen(page)).toBe(true);

    await openChannel(page, R.random);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-thread-open', 'false');
    await expect(threadPanel(page)).toHaveCount(0);

    await openChannel(page, R.general);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-thread-open', 'false');
    await expect(threadPanel(page)).toHaveCount(0);
  });
});

/* ================================================================== AC-T3 panel container */

test.describe('AC-T3 desktop panel container', () => {
  test('AC-T3-1 with no thread open the Phase 2 layout is unchanged', async ({ page }) => {
    await openGeneral(page);
    await expect(threadPanel(page)).toHaveCount(0);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-thread-open', 'false');

    const members = page.getByTestId('member-list');
    await expect(members).toBeVisible();
    const memberBox = (await members.boundingBox())!;
    expect(Math.round(memberBox.width), 'member-list is 240 px').toBe(240);
    const header = (await page.getByTestId('channel-header').boundingBox())!;
    expect(Math.round(header.height), 'channel-header is 48 px on desktop').toBe(48);
  });

  test('AC-T3-2/AC-T3-3 the panel replaces the member column and the member column comes back', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const members = page.getByTestId('member-list');
    const widthBefore = Math.round((await members.boundingBox())!.width);
    const headerBefore = await page.getByTestId('channel-header').boundingBox();

    const { rootId } = await rootInView(page, { label: 'QA T3-2 root' });
    await openThreadFromMessage(page, rootId);

    const panel = threadPanel(page);
    await expect(panel).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    annotate('panel-geometry', `x=${panelBox.x} w=${panelBox.width} viewport=${viewport.width}`);
    expect(Math.round(panelBox.width), 'panel is 360-480 px wide').toBeGreaterThanOrEqual(360);
    expect(Math.round(panelBox.width)).toBeLessThanOrEqual(480);
    expect(
      Math.round(panelBox.x + panelBox.width),
      'the panel sits at the right edge of the viewport',
    ).toBeGreaterThanOrEqual(viewport.width - 2);

    await expect(members, 'the member column is replaced while a thread is open').toBeHidden();
    const listBox = (await messageList(page).boundingBox())!;
    expect(Math.round(listBox.width), 'the room timeline keeps >= 400 px').toBeGreaterThanOrEqual(400);
    const headerAfter = await page.getByTestId('channel-header').boundingBox();
    expect(
      { x: Math.round(headerAfter!.x), h: Math.round(headerAfter!.height) },
      'channel-header geometry is unchanged',
    ).toEqual({ x: Math.round(headerBefore!.x), h: Math.round(headerBefore!.height) });

    // AC-T3-3
    await closeThread(page);
    await expect(members).toBeVisible();
    expect(Math.round((await members.boundingBox())!.width)).toBe(widthBefore);
  });
});

/* ================================================================== AC-T4 summary row */

test.describe('AC-T4 thread summary row', () => {
  test('AC-T4-1 a root with no replies has no summary row', async ({ page }) => {
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T4-1 root' });
    // A sentinel message guarantees sync has caught up past the root before we assert an absence.
    const markerId = await bob.send(R.general, uniqueBody('QA T4-1 marker'));
    await expect(row(page, markerId)).toBeVisible({ timeout: 15_000 });
    await expect(threadSummary(page, rootId)).toHaveCount(0);
    await expect(row(page, rootId).locator('[data-testid^="thread-summary-"]')).toHaveCount(0);
  });

  test('AC-T4-2/AC-T4-3/AC-T4-4 the row counts, sits under the root, ticks live and opens the thread', async ({
    page,
  }) => {
    await requireThreadUi(test, page, ['thread-panel', 'thread-summary']);
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T4-2 root' });

    await openThreadFromMessage(page, rootId);
    await replyInThreadAndSettle(page, uniqueBody('QA T4-2 alice one'));
    await replyInThreadAndSettle(page, uniqueBody('QA T4-2 alice two'));
    await closeThread(page);

    const summary = threadSummary(page, rootId);
    await expect(summary).toBeVisible({ timeout: LIVE });
    await expect(summary).toHaveAttribute('data-count', '2');
    await expect(summary.getByTestId('thread-summary-count')).toHaveText('2 replies');
    await expect(summary.getByTestId('thread-summary-time')).toHaveText('just now');

    // Directly under `message-{rootId}`: the row is the root row's next element sibling, or inside it.
    const placement = await page.evaluate(
      ([rootSel, summarySel]) => {
        const rootEl = document.querySelector(rootSel as string);
        const summaryEl = document.querySelector(summarySel as string);
        if (!rootEl || !summaryEl) return 'missing';
        if (rootEl.contains(summaryEl)) return 'inside-root-row';
        return rootEl.nextElementSibling === summaryEl ? 'next-sibling' : 'elsewhere';
      },
      [`[data-testid="message-${rootId}"]`, `[data-testid="thread-summary-${rootId}"]`] as const,
    );
    annotate('summary-placement', placement);
    expect(placement, 'the summary row sits directly under the root row').not.toBe('elsewhere');

    // One participant so far -> one avatar.
    const faces = await avatarNames(summary.getByTestId('thread-summary-avatars'));
    annotate('summary-avatars', `alice only -> ${JSON.stringify(faces)}`);
    expect(faces.length, 'one participant, one avatar').toBe(1);

    // AC-T4-3: bob replies via API -> 3 replies, 2 participants, no reload.
    await bob.sendThreadReply(R.general, rootId, uniqueBody('QA T4-3 bob reply'));
    await expect(summary.getByTestId('thread-summary-count')).toHaveText('3 replies', { timeout: LIVE });
    await expect
      .poll(() => avatarNames(summary.getByTestId('thread-summary-avatars')).then((f) => f.length), {
        timeout: LIVE,
      })
      .toBe(2);

    // AC-T4-4: clicking the row opens that thread.
    await openThreadFromSummary(page, rootId);
  });

  test('AC-T4-5 one reply reads "1 reply" and survives a reload before the thread is opened', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-summary');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { replies: 1, label: 'QA T4-5 root' });

    const summary = threadSummary(page, rootId);
    await expect(summary).toBeVisible({ timeout: LIVE });
    await expect(summary.getByTestId('thread-summary-count')).toHaveText('1 reply');

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20_000 });
    await expect(row(page, rootId)).toBeVisible({ timeout: 20_000 });
    await expect(threadSummary(page, rootId)).toBeVisible({ timeout: LIVE });
    await expect(threadSummary(page, rootId).getByTestId('thread-summary-count')).toHaveText('1 reply');
    await expect(threadPanel(page), 'the count comes from the server summary, unopened').toHaveCount(0);
  });
});

/* ================================================================== AC-T5 Reply in thread */

test.describe('AC-T5 "Reply in thread" action', () => {
  test('AC-T5-1 the toolbar offers it after Reply and it opens the panel focused', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, rootBody } = await rootInView(page, { label: 'QA T5-1 root' });

    const actions = await hoverActions(page, rootId);
    const order = await actions
      .locator('[data-testid^="message-action-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
    annotate('action-order', order.join(' '));
    expect(order, 'message-action-thread is in the toolbar').toContain('message-action-thread');
    expect(
      order.indexOf('message-action-thread'),
      'Reply in thread comes after Reply',
    ).toBeGreaterThan(order.indexOf('message-action-reply'));

    await actions.getByTestId('message-action-thread').click();
    await expect(threadPanel(page)).toHaveAttribute('data-root', rootId);
    await expect(threadRootEl(page)).toContainText(rootBody);
    await expect(threadComposer(page)).toBeFocused();
  });

  test('AC-T5-3 the panel offers neither Reply in thread nor Reply (threads do not nest)', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, replyIds } = await rootInView(page, { replies: 1, label: 'QA T5-3 root' });
    await openThreadFromMessage(page, rootId);

    const reply = threadRow(page, replyIds[0]!);
    await expect(reply).toBeVisible({ timeout: LIVE });
    await reply.hover();
    const replyActions = reply.getByTestId('message-actions');
    if ((await replyActions.count()) > 0) {
      await expect(replyActions.getByTestId('message-action-thread')).toHaveCount(0);
      await expect(replyActions.getByTestId('message-action-reply')).toHaveCount(0);
    }

    const rootRow = threadRootEl(page);
    await rootRow.hover();
    await expect(rootRow.getByTestId('message-action-thread')).toHaveCount(0);
    await expect(rootRow.getByTestId('message-action-reply')).toHaveCount(0);
    await expect(threadPanel(page).getByTestId('message-action-thread')).toHaveCount(0);
  });

  test('AC-T5-4 the action opens the existing thread of a root that already has replies', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, replyIds } = await rootInView(page, { replies: 2, label: 'QA T5-4 root' });

    await openThreadFromMessage(page, rootId);
    await expect(threadPanel(page)).toHaveAttribute('data-root', rootId);
    for (const id of replyIds) {
      await expect(threadRow(page, id)).toBeVisible({ timeout: LIVE });
    }
    await expect(threadDivider(page)).toHaveText('2 replies');
  });
});

/* ================================================================== AC-T6 ThreadView */

test.describe('AC-T6 ThreadView', () => {
  test('AC-T6-1 the panel has root, divider, list, typing slot and composer, top to bottom', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, rootBody } = await rootInView(page, { label: 'QA T6-1 root' });
    await openThreadFromMessage(page, rootId);

    const panel = threadPanel(page);
    await expect(threadRootEl(page)).toBeVisible();
    await expect(threadRootEl(page)).toContainText(rootBody);
    await expect(threadRootEl(page).getByTestId('message-timestamp')).toBeVisible();
    await expect(
      panel.getByTestId(`message-${rootId}`),
      'the root is `thread-root`, not a duplicate `message-{rootId}`',
    ).toHaveCount(0);

    await expect(threadDivider(page)).toHaveText('No replies yet');
    await expect(threadMessageList(page)).toBeVisible();
    await expect(threadComposer(page)).toBeVisible();
    await expect(threadComposer(page)).toHaveAttribute('placeholder', 'Replying in thread');
    // `thread-composer-send` follows the Phase 2 composer rule (AC-V1-1): the mic occupies the slot
    // while the input is empty and send appears as soon as there is text. So the registry element
    // must be *present*, and visible once something is typed — asserting it visible on an empty
    // composer would contradict AC-V1-1.
    await expect(page.getByTestId('thread-composer-send')).toBeAttached();
    await threadComposer(page).fill('x');
    await expect(page.getByTestId('thread-composer-send')).toBeVisible();
    await threadComposer(page).fill('');
    await expect(page.getByTestId('thread-close')).toBeVisible();

    // Top-to-bottom order by viewport y.
    const ys = await page.evaluate(
      (ids) =>
        (ids as string[]).map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          return el ? Math.round(el.getBoundingClientRect().top) : Number.NaN;
        }),
      ['thread-root', 'thread-replies-divider', 'thread-message-list', 'thread-composer-input'],
    );
    annotate('panel-order', ys.join(' < '));
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i], `${i}: panel children are in registry order`).toBeGreaterThanOrEqual(ys[i - 1]!);
    }
  });

  test('AC-T6-2/AC-T2-6 Enter sends: local echo, settled id, divider, no room row', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T6-2 root' });
    await openThreadFromMessage(page, rootId);

    const roomRowsBefore = await roomRowIds(page);
    const body = uniqueBody('Tacos work for me');
    const started = Date.now();
    await replyInThread(page, body);
    const sent = threadRowByText(page, body);
    await expect(sent).toBeVisible({ timeout: 5_000 });
    const echoMs = Date.now() - started;
    annotate('local-echo-ms', `${echoMs} ms (AC-T2-6 target 200 ms)`);
    expect(echoMs, 'the local echo is immediate').toBeLessThanOrEqual(1_000);
    await expect(sent).toHaveAttribute('data-sender', ALICE);

    const settled = await settledEventId(sent);
    expect(settled).toMatch(/^\$/);
    await expect(threadDivider(page)).toHaveText('1 reply', { timeout: LIVE });
    expect(await roomRowIds(page), 'the room timeline gained no row').toEqual(roomRowsBefore);
  });

  test('AC-T6-3 two replies group and render no fallback quote', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T6-3 root' });
    await openThreadFromMessage(page, rootId);

    const firstBody = uniqueBody('QA T6-3 first');
    const secondBody = uniqueBody('QA T6-3 second');
    const firstId = await replyInThreadAndSettle(page, firstBody);
    const secondId = await replyInThreadAndSettle(page, secondBody);

    await expect(threadRow(page, firstId).getByTestId('message-group-start')).toHaveCount(1);
    await expect(
      threadRow(page, secondId).getByTestId('message-group-start'),
      'grouping ignores the fallback m.in_reply_to',
    ).toHaveCount(0);
    await expect(threadPanel(page).getByTestId('message-reply-quote')).toHaveCount(0);
  });

  test(`AC-T6-4 a ${BIG_THREAD_REPLIES}-reply thread opens at the bottom and pages in without drift`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await requireThreadUi(test, page, 'thread-panel');
    const { rootId, replyIds } = await theBigThread();

    await openGeneral(page);
    // A thread built earlier (theBigThread is reused per worker) can fall out of #general's initial window when
    // other specs post after it: page back to the root (dirty-seed rule, e2e/README.md) instead of waiting for it.
    await paginateToTop(page, async () => (await row(page, rootId).count()) > 0, 12);
    await expect(row(page, rootId)).toBeVisible({ timeout: 20_000 });
    await openThreadFromMessage(page, rootId);
    await expect(threadMessageList(page)).toBeVisible();

    const newest = replyIds[replyIds.length - 1]!;
    await expect(threadRow(page, newest), 'the panel opens at the newest reply').toBeVisible({
      timeout: LIVE,
    });
    expect(await threadAtBottom(page, 12), 'the panel opens scrolled to the bottom').toBe(true);

    const idsAtOpen = await threadRowIds(page);
    annotate('initial-page', `${idsAtOpen.length} of ${replyIds.length} rows on open`);

    if (idsAtOpen.length < replyIds.length) {
      // Anchor drift: the topmost rendered row must not move while older replies are prepended.
      const anchorId = idsAtOpen[0]!;
      // Baseline is taken *after* the scroll, in the same evaluate (mirrors AC-B3-2 in
      // conversation.spec.ts): scrolling to the top is the action under test, not the jump.
      // Arm the loading-indicator watch *before* the scroll: the page request can complete within
      // one frame on a warm homeserver, so a check started afterwards misses the flash.
      const sawLoading = page
        .getByTestId('thread-timeline-loading')
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      const anchorBefore = await threadMessageList(page).evaluate((el, id) => {
        el.scrollTop = 0;
        return el.querySelector(`[data-testid="message-${id}"]`)!.getBoundingClientRect().top;
      }, anchorId);
      await expect
        .poll(async () => (await threadRowIds(page)).length, { timeout: 15_000 })
        .toBeGreaterThan(idsAtOpen.length);
      const anchorAfter = (await threadRow(page, anchorId).boundingBox())!.y;
      annotate('anchor-drift', `${Math.abs(anchorAfter - anchorBefore).toFixed(1)} px`);
      expect(Math.abs(anchorAfter - anchorBefore), 'anchor drift <= 5 px (AC-B3-2 rule)').toBeLessThanOrEqual(5);
      expect(await sawLoading, 'thread-timeline-loading must be shown while the page request is in flight').toBe(true);
    }

    await paginateThreadToTop(page, async () => (await threadRowIds(page)).length >= replyIds.length, 15);
    const ids = await threadRowIds(page);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => replyIds.includes(id))).toEqual(replyIds);
    await expect(page.getByTestId('thread-timeline-start')).toBeVisible();
  });

  test('AC-T6-5 bob\'s reply lands in the open panel and the list stays at the bottom', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { replies: 1, label: 'QA T6-5 root' });
    await openThreadFromMessage(page, rootId);
    await expect(threadMessageList(page)).toBeVisible();

    const replyId = await bob.sendThreadReply(R.general, rootId, uniqueBody('QA T6-5 live reply'));
    await expect(threadRow(page, replyId)).toBeVisible({ timeout: LIVE });
    await expect
      .poll(() => threadAtBottom(page, 12), { timeout: 3_000, intervals: [100, 200, 300] })
      .toBe(true);
  });

  test('AC-T6-6 closing and reopening shows the same replies with no empty flash', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId, replyIds } = await rootInView(page, { replies: 2, label: 'QA T6-6 root' });

    await openThreadFromMessage(page, rootId);
    for (const id of replyIds) await expect(threadRow(page, id)).toBeVisible({ timeout: LIVE });
    await closeThread(page);

    await openThreadFromMessage(page, rootId);
    // "No empty flash": the divider must never read "No replies yet" after a reopen.
    await expect(threadDivider(page)).toHaveText('2 replies', { timeout: 2_000 });
    const ids = await threadRowIds(page);
    expect(ids.filter((id) => replyIds.includes(id))).toEqual(replyIds);
  });

  test('AC-T6-7 bob typing shows in the panel and in the room indicator, and clears', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T6-7 root' });
    await openThreadFromMessage(page, rootId);

    await bob.typing(R.general, true, 20_000);
    await expect(threadTyping(page)).toHaveText(`${DISPLAY_NAMES.bob} is typing...`, { timeout: LIVE });
    await expect(page.getByTestId('typing-indicator')).toHaveText(
      `${DISPLAY_NAMES.bob} is typing...`,
      { timeout: LIVE },
    );

    await bob.typing(R.general, false);
    await expect(threadTyping(page)).toBeHidden({ timeout: LIVE });
    await expect(page.getByTestId('typing-indicator')).toBeHidden({ timeout: LIVE });
  });

  test('AC-T6-8 the panel sends a threaded receipt and leaves the main receipt alone', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    await scrollListToBottom(page);
    const mainBefore = await alice.readReceiptOf(R.general, ALICE);

    const { rootId } = await rootInView(page, { label: 'QA T6-8 root' });
    await openThreadFromMessage(page, rootId);
    const replyId = await replyInThreadAndSettle(page, uniqueBody('QA T6-8 reply'));

    const threadReceipt = await expect
      .poll(() => bob.threadReceiptOf(R.general, ALICE, rootId), {
        timeout: 15_000,
        intervals: [300, 500, 1_000],
      })
      .not.toBeUndefined()
      .then(() => bob.threadReceiptOf(R.general, ALICE, rootId));
    annotate('thread-receipt', `${threadReceipt} (newest reply ${replyId})`);
    expect(threadReceipt, 'alice has a receipt in this thread').toBeTruthy();
    const receipts = await bob.getReceipts(R.general);
    expect(receipts[threadReceipt!]?.[ALICE]?.thread_id).toBe(rootId);

    const mainAfter = await bob.readReceiptOf(R.general, ALICE);
    annotate('main-receipt', `before=${mainBefore ?? 'none'} after=${mainAfter ?? 'none'}`);
    expect(mainAfter, "the room's main receipt did not move onto the reply").not.toBe(replyId);
  });

  test('AC-T6-9 editing in the panel uses the thread composer banner and Escape behaves', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T6-9 root' });
    await openThreadFromMessage(page, rootId);
    const replyId = await replyInThreadAndSettle(page, uniqueBody('QA T6-9 mine'));

    const reply = threadRow(page, replyId);
    await reply.hover();
    await reply.getByTestId('message-actions').getByTestId('message-action-edit').click();
    await expect(page.getByTestId('thread-composer-edit-banner')).toBeVisible();
    await expect(
      page.getByTestId('composer-edit-banner'),
      "the room composer's banner must stay out of it",
    ).toHaveCount(0);

    // Escape in a non-empty input clears the edit; the panel stays open.
    await threadComposer(page).fill('still typing');
    await threadComposer(page).press('Escape');
    await expect(page.getByTestId('thread-composer-edit-banner')).toHaveCount(0);
    await expect(threadPanel(page)).toBeVisible();

    // Escape in an empty input closes the panel (desktop).
    await threadComposer(page).fill('');
    await threadComposer(page).press('Escape');
    await expect(threadPanel(page)).toHaveCount(0);
  });

  test('AC-T6-10 a redacted root still renders and the composer still sends', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { replies: 1, label: 'QA T6-10 root' });
    await openThreadFromMessage(page, rootId);

    await bob.redact(R.general, rootId, 'QA T6-10');
    await expect(threadRootEl(page).getByTestId('message-redacted')).toBeVisible({ timeout: LIVE });

    const body = uniqueBody('QA T6-10 after redaction');
    const sentId = await replyInThreadAndSettle(page, body);
    const event = await alice.getEvent(R.general, sentId);
    expectThreadRelation(event, rootId, threadRelationOf(event)!['m.in_reply_to']!.event_id!);
  });

  test('AC-T6-11 focus moves into the panel on open and back to the room composer on close', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T6-11 root' });

    await openThreadFromMessage(page, rootId);
    await expect(threadComposer(page)).toBeFocused();
    await closeThread(page);
    await expect(composer(page)).toBeFocused();
  });
});

/* ================================================================== AC-T7 Threads button + list */

test.describe('AC-T7 Threads button and list', () => {
  test('AC-T7-1 the header shows Threads left of the members button, in channels and DMs', async ({
    page,
  }) => {
    await requireThreadUi(test, page, 'threads-button');
    await openGeneral(page);

    const header = page.getByTestId('channel-header');
    await expect(threadsButton(page)).toBeVisible();
    const headerBox = (await header.boundingBox())!;
    expect(Math.round(headerBox.height), 'the header height is unchanged (48 px)').toBe(48);

    const threadsBox = (await threadsButton(page).boundingBox())!;
    const membersBox = (await page.getByTestId('member-toggle').boundingBox())!;
    annotate('header-buttons', `threads.x=${threadsBox.x} members.x=${membersBox.x}`);
    expect(threadsBox.x, 'Threads is left of the members button').toBeLessThan(membersBox.x);

    // DMs get the button too (at the right edge: there is no member toggle there).
    await openHome(page);
    await page.getByTestId(`dm-item-${R.dmBob}`).click();
    await expect(messageList(page)).toBeVisible();
    await expect(threadsButton(page), 'DMs show the Threads button as well').toBeVisible();
  });

  test('AC-T7-2 the list is a desktop popover with the registry item fields', async ({ page }) => {
    await requireThreadUi(test, page, 'threads-list');
    const { rootId } = await seedThread({
      roomId: R.general,
      replies: 2,
      rootBody: uniqueBody('QA T7-2 root'),
    });

    await openGeneral(page);
    await openThreadsList(page);
    await expect(threadList(page)).toHaveAttribute('data-variant', 'popover');

    const item = threadListItem(page, rootId);
    await expect(item).toBeVisible({ timeout: LIVE });
    await expect(item).toHaveAttribute('data-count', '2');
    await expect(item.getByTestId('thread-list-item-author')).toContainText(DISPLAY_NAMES.bob);
    await expect(item.getByTestId('thread-list-item-snippet')).toBeVisible();
    await expect(item.getByTestId('thread-list-item-count')).toHaveText('2 replies');
    await expect(item.getByTestId('thread-list-item-time')).toHaveText(/just now|min ago/);
    await expect(item.getByTestId('thread-list-item-avatars')).toBeVisible();

    const order = await threadListOrder(page);
    const ts = order.map((i) => i.ts);
    expect([...ts].sort((x, y) => y - x), 'items are ordered by data-ts descending').toEqual(ts);
  });

  test('AC-T7-3/AC-T7-4 a reply reorders the list and an item opens the thread', async ({ page }) => {
    await requireThreadUi(test, page, ['threads-list', 'thread-panel']);
    const a = await seedThread({ roomId: R.general, replies: 1, rootBody: uniqueBody('QA T7-3 A') });
    const b = await seedThread({ roomId: R.general, replies: 1, rootBody: uniqueBody('QA T7-3 B') });
    await bob.sendThreadReply(R.general, a.rootId, uniqueBody('QA T7-3 bump A'), { latest: a.replyIds[0] });

    await openGeneral(page);
    await openThreadsList(page);
    await expect(threadListItem(page, a.rootId)).toBeVisible({ timeout: LIVE });
    await expect(threadListItem(page, b.rootId)).toBeVisible();
    const order = await threadListOrder(page);
    expect(
      order.findIndex((i) => i.rootId === a.rootId),
      'A had the newest activity, so A is listed above B',
    ).toBeLessThan(order.findIndex((i) => i.rootId === b.rootId));

    await openThreadFromList(page, a.rootId);
  });

  test('AC-T7-5 a room with no threads shows the empty state', async ({ page }) => {
    await requireThreadUi(test, page, 'threads-list');
    // The carol DM is the quietest room on this homeserver and nothing in this suite ever threads in
    // it. If a previous session left a thread there the criterion cannot be judged — say so.
    const existing = await alice.getThreads(R.dmCarol);
    if (existing.rootIds.length > 0) {
      annotate(
        'dirty-homeserver',
        `AC-T7-5 needs a thread-less room; ${R.dmCarol} already has ${existing.rootIds.length} thread(s): ${existing.rootIds.join(', ')}`,
      );
      test.skip(true, 'the carol DM already holds threads on this homeserver');
    }

    await resetSession(page);
    await loginAs(page, 'alice');
    await openHome(page);
    await page.getByTestId(`dm-item-${R.dmCarol}`).click();
    await expect(messageList(page)).toBeVisible();

    await openThreadsList(page);
    await expect(threadListEmpty(page)).toBeVisible({ timeout: LIVE });
    await expect(threadListEmpty(page)).toHaveText('No threads yet');
  });

  test('AC-T7-6 the unread dot appears for an unread thread reply and clears on opening it', async ({
    page,
  }) => {
    await requireThreadUi(test, page, ['threads-button', 'thread-panel']);
    await openGeneral(page);
    await scrollListToBottom(page);
    const { rootId } = await rootInView(page, { label: 'QA T7-6 root' });
    // Read the room first, so the only unread left is the thread one. An *unthreaded* m.read on
    // the newest event clears every thread's unread server-side (leftovers from earlier runs
    // would otherwise keep the room-level dot on regardless of this test's thread).
    await alice.receipt(R.general, rootId);
    // Server first: `unreadFor()` returns `{ count, receiptEventId, approximate }` (main timeline
    // after alice's newest main receipt), so compare the count, not the object.
    await expect
      .poll(async () => (await alice.unreadFor(R.general)).count, { timeout: 15_000 })
      .toBe(0);
    // The precondition this criterion needs is "no unread thread" (hard). The room badge is only
    // the baseline for the before/after comparison below: wait for it to clear (it does on the
    // next /sync), but a late /sync must not fail the thread criterion - the comparison still holds.
    await expect(threadsUnreadDot(page)).toHaveCount(0, { timeout: 15_000 });
    await page
      .getByTestId(`channel-unread-${R.general}`)
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => undefined);
    const badgeBefore = await badgeCount(page.getByTestId(`channel-unread-${R.general}`));

    await bob.sendThreadReply(R.general, rootId, uniqueBody('QA T7-6 unread reply'));
    await expect(threadsUnreadDot(page)).toBeVisible({ timeout: LIVE });
    const badgeAfter = await badgeCount(page.getByTestId(`channel-unread-${R.general}`));
    annotate('general-badge', `before=${badgeBefore ?? 'none'} after=${badgeAfter ?? 'none'}`);
    expect(badgeAfter ?? 0, 'the room badge is untouched by a thread reply').toBeLessThanOrEqual(
      badgeBefore ?? 0,
    );

    await openThreadFromMessage(page, rootId);
    await expect(threadsUnreadDot(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test('AC-T7-7 Escape, an outside click and the close button all close the list', async ({ page }) => {
    await requireThreadUi(test, page, 'threads-list');
    await openGeneral(page);

    await openThreadsList(page);
    await page.keyboard.press('Escape');
    await expect(threadList(page)).toBeHidden();

    await openThreadsList(page);
    await messageList(page).click({ position: { x: 20, y: 20 } });
    await expect(threadList(page)).toBeHidden();

    await openThreadsList(page);
    await page.getByTestId('thread-list-close').click();
    await expect(threadList(page)).toBeHidden();
  });

  test('AC-T7-8 with the list closed the Phase 1 navigation criteria still hold', async ({ page }) => {
    await requireThreadUi(test, page, 'threads-button');
    await openGeneral(page);
    await expect(threadList(page)).toHaveCount(0);
    // Spot check of AC-A2/A3/A4 shapes; the full criteria live in e2e/navigation.spec.ts, which the
    // QA-17 regression gate runs in the same project.
    await expect(page.getByTestId('channel-list')).toBeVisible();
    await expect(page.getByTestId('member-list')).toBeVisible();
    await expect(page.getByTestId('channel-header-name')).toContainText('general');
    await openChannel(page, R.dev);
    await expect(page.getByTestId('channel-header-name')).toContainText('dev');
  });
});

/* ================================================================== AC-T9 in-thread features (P1) */

test.describe('AC-T9 in-thread edits, reactions, delete and media (P1)', () => {
  test('AC-T9-1 editing a reply marks it edited and leaves the room timeline alone', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T9-1 root' });
    await openThreadFromMessage(page, rootId);

    const original = uniqueBody('QA T9-1 original');
    const replyId = await replyInThreadAndSettle(page, original);
    const roomRowsBefore = await roomRowIds(page);

    const reply = threadRow(page, replyId);
    await reply.hover();
    await reply.getByTestId('message-actions').getByTestId('message-action-edit').click();
    await expect(page.getByTestId('thread-composer-edit-banner')).toBeVisible();
    const edited = `${original} edited`;
    await threadComposer(page).fill(edited);
    await threadComposer(page).press('Enter');

    await expect(threadRow(page, replyId).getByTestId('message-edited')).toBeVisible({ timeout: LIVE });
    expect(await roomRowIds(page), 'the room timeline is unchanged by an in-thread edit').toEqual(
      roomRowsBefore,
    );

    const replacement = await expect
      .poll(
        async () => {
          const chunk = await alice.messages(R.general, 50);
          return chunk.find(
            (e) =>
              (e.content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined)
                ?.rel_type === 'm.replace' &&
              (e.content['m.relates_to'] as { event_id?: string }).event_id === replyId,
          );
        },
        { timeout: 15_000, intervals: [300, 500, 1_000] },
      )
      .not.toBeUndefined()
      .then(async () => {
        const chunk = await alice.messages(R.general, 50);
        return chunk.find(
          (e) =>
            (e.content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined)
              ?.rel_type === 'm.replace' &&
            (e.content['m.relates_to'] as { event_id?: string }).event_id === replyId,
        )!;
      });
    const newContent = replacement.content['m.new_content'] as Record<string, unknown>;
    annotate('m.new_content', JSON.stringify(newContent));
    expect(newContent?.['m.relates_to'], 'm.new_content carries no m.relates_to').toBeUndefined();
  });

  test('AC-T9-2 reacting to a reply inside the panel works both ways', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T9-2 root' });
    await openThreadFromMessage(page, rootId);
    const replyId = await replyInThreadAndSettle(page, uniqueBody('QA T9-2 reply'));

    const reply = threadRow(page, replyId);
    await reply.hover();
    await reply.getByTestId('message-actions').getByTestId('message-action-react').click();
    const mine = PICKER_KEYS[0]; // 👍
    await page.getByTestId('reaction-picker').getByTestId(`reaction-picker-${mine}`).click();
    const minePill = reply.getByTestId(`reaction-${mine}`);
    await expect(minePill).toBeVisible({ timeout: LIVE });
    await expect(minePill).toHaveAttribute('data-mine', 'true');

    const theirs = PICKER_KEYS[4]; // 🔥
    await bob.react(R.general, replyId, theirs);
    await expect(reply.getByTestId(`reaction-${theirs}`)).toBeVisible({ timeout: LIVE });
  });

  test('AC-T9-3 deleting a reply redacts the row and drops the count by one', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T9-3 root' });
    await openThreadFromMessage(page, rootId);
    await replyInThreadAndSettle(page, uniqueBody('QA T9-3 keeper'));
    const victimId = await replyInThreadAndSettle(page, uniqueBody('QA T9-3 victim'));
    await expect(threadDivider(page)).toHaveText('2 replies', { timeout: LIVE });

    const victim = threadRow(page, victimId);
    await victim.hover();
    await victim.getByTestId('message-actions').getByTestId('message-action-delete').click();
    await page.getByTestId('delete-confirm').click();

    // The criterion has two halves and they fail independently, so both are measured and reported
    // from one run: the row's shape (a failure must say *which* way it went — row gone entirely, or
    // row present without the placeholder) and the count the divider ends on.
    const rowShape = async (): Promise<string> => {
      const rows = await threadRowIds(page);
      const present = rows.includes(victimId);
      const redacted = await threadRow(page, victimId).getByTestId('message-redacted').count();
      return `${present ? 'row-present' : 'row-gone'}/${redacted ? 'redacted' : 'no-placeholder'}`;
    };
    await expect
      .poll(rowShape, { timeout: 10_000, intervals: [300, 500, 1_000] })
      .toBe('row-present/redacted')
      .catch(() => undefined);
    const shape = await rowShape();
    const dividerText = await threadDivider(page).textContent();
    annotate('after-redaction', `row=${shape} divider="${dividerText ?? ''}"`);

    expect.soft(shape, 'the redacted reply keeps its row and shows message-redacted').toBe(
      'row-present/redacted',
    );
    await expect(threadDivider(page), 'a redaction is the one thing that lowers the count').toHaveText(
      '1 reply',
      { timeout: 10_000 },
    );
  });

  test('AC-T9-4 a voice note recorded in the panel carries the thread relation', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T9-4 root' });
    await openThreadFromMessage(page, rootId);

    await page.getByTestId('thread-composer-mic').click();
    await expect(page.getByTestId('thread-composer-recording')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('recording-timer')).toContainText(/0:0[1-9]/, { timeout: 10_000 });
    await page.getByTestId('recording-send').click();

    const voice = threadMessageList(page).getByTestId('voice-message');
    await expect(voice.first()).toBeVisible({ timeout: 20_000 });
    const rowId = await settledEventId(
      threadMessageList(page).getByTestId(/^message-[$~]/).filter({ has: page.getByTestId('voice-message') }).last(),
    );
    const event = await alice.getEvent(R.general, rowId);
    expect(event.content.msgtype).toBe('m.audio');
    expect(event.content['org.matrix.msc3245.voice'], 'the Phase 2 voice contract holds').toBeDefined();
    expectThreadRelation(event, rootId, threadRelationOf(event)!['m.in_reply_to']!.event_id!);
  });

  test('AC-T9-5 a PNG attached in the panel carries the thread relation', async ({ page }) => {
    await requireThreadUi(test, page, 'thread-panel');
    await openGeneral(page);
    const { rootId } = await rootInView(page, { label: 'QA T9-5 root' });
    await openThreadFromMessage(page, rootId);

    await page
      .getByTestId('thread-composer-file-input')
      .setInputFiles(resolve(HERE, 'fixtures/test-image.png'));
    const image = threadMessageList(page).getByTestId('message-image');
    await expect(image.first()).toBeVisible({ timeout: 25_000 });
    const rowId = await settledEventId(
      threadMessageList(page).getByTestId(/^message-[$~]/).filter({ has: page.getByTestId('message-image') }).last(),
    );
    const event = await alice.getEvent(R.general, rowId);
    expect(event.content.msgtype).toBe('m.image');
    expectThreadRelation(event, rootId, threadRelationOf(event)!['m.in_reply_to']!.event_id!);
  });
});

/* ================================================================== manual criteria */

test.describe('manual / device-only criteria', () => {
  test.skip('AC-T3-5 Android back closes an open thread before drawers (manual, device)', () => {
    // Needs a real device or emulator: `@capacitor/app` back-button events are not dispatched in
    // Chromium. Tracked in the docs/BUGS.md "cannot be judged here" list, like AC-M6/AC-V7.
  });
});
