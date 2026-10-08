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
import type { MatrixEvent } from 'matrix-js-sdk';
import { useTimeline, type TimelineSource } from '@/store/hooks.ts';
import { getReplyTargetId, isThreadReply } from '@/lib/matrix/utils.ts';
import { isSameDay } from '@/lib/format.ts';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Redacted thread replies (the "guard beyond the store filter", DEV-B-21)
// ---------------------------------------------------------------------------
/**
 * Ids this session has seen inside a thread, per room.
 *
 * Why this exists: redacting a message strips its `content`, including `m.relates_to`, so the server
 * stops listing it under `/relations/{root}/m.thread` and matrix-js-sdk deliberately **moves the
 * redacted event out of the thread and into the room's live timeline**
 * (`MatrixEvent.makeRedacted` -> `moveAllRelatedToMainTimeline`, "This will change if MSC3389 is
 * merged"). Verified in `__dev__/redact-probe.mjs`: after the redaction the event is in
 * `room.getLiveTimeline()` and in `eventsByRoom`, and **every** thread marker is gone - no wire
 * relation, `threadRootId` null, `getThread()` undefined, `unsigned` only `age` / `membership` /
 * `redacted_because`. Without this guard, deleting a reply from the thread panel adds a stray
 * "Message deleted" row to the channel (the plan calls a reply in the channel S1).
 *
 * Since the event itself carries no evidence any more, the only signal is that we saw it in a thread
 * before. The set only ever grows with ids that really were thread replies, so a redacted
 * *main-timeline* message can never be hidden by mistake (AC-B9 keeps working).
 *
 * Limit: a reply redacted before this session loaded (or in a thread never opened here) has no
 * record, so it still shows as "Message deleted" in the channel after a reload - see the Request to
 * Principal, where the bridge's `onRedaction(event, room, threadId)` has the authoritative signal at
 * the moment the redaction arrives.
 */
const seenThreadReplies = new Map<string, Set<string>>();

function rememberThreadReplies(roomId: string, events: MatrixEvent[]): void {
  let ids = seenThreadReplies.get(roomId);
  if (!ids) {
    ids = new Set();
    seenThreadReplies.set(roomId, ids);
  }
  for (const event of events) {
    const id = event.getId();
    if (id && !id.startsWith('~')) ids.add(id);
  }
}

/** True for an event the SDK moved into the main timeline because it was redacted inside a thread. */
function isRedactedThreadReply(roomId: string, event: MatrixEvent): boolean {
  if (!event.isRedacted()) return false;
  const id = event.getId();
  return !!id && !!seenThreadReplies.get(roomId)?.has(id);
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
  const { events, hasMore, isPaginating, version, paginateBack } = useTimeline(timelineSource);

  // Keep a record of which ids belong to a thread, so a later redaction cannot smuggle one of them
  // back into the channel (see `seenThreadReplies` above).
  useEffect(() => {
    if (threadRootId) rememberThreadReplies(roomId, events);
  }, [roomId, threadRootId, events]);

  // `version` is in the deps on purpose: edits/redactions mutate events in place (see ARCHITECTURE.md).
  const rows = useMemo(
    () => (threadRootId ? events : events.filter((e) => !isThreadReply(e) && !isRedactedThreadReply(roomId, e))),
    [events, roomId, threadRootId, version],
  );
  const items = useMemo(() => buildTimelineItems(rows), [rows, version]);
  return { items, events: rows, hasMore, isPaginating, version, paginateBack };
}
