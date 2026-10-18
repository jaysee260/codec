/**
 * Turns the raw live timeline into the flat list the message list renders: day dividers plus
 * message rows that know whether they start a sender group (DEV-B-1).
 *
 * Grouping rule (Discord): same sender, less than 5 minutes apart, same day, and neither the
 * previous nor the current row is a reply (replies always show their own header + quote).
 *
 * Phase 3 (DEV-B-20 / DEV-B-21): the hook takes a `TimelineSource`, so the same code feeds the
 * channel timeline (`{ roomId }`) and a thread panel (`{ roomId, threadRootId }`). Two guarantees:
 *
 *  - **no thread reply ever reaches the main list.** `useTimeline({ roomId })` already filters with
 *    `isMainTimelineEvent` and the SDK keeps `m.thread` replies out of the room's live timeline once
 *    `threadSupport` is on; the extra `isThreadReply` guard here is the belt-and-braces one the
 *    ticket asks for, so a leak needs three independent failures;
 *  - **grouping ignores the thread fallback.** A thread reply carries `m.in_reply_to` pointing at the
 *    previous reply purely as a fallback for non-threaded clients (`is_falling_back: true`), which
 *    `getReplyTargetId` already reports as "not a quote" - so consecutive replies by one sender group
 *    normally (AC-T6-3) and no `ReplyQuote` is rendered for them.
 */
import { useEffect, useMemo } from 'react';
import { EventType, RelationType, type MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { useTimeline, type TimelineSource } from '@/store/hooks.ts';
import { getReplyTargetId, isEditEvent, isThreadReply } from '@/lib/matrix/utils.ts';
import { isSameDay } from '@/lib/format.ts';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Redacted thread replies: the "Message deleted" tombstone (BUG-7 / AC-T9-3)
// ---------------------------------------------------------------------------
/**
 * Ids this session has rendered inside each thread, keyed by `roomId|rootId`.
 *
 * Why: redacting a message strips its `content`, including `m.relates_to`, so Synapse stops listing it
 * under `/relations/{root}/m.thread` and matrix-js-sdk **moves the redacted event out of the thread**
 * (`MatrixEvent.makeRedacted` -> `moveAllRelatedToMainTimeline` -> `moveToMainTimeline`, which calls
 * `thread.timelineSet.removeEvent(id)` and `setThread(undefined)`; the comment there says it changes
 * if MSC3389 lands). The reply therefore disappears from `thread.liveTimeline` and from our snapshot,
 * and the panel row vanishes under the reader's cursor instead of showing the Phase 1 `message-redacted`
 * placeholder the room timeline shows for a deleted message (AC-B9, AC-T9-3). Proven in
 * `__dev__/redact-probe.mjs`: after the redaction the event is gone from `thread.events`, carries no
 * thread marker at all, and the server's `/relations` no longer returns it.
 *
 * The event object itself is still alive - the SDK put it in the room's live timeline - so the panel can
 * read it back with `room.findEventById` and render it in place. Nothing is mutated and nothing is
 * fetched: this is a read of an event the SDK already holds, re-inserted in timestamp order.
 *
 * Only **redacted** events are ever restored, so a reply that leaves the snapshot for any other reason
 * (the SDK resets a thread's timeline when its initial `/relations` fetch lands) is not resurrected - it
 * comes back on its own, and `present` dedupes it if both happen at once.
 *
 * Session-only, like the core's `markRedactedThreadReply` guard that keeps the same event out of the
 * channel: a reply redacted before this client loaded was never rendered here, so there is nothing to
 * tombstone and the row is simply absent. Recorded as the residual in docs/BUGS.md.
 */
const seenThreadReplyIds = new Map<string, Set<string>>();

function rememberThreadReplies(key: string, events: MatrixEvent[]): void {
  let ids = seenThreadReplyIds.get(key);
  if (!ids) {
    ids = new Set();
    seenThreadReplyIds.set(key, ids);
  }
  for (const event of events) {
    const id = event.getId();
    if (id && !id.startsWith('~')) ids.add(id);
  }
}

/** Re-insert replies the SDK moved out of the thread because they were redacted, in timestamp order. */
function withRedactedTombstones(roomId: string, key: string, events: MatrixEvent[]): MatrixEvent[] {
  const seen = seenThreadReplyIds.get(key);
  if (!seen?.size) return events;
  const present = new Set(events.map((e) => e.getId()));
  let restored: MatrixEvent[] | null = null;
  const room = getClientOrNull()?.getRoom(roomId);
  if (!room) return events;
  for (const id of seen) {
    if (present.has(id)) continue;
    const event = room.findEventById(id);
    if (event?.isRedacted() && !isHiddenEncryptedRelation(event)) (restored ??= []).push(event);
  }
  if (!restored) return events;
  return [...events, ...restored].sort((a, b) => a.getTs() - b.getTs());
}

// ---------------------------------------------------------------------------
// Encrypted relations: never a row of their own (Phase 5, DEV-B-27 / DEV-B-30)
// ---------------------------------------------------------------------------
/**
 * `isDisplayableEvent` keeps every `m.room.encrypted` event so a message that fails to decrypt still gets a
 * placeholder row. Two kinds of encrypted event are not messages, though, and must not become rows:
 *
 *  - an edit or a reaction that is still encrypted (decrypting, or undecryptable): its `m.relates_to` is in
 *    the clear on the wire (`isRelation` reads `getWireContent()`), so it is recognised and dropped. Once it
 *    decrypts, its clear type takes it out of the rows anyway (aggregated onto its target);
 *  - a redacted reaction or edit (a reaction toggled off, a deleted edit): `makeRedacted` strips the
 *    decrypted content *and* the wire relation, leaving a bare `m.room.encrypted` that would render as
 *    "Message deleted". Ids seen as reactions / edits while they still had their relation are remembered for
 *    the session and dropped once redacted. A relation redacted before this page loaded cannot be told apart
 *    from a deleted message (the server prunes everything) and still shows as one: docs/BUGS.md residual.
 */
const relationEventIds = new Set<string>();

function isRelationEvent(event: MatrixEvent): boolean {
  return (
    event.getType() === EventType.Reaction ||
    isEditEvent(event) ||
    event.isRelation(RelationType.Annotation) ||
    event.isRelation(RelationType.Replace)
  );
}

function rememberRelations(events: MatrixEvent[]): void {
  for (const event of events) {
    if (!event.isEncrypted() || event.isRedacted()) continue;
    const id = event.getId();
    if (id && isRelationEvent(event)) relationEventIds.add(id);
  }
}

/** True for an encrypted edit / reaction that would otherwise render as a message row. */
export function isHiddenEncryptedRelation(event: MatrixEvent): boolean {
  if (!event.isEncrypted()) return false;
  if (event.isRedacted()) return relationEventIds.has(event.getId() ?? '');
  return event.getType() === EventType.RoomMessageEncrypted && isRelationEvent(event);
}

export type TimelineItem =
  | { kind: 'day'; key: string; ts: number }
  | { kind: 'message'; key: string; ts: number; event: MatrixEvent; groupStart: boolean };

export function buildTimelineItems(events: MatrixEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let prev: MatrixEvent | null = null;
  for (const event of events) {
    const ts = event.getTs();
    if (!prev || !isSameDay(prev.getTs(), ts)) {
      items.push({ kind: 'day', key: `day-${ts}-${items.length}`, ts });
      prev = null; // the first row after a divider always starts a group
    }
    const groupStart =
      !prev ||
      prev.getSender() !== event.getSender() ||
      ts - prev.getTs() > GROUP_WINDOW_MS ||
      !!getReplyTargetId(event) ||
      !!getReplyTargetId(prev);
    items.push({ kind: 'message', key: event.getId() ?? `row-${items.length}`, ts, event, groupStart });
    prev = event;
  }
  return items;
}

export interface RoomEvents {
  items: TimelineItem[];
  events: MatrixEvent[];
  hasMore: boolean;
  isPaginating: boolean;
  version: number;
  paginateBack(limit?: number): Promise<void>;
}

/**
 * Display-ready timeline for a source. Re-computed on every store `version` bump.
 * A plain room id is accepted as the Phase 1 call form (`useRoomEvents(roomId)`).
 */
export function useRoomEvents(source: string | TimelineSource): RoomEvents {
  const roomId = typeof source === 'string' ? source : source.roomId;
  const threadRootId = typeof source === 'string' ? undefined : source.threadRootId;
  const timelineSource = useMemo<TimelineSource>(() => ({ roomId, threadRootId }), [roomId, threadRootId]);
  const { events, allEvents, hasMore, isPaginating, version, paginateBack } = useTimeline(timelineSource);
  const key = threadRootId ? `${roomId}|${threadRootId}` : roomId;

  // Record which replies the panel has rendered, so a later redaction can be tombstoned rather than
  // silently dropping the row (see `seenThreadReplyIds` above).
  useEffect(() => {
    if (threadRootId) rememberThreadReplies(key, events);
  }, [key, threadRootId, events]);

  // `version` is in the deps on purpose: edits/redactions mutate events in place (see ARCHITECTURE.md).
  // The channel's own guard against redacted thread replies lives in the core (`timeline.ts`
  // `markRedactedThreadReply`, fed by the bridge's `RoomEvent.Redaction`, which still carries the
  // thread id), so `eventsByRoom` never offers them here; `isThreadReply` stays as the belt-and-braces
  // filter DEV-B-21 asks for.
  const rows = useMemo(() => {
    rememberRelations(allEvents);
    const visible = events.filter((e) => !isHiddenEncryptedRelation(e));
    return threadRootId ? withRedactedTombstones(roomId, key, visible) : visible.filter((e) => !isThreadReply(e));
  }, [events, allEvents, roomId, key, threadRootId, version]);
  const items = useMemo(() => buildTimelineItems(rows), [rows, version]);
  return { items, events: rows, hasMore, isPaginating, version, paginateBack };
}
