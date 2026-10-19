/**
 * Read receipts over the SDK (docs/archive/RECEIPTS_PLAN.md, docs/CORE_API.md "Read receipts"). Pure parts
 * live in `receipts-core.ts` (re-exported here). React hooks are in `src/store/receipts.ts`.
 *
 * Holders: the main timeline's receipts live on the `Room`, a thread's on its `Thread` (both extend the SDK's
 * `ReadReceipt`). They are never mixed (Advisor risk 1): `getReceiptHolder(room, source)` picks the right one and
 * every read goes through it. `m.read` with `thread_id: 'main'` and unthreaded receipts are room receipts; a
 * receipt with `thread_id: <root>` belongs to that thread (the SDK caches it until the Thread model exists).
 *
 * What counts as "read" is the SDK's `hasUserReadEvent` (threaded + unthreaded receipts, plus "the user sent an
 * event at or after it", plus "the user replied in the thread" for a root), and the SDK also synthesises an
 * `m.read` for the sender of every live event, so a sender's read point is at least their own last message.
 * Embraced on purpose (Element behaves the same); the current user is excluded from every list.
 */
import { EventStatus, Room, type MatrixClient, type MatrixEvent, type RoomMember, type Thread } from 'matrix-js-sdk';
import { memberAvatarUrl } from './utils.ts';
import {
  collectReadPoints,
  compareReaders,
  latestReceiptTs,
  mergeSendReadReceipts,
  pickLatestOwnSentId,
  ReaderCache,
  RECEIPT_SETTINGS_EVENT_TYPE,
  resolveSendReadReceipts,
  sameReaders,
  withPendingSendReadReceipts,
  type ReadPointSource,
  type Reader,
} from './receipts-core.ts';

export * from './receipts-core.ts';

/** Where receipts for a timeline source live: the room (main timeline) or the SDK `Thread` (thread panel). */
export type ReceiptHolder = Room | Thread;

/** `{ roomId }` -> the room; `{ roomId, threadRootId }` -> its Thread model, or null until the SDK has created it. */
export function getReceiptHolder(room: Room | null | undefined, threadRootId?: string | null): ReceiptHolder | null {
  if (!room) return null;
  if (!threadRootId) return room;
  return room.getThread(threadRootId) ?? null;
}

function roomOf(holder: ReceiptHolder): Room {
  return holder instanceof Room ? holder : holder.room;
}

/** Rooms above this many joined members get no "Not seen yet" list, only a count (`SeenBy.truncated`). */
export const SEEN_BY_MEMBER_LIMIT = 50;

/** Avatar size (px, cropped) baked into `Reader.avatarUrl`. */
export const READER_AVATAR_SIZE = 32;

// Reader objects are reused across rebuilds when nothing about the user changed (see `ReaderCache`).
const readerCaches = new WeakMap<Room, ReaderCache>();

function readerOf(room: Room, member: RoomMember, ts: number): Reader {
  let cache = readerCaches.get(room);
  if (!cache) {
    cache = new ReaderCache();
    readerCaches.set(room, cache);
  }
  return cache.get(member.userId, member.name, memberAvatarUrl(member, READER_AVATAR_SIZE) || null, ts);
}

/**
 * Timestamp of the user's read point on this holder: the holder's latest public receipt, or the room's unthreaded
 * receipt when newer (`Thread.getEventReadUpTo` honours the latter while the thread's own receipt may be null).
 * Others' private receipts never arrive here.
 */
function receiptTs(holder: ReceiptHolder, userId: string): number {
  return latestReceiptTs(holder.getReadReceiptForUserId(userId)?.data.ts, roomOf(holder).getLastUnthreadedReceiptFor(userId)?.ts);
}

/** `ReadPointSource` over a real holder (the pure `collectReadPoints` does the mapping). */
function sourceOf(holder: ReceiptHolder): ReadPointSource {
  const room = roomOf(holder);
  return {
    timelineIds: () => holder.timeline.map((e) => e.getId() ?? ''),
    readUpTo: (userId) => holder.getEventReadUpTo(userId),
    receiptTs: (userId) => receiptTs(holder, userId),
    // `room.findEventById` searches the threads too; an unthreaded receipt on a thread reply maps to its root row.
    threadRootOf: (eventId) => room.findEventById(eventId)?.threadRootId,
  };
}

/**
 * Joined members other than me (and `exceptUserId`), from the SDK's member list. Lazy loading means only senders
 * are known until `loadMembers(roomId)` has run; the hooks call it and re-run on `useRoomStore.version`.
 */
export function otherJoinedMembers(room: Room, myUserId: string | null | undefined, exceptUserId?: string | null): RoomMember[] {
  return room.getJoinedMembers().filter((m) => m.userId !== myUserId && m.userId !== exceptUserId);
}

export interface ReadPointsOptions {
  /** Reuse these row arrays when a row's readers did not change (stable identities for memoised rows). */
  previous?: ReadonlyMap<string, Reader[]>;
}

/**
 * Each other user's read point (`holder.getEventReadUpTo(userId)`, synthetic receipts included) attached to the
 * nearest displayed row at or before it. `displayedEvents` is what the list renders (`useTimeline().events`), in
 * order; hidden events (reactions, edits, state, undecryptable relations) are looked up in the holder's own
 * timeline. Users whose read point is not loaded (older than the window, or a thread whose `/relations` fetch has
 * not landed) get no avatar. Each row's readers are sorted newest receipt first. O(members + events).
 */
export function buildReadPoints(
  holder: ReceiptHolder | null | undefined,
  displayedEvents: readonly MatrixEvent[],
  myUserId: string | null | undefined,
  opts: ReadPointsOptions = {},
): Map<string, Reader[]> {
  if (!holder || !displayedEvents.length) return new Map();
  const room = roomOf(holder);
  const members = new Map(otherJoinedMembers(room, myUserId).map((m) => [m.userId, m]));
  const { rows, ts } = collectReadPoints(sourceOf(holder), [...members.keys()], displayedEvents.map((e) => e.getId() ?? ''));
  const out = new Map<string, Reader[]>();
  for (const [rowId, userIds] of rows) {
    const readers = userIds.map((id) => readerOf(room, members.get(id)!, ts.get(id) ?? 0)).sort(compareReaders);
    const prev = opts.previous?.get(rowId);
    out.set(rowId, prev && sameReaders(prev, readers) ? prev : readers);
  }
  return out;
}

/** Convenience for `buildReadPoints` + the sent-check rule in one pass (what `useReadPoints` memoises). */
export interface ReadPointsSnapshot {
  readPoints: Map<string, Reader[]>;
  /** Row that shows the single "sent" check (see `pickLatestOwnSentId`), or null. */
  latestOwnSentId: string | null;
}

export function buildReadPointsSnapshot(
  holder: ReceiptHolder | null | undefined,
  displayedEvents: readonly MatrixEvent[],
  myUserId: string | null | undefined,
  opts: ReadPointsOptions = {},
): ReadPointsSnapshot {
  const readPoints = buildReadPoints(holder, displayedEvents, myUserId, opts);
  return { readPoints, latestOwnSentId: pickLatestOwnSentId(displayedEvents, myUserId, readPoints) };
}

export interface SeenBy {
  /** Users (other than me and the sender) who have read up to this event, newest receipt first. */
  seen: Reader[];
  /** Joined members (other than me and the sender) who have not; empty when `truncated`. Sorted by name. */
  notSeen: Reader[];
  /** Number of users who have not seen it (also set when `truncated`). */
  notSeenCount: number;
  /** True in rooms above `SEEN_BY_MEMBER_LIMIT` joined members: show "N others haven't seen it yet" instead of the list. */
  truncated: boolean;
}

const EMPTY_SEEN_BY: SeenBy = { seen: [], notSeen: [], notSeenCount: 0, truncated: false };

/**
 * Who has / has not seen an event, per the settled rule: `holder.hasUserReadEvent(userId, eventId)` over the
 * joined members, excluding me and the sender (the sender has always seen their own message; the SDK agrees). An
 * event the holder does not have loaded (`findEventById` null: outside the window, or a thread not fetched yet)
 * yields the empty result rather than a warning from the SDK. Users with private receipts are, by design,
 * indistinguishable from "not seen yet".
 */
export function getSeenBy(holder: ReceiptHolder | null | undefined, event: MatrixEvent | string | null | undefined, myUserId: string | null | undefined): SeenBy {
  if (!holder || !event) return EMPTY_SEEN_BY;
  const eventId = typeof event === 'string' ? event : event.getId();
  if (!eventId || eventId.startsWith('~')) return EMPTY_SEEN_BY;
  const target = holder.findEventById(eventId);
  if (!target) return EMPTY_SEEN_BY;
  const room = roomOf(holder);
  const members = otherJoinedMembers(room, myUserId, target.getSender());
  const truncated = members.length > SEEN_BY_MEMBER_LIMIT;
  const seen: Reader[] = [];
  const notSeen: Reader[] = [];
  let notSeenCount = 0;
  for (const member of members) {
    if (holder.hasUserReadEvent(member.userId, eventId)) seen.push(readerOf(room, member, receiptTs(holder, member.userId)));
    else {
      notSeenCount++;
      // Not cached: ts 0 is not a receipt, and these lists are rebuilt only while the list is open.
      if (!truncated) notSeen.push({ userId: member.userId, displayName: member.name, avatarUrl: memberAvatarUrl(member, READER_AVATAR_SIZE) || null, ts: 0 });
    }
  }
  seen.sort(compareReaders);
  notSeen.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
  return { seen, notSeen, notSeenCount, truncated };
}

/** True while an event is a local echo the server has not acknowledged (id `~txn`, or status before `SENT`). */
export function isUnsentLocalEcho(event: MatrixEvent): boolean {
  const id = event.getId();
  return !id || id.startsWith('~') || (event.status !== null && event.status !== EventStatus.SENT);
}

// ---------------------------------------------------------------------------
// "Send read receipts" setting
// ---------------------------------------------------------------------------

function settingsContent(client: MatrixClient | null | undefined): Record<string, unknown> | undefined {
  // `im.vector.web.settings` is not one of the SDK's typed account-data events; it is a plain JSON object.
  return client?.getAccountData(RECEIPT_SETTINGS_EVENT_TYPE as never)?.getContent<Record<string, unknown>>();
}

/**
 * Current value of "Send read receipts" (default ON): the in-flight value while `setSendReadReceipts` is pending,
 * else account data. Synchronous; null client = ON.
 */
export function getSendReadReceipts(client: MatrixClient | null | undefined): boolean {
  return resolveSendReadReceipts(settingsContent(client));
}

/**
 * Write the setting: spreads the existing `im.vector.web.settings` content (Element keeps many keys there) and
 * sets `sendReadReceipts`. Resolves once `/sync` has echoed the change, so `getSendReadReceipts` reads the new
 * value afterwards (`client.setAccountData` waits for the echo); meanwhile `getSendReadReceipts` already answers `on`.
 */
export async function setSendReadReceipts(client: MatrixClient, on: boolean): Promise<void> {
  const merged = mergeSendReadReceipts(settingsContent(client), on);
  // Optimistic: receipts sent before the /sync echo already use the new type; a failed write reverts.
  await withPendingSendReadReceipts(on, () => client.setAccountData(RECEIPT_SETTINGS_EVENT_TYPE as never, merged as never));
}
