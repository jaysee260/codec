/**
 * SDK -> store bridge. Subscribes to MatrixClient events once per session and forwards them to the
 * stores with small debounces so a burst of sync events causes one React commit, not hundreds.
 *
 * Room list snapshot (rooms.ts):   any Room.* / RoomState.* / RoomMember.* / User.* / accountData
 * Timeline snapshot (timeline.ts): Room.timeline (main live timeline set), Room.timelineReset,
 *                                  Room.redaction, Room.localEchoUpdated
 * Thread snapshots (timeline.ts):  Room.timeline / Room.timelineReset whose timeline set belongs to a
 *                                  Thread (`timelineSet.thread`), Room.redaction with a thread id,
 *                                  Room.localEchoUpdated for events in a thread (Phase 3)
 * Thread models (threads.ts):      ThreadEvent.New / Update / Delete. The CLIENT does not re-emit these
 *                                  (only the Room does), so they are subscribed per Room: every room at
 *                                  bind time plus ClientEvent.Room for rooms that arrive later (Phase 3)
 * Receipts (receipts.ts):          Room.receipt, Room.localEchoUpdated, ThreadEvent.* -> receiptVersion[roomId];
 *                                  accountData im.vector.web.settings -> settingsVersion
 * Typing (timeline.ts):            RoomMember.typing (reads the m.typing event's user_ids directly,
 *                                  so users whose member event is not loaded yet still count)
 */
import {
  ClientEvent,
  EventStatus,
  EventType,
  HttpApiEvent,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  ThreadEvent,
  UserEvent,
  type EventTimelineSet,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type Thread,
} from 'matrix-js-sdk';
import type { IRoomTimelineData } from 'matrix-js-sdk/lib/models/event-timeline-set.js';
import { recomputeRooms } from './rooms.ts';
import {
  markRedactedThreadReply,
  refreshThread,
  refreshThreads,
  refreshTimeline,
  refreshTimelines,
  setTypingForRoom,
  threadKey,
} from './timeline.ts';
import { bumpThreadsVersion } from './threads.ts';
import { bumpReceiptSettingsVersion, bumpReceiptVersion } from './receipts.ts';
import { noteEncryptedRelation, resetEncryptedRelations } from '@/lib/matrix/utils.ts';
import { RECEIPT_SETTINGS_EVENT_TYPE } from '@/lib/matrix/receipts-core.ts';

const ROOMS_DEBOUNCE_MS = 50;
const TIMELINE_DEBOUNCE_MS = 30;

let bound: { client: MatrixClient; dispose: () => void } | null = null;

function debounce(fn: () => void, ms: number): { call: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface BridgeOptions {
  /** Called when the server revokes the token (HttpApiEvent.SessionLoggedOut). */
  onSessionLoggedOut?: () => void;
}

export function bindClient(client: MatrixClient, opts: BridgeOptions = {}): void {
  unbindClient();

  const rooms = debounce(recomputeRooms, ROOMS_DEBOUNCE_MS);
  const pendingTimelines = new Set<string>();
  /** threadKey -> [roomId, rootId] */
  const pendingThreads = new Map<string, [string, string]>();
  const timelines = debounce(() => {
    const ids = [...pendingTimelines];
    pendingTimelines.clear();
    if (ids.length === 1) refreshTimeline(ids[0]!);
    else if (ids.length > 1) refreshTimelines(ids);
    const threads = [...pendingThreads.values()];
    pendingThreads.clear();
    if (threads.length === 1) refreshThread(threads[0]![0], threads[0]![1]);
    else if (threads.length > 1) {
      const byRoom = new Map<string, string[]>();
      for (const [roomId, rootId] of threads) byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), rootId]);
      for (const [roomId, roots] of byRoom) refreshThreads(roomId, roots);
    }
  }, TIMELINE_DEBOUNCE_MS);
  const threadsVersion = debounce(bumpThreadsVersion, TIMELINE_DEBOUNCE_MS);
  // Read receipts: the SDK mutates receipt structures and event statuses in place, so the snapshots do not
  // change; `receiptVersion[roomId]` is what the receipt hooks memoise on. One commit per burst.
  const pendingReceipts = new Set<string>();
  const receipts = debounce(() => {
    const ids = [...pendingReceipts];
    pendingReceipts.clear();
    bumpReceiptVersion(ids);
  }, TIMELINE_DEBOUNCE_MS);
  const scheduleReceipts = (roomId: string): void => {
    pendingReceipts.add(roomId);
    receipts.call();
  };
  const scheduleTimeline = (roomId: string): void => {
    pendingTimelines.add(roomId);
    timelines.call();
  };
  const scheduleThread = (roomId: string, rootId: string): void => {
    pendingThreads.set(threadKey(roomId, rootId), [roomId, rootId]);
    timelines.call();
    threadsVersion.call();
  };
  // BUG-18: nothing before the initial sync is `Prepared`. Account data, presence, device / decryption events and
  // the first rooms of the initial sync all arrive earlier and would run `recomputeRooms` on a partial world (seen:
  // 0 rooms, sync state null), whose first-load landing rule then picks Home / the first DM and persists it. The
  // `Prepared` handler below does the first full recompute; until then the scheduler is a no-op.
  let prepared = client.getSyncState() === SyncState.Prepared || client.getSyncState() === SyncState.Syncing;
  const scheduleRooms = (): void => {
    if (prepared) rooms.call();
  };

  // Phase 3: ThreadEvent.* only fire on the Room. One listener set per room, attached at bind and on arrival.
  const roomListeners = new Map<string, () => void>();
  const attachRoom = (room: Room): void => {
    if (roomListeners.has(room.roomId)) return;
    const onThreadNew = (thread: Thread): void => {
      scheduleThread(room.roomId, thread.id);
      scheduleTimeline(room.roomId); // the root's summary row lives in the main timeline
      scheduleReceipts(room.roomId); // a new Thread takes over the threaded receipts the room cached for it
    };
    const onThreadUpdate = (thread: Thread): void => {
      scheduleThread(room.roomId, thread.id);
      scheduleTimeline(room.roomId);
      scheduleReceipts(room.roomId);
    };
    const onThreadDelete = (thread: Thread): void => {
      scheduleThread(room.roomId, thread.id);
      scheduleTimeline(room.roomId);
    };
    // Unread counts change outside of /sync too (the SDK zeroes them when my own receipt lands on the last
    // event); the client does not re-emit this one either.
    const onUnread = (): void => {
      scheduleRooms();
      threadsVersion.call();
    };
    room.on(ThreadEvent.New, onThreadNew);
    room.on(ThreadEvent.Update, onThreadUpdate);
    room.on(ThreadEvent.Delete, onThreadDelete);
    room.on(RoomEvent.UnreadNotifications, onUnread);
    roomListeners.set(room.roomId, () => {
      room.off(ThreadEvent.New, onThreadNew);
      room.off(ThreadEvent.Update, onThreadUpdate);
      room.off(ThreadEvent.Delete, onThreadDelete);
      room.off(RoomEvent.UnreadNotifications, onUnread);
    });
  };
  client.getRooms().forEach(attachRoom);

  const onSync = (state: SyncState, prev: SyncState | null): void => {
    if (state === SyncState.Syncing) scheduleRooms(); // every /sync response: unread counts, last activity
    if (state === SyncState.Prepared || (state === SyncState.Syncing && prev !== SyncState.Syncing)) {
      // Initial sync done (or reconnected after a gap): rebuild everything in one go.
      prepared = true;
      rooms.cancel();
      recomputeRooms();
      const all = client.getRooms();
      all.forEach(attachRoom);
      refreshTimelines(all.map((r) => r.roomId));
      for (const room of all) {
        const roots = room.getThreads().map((t) => t.id);
        if (roots.length) refreshThreads(room.roomId, roots);
      }
      threadsVersion.call();
    }
  };
  const onRoom = (room: Room): void => {
    attachRoom(room);
    scheduleRooms();
  };
  const onAccountData = (event: MatrixEvent): void => {
    if (event.getType() === EventType.Direct) scheduleRooms();
    if (event.getType() === RECEIPT_SETTINGS_EVENT_TYPE) bumpReceiptSettingsVersion(); // "Send read receipts" (any device)
  };
  const onReceipt = (_event: MatrixEvent, room: Room): void => {
    scheduleRooms(); // unread counts
    scheduleReceipts(room.roomId); // read avatars / seen-by lists
  };
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    _removed: boolean,
    data: IRoomTimelineData,
  ): void => {
    if (!room) return;
    noteEncryptedRelation(event); // Phase 5: remember encrypted reactions / edits before a redaction strips them
    const set = data.timeline.getTimelineSet();
    // Thread timelines (Phase 3): the Thread re-emits its timeline set's events through the room.
    if (set.thread) {
      scheduleThread(room.roomId, set.thread.id);
      return;
    }
    // Filtered timeline sets (thread list sets, search) are not mirrored; only the main live timeline is.
    if (set !== room.getUnfilteredTimelineSet()) return;
    scheduleTimeline(room.roomId);
    if (!toStartOfTimeline && data.liveEvent) scheduleRooms(); // last activity / unread counts
  };
  const onTimelineReset = (room: Room | undefined, timelineSet?: EventTimelineSet): void => {
    if (!room) return;
    // A Thread resets its live timeline when its initial /relations fetch lands (that is when its events arrive).
    if (timelineSet?.thread) scheduleThread(room.roomId, timelineSet.thread.id);
    else scheduleTimeline(room.roomId);
  };
  const onRedaction = (event: MatrixEvent, room: Room, threadId?: string): void => {
    // `threadId` is the redacted event's thread root (captured before the SDK strips it). A redacted *reply* is
    // moved into the main live timeline by the SDK (`moveAllRelatedToMainTimeline`); record it so the main
    // snapshots keep it out of the channel. The root itself (threadId === redacted id) stays a main-timeline row.
    const redactedId = event.event.redacts ?? event.getContent<{ redacts?: string }>().redacts;
    if (threadId && redactedId && redactedId !== threadId) markRedactedThreadReply(room.roomId, redactedId);
    scheduleTimeline(room.roomId);
    if (threadId) scheduleThread(room.roomId, threadId);
  };
  const onLocalEcho = (event: MatrixEvent, room: Room): void => {
    const thread = event.getThread();
    if (thread) {
      // matrix-js-sdk v43: `Room.addPendingEvent` (chronological ordering) only offers pending events to the
      // room's own timeline sets; the thread's timeline set is not among them, so a reply's local echo never
      // reaches `thread.events` until the remote echo arrives. Add it ourselves once (the remote echo is then
      // merged by `thread.timelineSet.handleRemoteEcho`, no duplicate). `canContain` keeps edits/reactions to
      // the root (main-timeline relations) out.
      const id = event.getId();
      if (id && event.status === EventStatus.SENDING && !thread.has(id) && thread.timelineSet.canContain(event)) {
        thread.addEvent(event, false);
      }
      scheduleThread(room.roomId, thread.id);
    }
    scheduleTimeline(room.roomId);
    scheduleReceipts(room.roomId); // send status flips (ENCRYPTING -> SENDING -> SENT -> null) and the ~txn -> $id swap
  };
  const onTyping = (event: MatrixEvent, member: RoomMember): void => {
    const me = client.getUserId();
    const ids = (event.getContent<{ user_ids?: string[] }>().user_ids ?? []).filter((id) => id !== me);
    setTypingForRoom(member.roomId, ids);
  };
  const onSessionLoggedOut = (): void => {
    opts.onSessionLoggedOut?.(); // token revoked server-side: the session store drops to the login screen
  };
  // Phase 5: the SDK decrypts in place and re-emits each event's `Event.decrypted` on the client (event mapper),
  // for sync, pagination, /relations and /event alike; late keys (backup restore, key shares) fire it again.
  // No timeline entry changes, so nothing else would re-render: refresh the owning timeline (main or thread), the
  // room list (previews, unread recount) and the thread summaries (`latestEvent` may just have decrypted).
  const onDecrypted = (event: MatrixEvent): void => {
    const roomId = event.getRoomId();
    if (!roomId) return;
    noteEncryptedRelation(event);
    const thread = event.getThread();
    if (thread) scheduleThread(roomId, thread.id);
    else scheduleTimeline(roomId);
    scheduleRooms();
    threadsVersion.call();
  };

  client.on(ClientEvent.Sync, onSync);
  client.on(MatrixEventEvent.Decrypted, onDecrypted);
  client.on(ClientEvent.Room, onRoom);
  client.on(ClientEvent.DeleteRoom, scheduleRooms);
  client.on(ClientEvent.AccountData, onAccountData);
  client.on(RoomEvent.Name, scheduleRooms);
  client.on(RoomEvent.MyMembership, scheduleRooms);
  client.on(RoomEvent.Receipt, onReceipt);
  client.on(RoomEvent.Tags, scheduleRooms);
  client.on(RoomStateEvent.Events, scheduleRooms);
  client.on(RoomStateEvent.Members, scheduleRooms);
  client.on(RoomStateEvent.NewMember, scheduleRooms);
  client.on(RoomMemberEvent.Membership, scheduleRooms);
  client.on(RoomMemberEvent.Name, scheduleRooms);
  client.on(RoomMemberEvent.PowerLevel, scheduleRooms);
  client.on(UserEvent.Presence, scheduleRooms);
  client.on(UserEvent.DisplayName, scheduleRooms);
  client.on(UserEvent.AvatarUrl, scheduleRooms);
  client.on(RoomEvent.Timeline, onTimeline);
  client.on(RoomEvent.TimelineReset, onTimelineReset);
  client.on(RoomEvent.Redaction, onRedaction);
  client.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
  client.on(RoomMemberEvent.Typing, onTyping);
  client.on(HttpApiEvent.SessionLoggedOut, onSessionLoggedOut);

  bound = {
    client,
    dispose() {
      rooms.cancel();
      timelines.cancel();
      threadsVersion.cancel();
      receipts.cancel();
      for (const off of roomListeners.values()) off();
      roomListeners.clear();
      client.off(ClientEvent.Sync, onSync);
      client.off(MatrixEventEvent.Decrypted, onDecrypted);
      client.off(ClientEvent.Room, onRoom);
      client.off(ClientEvent.DeleteRoom, scheduleRooms);
      client.off(ClientEvent.AccountData, onAccountData);
      client.off(RoomEvent.Name, scheduleRooms);
      client.off(RoomEvent.MyMembership, scheduleRooms);
      client.off(RoomEvent.Receipt, onReceipt);
      client.off(RoomEvent.Tags, scheduleRooms);
      client.off(RoomStateEvent.Events, scheduleRooms);
      client.off(RoomStateEvent.Members, scheduleRooms);
      client.off(RoomStateEvent.NewMember, scheduleRooms);
      client.off(RoomMemberEvent.Membership, scheduleRooms);
      client.off(RoomMemberEvent.Name, scheduleRooms);
      client.off(RoomMemberEvent.PowerLevel, scheduleRooms);
      client.off(UserEvent.Presence, scheduleRooms);
      client.off(UserEvent.DisplayName, scheduleRooms);
      client.off(UserEvent.AvatarUrl, scheduleRooms);
      client.off(RoomEvent.Timeline, onTimeline);
      client.off(RoomEvent.TimelineReset, onTimelineReset);
      client.off(RoomEvent.Redaction, onRedaction);
      client.off(RoomEvent.LocalEchoUpdated, onLocalEcho);
      client.off(RoomMemberEvent.Typing, onTyping);
      client.off(HttpApiEvent.SessionLoggedOut, onSessionLoggedOut);
    },
  };
}

export function unbindClient(): void {
  bound?.dispose();
  bound = null;
  resetEncryptedRelations();
}
