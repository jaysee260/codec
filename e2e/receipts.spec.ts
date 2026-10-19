/**
 * QA-R2: read receipts, desktop (docs/archive/RECEIPTS_ACCEPTANCE.md AC-R1, R2-1..6, R3-1..4, R4, R6, R7-1..4, R8-1/2, R9-1/2,
 * R10-2). Phone half: mobile-receipts.spec.ts. Helpers: fixtures/receipts.ts.
 *
 * ## How the reading side is driven (Advisor risk 7)
 * Other users read through the API (`readAs` = raw `POST /receipt/m.read`, `readPrivateAs` = `m.read.private`,
 * threaded with the root id), never by timing a second browser. Every assertion polls with a 15 s budget
 * (`RECEIPT_TIMEOUT`), there is no `waitForTimeout`, and every test sends its own fresh message(s) in #dev (plain)
 * or #vault (encrypted) and asserts on those event ids only. Each worker has its own Synapse (fixtures/pool.ts), so
 * "the newest row is mine" (the sent check) cannot be broken by another worker; inside a worker tests run one at a
 * time. By design, a user who posts after a message counts as having seen it (synthetic receipts), so a test never
 * lets bob post after the message whose "Not seen yet" it asserts.
 *
 * ## Second browser contexts (slow: a full login each)
 *  - AC-R2-1: bob's client sends its own receipt (live avatar, no reload);
 *  - AC-R7-2 / AC-R7-3: bob's view of alice's receipts (private never shows, public does).
 * Everything else is API + alice's page.
 *
 * ## Core half vs UI half
 * Every criterion first asserts the Principal's core through the dev hook (`window.__matrixPoc.receipts`:
 * `getReadPoints`, `getSeenBy`, `getLatestOwnSentId`, `getSendStatus`, `getSendReadReceipts`), which exists today.
 * The UI half (Dev A's components, Dev B's wiring) is `uiHalf` / `requireUi` from fixtures/e2ee.ts: a source scan
 * for the registry testids, so a test says "waiting on Dev A/B" until the testid exists anywhere in src/, and is red
 * (a real defect) once it does. Purely visual criteria (hover / click / Escape / geometry) are `requireUi` whole.
 *
 * ## Deviations, recorded on purpose
 *  - AC-R1-1 / AC-R1-2 hold the `/send` request behind a gate (released by the test) instead of a fixed 1 s delay,
 *    so "sending" is observed deterministically.
 *  - AC-R1-5 fails the send with **403 M_FORBIDDEN**, not 500: matrix-js-sdk's scheduler retries 5xx / network errors
 *    with backoff (~30 s) before NOT_SENT, while 4xx fails at once. The Phase 1 UI has no retry control
 *    (`failed to send` tag only), so "the retry path still works" is annotated, not asserted.
 *  - AC-R2-6's undecryptable row is a genuine historical UTD from `scripts/send-encrypted-sample.mjs` (sent before
 *    alice's device exists), not a second unverified alice context: same row state, one browser fewer.
 *  - AC-R7-2's "bob's context never shows alice (wait 5 s)" is a positive sentinel instead of a sleep: carol reads B2
 *    publicly after alice's private receipt has reached the server; once bob sees carol there, alice's absence is
 *    judged.
 *  - AC-R7-2 parks alice in #vault (not #general / #random / #lobby, which carry fresh-seed signals) so #dev can go
 *    unread first and the private receipt visibly clears it.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginAs, NAV_STORAGE_KEY } from './fixtures/auth.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { DISPLAY_NAMES, resolveRoom, userId } from './fixtures/seed.ts';
import { channelItem, hoverActions, messageList, nextFrames, openChannel, openSpace, parkAboveBottom, rowByText, settledEventId, typeAndSend } from './fixtures/ui.ts';
import { e2eeAfterEach, loginWith, requireUi, runSample, secondContext, uiHalf, waitForStatus, type SecondContext } from './fixtures/e2ee.ts';
import { annotate, markRoomRead } from './fixtures/state.ts';
import { openThreadFromMessage, seedThread } from './fixtures/threads.ts';
import {
  RECEIPT_TIMEOUT,
  SETTINGS_KEY,
  SETTINGS_TYPE,
  UI,
  accountDataOf,
  appSetting,
  appUnread,
  avatarIds,
  bottomGap,
  expectAvatars,
  expectReadersAt,
  latestOwnSentId,
  listIds,
  mainRow,
  notificationCount,
  openSeenByFromActions,
  plusNRoom,
  putAccountData,
  readAs,
  readPointsOf,
  readPrivateAs,
  readersAt,
  receiptAvatars,
  receiptList,
  receiptRequests,
  receiptStatus,
  receiptToggle,
  receiptTypesOn,
  rowOfReader,
  seenByOf,
  sendStatusByText,
  setAppSetting,
  snapshotSettings,
  threadRowIn,
  topOf,
  uniq,
  waitForReceiptsHook,
  type ReceiptRequests,
} from './fixtures/receipts.ts';

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const R = { dev: '', vault: '', acme: '' };
const A = userId('alice');
const B = userId('bob');
const C = userId('carol');
const D = userId('dave');
let alice: ApiUser;
let bob: ApiUser;

test.beforeAll(async () => {
  R.dev = await resolveRoom('dev');
  R.vault = await resolveRoom('vault');
  R.acme = await resolveRoom('acme-hq');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
  // bob / carol post into #dev and the sample script into #vault: leave alice with nothing unread (AC-A5-2 on the
  // next spec of this worker reads the Acme rail dot).
  await markRoomRead(R.dev).catch(() => undefined);
  await markRoomRead(R.vault).catch(() => undefined);
});

/* ------------------------------------------------------------------ helpers */

async function openRoom(page: Page, roomId: string): Promise<void> {
  if (!(await channelItem(page, roomId).isVisible().catch(() => false))) await openSpace(page, R.acme);
  await openChannel(page, roomId);
}

/** Receipt listener first, then alice straight into `roomId`. */
async function start(page: Page, roomId: string, opts: { encrypted?: boolean } = {}): Promise<ReceiptRequests> {
  const reqs = receiptRequests(page);
  await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId } });
  await waitForReceiptsHook(page);
  if (opts.encrypted) await waitForStatus(page);
  await openRoom(page, roomId);
  return reqs;
}

/** alice types `text` in the open room; returns the settled `$` id. */
async function sendUi(page: Page, text: string): Promise<string> {
  await typeAndSend(page, text);
  return settledEventId(rowByText(page, text), 20_000);
}

/** alice posts through the API (another device of hers); waits for the row in her page. */
async function sendApi(page: Page, roomId: string, text: string): Promise<string> {
  const id = await alice.send(roomId, text);
  await expect(mainRow(page, id)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
  return id;
}

/** A second desktop context for `user`, opened straight into `roomId`. */
async function contextIn(browser: Browser, user: 'bob' | 'carol', roomId: string): Promise<SecondContext> {
  const c = await secondContext(browser, user, { login: false });
  const selection = JSON.stringify({ spaceId: R.acme, roomId, lastRoomBySpace: { [R.acme]: roomId } });
  await c.page.addInitScript(([k, v]) => window.localStorage.setItem(k as string, v as string), [NAV_STORAGE_KEY, selection]);
  await loginWith(c.page, user);
  await waitForReceiptsHook(c.page);
  await openRoom(c.page, roomId);
  return c;
}

/** Holds every `/send` until `release()` (AC-R1-1 / AC-R1-2: "sending" observed, not raced). 15 s safety. */
async function holdSends(page: Page): Promise<{ release(): void; off(): Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pattern = '**/_matrix/client/v3/rooms/*/send/**';
  await page.route(pattern, async (route) => {
    await Promise.race([gate, new Promise((r) => setTimeout(r, 15_000))]);
    await route.continue().catch(() => undefined);
  });
  return { release, off: () => page.unroute(pattern) };
}

async function expectSendStatus(page: Page, roomId: string, text: string, status: string, timeout = RECEIPT_TIMEOUT): Promise<void> {
  let last = {};
  await expect
    .poll(async () => (last = await sendStatusByText(page, roomId, text)) && (last as { status: string | null }).status, {
      timeout,
      message: `core getSendStatus for "${text}" (last ${JSON.stringify(last)})`,
    })
    .toBe(status);
}

/** No `receipt-avatar` for `userId` anywhere inside `scope` (the main list by default). */
function avatarOf(page: Page, uid: string, scopeTestId = 'message-list') {
  return page.getByTestId(scopeTestId).locator(`[data-testid="receipt-avatar"][data-user-id="${uid}"]`);
}

/** bob roots a thread in #dev, alice replies T1 (API), alice's page opens the thread panel. */
async function threadWithAliceReply(page: Page, label: string): Promise<{ root: string; t1: string }> {
  const { rootId } = await seedThread({ roomId: R.dev, rootSender: 'bob', rootBody: uniq(`${label} root`) });
  const t1 = await alice.sendThreadReply(R.dev, rootId, uniq(`${label} T1`), { latest: rootId });
  await expect(mainRow(page, rootId)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
  await openThreadFromMessage(page, rootId);
  await expect(threadRowIn(page, t1)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
  return { root: rootId, t1 };
}

/* ================================================================== harness */

test('core: __matrixPoc.receipts exposes the QA contract', async ({ page }) => {
  await start(page, R.dev);
  const shape = await page.evaluate(() => {
    const h = (window as any).__matrixPoc.receipts;
    return ['getReadPoints', 'getSeenBy', 'getLatestOwnSentId', 'getSendStatus', 'getSendReadReceipts', 'setSendReadReceipts', 'markRead'].filter(
      (n) => typeof h[n] !== 'function',
    );
  });
  expect(shape, 'missing hook functions').toEqual([]);
  expect(typeof (await appSetting(page))).toBe('boolean');
  const points = await readPointsOf(page, R.dev);
  for (const users of Object.values(points)) expect(users, 'alice never reads her own rows (exclude me)').not.toContain(A);
});

/* ================================================================== AC-R1 send status */

test.describe('AC-R1 send status', () => {
  test('AC-R1-1 #dev: sending (held) -> sent; no avatars; bob rows never carry receipt-status', async ({ page }) => {
    await start(page, R.dev);
    const bobId = await bob.send(R.dev, uniq('R11 bob row'));
    await expect(mainRow(page, bobId)).toBeVisible({ timeout: RECEIPT_TIMEOUT });

    const hold = await holdSends(page);
    const text = uniq('status check');
    await typeAndSend(page, text);
    await expectSendStatus(page, R.dev, text, 'sending');
    await uiHalf('Dev A', [...UI.status], async () => {
      const st = receiptStatus(rowByText(page, text));
      await expect(st).toHaveAttribute('data-status', 'sending');
      await expect(st).toHaveAttribute('aria-label', 'Sending…');
      await expect(st).toHaveAttribute('title', 'Sending…');
    });
    hold.release();
    const id = await settledEventId(rowByText(page, text), 15_000);
    await hold.off();
    await expectSendStatus(page, R.dev, text, 'sent', 5_000);
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: 5_000 }).toBe(id);
    expect(await readersAt(page, R.dev, id)).toEqual([]);
    await uiHalf('Dev A', [...UI.status], async () => {
      const st = receiptStatus(mainRow(page, id));
      await expect(st).toHaveAttribute('data-status', 'sent', { timeout: 5_000 });
      await expect(st).toHaveAttribute('aria-label', 'Sent');
      await expect(st).toHaveAttribute('title', 'Sent');
      await expect(receiptAvatars(mainRow(page, id))).toHaveCount(0);
      await expect(receiptStatus(mainRow(page, bobId)), "other people's rows never carry receipt-status").toHaveCount(0);
    });
  });

  test('AC-R1-2 #vault (encrypted): sending -> sent on the $id row, never stuck at sending', async ({ page }) => {
    await start(page, R.vault, { encrypted: true });
    const hold = await holdSends(page);
    const text = uniq('vault status');
    await typeAndSend(page, text);
    await expectSendStatus(page, R.vault, text, 'sending', 20_000);
    await uiHalf('Dev A', [...UI.status], async () => {
      await expect(receiptStatus(rowByText(page, text))).toHaveAttribute('data-status', 'sending');
    });
    hold.release();
    const id = await settledEventId(rowByText(page, text), 20_000);
    await hold.off();
    expect(id.startsWith('$'), 'final row id is a server id').toBe(true);
    await expectSendStatus(page, R.vault, text, 'sent', 5_000);
    const s = await sendStatusByText(page, R.vault, text);
    expect(s.id, 'the event the status reads is the $ id').toBe(id);
    await expect.poll(() => latestOwnSentId(page, R.vault), { timeout: 5_000 }).toBe(id);
    await uiHalf('Dev A', [...UI.status], async () => {
      await expect(receiptStatus(mainRow(page, id))).toHaveAttribute('data-status', 'sent', { timeout: 5_000 });
      await expect(messageList(page).locator('[data-testid^="message-~"] [data-testid="receipt-status"]'), 'no ~txn row left behind').toHaveCount(0);
    });
  });

  test('AC-R1-3 only my newest unread message carries the sent check; it moves to M3', async ({ page }) => {
    await start(page, R.dev);
    const m1 = await sendUi(page, uniq('R13 M1'));
    const m2 = await sendUi(page, uniq('R13 M2'));
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: RECEIPT_TIMEOUT }).toBe(m2);
    await uiHalf('Dev A', [...UI.status], async () => {
      await expect(receiptStatus(mainRow(page, m2))).toHaveAttribute('data-status', 'sent');
      await expect(receiptStatus(mainRow(page, m1))).toHaveCount(0);
      await expect(receiptAvatars(mainRow(page, m1))).toHaveCount(0);
    });
    const m3 = await sendUi(page, uniq('R13 M3'));
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: RECEIPT_TIMEOUT }).toBe(m3);
    await uiHalf('Dev A', [...UI.status], async () => {
      await expect(receiptStatus(mainRow(page, m3))).toHaveAttribute('data-status', 'sent');
      await expect(receiptStatus(mainRow(page, m2))).toHaveCount(0);
      await expect(messageList(page).getByTestId('receipt-status').and(page.locator('[data-status="sent"]')), 'exactly one sent check in the list').toHaveCount(1);
    });
  });

  test('AC-R1-4 bob reads M2: the check is replaced by his avatar; M4 takes the check, M2 keeps bob', async ({ page }) => {
    await start(page, R.dev);
    const m2 = await sendUi(page, uniq('R14 M2'));
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: RECEIPT_TIMEOUT }).toBe(m2);
    await readAs('bob', R.dev, m2);
    await expectReadersAt(page, R.dev, m2, [B], { timeout: 5_000 });
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: 5_000 }).toBeNull();
    await uiHalf('Dev A', [...UI.status, ...UI.avatars], async () => {
      await expect(receiptStatus(mainRow(page, m2))).toHaveCount(0, { timeout: 5_000 });
      await expectAvatars(mainRow(page, m2), [B], { timeout: 5_000 });
    });
    const m4 = await sendUi(page, uniq('R14 M4'));
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: RECEIPT_TIMEOUT }).toBe(m4);
    expect(await readersAt(page, R.dev, m2)).toEqual([B]);
    await uiHalf('Dev A', [...UI.status, ...UI.avatars], async () => {
      await expect(receiptStatus(mainRow(page, m4))).toHaveAttribute('data-status', 'sent');
      await expectAvatars(mainRow(page, m2), [B]);
    });
  });

  test('AC-R1-5 a failed send shows failed next to the existing failed UI and never holds the sent check', async ({ page }) => {
    await start(page, R.dev);
    const pattern = '**/_matrix/client/v3/rooms/*/send/**';
    await page.route(pattern, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'qa: forced send failure' }) }));
    const text = uniq('R15 doomed');
    await typeAndSend(page, text);
    await expectSendStatus(page, R.dev, text, 'failed');
    const failedId = (await sendStatusByText(page, R.dev, text)).id;
    expect(await latestOwnSentId(page, R.dev), 'a failed message never holds the sent check').not.toBe(failedId);
    const echo = rowByText(page, text);
    await expect(echo, 'the existing failed UI').toContainText('failed to send');
    await uiHalf('Dev A', [...UI.status], async () => {
      await expect(receiptStatus(echo)).toHaveAttribute('data-status', 'failed');
    });
    await page.unroute(pattern);
    annotate('not-asserted', 'AC-R1-5 "retry path still works": the Phase 1 UI has no retry control (only the "failed to send" tag)');
  });
});

/* ================================================================== AC-R2 read avatars */

test.describe('AC-R2 read avatars', () => {
  test("AC-R2-1 bob's own client reads A1: his avatar appears live, no reload", async ({ page, browser }) => {
    await start(page, R.dev);
    const a1 = await sendApi(page, R.dev, uniq('R21 A1'));
    const navs = { count: 0 };
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navs.count += 1;
    });
    const b = await contextIn(browser, 'bob', R.dev);
    await expect.poll(() => bob.readReceiptOf(R.dev, B), { timeout: RECEIPT_TIMEOUT, message: "bob's client sent its receipt for A1" }).toBe(a1);
    await expectReadersAt(page, R.dev, a1, [B], { timeout: 5_000 });
    await uiHalf('Dev A', [...UI.avatars], async () => {
      await expectAvatars(mainRow(page, a1), [B], { timeout: 5_000 });
      await expect(receiptAvatars(mainRow(page, a1))).toHaveAttribute('aria-label', `Seen by ${DISPLAY_NAMES.bob}`);
    });
    expect(navs.count, 'no reload of alice\'s page').toBe(0);
    await b.close();
  });

  test('AC-R2-2 avatars move: bob A1 -> A2; carol then reads A1', async ({ page }) => {
    await start(page, R.dev);
    const a1 = await sendApi(page, R.dev, uniq('R22 A1'));
    await readAs('bob', R.dev, a1);
    await expectReadersAt(page, R.dev, a1, [B]);
    const a2 = await sendApi(page, R.dev, uniq('R22 A2'));
    await readAs('bob', R.dev, a2);
    await expectReadersAt(page, R.dev, a2, [B]);
    await expectReadersAt(page, R.dev, a1, []);
    await uiHalf('Dev A', [...UI.avatars], async () => {
      await expectAvatars(mainRow(page, a2), [B]);
      await expectAvatars(mainRow(page, a1), []);
    });
    await readAs('carol', R.dev, a1);
    await expectReadersAt(page, R.dev, a1, [C]);
    expect(await readersAt(page, R.dev, a2)).toEqual([B]);
    await uiHalf('Dev A', [...UI.avatars], async () => {
      await expectAvatars(mainRow(page, a1), [C]);
      await expectAvatars(mainRow(page, a2), [B]);
    });
  });

  test('AC-R2-3 receipts on hidden events (reaction, edit, redaction) attach to the nearest earlier row', async ({ page }) => {
    await start(page, R.dev);
    // Reaction.
    const a3 = await sendApi(page, R.dev, uniq('R23 reacted'));
    const reaction = await bob.react(R.dev, a3, '👀');
    await readAs('bob', R.dev, reaction);
    await expectReadersAt(page, R.dev, a3, [B], { message: 'receipt on the reaction -> A3' });
    await uiHalf('Dev A', [...UI.avatars], () => expectAvatars(mainRow(page, a3), [B]));
    // Edit (alice edits her own message; bob reads the m.replace event).
    const a3e = await sendApi(page, R.dev, uniq('R23 edited'));
    const edit = await alice.sendEvent(R.dev, 'm.room.message', {
      msgtype: 'm.text',
      body: '* R23 edited (v2)',
      'm.new_content': { msgtype: 'm.text', body: 'R23 edited (v2)' },
      'm.relates_to': { rel_type: 'm.replace', event_id: a3e },
    });
    await expect(mainRow(page, a3e).getByTestId('message-edited')).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await readAs('bob', R.dev, edit);
    await expectReadersAt(page, R.dev, a3e, [B], { message: 'receipt on the edit -> the edited row' });
    expect(await readersAt(page, R.dev, a3)).toEqual([]);
    await uiHalf('Dev A', [...UI.avatars], () => expectAvatars(mainRow(page, a3e), [B]));
    // Redaction (the redacted row stays rendered as message-redacted and keeps the avatar).
    const a3r = await sendApi(page, R.dev, uniq('R23 redacted'));
    const redaction = await alice.redact(R.dev, a3r);
    await expect(mainRow(page, a3r).getByTestId('message-redacted')).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await readAs('bob', R.dev, redaction);
    await expectReadersAt(page, R.dev, a3r, [B], { message: 'receipt on the redaction -> the redacted row' });
    await uiHalf('Dev A', [...UI.avatars], () => expectAvatars(mainRow(page, a3r), [B]));
  });

  test('AC-R2-4 (P1) four throwaway readers: data-count 4, three avatars, +1', async ({ page }) => {
    const room = await plusNRoom(R.acme, 4);
    try {
      const id = await alice.send(room.roomId, uniq('R24 plus n'));
      for (const r of room.readers) await readAs(r, room.roomId, id);
      await start(page, room.roomId);
      await expect(mainRow(page, id)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
      const ids = room.readers.map((r) => r.userId);
      await expectReadersAt(page, room.roomId, id, [...ids].reverse(), { ordered: true, message: '4 readers, newest first' });
      await uiHalf('Dev A', [...UI.avatars, ...UI.more], async () => {
        const strip = receiptAvatars(mainRow(page, id));
        await expect(strip).toHaveAttribute('data-count', '4', { timeout: RECEIPT_TIMEOUT });
        await expect(strip.getByTestId('receipt-avatar')).toHaveCount(3);
        await expect(strip.getByTestId('receipt-more')).toHaveText('+1');
        await expect(strip).toHaveAttribute('aria-label', /^Seen by .+, .+, .+ and 1 others?$/);
      });
    } finally {
      await room.cleanup();
    }
  });

  test('AC-R2-5 + AC-R10-2 three readers newest first, no +N, alice never an avatar; UI == core', async ({ page }) => {
    await start(page, R.dev);
    const a4 = await sendApi(page, R.dev, uniq('R25 A4'));
    await readAs('bob', R.dev, a4);
    await readAs('carol', R.dev, a4);
    await readAs('dave', R.dev, a4);
    await expectReadersAt(page, R.dev, a4, [D, C, B], { ordered: true });
    const points = await readPointsOf(page, R.dev);
    expect(Object.values(points).flat(), 'alice is never a reader on any row').not.toContain(A);
    await uiHalf('Dev A', [...UI.avatars], async () => {
      const r = mainRow(page, a4);
      await expectAvatars(r, [D, C, B], { ordered: true });
      await expect(r.getByTestId('receipt-more')).toHaveCount(0);
      await expect(avatarOf(page, A), "alice's own receipt never produces an avatar").toHaveCount(0);
      // AC-R10-2: what the UI shows is what the hook says.
      const core = await readersAt(page, R.dev, a4);
      await expect(receiptAvatars(r)).toHaveAttribute('data-count', String(core.length));
      expect(await avatarIds(r)).toEqual(core.slice(0, 3));
    });
  });

  test('AC-R2-6 #vault: bob reads V1 like in #dev; an undecryptable row still shows its readers', async ({ page }) => {
    test.setTimeout(180_000);
    // A genuine historical UTD for alice's new device: the sample device sends before alice logs in.
    const sample = runSample({ count: 1 });
    const utd = sample.eventIds[0]!;
    await readAs('dave', R.vault, utd);
    await start(page, R.vault, { encrypted: true });
    const v1 = await sendUi(page, uniq('R26 V1'));
    await readAs('bob', R.vault, v1);
    await expectReadersAt(page, R.vault, v1, [B]);
    await expect.poll(async () => (await readersAt(page, R.vault, utd)).includes(D), { timeout: RECEIPT_TIMEOUT, message: "dave's read point is the UTD row" }).toBe(true);
    await uiHalf('Dev A', [...UI.avatars], async () => {
      await expectAvatars(mainRow(page, v1), [B]);
      const u = mainRow(page, utd);
      await expect(u.getByTestId('message-undecryptable')).toBeVisible({ timeout: 20_000 });
      await expect(receiptAvatars(u)).toBeVisible();
      expect(await avatarIds(u)).toContain(D);
    });
  });
});

/* ================================================================== AC-R3 seen-by list */

test.describe('AC-R3 seen-by list', () => {
  test('AC-R3-1 + AC-R10-2 hover opens the popover: bob before carol, dave not seen; alice nowhere', async ({ page }) => {
    await start(page, R.dev);
    const a5 = await sendApi(page, R.dev, uniq('R31 A5'));
    await readAs('carol', R.dev, a5);
    await readAs('bob', R.dev, a5);
    await expectReadersAt(page, R.dev, a5, [B, C], { ordered: true });
    let core = await seenByOf(page, R.dev, a5);
    await expect.poll(async () => (core = await seenByOf(page, R.dev, a5)).seen, { timeout: RECEIPT_TIMEOUT }).toEqual([B, C]);
    expect(core.notSeen).toEqual([D]);
    expect([...core.seen, ...core.notSeen], 'viewer + sender (alice) in neither list').not.toContain(A);
    expect(core.raw.seen.every((r) => r.ts > 0), 'seen entries carry a read time').toBe(true);

    requireUi('Dev A', ...UI.avatars, ...UI.list);
    await receiptAvatars(mainRow(page, a5)).hover();
    const list = receiptList(page);
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('data-event-id', a5);
    await expect(list).toHaveAttribute('data-mode', 'popover');
    await expect(list.getByTestId('receipt-list-seen')).toContainText('Seen by');
    await expect(list.getByTestId('receipt-list-unseen')).toContainText('Not seen yet');
    expect(await listIds(page, 'seen')).toEqual([B, C]);
    expect(await listIds(page, 'unseen')).toEqual([D]);
    for (const [uid, name] of [[B, DISPLAY_NAMES.bob], [C, DISPLAY_NAMES.carol]] as const) {
      const item = list.locator(`[data-testid="receipt-list-item"][data-user-id="${uid}"]`);
      await expect(item).toContainText(name);
      await expect(item.getByTestId('receipt-list-time')).toBeVisible();
      await expect(item.getByTestId('receipt-list-time')).toHaveAttribute('title', /\d/);
    }
    await expect(list.locator(`[data-user-id="${A}"]`)).toHaveCount(0);
  });

  test('AC-R3-2 click keeps it open; Escape and outside click close; only one list at a time', async ({ page }) => {
    await start(page, R.dev);
    const first = await sendApi(page, R.dev, uniq('R32 first'));
    const second = await sendApi(page, R.dev, uniq('R32 second'));
    await readAs('carol', R.dev, first);
    await readAs('bob', R.dev, second);
    await expectReadersAt(page, R.dev, first, [C]);
    await expectReadersAt(page, R.dev, second, [B]);
    requireUi('Dev A', ...UI.avatars, ...UI.list);
    const list = receiptList(page);

    await receiptAvatars(mainRow(page, first)).click();
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('data-event-id', first);
    await page.getByTestId('composer-input').hover(); // pointer leaves the trigger
    await expect(list, 'a clicked list stays open after the pointer leaves').toBeVisible();
    await expect(list).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);

    await receiptAvatars(mainRow(page, first)).click();
    await expect(list).toBeVisible();
    await page.getByTestId('channel-header').click({ position: { x: 5, y: 5 } });
    await expect(list, 'an outside click closes it').toHaveCount(0);

    await receiptAvatars(mainRow(page, first)).click();
    await expect(list).toHaveAttribute('data-event-id', first);
    await receiptAvatars(mainRow(page, second)).click();
    await expect(list, 'exactly one receipt-list').toHaveCount(1);
    await expect(list).toHaveAttribute('data-event-id', second);
  });

  test('AC-R3-3 nobody read A6: Seen by from the actions lists bob, carol, dave; B1 excludes its sender', async ({ page }) => {
    await start(page, R.dev);
    const a6 = await sendApi(page, R.dev, uniq('R33 A6'));
    expect(await readersAt(page, R.dev, a6)).toEqual([]);
    const core = await seenByOf(page, R.dev, a6);
    expect(core.seen).toEqual([]);
    expect([...core.notSeen].sort()).toEqual([B, C, D].sort());
    await uiHalf('Dev B', [...UI.seenByAction, ...UI.list, ...UI.listEmpty], async () => {
      await expect(receiptAvatars(mainRow(page, a6))).toHaveCount(0);
      const list = await openSeenByFromActions(page, mainRow(page, a6), a6);
      await expect(list.getByTestId('receipt-list-empty')).toHaveText('Nobody has seen this yet');
      await expect(list.getByTestId('receipt-list-seen')).toHaveCount(0);
      expect((await listIds(page, 'unseen')).sort()).toEqual([B, C, D].sort());
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
    });
    // Only now may bob post: posting after A6 would count as having seen it.
    const b1 = await bob.send(R.dev, uniq('R33 B1'));
    await expect(mainRow(page, b1)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    const forB1 = await seenByOf(page, R.dev, b1);
    expect([...forB1.notSeen].sort(), 'sender (bob) and viewer (alice) excluded').toEqual([C, D].sort());
    expect(forB1.seen).not.toContain(B);
    await uiHalf('Dev B', [...UI.seenByAction, ...UI.list], async () => {
      await openSeenByFromActions(page, mainRow(page, b1), b1);
      expect((await listIds(page, 'unseen')).sort()).toEqual([C, D].sort());
      expect(await listIds(page, 'seen')).not.toContain(B);
    });
  });

  test('AC-R3-4 a private receipt (bob m.read.private) reads as Not seen yet, never Seen by', async ({ page }) => {
    await start(page, R.dev);
    const a7 = await sendApi(page, R.dev, uniq('R34 A7'));
    await readPrivateAs('bob', R.dev, a7);
    await expect.poll(() => receiptTypesOn('bob', R.dev, a7, B), { timeout: RECEIPT_TIMEOUT, message: "bob's own sync holds his private receipt" }).toEqual(['m.read.private']);
    // Sentinel: carol's public receipt after bob's private one; once alice sees carol, bob's absence is judged.
    await readAs('carol', R.dev, a7);
    await expectReadersAt(page, R.dev, a7, [C]);
    const core = await seenByOf(page, R.dev, a7);
    expect(core.seen).toEqual([C]);
    expect(core.notSeen).toContain(B);
    expect([...core.seen, ...core.notSeen]).not.toContain(A);
    expect(await receiptTypesOn('alice', R.dev, a7, B), "alice's sync never carries bob's private receipt").toEqual([]);
    await uiHalf('Dev B', [...UI.seenByAction, ...UI.list], async () => {
      await openSeenByFromActions(page, mainRow(page, a7), a7);
      expect(await listIds(page, 'seen')).toEqual([C]);
      expect(await listIds(page, 'unseen')).toContain(B);
      await expect(receiptList(page).locator(`[data-user-id="${A}"]`)).toHaveCount(0);
    });
  });
});

/* ================================================================== AC-R4 Seen by action */

test.describe('AC-R4 Seen by in the message actions', () => {
  const EXISTING = ['message-action-react', 'message-action-reply', 'message-action-thread', 'message-action-edit', 'message-action-delete'];

  async function actionIds(page: Page, eventId: string): Promise<string[]> {
    const bar = await hoverActions(page, eventId);
    return bar.locator('[data-testid^="message-action-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  }

  test('AC-R4-1 Seen by on own and bob rows, appended after the existing actions; all usable beside the thread panel', async ({ page }) => {
    requireUi('Dev B', ...UI.seenByAction, ...UI.list);
    await start(page, R.dev);
    const mine = await sendApi(page, R.dev, uniq('R41 mine'));
    const theirs = await bob.send(R.dev, uniq('R41 bob'));
    await expect(mainRow(page, theirs)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    for (const id of [mine, theirs]) {
      const ids = await actionIds(page, id);
      expect(ids, `${id}: Seen by present`).toContain('message-action-seen-by');
      expect(ids[ids.length - 1], 'Seen by is appended last').toBe('message-action-seen-by');
      const existing = ids.filter((t) => EXISTING.includes(t));
      expect(existing, 'existing actions keep their order').toEqual(EXISTING.filter((t) => existing.includes(t)));
      await expect(mainRow(page, id).getByTestId('message-action-seen-by')).toHaveAttribute('aria-label', 'Seen by');
      await mainRow(page, id).getByTestId('message-action-seen-by').click();
      await expect(receiptList(page)).toHaveAttribute('data-event-id', id);
      await page.keyboard.press('Escape');
      await expect(receiptList(page)).toHaveCount(0);
    }
    expect(await actionIds(page, mine), 'own row has every existing action').toEqual(expect.arrayContaining(EXISTING));

    // Narrowest column: the thread panel open beside the channel.
    await openThreadFromMessage(page, theirs);
    const bar = await hoverActions(page, mine);
    const buttons = bar.locator('[data-testid^="message-action-"]');
    const n = await buttons.count();
    expect(n).toBeGreaterThanOrEqual(EXISTING.length + 1);
    const listBox = (await messageList(page).boundingBox())!;
    for (let i = 0; i < n; i += 1) {
      const btn = buttons.nth(i);
      const tid = await btn.getAttribute('data-testid');
      await expect(btn, `${tid} visible with the thread panel open`).toBeVisible();
      const bb = (await btn.boundingBox())!;
      expect(bb.x >= listBox.x - 1 && bb.x + bb.width <= listBox.x + listBox.width + 1, `${tid} inside the message column`).toBe(true);
      const hit = await btn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === el || el.contains(top));
      });
      expect(hit, `${tid} is the topmost element at its centre (clickable)`).toBe(true);
    }
    await bar.getByTestId('message-action-seen-by').click();
    await expect(receiptList(page)).toHaveAttribute('data-event-id', mine);
  });

  test('AC-R4-2 a redacted row has no Seen by action', async ({ page }) => {
    requireUi('Dev B', ...UI.seenByAction);
    await start(page, R.dev);
    const live = await sendApi(page, R.dev, uniq('R42 live'));
    const gone = await sendApi(page, R.dev, uniq('R42 gone'));
    await alice.redact(R.dev, gone);
    await expect(mainRow(page, gone).getByTestId('message-redacted')).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    // Sentinel: the action exists on a live row first.
    await hoverActions(page, live);
    await expect(mainRow(page, live).getByTestId('message-action-seen-by')).toBeVisible();
    await mainRow(page, gone).hover();
    await expect(mainRow(page, gone).getByTestId('message-action-seen-by')).toHaveCount(0);
  });
});

/* ================================================================== AC-R6 threads */

test.describe('AC-R6 threads', () => {
  test('AC-R6-1 a threaded receipt shows in the thread panel only', async ({ page }) => {
    await start(page, R.dev);
    const { root, t1 } = await threadWithAliceReply(page, 'R61');
    const mainBefore = await rowOfReader(page, R.dev, B);
    await readAs('bob', R.dev, t1, root);
    await expectReadersAt(page, R.dev, t1, [B], { threadRootId: root, message: 'thread readers at T1' });
    expect(await rowOfReader(page, R.dev, B), "bob's main read point does not move for a threaded receipt").toBe(mainBefore);
    expect(Object.keys(await readPointsOf(page, R.dev))).not.toContain(t1);
    await uiHalf('Dev B', [...UI.avatars], async () => {
      await expectAvatars(threadRowIn(page, t1), [B]);
      const mainBob = avatarOf(page, B);
      if (mainBefore) {
        await expect(mainBob).toHaveCount(1);
        await expect(mainRow(page, mainBefore).getByTestId('receipt-avatar').and(page.locator(`[data-user-id="${B}"]`))).toHaveCount(1);
      } else {
        await expect(mainBob).toHaveCount(0);
      }
    });
  });

  test('AC-R6-2 a main-timeline receipt (thread_id "main") shows on no thread row', async ({ page }) => {
    await start(page, R.dev);
    const { root, t1 } = await threadWithAliceReply(page, 'R62');
    const m = await sendApi(page, R.dev, uniq('R62 main M'));
    // `thread_id: "main"` is what Codec and Element send for the main timeline (threadSupport: true).
    await readAs('bob', R.dev, m, 'main');
    await expectReadersAt(page, R.dev, m, [B], { message: 'sentinel: bob read M in main' });
    const threadPoints = await readPointsOf(page, R.dev, root);
    expect(threadPoints, 'no thread row carries bob for a main receipt').not.toEqual(expect.objectContaining({ [t1]: expect.arrayContaining([B]) }));
    expect(Object.values(threadPoints).flat()).not.toContain(B);
    await uiHalf('Dev B', [...UI.avatars], async () => {
      await expectAvatars(mainRow(page, m), [B]);
      await expect(avatarOf(page, B, 'thread-panel')).toHaveCount(0);
    });
  });

  test('AC-R6-2b an UNTHREADED receipt newer than T1: the thread avatar agrees with getSeenBy (spec: it covers threads)', async ({ page }) => {
    await start(page, R.dev);
    const { root, t1 } = await threadWithAliceReply(page, 'R62b');
    const m = await sendApi(page, R.dev, uniq('R62b main M'));
    // Advisor ruling (AC-R6-2): the SDK's unthreaded fallback in Thread.getEventReadUpTo compares by ts, not DAG order.
    // T1 and M are posted with real round trips in between, so this is deterministic; never assert it on events
    // posted within the same second.
    await readAs('bob', R.dev, m); // no thread_id: an unthreaded receipt, which per the Matrix spec also reads every thread up to it
    await expectReadersAt(page, R.dev, m, [B], { message: 'sentinel: bob read M in main' });
    const seen = await seenByOf(page, R.dev, t1, root);
    const onT1 = (await readersAt(page, R.dev, t1, root)).includes(B);
    expect(onT1, `avatar on T1 (${onT1}) must agree with getSeenBy(T1).seen containing bob (${seen.seen.includes(B)})`).toBe(seen.seen.includes(B));
    annotate('ruling', `unthreaded receipt -> bob on T1 in the thread: ${onT1} (docs/BUGS.md "Read receipts", AC-R6-2 note)`);
  });

  test('AC-R6-3 one sent check per timeline: T2 in the thread, M in the main list', async ({ page }) => {
    await start(page, R.dev);
    const { rootId } = await seedThread({ roomId: R.dev, rootSender: 'bob', rootBody: uniq('R63 root') });
    await expect(mainRow(page, rootId)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    const m = await sendApi(page, R.dev, uniq('R63 main M'));
    const t2 = await alice.sendThreadReply(R.dev, rootId, uniq('R63 T2'), { latest: rootId });
    await openThreadFromMessage(page, rootId);
    await expect(threadRowIn(page, t2)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expect.poll(() => latestOwnSentId(page, R.dev, rootId), { timeout: RECEIPT_TIMEOUT, message: 'thread sent check' }).toBe(t2);
    await expect.poll(() => latestOwnSentId(page, R.dev), { timeout: RECEIPT_TIMEOUT, message: 'main sent check' }).toBe(m);
    await uiHalf('Dev B', [...UI.status], async () => {
      await expect(receiptStatus(threadRowIn(page, t2))).toHaveAttribute('data-status', 'sent');
      await expect(receiptStatus(mainRow(page, m))).toHaveAttribute('data-status', 'sent');
    });
  });

  test('AC-R6-4 (P1) a threaded receipt on a reaction to T1 attaches to T1', async ({ page }) => {
    await start(page, R.dev);
    const { root, t1 } = await threadWithAliceReply(page, 'R64');
    const reaction = await bob.react(R.dev, t1, '👍');
    await readAs('bob', R.dev, reaction, root);
    await expectReadersAt(page, R.dev, t1, [B], { threadRootId: root });
    await uiHalf('Dev B', [...UI.avatars], () => expectAvatars(threadRowIn(page, t1), [B]));
  });
});

/* ================================================================== AC-R7 private receipts setting */

test.describe('AC-R7 Send read receipts setting', () => {
  let settings: Awaited<ReturnType<typeof snapshotSettings>>;
  test.beforeEach(async () => {
    settings = await snapshotSettings('alice');
  });
  test.afterEach(async () => {
    // Never leave alice OFF for the next spec on this worker.
    await settings.restore();
  });

  /** OFF/ON through the toggle when it exists, else through the hook (annotated `core-fallback`). */
  async function setSetting(page: Page, on: boolean): Promise<void> {
    const viaUi = await uiHalf('Dev A', [...UI.toggle], async () => {
      const t = receiptToggle(page);
      await expect(t).toBeVisible();
      if ((await t.getAttribute('aria-checked')) !== String(on)) await t.click();
      await expect(t).toHaveAttribute('aria-checked', String(on));
    });
    if (!viaUi) {
      annotate('core-fallback', `setSendReadReceipts(${on}) through the dev hook`);
      await setAppSetting(page, on);
    }
    await expect.poll(() => appSetting(page), { timeout: RECEIPT_TIMEOUT }).toBe(on);
    await expect.poll(async () => (await accountDataOf('alice'))?.[SETTINGS_KEY], { timeout: RECEIPT_TIMEOUT, message: 'account data' }).toBe(on);
  }

  test('AC-R7-1 default ON for an account without the key', async ({ page }) => {
    const { [SETTINGS_KEY]: _drop, ...rest } = settings.before ?? {};
    await putAccountData('alice', SETTINGS_TYPE, rest);
    await start(page, R.dev);
    expect(await appSetting(page)).toBe(true);
    await uiHalf('Dev A', [...UI.toggle], async () => {
      await expect(receiptToggle(page)).toBeVisible();
      await expect(receiptToggle(page)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByText('Send read receipts')).toBeVisible();
    });
  });

  test('AC-R7-2 OFF: alice posts m.read.private only, bob never sees her, her unread still clears', async ({ page, browser }) => {
    const reqs = await start(page, R.vault);
    await setSetting(page, false);
    const mark = Date.now();

    const b2 = await bob.send(R.dev, uniq('R72 B2'));
    await expect.poll(() => appUnread(page, R.dev), { timeout: RECEIPT_TIMEOUT, message: '#dev goes unread for alice first' }).toBeGreaterThanOrEqual(1);
    await openRoom(page, R.dev);
    await expect(mainRow(page, b2)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expect.poll(() => reqs.forEvent(b2).map((r) => r.type), { timeout: RECEIPT_TIMEOUT, message: 'alice receipts B2' }).toContain('m.read.private');
    expect(reqs.since(mark).filter((r) => r.type !== 'm.read.private'), 'S1: never a public m.read while OFF').toEqual([]);

    // Server: alice holds a private receipt on B2; bob's sync never carries alice there.
    await expect.poll(() => receiptTypesOn('alice', R.dev, b2, A), { timeout: RECEIPT_TIMEOUT }).toContain('m.read.private');
    await readAs('carol', R.dev, b2); // sentinel, after alice's private receipt landed
    await expect.poll(() => receiptTypesOn('bob', R.dev, b2, C), { timeout: RECEIPT_TIMEOUT }).toEqual(['m.read']);
    expect(await receiptTypesOn('bob', R.dev, b2, A), "bob's sync has no receipt of alice on B2").toEqual([]);
    expect(await bob.readReceiptOf(R.dev, A)).not.toBe(b2);

    // Unread clears (app + server) with the private receipt.
    await expect.poll(() => appUnread(page, R.dev), { timeout: RECEIPT_TIMEOUT }).toBe(0);
    await expect.poll(() => notificationCount('alice', R.dev), { timeout: RECEIPT_TIMEOUT, message: 'server notification_count' }).toBe(0);

    // bob's own client.
    const b = await contextIn(browser, 'bob', R.dev);
    await expect.poll(async () => (await readersAt(b.page, R.dev, b2)).includes(C), { timeout: RECEIPT_TIMEOUT, message: "bob's client sees carol on B2 (sentinel)" }).toBe(true);
    expect(await readersAt(b.page, R.dev, b2), "bob's client never places alice at B2").not.toContain(A);
    await uiHalf('Dev A', [...UI.avatars], async () => {
      await expect.poll(async () => avatarIds(mainRow(b.page, b2)), { timeout: RECEIPT_TIMEOUT }).toContain(C);
      expect(await avatarIds(mainRow(b.page, b2))).not.toContain(A);
    });
    expect(reqs.since(mark).filter((r) => r.type !== 'm.read.private'), 'S1 (end of test)').toEqual([]);
    await b.close();
  });

  test('AC-R7-3 OFF still shows others; back ON: m.read again and bob sees alice', async ({ page, browser }) => {
    const reqs = await start(page, R.dev);
    await setSetting(page, false);
    const offMark = Date.now();
    const a8 = await sendApi(page, R.dev, uniq('R73 A8'));
    await readAs('bob', R.dev, a8);
    await expectReadersAt(page, R.dev, a8, [B], { message: 'alice still sees public receipts while OFF' });
    await uiHalf('Dev A', [...UI.avatars], () => expectAvatars(mainRow(page, a8), [B]));
    expect(reqs.since(offMark).filter((r) => r.type !== 'm.read.private'), 'S1 while OFF').toEqual([]);

    await setSetting(page, true);
    const b3 = await bob.send(R.dev, uniq('R73 B3'));
    await expect(mainRow(page, b3)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expect.poll(() => reqs.forEvent(b3).map((r) => r.type), { timeout: RECEIPT_TIMEOUT }).toContain('m.read');
    await expect.poll(() => receiptTypesOn('bob', R.dev, b3, A), { timeout: RECEIPT_TIMEOUT }).toContain('m.read');
    const b = await contextIn(browser, 'bob', R.dev);
    await expectReadersAt(b.page, R.dev, b3, [A], { message: "bob's client shows alice on B3" });
    await uiHalf('Dev A', [...UI.avatars], () => expectAvatars(mainRow(b.page, b3), [A]));
    await b.close();
  });

  test('AC-R7-4 account data merge, survives a reload, flips live from an API PUT', async ({ page }) => {
    const { [SETTINGS_KEY]: _drop, ...rest } = settings.before ?? {};
    await putAccountData('alice', SETTINGS_TYPE, { ...rest, someOtherKey: 1 });
    await start(page, R.dev);
    await setSetting(page, false);
    const stored = await accountDataOf('alice');
    expect(stored).toEqual({ ...rest, someOtherKey: 1, [SETTINGS_KEY]: false });

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await waitForReceiptsHook(page);
    await expect.poll(() => appSetting(page), { timeout: RECEIPT_TIMEOUT, message: 'still OFF after reload' }).toBe(false);
    await uiHalf('Dev A', [...UI.toggle], () => expect(receiptToggle(page)).toHaveAttribute('aria-checked', 'false', { timeout: RECEIPT_TIMEOUT }));

    await putAccountData('alice', SETTINGS_TYPE, { ...stored, [SETTINGS_KEY]: true }); // "as Element would do"
    await expect.poll(() => appSetting(page), { timeout: RECEIPT_TIMEOUT, message: 'flips live from account data' }).toBe(true);
    await uiHalf('Dev A', [...UI.toggle], () => expect(receiptToggle(page)).toHaveAttribute('aria-checked', 'true', { timeout: RECEIPT_TIMEOUT }));
  });
});

/* ================================================================== AC-R8 accessibility */

test.describe('AC-R8 accessibility', () => {
  test('AC-R8-1 status, avatars and list carry their roles and labels', async ({ page }) => {
    requireUi('Dev A', ...UI.status, ...UI.avatars, ...UI.list);
    await start(page, R.dev);
    const a = await sendUi(page, uniq('R81'));
    const st = receiptStatus(mainRow(page, a));
    await expect(st).toHaveAttribute('data-status', 'sent', { timeout: RECEIPT_TIMEOUT });
    await expect(st).toHaveAttribute('aria-label', 'Sent');
    await expect(st).toHaveAttribute('title', 'Sent');
    await readAs('bob', R.dev, a);
    const strip = receiptAvatars(mainRow(page, a));
    await expect(strip).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    // Review finding 2 (2026-10-18): the strip opens a dialog, so it is a button with aria-haspopup / aria-expanded.
    await expect(strip).toHaveAttribute('role', 'button');
    await expect(strip).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(strip).toHaveAttribute('aria-expanded', 'false');
    await expect(strip).toHaveAttribute('aria-label', `Seen by ${DISPLAY_NAMES.bob}`);
    const imgs = strip.locator('img');
    for (let i = 0; i < (await imgs.count()); i += 1) await expect(imgs.nth(i)).toHaveAttribute('alt', '');
    await strip.click();
    const list = receiptList(page);
    await expect(list).toHaveAttribute('role', 'dialog');
    await expect(list).toHaveAttribute('aria-label', 'Seen by');
    await expect(strip, 'aria-expanded while its list is open').toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(strip, 'aria-expanded once it closed').toHaveAttribute('aria-expanded', 'false');
  });

  test('AC-R8-2 keyboard: avatars focusable, Enter / Space open, Escape closes and returns focus', async ({ page }) => {
    requireUi('Dev A', ...UI.avatars, ...UI.list);
    await start(page, R.dev);
    const a = await sendApi(page, R.dev, uniq('R82'));
    await readAs('bob', R.dev, a);
    const strip = receiptAvatars(mainRow(page, a));
    await expect(strip).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expect(strip).toHaveAttribute('tabindex', '0');
    const list = receiptList(page);
    for (const key of ['Enter', ' ']) {
      await strip.focus();
      await page.keyboard.press(key);
      await expect(list, `${JSON.stringify(key)} opens the list`).toBeVisible();
      await expect.poll(() => list.evaluate((el) => el.contains(document.activeElement)), { message: 'focus moves into the list' }).toBe(true);
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
      await expect(strip, 'focus returns to the trigger').toBeFocused();
    }
  });
});

/* ================================================================== AC-R9 scroll stability */

test.describe('AC-R9 scroll stability', () => {
  test('AC-R9-1 pinned to the bottom: the check -> avatars swap keeps the bottom and the rows above', async ({ page }) => {
    requireUi('Dev A', ...UI.status, ...UI.avatars);
    await start(page, R.dev);
    const above = await sendUi(page, uniq('R91 above'));
    const a = await sendUi(page, uniq('R91 newest'));
    await expect(receiptStatus(mainRow(page, a))).toHaveAttribute('data-status', 'sent', { timeout: RECEIPT_TIMEOUT });
    await expect.poll(() => bottomGap(page), { message: 'pinned to the bottom before' }).toBeLessThan(2);
    const before = await topOf(mainRow(page, above));
    await readAs('bob', R.dev, a);
    await expect(receiptAvatars(mainRow(page, a))).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(await bottomGap(page), 'still at the bottom').toBeLessThan(2);
    const after = await topOf(mainRow(page, above));
    expect(Math.abs(after - before), `row above moved ${after - before}px`).toBeLessThanOrEqual(2);
  });

  test('AC-R9-2 scrolled up: avatars moving below the viewport do not move the row being read', async ({ page }) => {
    requireUi('Dev A', ...UI.avatars);
    await start(page, R.dev);
    const carol = await asUser('carol');
    const tag = uniq('R92');
    const ids: string[] = [];
    for (let i = 0; i < 40; i += 1) ids.push(await carol.send(R.dev, `${tag} filler ${i + 1}`));
    await expect(mainRow(page, ids[39]!)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    const anchor = mainRow(page, ids[5]!);
    await anchor.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await expect.poll(() => bottomGap(page), { message: 'scrolled well away from the bottom' }).toBeGreaterThan(200);
    const listBox = (await messageList(page).boundingBox())!;
    const targetTop = await topOf(mainRow(page, ids[36]!));
    if (targetTop < listBox.y + listBox.height) annotate('geometry', `filler 37 is inside the viewport (top ${targetTop}, list bottom ${listBox.y + listBox.height})`);
    const before = await topOf(anchor);
    await readAs('bob', R.dev, ids[36]!);
    await expect(receiptAvatars(mainRow(page, ids[36]!))).toHaveCount(1, { timeout: RECEIPT_TIMEOUT });
    await readAs('bob', R.dev, ids[39]!);
    await expect.poll(async () => avatarIds(mainRow(page, ids[39]!)), { timeout: RECEIPT_TIMEOUT }).toContain(B);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const after = await topOf(anchor);
    expect(Math.abs(after - before), `the row being read moved ${after - before}px`).toBeLessThanOrEqual(2);
  });
});

/* ================================================================== stick band (AC-L7-4 root cause) */

/*
 * Regressions for Dev B's stick-to-bottom fix (2026-10-18): "stuck" = within 40 px of the bottom, and any commit or
 * late growth used to snap to the *true* bottom, moving every visible row by the remaining gap. Each test parks
 * the list 10-35 px above the bottom, triggers one non-arrival change, and asserts the newest row (below every
 * change) has not moved and the gap is kept.
 */
test.describe('Stick band: parked just above the bottom', () => {
  async function parked(page: Page, label: string): Promise<{ older: string; visible: string; newest: string; gap: number; before: number }> {
    // Everything is posted BEFORE alice logs in, so it arrives in the initial sync window (~30 events): posting 27
    // events while she is live can produce a limited sync, which resets the timeline and drops the older row.
    const older = await alice.send(R.dev, uniq(`${label} older`));
    for (let i = 0; i < 23; i += 1) await bob.send(R.dev, `${label} filler ${i + 1}`);
    const visible = await alice.send(R.dev, uniq(`${label} visible`)); // alice's own visible row, editable by her
    const last = await bob.send(R.dev, `${label} last`);
    await start(page, R.dev);
    await expect(mainRow(page, last)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expect(mainRow(page, older), 'the older row is in the initial window').toBeAttached({ timeout: RECEIPT_TIMEOUT });
    const gap = await parkAboveBottom(page, 20);
    expect(gap, 'parked inside the 40 px band').toBeGreaterThanOrEqual(10);
    expect(gap).toBeLessThanOrEqual(35);
    const listBox = (await messageList(page).boundingBox())!;
    const olderBox = (await mainRow(page, older).boundingBox())!;
    expect(olderBox.y + olderBox.height, 'the older row is above the viewport').toBeLessThan(listBox.y);
    return { older, visible, newest: last, gap, before: await topOf(mainRow(page, last)) };
  }

  async function expectNoJump(page: Page, p: { newest: string; gap: number; before: number }, what: string): Promise<void> {
    await nextFrames(page);
    const after = await topOf(mainRow(page, p.newest));
    expect(Math.abs(after - p.before), `${what}: the newest row moved ${after - p.before}px`).toBeLessThanOrEqual(2);
    const gapAfter = await bottomGap(page);
    expect(Math.abs(gapAfter - p.gap), `${what}: bottom gap kept (${p.gap} -> ${gapAfter}), not snapped to 0`).toBeLessThanOrEqual(2);
  }

  test('REG-STICK-b1 a typing notification does not jump the list', async ({ page }) => {
    const p = await parked(page, 'STb1');
    await bob.typing(R.dev, true, 20_000);
    await expect(page.getByTestId('typing-indicator')).toContainText(/typing/i, { timeout: RECEIPT_TIMEOUT });
    await expectNoJump(page, p, 'typing on');
    await bob.typing(R.dev, false);
  });

  test('REG-STICK-b2 an edit of a visible message does not jump the list', async ({ page }) => {
    const p = await parked(page, 'STb2');
    await alice.sendEvent(R.dev, 'm.room.message', {
      msgtype: 'm.text',
      body: '* STb2 visible (v2)',
      'm.new_content': { msgtype: 'm.text', body: 'STb2 visible (v2)' },
      'm.relates_to': { rel_type: 'm.replace', event_id: p.visible },
    });
    await expect(mainRow(page, p.visible).getByTestId('message-edited')).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expectNoJump(page, p, 'edit');
  });

  test('REG-STICK-c a read-avatar strip appearing on an older row above the viewport does not jump the list', async ({ page }) => {
    requireUi('Dev A', ...UI.avatars);
    const p = await parked(page, 'STc');
    await readAs('carol', R.dev, p.older);
    await expectReadersAt(page, R.dev, p.older, [C]);
    await expect(receiptAvatars(mainRow(page, p.older))).toHaveCount(1, { timeout: RECEIPT_TIMEOUT });
    await expectNoJump(page, p, 'strip above the viewport');
  });
});

/* ================================================================== review findings (fix wave regressions) */

test.describe('Review findings (regressions)', () => {
  let settings: Awaited<ReturnType<typeof snapshotSettings>>;
  test.beforeEach(async () => {
    settings = await snapshotSettings('alice');
  });
  test.afterEach(async () => {
    await settings.restore();
  });

  test('REV-R1 toggle OFF in the UI takes effect before the account-data echo: the next receipt is m.read.private (S1)', async ({ page }) => {
    requireUi('Dev A', ...UI.toggle);
    const reqs = await start(page, R.dev);
    const toggle = receiptToggle(page);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Hold the account-data PUT: the server never stores the new value, so no /sync echo can arrive while held.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    let passed = 0;
    const pattern = `**/user/*/account_data/${SETTINGS_TYPE}`;
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      held += 1;
      await Promise.race([gate, new Promise((r) => setTimeout(r, 30_000))]);
      passed += 1;
      await route.continue().catch(() => undefined);
    });
    const mark = Date.now();
    await toggle.click();
    await expect.poll(() => held, { message: 'the PUT is in flight (held)' }).toBe(1);
    expect(await appSetting(page), 'OFF immediately, before the echo').toBe(false);
    const b = await bob.send(R.dev, uniq('REV1 B'));
    await expect(mainRow(page, b)).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    await expect.poll(() => reqs.forEvent(b).map((r) => r.type), { timeout: RECEIPT_TIMEOUT, message: 'alice receipts B while the write is held' }).toContain('m.read.private');
    expect(passed, 'the PUT was still held when the receipt went out').toBe(0);
    expect(await accountDataOf('alice').then((c) => c?.[SETTINGS_KEY]), 'the server has not seen OFF yet').not.toBe(false);
    expect(reqs.since(mark).filter((r) => r.type !== 'm.read.private'), 'S1: never a public m.read after the toggle').toEqual([]);
    release();
    await expect.poll(async () => (await accountDataOf('alice'))?.[SETTINGS_KEY], { timeout: RECEIPT_TIMEOUT, message: 'the write lands' }).toBe(false);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await appSetting(page)).toBe(false);
    await page.unroute(pattern);
    expect(await receiptTypesOn('bob', R.dev, b, A), "bob's sync never carries alice on B").toEqual([]);
    expect(reqs.since(mark).filter((r) => r.type !== 'm.read.private'), 'S1 (end of test)').toEqual([]);
  });

  test('REV-R5 Escape: a hover preview closes AND the thread panel closes; a pinned list keeps the panel open', async ({ page }) => {
    requireUi('Dev A', ...UI.avatars, ...UI.list);
    await start(page, R.dev);
    const { root, t1 } = await threadWithAliceReply(page, 'REV5');
    await readAs('bob', R.dev, t1, root);
    const strip = receiptAvatars(threadRowIn(page, t1));
    await expect(strip).toBeVisible({ timeout: RECEIPT_TIMEOUT });
    const list = receiptList(page);
    const panel = page.getByTestId('thread-panel');

    // Pinned (click): Escape closes the list only.
    await strip.click();
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(panel, 'a pinned list consumes Escape: the thread panel stays').toBeVisible();
    await expect(panel).toHaveAttribute('data-root', root);

    // Hover preview with focus inside the panel: Escape closes the preview and still reaches the panel.
    await strip.focus();
    await page.mouse.move(0, 0);
    await strip.hover();
    await expect(list).toBeVisible();
    await expect(strip, 'hover does not move focus out of the panel').toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(panel, 'a hover preview lets Escape through: the thread panel closes too').toHaveCount(0);
  });
});
