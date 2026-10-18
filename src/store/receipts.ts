/**
 * Read receipts store + hooks (docs/ARCHITECTURE.md "Read receipts deltas"). Re-exported from `./hooks.ts` and
 * `@/store`.
 *
 * The SDK mutates receipts in place (`Room` / `Thread` receipt structures), so nothing in the timeline snapshot
 * changes when a receipt arrives. The bridge bumps `receiptVersion[roomId]` on `RoomEvent.Receipt`, on
 * `Room.localEchoUpdated` (send status flips, the `~txn` -> `$id` swap) and on thread model updates (a Thread
 * created later takes over the receipts the room cached for it); the hooks here memoise on that counter, the
 * displayed events' identity and the room-list version (member names / avatars, lazy-loaded members).
 * `settingsVersion` bumps when `im.vector.web.settings` account data changes (this device or another).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { loadMembers } from '@/lib/matrix/actions.ts';
import {
  buildReadPointsSnapshot,
  getReceiptHolder,
  getSeenBy,
  getSendReadReceipts,
  getSendStatus,
  setSendReadReceipts,
  type Reader,
  type SeenBy,
  type SendStatus,
} from '@/lib/matrix/receipts.ts';
import { useRoomStore } from './rooms.ts';
import { useSessionStore } from './session.ts';
import { useTimelineStore, type TimelineSource } from './timeline.ts';

export interface ReceiptState {
  /** Per room: bumps on every receipt / local-echo / thread-model change the bridge sees for that room. */
  receiptVersion: Record<string, number>;
  /** Bumps when the `im.vector.web.settings` account data changes. */
  settingsVersion: number;
}

export const useReceiptStore = create<ReceiptState>(() => ({ receiptVersion: {}, settingsVersion: 0 }));

/** Bridge: receipts (or send statuses) of these rooms changed. One commit for the batch. */
export function bumpReceiptVersion(roomIds: Iterable<string>): void {
  const ids = [...roomIds];
  if (!ids.length) return;
  useReceiptStore.setState((s) => {
    const receiptVersion = { ...s.receiptVersion };
    for (const id of ids) receiptVersion[id] = (receiptVersion[id] ?? 0) + 1;
    return { receiptVersion };
  });
}

/** Bridge: the settings account-data event changed. */
export function bumpReceiptSettingsVersion(): void {
  useReceiptStore.setState((s) => ({ settingsVersion: s.settingsVersion + 1 }));
}

/** Logout. */
export function resetReceipts(): void {
  useReceiptStore.setState((s) => ({ receiptVersion: {}, settingsVersion: s.settingsVersion + 1 }));
}

/** The per-room counter (0 until the first receipt event); put it in memo deps when reading receipts yourself. */
export function useReceiptVersion(roomId: string | null | undefined): number {
  return useReceiptStore((s) => (roomId ? (s.receiptVersion[roomId] ?? 0) : 0));
}

const EMPTY_READ_POINTS: Map<string, Reader[]> = new Map();

/** `useReadPoints` + the sent-check row, computed once per list render. */
export interface ReadPointsResult {
  /** Row event id -> readers whose latest read point is that row (everyone but me), newest receipt first. */
  readPoints: Map<string, Reader[]>;
  /** The one row that shows the "sent" check (my newest message, newest row, nobody has read it), or null. */
  latestOwnSentId: string | null;
}

/**
 * Both outputs in one memo: the per-row readers map and the sent-check row. `displayedEvents` is
 * `useTimeline(source).events` (the rows the list renders, in order); pass the same array identity you render
 * from. Triggers `loadMembers` so lazily loaded members get their avatars. Rebuilt on receipts, send-status
 * changes, timeline changes (array identity) and member changes; O(members + rows) per rebuild, row arrays keep
 * their identity when their readers did not change.
 */
export function useReadPointsResult(source: TimelineSource | null, displayedEvents: readonly MatrixEvent[]): ReadPointsResult {
  const roomId = source?.roomId ?? null;
  const rootId = source?.threadRootId ?? null;
  const myUserId = useSessionStore((s) => s.userId);
  const receiptVersion = useReceiptVersion(roomId);
  const roomsVersion = useRoomStore((s) => s.version);
  // A thread source: the Thread model may not exist yet when the panel mounts; it appears with a thread commit.
  const threadVersion = useTimelineStore((s) => (rootId ? s.threadVersion : 0));
  const previous = useRef<Map<string, Reader[]>>(EMPTY_READ_POINTS);
  useEffect(() => {
    if (roomId) void loadMembers(roomId);
  }, [roomId]);
  return useMemo(() => {
    const room = roomId ? getClientOrNull()?.getRoom(roomId) : null;
    const holder = getReceiptHolder(room, rootId);
    const snap = buildReadPointsSnapshot(holder, displayedEvents, myUserId, { previous: previous.current });
    previous.current = snap.readPoints;
    return snap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, rootId, displayedEvents, myUserId, receiptVersion, roomsVersion, threadVersion]);
}

/** Row event id -> readers (everyone but me) whose latest read point maps onto that row. See `useReadPointsResult`. */
export function useReadPoints(source: TimelineSource | null, displayedEvents: readonly MatrixEvent[]): Map<string, Reader[]> {
  return useReadPointsResult(source, displayedEvents).readPoints;
}

/** The row that shows the single "sent" check, or null. See `useReadPointsResult`. */
export function useLatestOwnSentId(source: TimelineSource | null, displayedEvents: readonly MatrixEvent[]): string | null {
  return useReadPointsResult(source, displayedEvents).latestOwnSentId;
}

/**
 * `'sending' | 'sent' | 'failed'` for my rows, `null` for everyone else's. Re-evaluated on the room's receipt
 * version (the bridge bumps it on `Room.localEchoUpdated`, i.e. every status flip including the E2EE
 * `ENCRYPTING -> SENDING -> SENT -> null` chain) and on timeline commits.
 */
export function useSendStatus(event: MatrixEvent | null | undefined): SendStatus {
  const myUserId = useSessionStore((s) => s.userId);
  const roomId = event?.getRoomId() ?? null;
  const receiptVersion = useReceiptVersion(roomId);
  const version = useTimelineStore((s) => s.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getSendStatus(event, myUserId), [event, myUserId, receiptVersion, version]);
}

const EMPTY_SEEN_BY: SeenBy = { seen: [], notSeen: [], notSeenCount: 0, truncated: false };

/**
 * Seen-by list for one event of a source: `{ seen, notSeen, notSeenCount, truncated }` (see `getSeenBy`). Calls
 * `loadMembers` so "Not seen yet" covers every joined member, not only the senders the initial sync knew
 * (Advisor risk 6); re-evaluates when they arrive (`useRoomStore.version`). Pass `null` while the list is closed.
 */
export function useSeenBy(source: TimelineSource | null, eventId: string | null | undefined): SeenBy {
  const roomId = source?.roomId ?? null;
  const rootId = source?.threadRootId ?? null;
  const myUserId = useSessionStore((s) => s.userId);
  const receiptVersion = useReceiptVersion(roomId);
  const roomsVersion = useRoomStore((s) => s.version);
  const threadVersion = useTimelineStore((s) => (rootId ? s.threadVersion : 0));
  useEffect(() => {
    if (roomId && eventId) void loadMembers(roomId);
  }, [roomId, eventId]);
  return useMemo(() => {
    if (!roomId || !eventId) return EMPTY_SEEN_BY;
    const holder = getReceiptHolder(getClientOrNull()?.getRoom(roomId), rootId);
    return getSeenBy(holder, eventId, myUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, rootId, eventId, myUserId, receiptVersion, roomsVersion, threadVersion]);
}

/**
 * The "Send read receipts" setting: `[on, setOn]`. `on` reads account data (default true) and follows changes
 * made on other devices; `setOn` writes it (merging the other keys of `im.vector.web.settings`), reflects the
 * new value immediately and resolves once `/sync` echoed it. Rejects (and reverts) on failure.
 */
export function useSendReadReceiptsSetting(): [boolean, (on: boolean) => Promise<void>] {
  const settingsVersion = useReceiptStore((s) => s.settingsVersion);
  const [pending, setPending] = useState<boolean | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stored = useMemo(() => getSendReadReceipts(getClientOrNull()), [settingsVersion]);
  const setOn = useCallback(async (on: boolean): Promise<void> => {
    const client = getClientOrNull();
    if (!client) throw new Error('Not logged in');
    setPending(on);
    try {
      await setSendReadReceipts(client, on);
      bumpReceiptSettingsVersion();
    } finally {
      setPending(null);
    }
  }, []);
  return [pending ?? stored, setOn];
}
