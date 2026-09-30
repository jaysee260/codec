/**
 * Turns the raw live timeline into the flat list the message list renders: day dividers plus
 * message rows that know whether they start a sender group (DEV-B-1).
 *
 * Grouping rule (Discord): same sender, less than 5 minutes apart, same day, and neither the
 * previous nor the current row is a reply (replies always show their own header + quote).
 */
import { useMemo } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { useRoomTimeline } from '@/store/hooks.ts';
import { getReplyTargetId } from '@/lib/matrix/utils.ts';
import { isSameDay } from '@/lib/format.ts';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

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

/** Display-ready timeline for a room. Re-computed on every store `version` bump. */
export function useRoomEvents(roomId: string): RoomEvents {
  const { events, hasMore, isPaginating, version, paginateBack } = useRoomTimeline(roomId);
  // `version` is in the deps on purpose: edits/redactions mutate events in place (see ARCHITECTURE.md).
  const items = useMemo(() => buildTimelineItems(events), [events, version]);
  return { items, events, hasMore, isPaginating, version, paginateBack };
}
