/**
 * Thread state (Phase 3): which thread is open, plus hooks that read the SDK `Thread` models
 * (`room.getThread(rootId)`, `room.getThreads()`) and the server bundle on root events
 * (`unsigned.m.relations.m.thread` = `{ count, current_user_participated, latest_event }`).
 *
 *  - `openThreadRootId` / `openThreadRoomId`: the thread panel (desktop right column, phone full screen).
 *    `openThread(rootId)` collapses a reply id to its root (threads never nest); the thread closes by itself
 *    when the selected room changes and on logout.
 *  - `version` bumps whenever a Thread model changes (bridge: `ThreadEvent.New/Update/Delete`, thread
 *    timeline commits). Hooks subscribe to it, so summary rows re-render when a reply lands without the
 *    main timeline changing.
 *  - "Unread" for threads means the server-computed per-thread notification counts
 *    (`unread_thread_notifications`, MSC3773 / spec v1.4) which the SDK requests in its sync filter when
 *    `threadSupport` is on. They respect threaded read receipts (`thread_id` = root): a receipt on the newest
 *    reply (`markThreadRead`) clears the thread; a main-timeline receipt does not. The counts follow the
 *    user's push rules like room unreads do (a reply in a room you are in notifies by default).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { NotificationCountType, type MatrixEvent, type Room, type Thread } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { fetchEvent, fetchRoomThreads, hasMoreRoomThreads, loadMoreRoomThreads, resolveThreadRoot } from '@/lib/matrix/actions.ts';
import { isThreadReply } from '@/lib/matrix/utils.ts';
import { useRoomStore } from './rooms.ts';
import { useLayoutStore } from './layout.ts';
import { bumpThreadVersion, ensureThreadTimeline, useTimelineStore } from './timeline.ts';

/** Max distinct reply senders reported in `participants` (newest first), per docs/archive/PHASE3_TICKETS.md. */
const MAX_PARTICIPANTS = 5;

/** Server-side aggregation of `m.thread` on a root event (`unsigned.m.relations.m.thread`). */
interface ThreadBundle {
  count: number;
  current_user_participated?: boolean;
  latest_event?: Record<string, unknown>;
}

export interface ThreadSummary {
  rootId: string;
  roomId: string;
  /** Number of replies: SDK `thread.length` (server count + my pending replies), else the bundle `count`. */
  count: number;
  /** `origin_server_ts` of the latest reply (0 when unknown). */
  latestTs: number;
  /** Latest reply when known (from the loaded thread timeline, else the server bundle's `latest_event`). */
  latestEvent?: MatrixEvent;
  /**
   * Distinct sender ids of the replies loaded so far, **newest first, at most 5**, always including the latest
   * reply's sender. Before the thread timeline is loaded this is just `[latest sender]`.
   */
  participants: string[];
  /** The current user has replied in this thread (server `current_user_participated`, latched locally on send). */
  participated: boolean;
  /** `room.getThreadUnreadNotificationCount(rootId) > 0` - see the module comment for what unread means. */
  hasUnread: boolean;
  /** The root event when loaded (same object as `root`). */
  rootEvent?: MatrixEvent;
  /** Alias of `rootEvent` (docs/archive/PHASE3_TICKETS.md `ThreadInfo.root`). */
  root?: MatrixEvent;
}

/** docs/archive/PHASE3_TICKETS.md name for the thread-list item; same shape as `ThreadSummary`. */
export type ThreadInfo = ThreadSummary;

export interface ThreadState {
  /** The open thread, or null. `openThreadRootId` / `openThreadRoomId` are the same data flattened. */
  open: { roomId: string; rootId: string } | null;
  openThreadRootId: string | null;
  openThreadRoomId: string | null;
  /** Bumps on every Thread model change. Put it in memo deps when reading SDK thread objects in render. */
  version: number;
  /**
   * Open the thread rooted at `rootId` (a reply id is collapsed to its root). `roomId` defaults to the selected
   * room. Get-or-creates the SDK `Thread` (fetching the root when it is not loaded) and closes phone drawers.
   */
  openThread(rootId: string, roomId?: string): void;
  /** Close the thread panel. Returns true when one was open (Android back, Escape). */
  closeThread(): boolean;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  open: null,
  openThreadRootId: null,
  openThreadRoomId: null,
  version: 0,

  openThread(rootId, roomId) {
    const room = roomId ?? useRoomStore.getState().selectedRoomId;
    if (!room) return;
    const root = resolveThreadRoot(room, rootId);
    set({ open: { roomId: room, rootId: root }, openThreadRootId: root, openThreadRoomId: room });
    useLayoutStore.getState().closeDrawers();
    void ensureThreadTimeline(room, root);
  },

  closeThread() {
    if (!get().openThreadRootId) return false;
    set({ open: null, openThreadRootId: null, openThreadRoomId: null });
    return true;
  },
}));

/** Bridge: a Thread model changed (new / updated / deleted / timeline commit). Bumps `useTimelineStore.threadVersion` too. */
export function bumpThreadsVersion(): void {
  useThreadStore.setState((s) => ({ version: s.version + 1 }));
  bumpThreadVersion();
}

export function resetThreads(): void {
  useThreadStore.setState((s) => ({ open: null, openThreadRootId: null, openThreadRoomId: null, version: s.version + 1 }));
}

/** Selector: root id of the open thread, or null (docs/archive/PHASE3_TICKETS.md). */
export function useOpenThreadRootId(): string | null {
  return useThreadStore((s) => s.openThreadRootId);
}

// A room switch closes the thread (the panel belongs to the conversation it was opened from).
useRoomStore.subscribe((s, prev) => {
  if (s.selectedRoomId !== prev.selectedRoomId) useThreadStore.getState().closeThread();
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summarize(room: Room, rootId: string, rootEvent?: MatrixEvent): ThreadSummary | null {
  const thread = room.getThread(rootId);
  const root = rootEvent ?? thread?.rootEvent ?? room.findEventById(rootId);
  const bundle = root?.getServerAggregatedRelation<ThreadBundle>('m.thread');
  if (!thread && !bundle) return null;
  if (root?.isRedacted()) return null; // redacted roots are dropped from lists and rows

  let count: number;
  let latestEvent: MatrixEvent | undefined;
  let participants: string[];
  let participated: boolean;
  if (thread) {
    count = Math.max(thread.length, bundle?.count ?? 0);
    latestEvent = thread.replyToEvent ?? undefined;
    const senders: string[] = [];
    const latestSender = latestEvent?.getSender();
    if (latestSender) senders.push(latestSender);
    const events = thread.events;
    for (let i = events.length - 1; i >= 0 && senders.length < MAX_PARTICIPANTS; i--) {
      const ev = events[i]!;
      const sender = ev.getSender();
      if (ev.getId() === rootId || !isThreadReply(ev) || ev.isRedacted() || !sender) continue;
      if (!senders.includes(sender)) senders.push(sender);
    }
    participants = senders;
    participated = thread.hasCurrentUserParticipated;
  } else {
    count = bundle!.count ?? 0;
    const latest = bundle!.latest_event;
    latestEvent = latest ? getClientOrNull()?.getEventMapper()({ ...latest, room_id: room.roomId } as never) : undefined;
    const latestSender = latestEvent?.getSender();
    participants = latestSender ? [latestSender] : [];
    participated = !!bundle!.current_user_participated;
  }
  if (count <= 0) return null;
  return {
    rootId,
    roomId: room.roomId,
    count,
    latestTs: latestEvent?.getTs() ?? 0,
    latestEvent,
    participants,
    participated,
    hasUnread: room.getThreadUnreadNotificationCount(rootId, NotificationCountType.Total) > 0,
    rootEvent: root ?? undefined,
    root: root ?? undefined,
  };
}

/** Thread summary of a (root) event for the summary row under it, or null when the event has no thread. */
export function getThreadSummary(roomId: string, rootId: string): ThreadSummary | null {
  const room = getClientOrNull()?.getRoom(roomId);
  return room ? summarize(room, rootId) : null;
}

/**
 * Summary of the thread rooted at `event` for the "N replies - last reply ..." row under a message, or null
 * when nobody has replied in a thread to it. Reads the SDK `Thread` when it exists, else the server bundle.
 * Re-renders on thread, timeline and room (receipts / unread) changes.
 */
export function useThreadSummary(event: MatrixEvent | null | undefined): ThreadSummary | null {
  const threadVersion = useThreadStore((s) => s.version);
  const timelineVersion = useTimelineStore((s) => s.version);
  const roomVersion = useRoomStore((s) => s.version);
  const roomId = event?.getRoomId() ?? null;
  const eventId = event?.getId() ?? null;
  return useMemo(() => {
    if (!event || !roomId || !eventId || eventId.startsWith('~') || isThreadReply(event)) return null;
    const room = getClientOrNull()?.getRoom(roomId);
    return room ? summarize(room, eventId, event) : null;
  }, [event, roomId, eventId, threadVersion, timelineVersion, roomVersion]);
}

/** The root event of a thread (loaded timeline first, then the Thread model, then `/event`). */
export function useThreadRoot(roomId: string | null, rootId: string | null): MatrixEvent | undefined {
  const threadVersion = useThreadStore((s) => s.version);
  const timelineVersion = useTimelineStore((s) => s.version);
  const [fetched, setFetched] = useState<MatrixEvent | undefined>(undefined);
  const local = useMemo(() => {
    if (!roomId || !rootId) return undefined;
    const room = getClientOrNull()?.getRoom(roomId);
    return room?.findEventById(rootId) ?? room?.getThread(rootId)?.rootEvent ?? undefined;
  }, [roomId, rootId, threadVersion, timelineVersion]);
  useEffect(() => {
    setFetched(undefined);
    if (!roomId || !rootId || local) return;
    let cancelled = false;
    void fetchEvent(roomId, rootId).then((ev) => {
      if (!cancelled) setFetched(ev);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, rootId, local]);
  return local ?? fetched;
}

// ---------------------------------------------------------------------------
// Thread list
// ---------------------------------------------------------------------------

export interface RoomThreads {
  /** Every thread the SDK knows for the room, newest activity first (redacted roots dropped). */
  threads: ThreadSummary[];
  /** True while the first `/threads` fetch (or `refresh` / `loadMore`) is in flight. */
  loading: boolean;
  /** Message of the last failed server fetch (the list still shows what the SDK knows), else null. */
  error: string | null;
  /** Re-run the server fetch (idempotent in the SDK) and re-read the models. */
  refresh(): Promise<void>;
  /** True when the server has older threads than the list loaded so far (30 per page). */
  hasMore: boolean;
  /** Load the next page of older threads. */
  loadMore(): Promise<void>;
}

function listThreads(roomId: string): ThreadSummary[] {
  const room = getClientOrNull()?.getRoom(roomId);
  if (!room) return [];
  const out: ThreadSummary[] = [];
  for (const thread of room.getThreads()) {
    const s = summarize(room, thread.id);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.latestTs - a.latestTs);
}

/**
 * Threads of a room for the header "Threads" list: `room.getThreads()` after loading the server list
 * (`GET /rooms/{id}/threads?include=all`, newest 30 by last activity) once per room. Threads the live
 * timeline discovers later (new replies) appear automatically; `loadMore()` pages older ones.
 */
export function useRoomThreads(roomId: string | null): RoomThreads {
  const threadVersion = useThreadStore((s) => s.version);
  const timelineVersion = useTimelineStore((s) => s.version);
  const roomVersion = useRoomStore((s) => s.version);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    try {
      await fetchRoomThreads(roomId);
      setError(null);
    } catch (e) {
      // offline / server error: the list still shows what the SDK already knows
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setTick((t) => t + 1);
    }
  }, [roomId]);

  const loadMore = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    try {
      await loadMoreRoomThreads(roomId);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setTick((t) => t + 1);
    }
  }, [roomId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const threads = useMemo(
    () => (roomId ? listThreads(roomId) : []),
    [roomId, threadVersion, timelineVersion, roomVersion, tick],
  );
  const hasMore = useMemo(
    () => (roomId ? hasMoreRoomThreads(roomId) : false),
    [roomId, tick, threadVersion],
  );
  return { threads, loading, error, refresh, hasMore, loadMore };
}

/**
 * True when any thread in the room has unread notifications (`room.hasThreadUnreadNotification()`, server
 * `unread_thread_notifications`); for the header "Threads" dot. Updates with /sync and threaded receipts.
 */
export function useThreadUnread(roomId: string | null): boolean {
  const roomVersion = useRoomStore((s) => s.version);
  const threadVersion = useThreadStore((s) => s.version);
  return useMemo(
    () => (roomId ? (getClientOrNull()?.getRoom(roomId)?.hasThreadUnreadNotification() ?? false) : false),
    [roomId, roomVersion, threadVersion],
  );
}

/** The open thread as a timeline source (`null` when closed). */
export function useOpenThread(): { roomId: string; threadRootId: string } | null {
  const rootId = useThreadStore((s) => s.openThreadRootId);
  const roomId = useThreadStore((s) => s.openThreadRoomId);
  return rootId && roomId ? { roomId, threadRootId: rootId } : null;
}

/** Internal helper for scripts / devtools: the SDK Thread model, if known. */
export function getThreadModel(roomId: string, rootId: string): Thread | null {
  return getClientOrNull()?.getRoom(roomId)?.getThread(rootId) ?? null;
}

/** True once the thread's initial `/relations` fetch has completed (its events are in the store). */
export function isThreadReady(roomId: string, rootId: string): boolean {
  return getThreadModel(roomId, rootId)?.initialEventsFetched ?? false;
}
