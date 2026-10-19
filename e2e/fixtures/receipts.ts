/**
 * Read receipts fixtures (QA-R1; docs/RECEIPTS_ACCEPTANCE.md, docs/ARCHITECTURE.md "Read receipts deltas").
 *
 * Three layers, same split as the Phase 5 helpers:
 *  - **API** (plain `fetch`, no app code): `readAs` / `readPrivateAs` post receipts as any user, `syncReceipts` /
 *    `notificationCount` read what the server tells a user (cache-busted, see `syncOnce`), `accountDataOf` /
 *    `putAccountData` / `setSendReadReceiptsViaApi` drive `im.vector.web.settings`, `plusNRoom` builds the "+N" room
 *    from throwaway users (AC-R2-4).
 *  - **core** (the Principal's dev hook `window.__matrixPoc.receipts`): `readPointsOf`, `readersAt`, `seenByOf`,
 *    `latestOwnSentId`, `sendStatusByText`, `appSetting`, `setAppSetting`. These run before Dev A / Dev B's UI exists,
 *    so the core half of every criterion is judged from day one.
 *  - **UI** (registry testids only): `receiptAvatars`, `avatarIds`, `receiptStatus`, `receiptList`, `listIds`,
 *    `receiptToggle`. Specs gate them with `requireUi` / `uiHalf` from `fixtures/e2ee.ts` (a source scan).
 *
 * `receiptRequests(page)` records every receipt the page POSTs (`/receipt/{type}/{eventId}`), so AC-R7 can assert
 * "never `m.read` while the setting is OFF" literally (S1 in docs/BUGS.md "Read receipts").
 */
import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { createRoom, freshUser, joinRoom, type Credentials } from './e2ee-api.ts';
import { asUser } from './matrix-api.ts';
import { noteServerUse } from './run-log.ts';
import { HS_URL, uniqueName, type UserKey } from './seed.ts';
import { threadPanel } from './threads.ts';

const V3 = `${HS_URL}/_matrix/client/v3`;
export const SETTINGS_TYPE = 'im.vector.web.settings';
export const SETTINGS_KEY = 'sendReadReceipts';
/** Advisor risk 7: receipt round trips poll for 15 s. */
export const RECEIPT_TIMEOUT = 15_000;

/** Testids by owner (docs/RECEIPTS_ACCEPTANCE.md "Test ID registry"), for `requireUi` / `uiHalf`. */
export const UI = {
  status: ['receipt-status'],
  avatars: ['receipt-avatars', 'receipt-avatar'],
  more: ['receipt-more'],
  list: ['receipt-list', 'receipt-list-seen', 'receipt-list-unseen', 'receipt-list-item'],
  listEmpty: ['receipt-list-empty'],
  backdrop: ['receipt-list-backdrop'],
  seenByAction: ['message-action-seen-by'],
  toggle: ['settings-send-read-receipts'],
} as const;

/* ============================================================================================ API */

/** Anyone who can post: a seeded user key, or a throwaway / API session. */
export type Who = UserKey | { token: string; userId: string };

async function tokenOf(who: Who): Promise<{ token: string; userId: string }> {
  if (typeof who !== 'string') return who;
  const u = await asUser(who);
  return { token: u.token, userId: u.userId };
}

async function call<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown, ok404 = false): Promise<{ status: number; json: T }> {
  noteServerUse();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(path.startsWith('http') ? path : `${V3}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & { retry_after_ms?: number };
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Math.min((json.retry_after_ms ?? 500) + 50, 5000)));
      continue;
    }
    if (res.status === 404 && ok404) return { status: 404, json };
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { status: res.status, json };
  }
  throw new Error(`${method} ${path}: still rate-limited`);
}

export type ReceiptType = 'm.read' | 'm.read.private';

/** `POST /rooms/{roomId}/receipt/{type}/{eventId}`, `thread_id` when given (a root id, or `'main'`). */
export async function postReceipt(who: Who, type: ReceiptType, roomId: string, eventId: string, threadId?: string): Promise<void> {
  const { token } = await tokenOf(who);
  await call('POST', `/rooms/${encodeURIComponent(roomId)}/receipt/${type}/${encodeURIComponent(eventId)}`, token, threadId ? { thread_id: threadId } : {});
}

/** "X reads E" (docs/RECEIPTS_ACCEPTANCE.md): a public `m.read`, threaded when `threadId` is the root. */
export function readAs(who: Who, roomId: string, eventId: string, threadId?: string): Promise<void> {
  return postReceipt(who, 'm.read', roomId, eventId, threadId);
}

/** AC-R3-4: a private receipt (`m.read.private`): only the poster's own /sync ever sees it. */
export function readPrivateAs(who: Who, roomId: string, eventId: string, threadId?: string): Promise<void> {
  return postReceipt(who, 'm.read.private', roomId, eventId, threadId);
}

/** eventId -> receipt type -> userId -> `{ ts, thread_id? }`, everything `who`'s /sync carries for the room. */
export type SyncReceipts = Record<string, Record<string, Record<string, { ts?: number; thread_id?: string }>>>;

let nonce = 0;
/**
 * One `/sync?timeout=0` for one room. The per-call `account_data.limit` nonce defeats Synapse's ~2 min initial-sync
 * response cache (same trick and reason as `ApiUser.getReceipts`, e2e/README.md "Conventions").
 */
async function syncOnce(token: string, roomId: string): Promise<{ receipts: SyncReceipts; notificationCount: number | undefined }> {
  nonce += 1;
  const filter = JSON.stringify({
    room: { rooms: [roomId], timeline: { limit: 1 }, ephemeral: { types: ['m.receipt'] }, state: { types: [] } },
    presence: { types: [] },
    account_data: { types: [], limit: 1000 + nonce },
  });
  const { json } = await call<any>('GET', `/sync?timeout=0&filter=${encodeURIComponent(filter)}`, token);
  const joined = json.rooms?.join?.[roomId];
  const receipts: SyncReceipts = {};
  for (const ev of joined?.ephemeral?.events ?? []) {
    if (ev.type !== 'm.receipt') continue;
    for (const [eventId, byType] of Object.entries(ev.content as SyncReceipts)) {
      const slot = (receipts[eventId] ??= {});
      for (const [type, users] of Object.entries(byType)) slot[type] = { ...(slot[type] ?? {}), ...users };
    }
  }
  return { receipts, notificationCount: joined?.unread_notifications?.notification_count };
}

/** All receipts (`m.read` and, for the user's own, `m.read.private`) `who`'s /sync carries for `roomId`. */
export async function syncReceipts(who: Who, roomId: string): Promise<SyncReceipts> {
  return (await syncOnce((await tokenOf(who)).token, roomId)).receipts;
}

/** Receipt types `who` can see `userId` holding on `eventId` (empty = none visible to `who`). */
export async function receiptTypesOn(who: Who, roomId: string, eventId: string, userId: string): Promise<string[]> {
  const r = (await syncReceipts(who, roomId))[eventId] ?? {};
  return Object.entries(r)
    .filter(([, users]) => !!users[userId])
    .map(([type]) => type)
    .sort();
}

/** The server's main-timeline `notification_count` for `who` in `roomId` (what the unread badge is built from). */
export async function notificationCount(who: Who, roomId: string): Promise<number> {
  return (await syncOnce((await tokenOf(who)).token, roomId)).notificationCount ?? 0;
}

/** Global account data of `type`, or null when the user has none. */
export async function accountDataOf<T = Record<string, unknown>>(who: Who, type: string = SETTINGS_TYPE): Promise<T | null> {
  const { token, userId } = await tokenOf(who);
  const r = await call<T>('GET', `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`, token, undefined, true);
  return r.status === 404 ? null : r.json;
}

/** `PUT` account data verbatim (what Element does when the user flips its own toggle). */
export async function putAccountData(who: Who, type: string, content: Record<string, unknown>): Promise<void> {
  const { token, userId } = await tokenOf(who);
  await call('PUT', `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`, token, content);
}

/** Flip `sendReadReceipts` from outside the app, merging like Element does (never clobbering other keys). */
export async function setSendReadReceiptsViaApi(who: Who, on: boolean): Promise<Record<string, unknown>> {
  const content = { ...((await accountDataOf(who)) ?? {}), [SETTINGS_KEY]: on };
  await putAccountData(who, SETTINGS_TYPE, content);
  return content;
}

/**
 * Snapshot of `im.vector.web.settings` for `who`; `restore()` puts it back (`{}` when there was none, which reads
 * as the default ON). Every AC-R7 test restores in `afterEach`: a leftover OFF would make alice send private
 * receipts in every later spec on the same worker (AC-B7 would go red for no reason of its own).
 */
export async function snapshotSettings(who: Who = 'alice'): Promise<{ before: Record<string, unknown> | null; restore(): Promise<void> }> {
  const before = await accountDataOf(who);
  return {
    before,
    async restore() {
      await putAccountData(who, SETTINGS_TYPE, before ?? {});
    },
  };
}

export interface PlusNRoom {
  roomId: string;
  readers: Credentials[];
  /** alice leaves + forgets, the space link is removed, the readers leave. Best effort. */
  cleanup(): Promise<void>;
}

/**
 * AC-R2-4 (Advisor consult 1): `n` throwaway users (`freshUser('qarcpt')`) in a fresh room alice creates under
 * `spaceId`, all joined. Pure API; no seed change, no extra browser.
 */
export async function plusNRoom(spaceId: string, n = 4): Promise<PlusNRoom> {
  const alice = await asUser('alice');
  const readers: Credentials[] = [];
  for (let i = 0; i < n; i += 1) readers.push(await freshUser('qarcpt'));
  const roomId = await createRoom(alice.token, { name: uniqueName('qa-receipts-plusn'), preset: 'public_chat', spaceId, invite: readers.map((r) => r.userId) });
  for (const r of readers) await joinRoom(r.token, roomId);
  return {
    roomId,
    readers,
    async cleanup() {
      for (const r of readers) await call('POST', `/rooms/${encodeURIComponent(roomId)}/leave`, r.token, {}).catch(() => undefined);
      await alice.sendStateEvent(spaceId, 'm.space.child', roomId, {}).catch(() => undefined);
      await alice.leaveRoom(roomId).catch(() => undefined);
      await alice.forgetRoom(roomId).catch(() => undefined);
    },
  };
}

/* ============================================================================================ requests */

export interface ReceiptRequest {
  type: string;
  roomId: string;
  eventId: string;
  threadId?: string;
  at: number;
}

export interface ReceiptRequests {
  all(): ReceiptRequest[];
  /** Receipt types posted, in order (optionally only those at or after `since`, a `Date.now()` mark). */
  types(since?: number): string[];
  last(): ReceiptRequest | undefined;
  forEvent(eventId: string): ReceiptRequest[];
  since(mark: number): ReceiptRequest[];
}

/** Records every `POST .../receipt/{type}/{eventId}` the page sends (install before the first navigation). */
export function receiptRequests(page: Page): ReceiptRequests {
  const seen: ReceiptRequest[] = [];
  const onRequest = (req: Request): void => {
    if (req.method() !== 'POST') return;
    const m = /\/rooms\/([^/]+)\/receipt\/([^/]+)\/([^/?]+)/.exec(req.url());
    if (!m) return;
    let threadId: string | undefined;
    try {
      threadId = (req.postDataJSON() as { thread_id?: string } | null)?.thread_id;
    } catch {
      threadId = undefined;
    }
    seen.push({ roomId: decodeURIComponent(m[1]!), type: decodeURIComponent(m[2]!), eventId: decodeURIComponent(m[3]!), threadId, at: Date.now() });
  };
  page.on('request', onRequest);
  return {
    all: () => [...seen],
    types: (since = 0) => seen.filter((r) => r.at >= since).map((r) => r.type),
    last: () => seen[seen.length - 1],
    forEvent: (eventId) => seen.filter((r) => r.eventId === eventId),
    since: (mark) => seen.filter((r) => r.at >= mark),
  };
}

/* ============================================================================================ core (dev hook) */

export interface ReaderJson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  ts: number;
}

export interface SeenByJson {
  seen: ReaderJson[];
  notSeen: ReaderJson[];
  notSeenCount?: number;
  truncated: boolean;
}

/** Waits for `window.__matrixPoc.receipts` (the Principal's QA hook). */
export async function waitForReceiptsHook(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__matrixPoc?.receipts?.getReadPoints, undefined, { timeout: 30_000 });
}

/** `getReadPoints(roomId, threadRootId?)` as `{ rowId: userId[] }` (reader order kept: newest first). */
export async function readPointsOf(page: Page, roomId: string, threadRootId?: string): Promise<Record<string, string[]>> {
  return page.evaluate(
    ([r, t]) => {
      const map = (window as any).__matrixPoc.receipts.getReadPoints(r, t ?? undefined) as Record<string, { userId: string }[]>;
      return Object.fromEntries(Object.entries(map).map(([id, readers]) => [id, readers.map((x) => x.userId)]));
    },
    [roomId, threadRootId ?? null] as const,
  );
}

/** Readers (user ids, newest first) whose read point is the row `eventId` (core view). */
export async function readersAt(page: Page, roomId: string, eventId: string, threadRootId?: string): Promise<string[]> {
  return (await readPointsOf(page, roomId, threadRootId))[eventId] ?? [];
}

/** The row (if any) holding `userId`'s read point (core view). */
export async function rowOfReader(page: Page, roomId: string, userId: string, threadRootId?: string): Promise<string | null> {
  const map = await readPointsOf(page, roomId, threadRootId);
  return Object.entries(map).find(([, users]) => users.includes(userId))?.[0] ?? null;
}

/** Polls the core until the readers at `eventId` are exactly `users` (order checked when `ordered`). */
export async function expectReadersAt(page: Page, roomId: string, eventId: string, users: string[], opts: { threadRootId?: string; ordered?: boolean; timeout?: number; message?: string } = {}): Promise<void> {
  const norm = (xs: string[]): string[] => (opts.ordered ? xs : [...xs].sort());
  await expect
    .poll(async () => norm(await readersAt(page, roomId, eventId, opts.threadRootId)), {
      timeout: opts.timeout ?? RECEIPT_TIMEOUT,
      message: opts.message ?? `core readers at ${eventId}${opts.threadRootId ? ` (thread ${opts.threadRootId})` : ''}`,
    })
    .toEqual(norm(users));
}

/** `getSeenBy` as user-id lists. Loads the room's members first (what `useSeenBy` does; lazy-loaded members). */
export async function seenByOf(page: Page, roomId: string, eventId: string, threadRootId?: string): Promise<{ seen: string[]; notSeen: string[]; truncated: boolean; raw: SeenByJson }> {
  const raw = await page.evaluate(
    async ([r, id, t]) => {
      const w = (window as any).__matrixPoc;
      await w.getClient()?.getRoom(r)?.loadMembersIfNeeded?.();
      return JSON.parse(JSON.stringify(w.receipts.getSeenBy(r, id, t ?? undefined)));
    },
    [roomId, eventId, threadRootId ?? null] as const,
  );
  return { seen: raw.seen.map((x: ReaderJson) => x.userId), notSeen: raw.notSeen.map((x: ReaderJson) => x.userId), truncated: raw.truncated, raw };
}

/** `getLatestOwnSentId(roomId, threadRootId?)`: the one row that carries the "sent" check (core view). */
export async function latestOwnSentId(page: Page, roomId: string, threadRootId?: string): Promise<string | null> {
  return page.evaluate(([r, t]) => (window as any).__matrixPoc.receipts.getLatestOwnSentId(r, t ?? undefined), [roomId, threadRootId ?? null] as const);
}

/**
 * The send status and current id of my newest event whose body contains `text`, from the client's live timeline
 * (pendingEventOrdering is chronological, so it holds the `~txn` local echo too, and the swap to `$id`). `status` comes from the hook's
 * `getSendStatus(roomId, id)`; `rawStatus` is `event.status` for the failure message.
 */
export async function sendStatusByText(page: Page, roomId: string, text: string): Promise<{ id: string | null; status: string | null; rawStatus: string | null }> {
  return page.evaluate(
    ([r, needle]) => {
      const w = (window as any).__matrixPoc;
      const room = w.getClient()?.getRoom(r);
      if (!room) return { id: null, status: null, rawStatus: null };
      // Chronological pending ordering: local echoes (and failed ones) live in the live timeline; getPendingEvents() throws.
      const all = room.getLiveTimeline().getEvents();
      const ev = [...all].reverse().find((e: any) => String(e.getContent()?.body ?? '').includes(needle));
      if (!ev) return { id: null, status: null, rawStatus: null };
      return { id: ev.getId() ?? null, status: w.receipts.getSendStatus(r, ev.getId()) ?? null, rawStatus: ev.status ?? null };
    },
    [roomId, text] as const,
  );
}

/** `getSendReadReceipts()` in the page (the app's live reading of the account data). */
export function appSetting(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__matrixPoc.receipts.getSendReadReceipts());
}

/** `setSendReadReceipts(on)` through the hook (the core path the toggle uses). */
export async function setAppSetting(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => (window as any).__matrixPoc.receipts.setSendReadReceipts(v), on);
}

/** The app's main-timeline unread count for a room (`useRoomStore.unreadByRoom`). */
export function appUnread(page: Page, roomId: string): Promise<number> {
  return page.evaluate((r) => (window as any).__matrixPoc.rooms.getState().unreadByRoom?.[r] ?? 0, roomId);
}

/* ============================================================================================ UI */

/** A row by event id inside the main list (thread rows live in `thread-panel`, use `threadScope`). */
export const mainRow = (page: Page, eventId: string): Locator => page.getByTestId('message-list').getByTestId(`message-${eventId}`);
export const threadRowIn = (page: Page, eventId: string): Locator => threadPanel(page).getByTestId(`message-${eventId}`);

export const receiptAvatars = (scope: Locator): Locator => scope.getByTestId('receipt-avatars');
export const receiptStatus = (scope: Locator): Locator => scope.getByTestId('receipt-status');
export const receiptList = (page: Page): Locator => page.getByTestId('receipt-list');
export const receiptToggle = (page: Page): Locator => page.getByTestId('settings-send-read-receipts');

/** `data-user-id` of each rendered `receipt-avatar` in a row, DOM order. */
export async function avatarIds(scope: Locator): Promise<string[]> {
  return scope.getByTestId('receipt-avatar').evaluateAll((els) => els.map((el) => el.getAttribute('data-user-id') ?? ''));
}

/** Polls the UI until the row's avatars are exactly `users` (DOM order checked when `ordered`). */
export async function expectAvatars(row: Locator, users: string[], opts: { ordered?: boolean; timeout?: number } = {}): Promise<void> {
  const norm = (xs: string[]): string[] => (opts.ordered ? xs : [...xs].sort());
  if (users.length === 0) {
    await expect(receiptAvatars(row)).toHaveCount(0, { timeout: opts.timeout ?? RECEIPT_TIMEOUT });
    return;
  }
  await expect(receiptAvatars(row)).toHaveAttribute('data-count', String(users.length), { timeout: opts.timeout ?? RECEIPT_TIMEOUT });
  await expect.poll(async () => norm(await avatarIds(row)), { timeout: opts.timeout ?? RECEIPT_TIMEOUT, message: 'receipt-avatar data-user-id' }).toEqual(norm(users.slice(0, 3)));
}

/** `data-user-id`s of `receipt-list-item`s in one section (`seen` | `unseen`), DOM order. */
export async function listIds(page: Page, section: 'seen' | 'unseen'): Promise<string[]> {
  return receiptList(page)
    .locator(`[data-testid="receipt-list-item"][data-section="${section}"]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-user-id') ?? ''));
}

/** Hover a row so `message-actions` shows, click `message-action-seen-by`, wait for the list of that row. */
export async function openSeenByFromActions(page: Page, row: Locator, eventId: string): Promise<Locator> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const action = row.getByTestId('message-actions').getByTestId('message-action-seen-by');
  await expect(action).toBeVisible();
  await action.click();
  const list = receiptList(page);
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute('data-event-id', eventId);
  return list;
}

/** Unique message text for this test (every criterion sends its own message). */
export function uniq(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/** Distance of `message-list` from its bottom, in px. */
export function bottomGap(page: Page, testId = 'message-list'): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Viewport-relative top of an element (`getBoundingClientRect().top`). */
export function topOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => el.getBoundingClientRect().top);
}
