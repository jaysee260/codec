/**
 * Timeline store: per-room snapshot of the SDK live timeline (unfiltered, oldest first), backwards
 * pagination state, and typing users. The bridge calls `refreshTimeline(roomId)` (debounced per room)
 * whenever the SDK mutates that room's live timeline; `version` bumps on every commit.
 *
 * Single source of truth is always `room.getLiveTimeline().getEvents()`; we only copy the array so
 * React sees a new identity. Edits and reactions are NOT separate rows for display: the SDK
 * aggregates them onto their target (`event.getContent()` / `event.replacingEvent()` /
 * `getReactions(roomId, eventId)`), so filter them out with `isDisplayableEvent()`.
 *
 * Phase 3 (threads): a timeline is addressed by a `TimelineSource` - `{ roomId }` for the room's main
 * timeline or `{ roomId, threadRootId }` for one thread. Thread snapshots mirror
 * `room.getThread(rootId).liveTimeline.getEvents()` (the SDK `Thread` model, `/relations`-backed) and
 * live in `eventsByThread` under `threadKey(roomId, rootId)`; the main-timeline maps are unchanged so
 * Phase 1/2 consumers keep working. With `threadSupport: true` the SDK partitions `m.thread` replies
 * out of the main live timeline, so `eventsByRoom` never contains thread replies (the root stays in
 * both). `paginateBack(source)` works for both kinds.
 */
import { create } from 'zustand';
import { Direction, type MatrixEvent, type Room, type Thread } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { ensureThread } from '@/lib/matrix/actions.ts';
import { isDisplayableEvent } from '@/lib/matrix/utils.ts';

/** Which timeline: the room's main timeline, or the thread rooted at `threadRootId` inside that room. */
export interface TimelineSource {
  roomId: string;
  /** Root event id of a thread. Omit (or undefined) for the main timeline. */
  threadRootId?: string;
}

/** Key of a thread snapshot in `eventsByThread` / `canPaginateBackThread` / `isPaginatingThread`. */
export function threadKey(roomId: string, threadRootId: string): string {
  return `${roomId}|${threadRootId}`;
}

/**
 * Key for per-source UI state (drafts, reply/edit targets, scroll anchors): the thread root id for a thread
 * source, else the room id (docs/PHASE3_TICKETS.md Shared API). Event ids are globally unique, so no room prefix.
 */
export function sourceKey(source: TimelineSource): string {
  return source.threadRootId ?? source.roomId;
}

/** Normalise the Phase 1 `(roomId)` call form to a source. */
function toSource(source: string | TimelineSource): TimelineSource {
  return typeof source === 'string' ? { roomId: source } : source;
}

export interface TimelineState {
  /** Live timeline events per room, oldest first, unfiltered (state events, reactions, edits included). */
  eventsByRoom: Record<string, MatrixEvent[]>;
  /** False once the start of the room has been reached. Missing key = unknown (treat as true). */
  canPaginateBack: Record<string, boolean>;
  isPaginating: Record<string, boolean>;
  /** User ids currently typing per room, excluding the current user. */
  typingByRoom: Record<string, string[]>;
  /**
   * Phase 3: thread timeline events per `threadKey(roomId, rootId)`, oldest first, unfiltered (the root
   * event is included once the start of the thread has been reached; reactions/edits to replies too).
   */
  eventsByThread: Record<string, MatrixEvent[]>;
  /** False once the start of the thread has been reached (no backward `/relations` token). Missing = unknown. */
  canPaginateBackThread: Record<string, boolean>;
  isPaginatingThread: Record<string, boolean>;
  version: number;
  /**
   * Phase 3: bumps on every thread snapshot commit and on every Thread model change (bridge: ThreadEvent.*).
   * `version` bumps too, so Phase 1 memo deps keep working; subscribe to this one for thread-only re-renders.
   */
  threadVersion: number;
  /**
   * Load `limit` older events into the live timeline. Resolves when the store has been refreshed.
   * Accepts a room id (Phase 1) or a `TimelineSource` (Phase 3: a thread source paginates the thread via
   * `/relations/{root}/m.thread`, backwards).
   */
  paginateBack(source: string | TimelineSource, limit?: number): Promise<void>;
  /** Phase 3: load `limit` older replies of a thread (`/relations/{root}/m.thread`, backwards). */
  paginateBackThread(roomId: string, threadRootId: string, limit?: number): Promise<void>;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  eventsByRoom: {},
  canPaginateBack: {},
  isPaginating: {},
  typingByRoom: {},
  eventsByThread: {},
  canPaginateBackThread: {},
  isPaginatingThread: {},
  version: 0,
  threadVersion: 0,

  async paginateBack(source, limit = 30) {
    const { roomId, threadRootId } = toSource(source);
    if (threadRootId) return get().paginateBackThread(roomId, threadRootId, limit);
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

  async paginateBackThread(roomId, threadRootId, limit = 30) {
    const client = getClientOrNull();
    if (!client) return;
    const key = threadKey(roomId, threadRootId);
    const st = get();
    if (st.isPaginatingThread[key] || st.canPaginateBackThread[key] === false) return;
    set((s) => ({ isPaginatingThread: { ...s.isPaginatingThread, [key]: true } }));
    try {
      // Creates the Thread model (and triggers its initial /relations fetch) when the SDK does not know it yet.
      const thread = await ensureThread(roomId, threadRootId);
      if (!thread) return;
      // Never cache `liveTimeline`: the Thread swaps it in resetLiveTimeline() while initialising.
      const timeline = thread.liveTimeline;
      if (!timeline.getPaginationToken(Direction.Backward)) {
        set((s) => ({ canPaginateBackThread: { ...s.canPaginateBackThread, [key]: false } }));
        return;
      }
      await client.paginateEventTimeline(timeline, { backwards: true, limit });
    } finally {
      set((s) => ({ isPaginatingThread: { ...s.isPaginatingThread, [key]: false } }));
      refreshThread(roomId, threadRootId);
    }
  },
}));

/** Phase 3 convenience: `paginateBack` for either kind of timeline source (same as the store method). */
export function paginateBack(source: string | TimelineSource, limit?: number): Promise<void> {
  return useTimelineStore.getState().paginateBack(source, limit);
}

/** Bridge / threads.ts: a Thread model changed without a snapshot commit (new / deleted / metadata). */
export function bumpThreadVersion(): void {
  useTimelineStore.setState((s) => ({ threadVersion: s.threadVersion + 1 }));
}

// ---------------------------------------------------------------------------
// Redacted thread replies (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Ids of thread replies redacted during this session, per room. matrix-js-sdk v43 `MatrixEvent.makeRedacted`
 * -> `moveAllRelatedToMainTimeline` moves a redacted reply (and its relations) into the room's live timeline and
 * strips every thread marker, so without this guard "Message deleted" rows would appear in the channel. The bridge
 * records the id from `RoomEvent.Redaction` (which still carries the thread id) and the main snapshots skip it.
 * Session-only: a reply redacted before this client loaded has no record and renders in the channel after a
 * reload (server/SDK limitation, MSC3389 pending). Dev B's view-level guard in `useRoomEvents` stays as a second line.
 */
const redactedThreadReplyIds = new Map<string, Set<string>>();

/** Bridge: a thread reply (not a root) was redacted; keep it out of the main timeline snapshots. */
export function markRedactedThreadReply(roomId: string, eventId: string): void {
  let set = redactedThreadReplyIds.get(roomId);
  if (!set) {
    set = new Set();
    redactedThreadReplyIds.set(roomId, set);
  }
  set.add(eventId);
}

/** True when the event id is a thread reply redacted during this session (so it must not render in the channel). */
export function isRedactedThreadReply(roomId: string, eventId: string | undefined): boolean {
  return !!eventId && (redactedThreadReplyIds.get(roomId)?.has(eventId) ?? false);
}

/** Main-timeline events minus redacted thread replies the SDK moved there. */
function mainTimelineEvents(room: Room): MatrixEvent[] {
  const skip = redactedThreadReplyIds.get(room.roomId);
  const events = room.getLiveTimeline().getEvents();
  return skip?.size ? events.filter((e) => !skip.has(e.getId() ?? '')) : [...events];
}

/** Copy the room's live timeline into the store and update `canPaginateBack`. */
export function refreshTimeline(roomId: string): void {
  const room = getClientOrNull()?.getRoom(roomId);
  if (!room) return;
  const timeline = room.getLiveTimeline();
  const events = mainTimelineEvents(room);
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
    eventsByRoom[roomId] = mainTimelineEvents(room);
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

function snapshotThread(thread: Thread): { events: MatrixEvent[]; canPaginateBack: boolean } {
  const timeline = thread.liveTimeline;
  const events = [...timeline.getEvents()];
  // Until the initial /relations fetch has run the token is null although history exists; report "unknown"
  // (true) so a consumer calls paginateBack, which waits for the initialisation.
  const canPaginateBack = thread.initialEventsFetched ? timeline.getPaginationToken(Direction.Backward) !== null : true;
  return { events, canPaginateBack };
}

/**
 * Phase 3: copy a thread's live timeline into the store. No-op when the SDK has no `Thread` for the root yet
 * (use `ensureThreadTimeline` / `paginateBack(source)` to create it).
 */
export function refreshThread(roomId: string, threadRootId: string): void {
  const room: Room | null | undefined = getClientOrNull()?.getRoom(roomId);
  const thread = room?.getThread(threadRootId);
  if (!thread) return;
  const key = threadKey(roomId, threadRootId);
  const { events, canPaginateBack } = snapshotThread(thread);
  useTimelineStore.setState((s) => ({
    eventsByThread: { ...s.eventsByThread, [key]: events },
    canPaginateBackThread: { ...s.canPaginateBackThread, [key]: canPaginateBack },
    version: s.version + 1,
    threadVersion: s.threadVersion + 1,
  }));
}

/** Refresh several threads of one room in one commit. */
export function refreshThreads(roomId: string, threadRootIds: string[]): void {
  const room = getClientOrNull()?.getRoom(roomId);
  if (!room) return;
  const eventsByThread: Record<string, MatrixEvent[]> = {};
  const canPaginateBackThread: Record<string, boolean> = {};
  for (const rootId of threadRootIds) {
    const thread = room.getThread(rootId);
    if (!thread) continue;
    const snap = snapshotThread(thread);
    eventsByThread[threadKey(roomId, rootId)] = snap.events;
    canPaginateBackThread[threadKey(roomId, rootId)] = snap.canPaginateBack;
  }
  useTimelineStore.setState((s) => ({
    eventsByThread: { ...s.eventsByThread, ...eventsByThread },
    canPaginateBackThread: { ...s.canPaginateBackThread, ...canPaginateBackThread },
    version: s.version + 1,
    threadVersion: s.threadVersion + 1,
  }));
}

/**
 * Phase 3: make sure a thread has a `Thread` model and a snapshot. Creates the model (fetching the root event
 * when it is not loaded) and kicks off its initial `/relations` fetch; the bridge refreshes the snapshot when
 * the events land. Resolves with the Thread (null when the root cannot be found).
 */
export async function ensureThreadTimeline(roomId: string, threadRootId: string): Promise<Thread | null> {
  const thread = await ensureThread(roomId, threadRootId);
  if (!thread) return null;
  refreshThread(roomId, threadRootId);
  // The SDK's initial fetch is `/relations` without a limit, i.e. Synapse's default of 5 relation events
  // (reactions and edits included), so a busy thread would open with 2-3 visible replies. Wait for that
  // fetch, then top the first page up once so the panel opens with up to ~30 replies.
  await waitForThreadReady(thread);
  refreshThread(roomId, threadRootId);
  const key = threadKey(roomId, threadRootId);
  const st = useTimelineStore.getState();
  const visible = (st.eventsByThread[key] ?? []).filter((e) => e.getId() !== threadRootId && isDisplayableEvent(e)).length;
  if (st.canPaginateBackThread[key] !== false && visible < THREAD_FIRST_PAGE_MIN) {
    await st.paginateBackThread(roomId, threadRootId, 30);
  }
  return thread;
}

/** Visible replies a freshly opened thread should have before the first user-driven `paginateBack`. */
const THREAD_FIRST_PAGE_MIN = 20;

/** Resolve once the Thread's initial `/relations` fetch has run (or after `timeoutMs`). */
function waitForThreadReady(thread: Thread, timeoutMs = 10_000): Promise<void> {
  if (thread.initialEventsFetched) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      if (thread.initialEventsFetched || Date.now() - start > timeoutMs) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

export function setTypingForRoom(roomId: string, userIds: string[]): void {
  useTimelineStore.setState((s) => {
    const prev = s.typingByRoom[roomId] ?? [];
    if (prev.length === userIds.length && prev.every((id, i) => id === userIds[i])) return s;
    return { typingByRoom: { ...s.typingByRoom, [roomId]: userIds }, version: s.version + 1 };
  });
}

export function resetTimelines(): void {
  redactedThreadReplyIds.clear();
  useTimelineStore.setState((s) => ({
    eventsByRoom: {},
    canPaginateBack: {},
    isPaginating: {},
    typingByRoom: {},
    eventsByThread: {},
    canPaginateBackThread: {},
    isPaginatingThread: {},
    version: s.version + 1,
    threadVersion: s.threadVersion + 1,
  }));
}
