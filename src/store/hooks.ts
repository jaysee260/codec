/**
 * Convenience React hooks over the stores. Devs may use these or read the stores directly.
 */
import { useEffect, useMemo, useState } from 'react';
import { KnownMembership, type MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { loadMembers } from '@/lib/matrix/actions.ts';
import { fetchDecryptedMedia, type EncryptedFile } from '@/lib/matrix/attachments.ts';
import {
  displayNameOf,
  getDecryptionState,
  isDisplayableEvent,
  isMainTimelineEvent,
  isRoomEncrypted,
  memberAvatarUrl,
  type DecryptionState,
} from '@/lib/matrix/utils.ts';
import { useRoomStore, type RoomSummary } from './rooms.ts';
import {
  ensureThreadTimeline,
  ensureTimeline,
  isRedactedThreadReply,
  paginateBack,
  threadKey,
  useTimelineStore,
  type TimelineSource,
} from './timeline.ts';
import { useSessionStore } from './session.ts';

const EMPTY_EVENTS: MatrixEvent[] = [];

export interface RoomTimeline {
  /**
   * Displayable events only, oldest first. Main timeline: messages + stickers, no reactions/edits/state and
   * **no thread replies**. Thread timeline: the replies (messages/stickers) without the root event.
   */
  events: MatrixEvent[];
  /** All live timeline events, unfiltered (thread timelines include the root once history is fully loaded). */
  allEvents: MatrixEvent[];
  hasMore: boolean;
  isPaginating: boolean;
  /** Bumps on every timeline change; put it in memo deps if you memoise rows (edits/reactions mutate events in place). */
  version: number;
  paginateBack(limit?: number): Promise<void>;
}

/** Same shape for both kinds of timeline (Phase 3 name). */
export type Timeline = RoomTimeline;

/**
 * Live timeline for a source: `{ roomId }` = the room's main timeline, `{ roomId, threadRootId }` = that thread
 * (SDK `Thread` timeline, `/relations`-backed). Same return shape either way. Opening a thread source creates
 * the Thread model and loads its newest replies; `paginateBack` loads older ones.
 */
export function useTimeline(source: TimelineSource | null): RoomTimeline {
  const roomId = source?.roomId ?? null;
  const rootId = source?.threadRootId ?? null;
  const key = roomId && rootId ? threadKey(roomId, rootId) : null;
  const allEvents =
    useTimelineStore((s) => (key ? s.eventsByThread[key] : roomId ? s.eventsByRoom[roomId] : undefined)) ?? EMPTY_EVENTS;
  const hasMore = useTimelineStore((s) =>
    key ? (s.canPaginateBackThread[key] ?? true) : roomId ? (s.canPaginateBack[roomId] ?? true) : false,
  );
  const isPaginating = useTimelineStore((s) => (key ? !!s.isPaginatingThread[key] : roomId ? !!s.isPaginating[roomId] : false));
  const version = useTimelineStore((s) => s.version);

  useEffect(() => {
    if (!roomId) return;
    if (rootId) void ensureThreadTimeline(roomId, rootId);
    else ensureTimeline(roomId);
  }, [roomId, rootId]);

  const events = useMemo(
    () =>
      rootId
        ? allEvents.filter((e) => e.getId() !== rootId && isDisplayableEvent(e))
        : // `eventsByRoom` already skips redacted thread replies the SDK moved into the main timeline; re-checked here
          // so a consumer reading `allEvents` through its own filter gets the same guarantee.
          allEvents.filter((e) => isMainTimelineEvent(e) && !isRedactedThreadReply(roomId!, e.getId())),
    [allEvents, rootId, roomId],
  );

  return {
    events,
    allEvents,
    hasMore,
    isPaginating,
    version,
    paginateBack: (limit?: number) =>
      roomId ? paginateBack(rootId ? { roomId, threadRootId: rootId } : { roomId }, limit) : Promise.resolve(),
  };
}

/** Live main timeline for a room, pre-filtered for display (Phase 1 name; thin wrapper over `useTimeline`). */
export function useRoomTimeline(roomId: string | null): RoomTimeline {
  return useTimeline(roomId ? { roomId } : null);
}

/**
 * Display names of users typing in a room (never includes the current user). Accepts a room id or a timeline
 * source; typing is room-scoped in Matrix, so a thread source reports the same room-wide list.
 */
export function useTyping(source: string | TimelineSource | null): string[] {
  const roomId = typeof source === 'string' ? source : (source?.roomId ?? null);
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

// ---------------------------------------------------------------------------
// Encryption (Phase 5)
// ---------------------------------------------------------------------------

/** True when the room has `m.room.encryption` (lock icon, encrypted composer hint). Re-reads on room-list changes. */
export function useRoomEncrypted(roomId: string | null): boolean {
  const version = useRoomStore((s) => s.version);
  return useMemo(() => isRoomEncrypted(roomId), [roomId, version]);
}

/**
 * Decryption state of an event for its row: `status` 'none' (plaintext event) | 'decrypting' | 'decrypted' |
 * 'failed' (+ `code`, `message`, `historical`). Re-evaluated on every timeline commit, which the bridge triggers
 * when the SDK decrypts the event in place (`MatrixEventEvent.Decrypted`).
 */
export function useDecryptionState(event: MatrixEvent | null | undefined): DecryptionState {
  const version = useTimelineStore((s) => s.version);
  return useMemo(() => (event ? getDecryptionState(event) : { status: 'none' as const }), [event, version]);
}

export interface DecryptedMedia {
  /** `blob:` URL for `<img src>` / `<audio src>` / `<a href download>`, or null while loading / on error. */
  url: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Download + decrypt an encrypted attachment (`DisplayBody.file`, `info.thumbnail_file`, `VoiceMessageInfo.file`)
 * into a `blob:` URL. Pass `null` for plaintext media (returns `{ url: null, loading: false }`, so a component can
 * fall back to `mxcToHttp(body.url)`). The URL is cached per attachment for the session; do not revoke it.
 */
export function useDecryptedMediaUrl(file: EncryptedFile | null | undefined, mimetype?: string): DecryptedMedia {
  const key = file?.url ?? null;
  const [state, setState] = useState<DecryptedMedia>({ url: null, loading: !!file, error: null });
  useEffect(() => {
    if (!file) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ url: null, loading: true, error: null });
    fetchDecryptedMedia(file, mimetype).then(
      (url) => {
        if (!cancelled) setState({ url, loading: false, error: null });
      },
      (e: unknown) => {
        if (!cancelled) setState({ url: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `file` objects are re-created on every getDisplayBody(); key on the mxc url (+ type) instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mimetype]);
  return state;
}

/** docs/archive/PHASE5_TICKETS.md name for `useDecryptedMediaUrl`. */
export const useMediaObjectUrl = useDecryptedMediaUrl;

// Phase 2 (docs/archive/PHASE2_TICKETS.md Shared API): layout hooks live in ./layout.ts and are re-exported here.
export { useIsPhone, useViewport, type Viewport } from './layout.ts';

// Phase 5: security hooks live in ./security.ts and are re-exported here.
export { useSecurityStore, useSecurityHint, securityHint, type SecurityState, type SecurityHint, type VerificationFlow, type SasState, type RecoveryState, type PendingPrompt } from './security.ts';

// Phase 3: thread hooks live in ./threads.ts and are re-exported here.
export {
  useThreadStore,
  useThreadSummary,
  useThreadRoot,
  useRoomThreads,
  useThreadUnread,
  useOpenThread,
  useOpenThreadRootId,
  type ThreadSummary,
  type ThreadInfo,
  type RoomThreads,
  type ThreadState,
} from './threads.ts';
export { type TimelineSource, sourceKey, threadKey } from './timeline.ts';

// Read receipts: hooks live in ./receipts.ts and are re-exported here.
export {
  useReceiptStore,
  useReceiptVersion,
  useReadPoints,
  useReadPointsResult,
  useLatestOwnSentId,
  useSendStatus,
  useSeenBy,
  useSendReadReceiptsSetting,
  type ReceiptState,
  type ReadPointsResult,
} from './receipts.ts';
export { type Reader, type SeenBy, type SendStatus } from '@/lib/matrix/receipts.ts';
