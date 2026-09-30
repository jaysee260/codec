/**
 * SDK -> store bridge. Subscribes to MatrixClient events once per session and forwards them to the
 * stores with small debounces so a burst of sync events causes one React commit, not hundreds.
 *
 * Room list snapshot (rooms.ts):   any Room.* / RoomState.* / RoomMember.* / User.* / accountData
 * Timeline snapshot (timeline.ts): Room.timeline (live timeline set only), Room.timelineReset,
 *                                  Room.redaction, Room.localEchoUpdated
 * Typing (timeline.ts):            RoomMember.typing (reads the m.typing event's user_ids directly,
 *                                  so users whose member event is not loaded yet still count)
 */
import {
  ClientEvent,
  EventType,
  HttpApiEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  UserEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import type { IRoomTimelineData } from 'matrix-js-sdk/lib/models/event-timeline-set.js';
import { recomputeRooms } from './rooms.ts';
import { refreshTimeline, refreshTimelines, setTypingForRoom } from './timeline.ts';

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
  const timelines = debounce(() => {
    const ids = [...pendingTimelines];
    pendingTimelines.clear();
    if (ids.length === 1) refreshTimeline(ids[0]!);
    else if (ids.length > 1) refreshTimelines(ids);
  }, TIMELINE_DEBOUNCE_MS);
  const scheduleTimeline = (roomId: string): void => {
    pendingTimelines.add(roomId);
    timelines.call();
  };
  const scheduleRooms = (): void => rooms.call();

  const onSync = (state: SyncState, prev: SyncState | null): void => {
    if (state === SyncState.Syncing) scheduleRooms(); // every /sync response: unread counts, last activity
    if (state === SyncState.Prepared || (state === SyncState.Syncing && prev !== SyncState.Syncing)) {
      // Initial sync done (or reconnected after a gap): rebuild everything in one go.
      rooms.cancel();
      recomputeRooms();
      refreshTimelines(client.getRooms().map((r) => r.roomId));
    }
  };
  const onAccountData = (event: MatrixEvent): void => {
    if (event.getType() === EventType.Direct) scheduleRooms();
  };
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    _removed: boolean,
    data: IRoomTimelineData,
  ): void => {
    if (!room) return;
    // Ignore thread timelines and filtered timeline sets; we only mirror the main live timeline.
    if (data.timeline.getTimelineSet() !== room.getUnfilteredTimelineSet()) return;
    scheduleTimeline(room.roomId);
    if (!toStartOfTimeline && data.liveEvent) scheduleRooms(); // last activity / unread counts
    void event;
  };
  const onTimelineReset = (room: Room | undefined): void => {
    if (room) scheduleTimeline(room.roomId);
  };
  const onRedaction = (_event: MatrixEvent, room: Room): void => scheduleTimeline(room.roomId);
  const onLocalEcho = (_event: MatrixEvent, room: Room): void => scheduleTimeline(room.roomId);
  const onTyping = (event: MatrixEvent, member: RoomMember): void => {
    const me = client.getUserId();
    const ids = (event.getContent<{ user_ids?: string[] }>().user_ids ?? []).filter((id) => id !== me);
    setTypingForRoom(member.roomId, ids);
  };
  const onSessionLoggedOut = (): void => {
    opts.onSessionLoggedOut?.(); // token revoked server-side: the session store drops to the login screen
  };

  client.on(ClientEvent.Sync, onSync);
  client.on(ClientEvent.Room, scheduleRooms);
  client.on(ClientEvent.DeleteRoom, scheduleRooms);
  client.on(ClientEvent.AccountData, onAccountData);
  client.on(RoomEvent.Name, scheduleRooms);
  client.on(RoomEvent.MyMembership, scheduleRooms);
  client.on(RoomEvent.Receipt, scheduleRooms);
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
      client.off(ClientEvent.Sync, onSync);
      client.off(ClientEvent.Room, scheduleRooms);
      client.off(ClientEvent.DeleteRoom, scheduleRooms);
      client.off(ClientEvent.AccountData, onAccountData);
      client.off(RoomEvent.Name, scheduleRooms);
      client.off(RoomEvent.MyMembership, scheduleRooms);
      client.off(RoomEvent.Receipt, scheduleRooms);
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
}
