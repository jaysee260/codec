/**
 * Timeline store: per-room snapshot of the SDK live timeline (unfiltered, oldest first), backwards
 * pagination state, and typing users. The bridge calls `refreshTimeline(roomId)` (debounced per room)
 * whenever the SDK mutates that room's live timeline; `version` bumps on every commit.
 *
 * Single source of truth is always `room.getLiveTimeline().getEvents()`; we only copy the array so
 * React sees a new identity. Edits and reactions are NOT separate rows for display: the SDK
 * aggregates them onto their target (`event.getContent()` / `event.replacingEvent()` /
 * `getReactions(roomId, eventId)`), so filter them out with `isDisplayableEvent()`.
 */
import { create } from 'zustand';
import { Direction, type MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';

export interface TimelineState {
  /** Live timeline events per room, oldest first, unfiltered (state events, reactions, edits included). */
  eventsByRoom: Record<string, MatrixEvent[]>;
  /** False once the start of the room has been reached. Missing key = unknown (treat as true). */
  canPaginateBack: Record<string, boolean>;
  isPaginating: Record<string, boolean>;
  /** User ids currently typing per room, excluding the current user. */
  typingByRoom: Record<string, string[]>;
  version: number;
  /** Load `limit` older events into the live timeline. Resolves when the store has been refreshed. */
  paginateBack(roomId: string, limit?: number): Promise<void>;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  eventsByRoom: {},
  canPaginateBack: {},
  isPaginating: {},
  typingByRoom: {},
  version: 0,

  async paginateBack(roomId, limit = 30) {
    const client = getClientOrNull();
    const room = client?.getRoom(roomId);
    if (!client || !room) return;
    const st = get();
    if (st.isPaginating[roomId] || st.canPaginateBack[roomId] === false) return;
    set((s) => ({ isPaginating: { ...s.isPaginating, [roomId]: true } }));
    try {
      const timeline = room.getLiveTimeline();
      if (!timeline.getPaginationToken(Direction.Backward)) {
        set((s) => ({ canPaginateBack: { ...s.canPaginateBack, [roomId]: false } }));
        return;
      }
      await client.paginateEventTimeline(timeline, { backwards: true, limit });
    } finally {
      set((s) => ({ isPaginating: { ...s.isPaginating, [roomId]: false } }));
      refreshTimeline(roomId);
    }
  },
}));

/** Copy the room's live timeline into the store and update `canPaginateBack`. */
export function refreshTimeline(roomId: string): void {
  const room = getClientOrNull()?.getRoom(roomId);
  if (!room) return;
  const timeline = room.getLiveTimeline();
  const events = [...timeline.getEvents()];
  const canPaginateBack = timeline.getPaginationToken(Direction.Backward) !== null;
  useTimelineStore.setState((s) => ({
    eventsByRoom: { ...s.eventsByRoom, [roomId]: events },
    canPaginateBack: { ...s.canPaginateBack, [roomId]: canPaginateBack },
    version: s.version + 1,
  }));
}

/** Refresh several rooms in one commit (used after the initial sync). */
export function refreshTimelines(roomIds: string[]): void {
  const client = getClientOrNull();
  if (!client) return;
  const eventsByRoom: Record<string, MatrixEvent[]> = {};
  const canPaginateBack: Record<string, boolean> = {};
  for (const roomId of roomIds) {
    const room = client.getRoom(roomId);
    if (!room) continue;
    const timeline = room.getLiveTimeline();
    eventsByRoom[roomId] = [...timeline.getEvents()];
    canPaginateBack[roomId] = timeline.getPaginationToken(Direction.Backward) !== null;
  }
  useTimelineStore.setState((s) => ({
    eventsByRoom: { ...s.eventsByRoom, ...eventsByRoom },
    canPaginateBack: { ...s.canPaginateBack, ...canPaginateBack },
    version: s.version + 1,
  }));
}

/** Make sure a room has a snapshot (used by hooks when a room is opened for the first time). */
export function ensureTimeline(roomId: string): void {
  if (!(roomId in useTimelineStore.getState().eventsByRoom)) refreshTimeline(roomId);
}

export function setTypingForRoom(roomId: string, userIds: string[]): void {
  useTimelineStore.setState((s) => {
    const prev = s.typingByRoom[roomId] ?? [];
    if (prev.length === userIds.length && prev.every((id, i) => id === userIds[i])) return s;
    return { typingByRoom: { ...s.typingByRoom, [roomId]: userIds }, version: s.version + 1 };
  });
}

export function resetTimelines(): void {
  useTimelineStore.setState((s) => ({
    eventsByRoom: {},
    canPaginateBack: {},
    isPaginating: {},
    typingByRoom: {},
    version: s.version + 1,
  }));
}
