/**
 * Convenience React hooks over the stores. Devs may use these or read the stores directly.
 */
import { useEffect, useMemo } from 'react';
import { KnownMembership, type MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { loadMembers } from '@/lib/matrix/actions.ts';
import { displayNameOf, isDisplayableEvent, memberAvatarUrl } from '@/lib/matrix/utils.ts';
import { useRoomStore, type RoomSummary } from './rooms.ts';
import { ensureTimeline, useTimelineStore } from './timeline.ts';
import { useSessionStore } from './session.ts';

const EMPTY_EVENTS: MatrixEvent[] = [];

export interface RoomTimeline {
  /** Displayable events only (messages, stickers; no reactions/edits/state), oldest first. */
  events: MatrixEvent[];
  /** All live timeline events, unfiltered. */
  allEvents: MatrixEvent[];
  hasMore: boolean;
  isPaginating: boolean;
  /** Bumps on every timeline change; put it in memo deps if you memoise rows (edits/reactions mutate events in place). */
  version: number;
  paginateBack(limit?: number): Promise<void>;
}

/** Live timeline for a room, pre-filtered for display. */
export function useRoomTimeline(roomId: string | null): RoomTimeline {
  const allEvents = useTimelineStore((s) => (roomId ? s.eventsByRoom[roomId] : undefined)) ?? EMPTY_EVENTS;
  const hasMore = useTimelineStore((s) => (roomId ? (s.canPaginateBack[roomId] ?? true) : false));
  const isPaginating = useTimelineStore((s) => (roomId ? !!s.isPaginating[roomId] : false));
  const version = useTimelineStore((s) => s.version);
  const paginateBack = useTimelineStore((s) => s.paginateBack);

  useEffect(() => {
    if (roomId) ensureTimeline(roomId);
  }, [roomId]);

  const events = useMemo(() => allEvents.filter(isDisplayableEvent), [allEvents]);

  return {
    events,
    allEvents,
    hasMore,
    isPaginating,
    version,
    paginateBack: (limit?: number) => (roomId ? paginateBack(roomId, limit) : Promise.resolve()),
  };
}

/** Display names of users typing in a room (never includes the current user). */
export function useTyping(roomId: string | null): string[] {
  const ids = useTimelineStore((s) => (roomId ? s.typingByRoom[roomId] : undefined));
  const roomVersion = useRoomStore((s) => s.version);
  return useMemo(() => {
    if (!roomId || !ids?.length) return [];
    const room = getClientOrNull()?.getRoom(roomId);
    return ids.map((id) => displayNameOf(room, id));
  }, [roomId, ids, roomVersion]);
}

export type Presence = 'online' | 'offline' | 'unavailable';

export interface MemberInfo {
  userId: string;
  name: string;
  avatarUrl: string;
  powerLevel: number;
  membership: string;
  presence: Presence;
}

export interface RoomMembers {
  joined: MemberInfo[];
  invited: MemberInfo[];
}

const EMPTY_MEMBERS: RoomMembers = { joined: [], invited: [] };

function toInfo(userId: string, name: string, avatarUrl: string, powerLevel: number, membership: string): MemberInfo {
  const presence = (getClientOrNull()?.getUser(userId)?.presence ?? 'offline') as Presence;
  return { userId, name, avatarUrl, powerLevel, membership, presence };
}

/** Joined + invited members of a room, sorted by power level then name. Triggers lazy member loading. */
export function useMembers(roomId: string | null): RoomMembers {
  const version = useRoomStore((s) => s.version);
  useEffect(() => {
    if (roomId) void loadMembers(roomId);
  }, [roomId]);
  return useMemo(() => {
    const room = roomId ? getClientOrNull()?.getRoom(roomId) : null;
    if (!room) return EMPTY_MEMBERS;
    const sort = (a: MemberInfo, b: MemberInfo): number => b.powerLevel - a.powerLevel || a.name.localeCompare(b.name);
    const joined = room
      .getJoinedMembers()
      .map((m) => toInfo(m.userId, m.name, memberAvatarUrl(m, 40), m.powerLevel, KnownMembership.Join))
      .sort(sort);
    const invited = room
      .getMembersWithMembership(KnownMembership.Invite)
      .map((m) => toInfo(m.userId, m.name, memberAvatarUrl(m, 40), m.powerLevel, KnownMembership.Invite))
      .sort(sort);
    return { joined, invited };
  }, [roomId, version]);
}

export function useRoomSummary(roomId: string | null): RoomSummary | undefined {
  return useRoomStore((s) => (roomId ? s.roomsById[roomId] : undefined));
}

export function useSelectedRoom(): RoomSummary | undefined {
  return useRoomStore((s) => (s.selectedRoomId ? s.roomsById[s.selectedRoomId] : undefined));
}

/** The current user's id (null when logged out). */
export function useMyUserId(): string | null {
  return useSessionStore((s) => s.userId);
}
