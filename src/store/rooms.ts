/**
 * Room store: React-friendly snapshot of the SDK's room list, grouped the Discord way
 * (spaces -> channels, DMs from m.direct), plus navigation selection.
 *
 * `recomputeRooms()` is called by the bridge (debounced) on any Room.* / RoomState.* / receipt /
 * account-data event; `version` bumps on every recompute so components can subscribe to it.
 */
import { create } from 'zustand';
import { EventType, KnownMembership, NotificationCountType, type Room } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { NAV_STORAGE_KEY } from '@/lib/matrix/config.ts';
import { getDirectMap } from '@/lib/matrix/actions.ts';
import { roomAvatarUrl, roomTopic } from '@/lib/matrix/utils.ts';

export interface RoomSummary {
  roomId: string;
  /** Room name, or the other user's display name for DMs. Channels are bare words ("general"). */
  name: string;
  topic?: string;
  /** http avatar (96px crop) or undefined. DMs fall back to the other member's avatar. */
  avatarUrl?: string;
  canonicalAlias?: string;
  isSpace: boolean;
  /** Space this channel belongs to (via m.space.child on the space, else m.space.parent on the room). */
  parentSpaceId?: string;
  /** `order` from the space's m.space.child event, used for channel sorting. */
  order?: string;
  isDm: boolean;
  /** The other participant of a DM (from m.direct). */
  dmUserId?: string;
  joinRule: string;
  membership: string;
  lastActiveTs: number;
  memberCount: number;
  /** Unread notification count of the **main timeline** (`unread_notifications.notification_count`; thread replies excluded since Phase 3). */
  unread: number;
  highlight: number;
  /** Phase 3: some thread in the room has unread notifications (`unread_thread_notifications`, cleared by threaded receipts). */
  threadUnread: boolean;
  /** Phase 5: the room has `m.room.encryption` (lock icon; sends are encrypted). Recomputed when the state event arrives. */
  encrypted: boolean;
}

export type SpaceSelection = string | 'home';

export interface RoomStoreState {
  /** True after the first recompute following the initial sync. */
  ready: boolean;
  /** Joined spaces sorted by name. */
  spaces: RoomSummary[];
  /** Joined channels per space, sorted by m.space.child `order` then name. */
  channelsBySpace: Record<string, RoomSummary[]>;
  /** DM rooms (from m.direct), newest activity first. */
  dms: RoomSummary[];
  /** Joined non-space rooms that belong to no space and are not DMs. */
  orphanRooms: RoomSummary[];
  /** Rooms I am invited to (not yet joined). */
  invites: RoomSummary[];
  roomsById: Record<string, RoomSummary>;
  unreadByRoom: Record<string, number>;
  highlightByRoom: Record<string, number>;
  /** Phase 3: `room.hasThreadUnreadNotification()` per room, for the header "Threads" dot. */
  threadUnreadByRoom: Record<string, boolean>;
  selectedSpaceId: SpaceSelection;
  selectedRoomId: string | null;
  /** Last selected room per space ('home' for DMs), restored when switching back. */
  lastRoomBySpace: Record<string, string>;
  /**
   * Room / space selected via selectRoom()/selectSpace() before /sync delivered it (just created).
   * Kept as the selection instead of being replaced by a fallback, and honoured when it arrives.
   */
  pendingRoomId: string | null;
  pendingSpaceId: string | null;
  version: number;
  /** Select a space (or 'home' for DMs). Auto-selects the last/first channel of that space. */
  selectSpace(spaceId: SpaceSelection): void;
  /** Select a room; switches the space rail to the room's space (or 'home' for DMs/orphans). */
  selectRoom(roomId: string | null): void;
}

interface PersistedSelection {
  spaceId: SpaceSelection;
  roomId: string | null;
  lastRoomBySpace: Record<string, string>;
}

function loadSelection(): PersistedSelection | null {
  try {
    const raw = localStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSelection>;
    return {
      spaceId: parsed.spaceId ?? 'home',
      roomId: parsed.roomId ?? null,
      lastRoomBySpace: parsed.lastRoomBySpace ?? {},
    };
  } catch {
    return null;
  }
}

function persistSelection(sel: PersistedSelection): void {
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(sel));
  } catch {
    /* ignore quota / private mode */
  }
}

type RoomSelectedListener = (roomId: string) => void;
const roomSelectedListeners = new Set<RoomSelectedListener>();

/**
 * Fires on every explicit `selectRoom(roomId)` call (a user picking a channel/DM), and NOT when the
 * selection changes as a side effect of `selectSpace()` or of a sync-driven recompute. The layout
 * store uses it to close the phone nav drawer (AC-M2-2 closes, AC-M2-4 space switch stays open).
 */
export function onRoomSelected(listener: RoomSelectedListener): () => void {
  roomSelectedListeners.add(listener);
  return () => {
    roomSelectedListeners.delete(listener);
  };
}

const byName = (a: RoomSummary, b: RoomSummary): number => a.name.localeCompare(b.name);
const byOrderThenName = (a: RoomSummary, b: RoomSummary): number => {
  const ao = a.order ?? '￿';
  const bo = b.order ?? '￿';
  return ao < bo ? -1 : ao > bo ? 1 : byName(a, b);
};

function spaceOf(summary: RoomSummary | undefined, fallback: SpaceSelection): SpaceSelection {
  if (!summary) return fallback;
  if (summary.isSpace) return summary.roomId;
  if (summary.isDm) return 'home';
  // A non-DM room without a known parent is either a genuinely space-less room (selected from Home, so
  // `fallback` is already 'home') or a just-created channel that /sync delivered in two batches
  // (membership first, name + m.space.parent next). Either way: stay where we are; recomputeRooms()
  // re-homes the sidebar as soon as the parent is known.
  return summary.parentSpaceId ?? fallback;
}

function loadMembersInBackground(roomId: string | null): void {
  if (!roomId) return;
  void getClientOrNull()?.getRoom(roomId)?.loadMembersIfNeeded();
}

const emptyState = {
  ready: false,
  spaces: [] as RoomSummary[],
  channelsBySpace: {} as Record<string, RoomSummary[]>,
  dms: [] as RoomSummary[],
  orphanRooms: [] as RoomSummary[],
  invites: [] as RoomSummary[],
  roomsById: {} as Record<string, RoomSummary>,
  unreadByRoom: {} as Record<string, number>,
  highlightByRoom: {} as Record<string, number>,
  threadUnreadByRoom: {} as Record<string, boolean>,
  selectedSpaceId: 'home' as SpaceSelection,
  selectedRoomId: null as string | null,
  lastRoomBySpace: {} as Record<string, string>,
  pendingRoomId: null as string | null,
  pendingSpaceId: null as string | null,
};

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  ...emptyState,
  version: 0,

  selectSpace(spaceId) {
    const st = get();
    const remembered = st.lastRoomBySpace[spaceId];
    const candidates = spaceId === 'home' ? st.dms : (st.channelsBySpace[spaceId] ?? []);
    const roomId =
      remembered && candidates.some((r) => r.roomId === remembered) ? remembered : (candidates[0]?.roomId ?? null);
    const lastRoomBySpace = roomId ? { ...st.lastRoomBySpace, [spaceId]: roomId } : st.lastRoomBySpace;
    // A space that /sync has not delivered yet (just created) stays pending until it arrives.
    const known = spaceId === 'home' || !!st.roomsById[spaceId];
    set({ selectedSpaceId: spaceId, selectedRoomId: roomId, lastRoomBySpace, pendingSpaceId: known ? null : spaceId, pendingRoomId: null });
    persistSelection({ spaceId, roomId, lastRoomBySpace });
    loadMembersInBackground(roomId);
  },

  selectRoom(roomId) {
    const st = get();
    if (!roomId) {
      set({ selectedRoomId: null, pendingRoomId: null });
      persistSelection({ spaceId: st.selectedSpaceId, roomId: null, lastRoomBySpace: st.lastRoomBySpace });
      return;
    }
    const summary = st.roomsById[roomId];
    const spaceId = spaceOf(summary, st.selectedSpaceId);
    const lastRoomBySpace = { ...st.lastRoomBySpace, [spaceId]: roomId };
    // Unknown room (just created, /sync has not delivered it yet): keep it as the pending selection so
    // the next recompute neither falls back to the first channel nor loses it; it is honoured on arrival.
    set({ selectedSpaceId: spaceId, selectedRoomId: roomId, lastRoomBySpace, pendingRoomId: summary ? null : roomId });
    persistSelection({ spaceId, roomId, lastRoomBySpace });
    loadMembersInBackground(roomId);
    for (const listener of roomSelectedListeners) listener(roomId);
  },
}));

function summarize(room: Room, dmUserId: string | undefined, parentSpaceId: string | undefined, order: string | undefined): RoomSummary {
  const alias = room.getCanonicalAlias() ?? undefined;
  return {
    roomId: room.roomId,
    name: room.name || alias?.replace(/^#/, '').replace(/:.*$/, '') || room.roomId,
    topic: roomTopic(room),
    avatarUrl: roomAvatarUrl(room, 96) || undefined,
    canonicalAlias: alias,
    isSpace: room.isSpaceRoom(),
    parentSpaceId,
    order,
    isDm: !!dmUserId,
    dmUserId,
    joinRule: room.getJoinRule(),
    membership: room.getMyMembership(),
    lastActiveTs: room.getLastActiveTimestamp(),
    memberCount: room.getJoinedMemberCount(),
    // Phase 3: main timeline only. `getUnreadNotificationCount()` would add every thread's count, and a
    // main-timeline receipt (thread_id 'main') never clears those, so the channel badge could get stuck.
    unread: room.getRoomUnreadNotificationCount(NotificationCountType.Total),
    highlight: room.getRoomUnreadNotificationCount(NotificationCountType.Highlight),
    threadUnread: room.hasThreadUnreadNotification(),
    encrypted: room.hasEncryptionStateEvent(),
  };
}

/** Rebuild the whole snapshot from the SDK. Called by the bridge (debounced). */
export function recomputeRooms(): void {
  const client = getClientOrNull();
  if (!client) return;

  const dmUserByRoom = new Map<string, string>();
  for (const [userId, roomIds] of Object.entries(getDirectMap())) {
    for (const roomId of roomIds ?? []) if (!dmUserByRoom.has(roomId)) dmUserByRoom.set(roomId, userId);
  }

  const rooms = client.getRooms();

  // Space -> children as declared by the spaces I am in.
  const childInfo = new Map<string, { spaceId: string; order?: string }>();
  for (const space of rooms) {
    if (!space.isSpaceRoom() || space.getMyMembership() !== KnownMembership.Join) continue;
    for (const ev of space.currentState.getStateEvents(EventType.SpaceChild)) {
      const content = ev.getContent<{ via?: string[]; order?: string }>();
      const childId = ev.getStateKey();
      if (!childId || !Array.isArray(content.via) || content.via.length === 0) continue;
      if (!childInfo.has(childId)) {
        childInfo.set(childId, { spaceId: space.roomId, order: typeof content.order === 'string' ? content.order : undefined });
      }
    }
  }

  const spaces: RoomSummary[] = [];
  const channelsBySpace: Record<string, RoomSummary[]> = {};
  const dms: RoomSummary[] = [];
  const orphanRooms: RoomSummary[] = [];
  const invites: RoomSummary[] = [];
  const roomsById: Record<string, RoomSummary> = {};
  const unreadByRoom: Record<string, number> = {};
  const highlightByRoom: Record<string, number> = {};
  const threadUnreadByRoom: Record<string, boolean> = {};

  for (const room of rooms) {
    const membership = room.getMyMembership();
    if (membership !== KnownMembership.Join && membership !== KnownMembership.Invite) continue;

    const dmUserId =
      dmUserByRoom.get(room.roomId) ?? (membership === KnownMembership.Invite ? room.getDMInviter() : undefined);
    const info = childInfo.get(room.roomId);
    let parentSpaceId = info?.spaceId;
    if (!parentSpaceId) {
      for (const ev of room.currentState.getStateEvents(EventType.SpaceParent)) {
        const content = ev.getContent<{ via?: string[] }>();
        const spaceId = ev.getStateKey();
        if (spaceId && Array.isArray(content.via) && content.via.length > 0 && client.getRoom(spaceId)?.isSpaceRoom()) {
          parentSpaceId = spaceId;
          break;
        }
      }
    }

    const summary = summarize(room, dmUserId, parentSpaceId, info?.order);
    roomsById[room.roomId] = summary;
    unreadByRoom[room.roomId] = summary.unread;
    highlightByRoom[room.roomId] = summary.highlight;
    threadUnreadByRoom[room.roomId] = summary.threadUnread;

    if (membership === KnownMembership.Invite) {
      invites.push(summary);
    } else if (summary.isSpace) {
      spaces.push(summary);
    } else if (summary.isDm) {
      dms.push(summary);
    } else if (parentSpaceId) {
      (channelsBySpace[parentSpaceId] ??= []).push(summary);
    } else {
      orphanRooms.push(summary);
    }
  }

  spaces.sort(byName);
  for (const list of Object.values(channelsBySpace)) list.sort(byOrderThenName);
  dms.sort((a, b) => b.lastActiveTs - a.lastActiveTs);
  orphanRooms.sort(byName);

  const prev = useRoomStore.getState();
  let { selectedSpaceId, selectedRoomId, lastRoomBySpace, pendingRoomId, pendingSpaceId } = prev;
  const firstReady = !prev.ready;
  const isJoined = (id: string | null | undefined): boolean =>
    !!id && roomsById[id]?.membership === KnownMembership.Join;

  if (firstReady) {
    const saved = loadSelection();
    if (saved) {
      lastRoomBySpace = saved.lastRoomBySpace;
      selectedSpaceId = saved.spaceId;
      selectedRoomId = saved.roomId;
    }
  }

  // Selections made before /sync delivered the room/space (createChannel/createSpace/createDm flows):
  // honour them now that they exist.
  if (pendingSpaceId && spaces.some((s) => s.roomId === pendingSpaceId)) {
    selectedSpaceId = pendingSpaceId;
    if (!isJoined(selectedRoomId) || roomsById[selectedRoomId!]!.parentSpaceId !== pendingSpaceId) selectedRoomId = null;
    pendingSpaceId = null;
  }
  if (pendingRoomId && isJoined(pendingRoomId)) {
    selectedRoomId = pendingRoomId;
    pendingRoomId = null;
  }

  // Invariant: the sidebar shows the space that contains the selected room. Re-evaluated on every
  // recompute because Synapse can deliver a just-created room in two /sync batches (membership first,
  // then m.room.name / m.space.parent), so its space may only become known after it was selected.
  const selected = selectedRoomId ? roomsById[selectedRoomId] : undefined;
  if (selected && isJoined(selectedRoomId)) {
    if (selected.isDm) selectedSpaceId = 'home';
    else if (selected.parentSpaceId && spaces.some((s) => s.roomId === selected.parentSpaceId)) {
      selectedSpaceId = selected.parentSpaceId;
    }
  }

  // Validate the selection against what exists now (a still-pending id is left alone).
  const spaceExists = selectedSpaceId === 'home' || spaces.some((s) => s.roomId === selectedSpaceId);
  if (!spaceExists && selectedSpaceId !== pendingSpaceId) selectedSpaceId = spaces[0]?.roomId ?? 'home';
  if (selectedRoomId && !isJoined(selectedRoomId) && selectedRoomId !== pendingRoomId) {
    selectedRoomId = null;
  }
  if (firstReady && selectedSpaceId === 'home' && !selectedRoomId && spaces.length > 0 && !loadSelection()) {
    // First ever load: land on the first space like Discord does.
    selectedSpaceId = spaces[0]!.roomId;
  }
  if (!selectedRoomId && selectedSpaceId !== pendingSpaceId) {
    const candidates = selectedSpaceId === 'home' ? dms : (channelsBySpace[selectedSpaceId] ?? []);
    const remembered = lastRoomBySpace[selectedSpaceId];
    selectedRoomId =
      remembered && candidates.some((r) => r.roomId === remembered) ? remembered : (candidates[0]?.roomId ?? null);
  }
  if (selectedRoomId) lastRoomBySpace = { ...lastRoomBySpace, [selectedSpaceId]: selectedRoomId };

  const selectionChanged = selectedSpaceId !== prev.selectedSpaceId || selectedRoomId !== prev.selectedRoomId;
  if (selectionChanged || firstReady) {
    persistSelection({ spaceId: selectedSpaceId, roomId: selectedRoomId, lastRoomBySpace });
    loadMembersInBackground(selectedRoomId);
  }

  useRoomStore.setState({
    ready: true,
    spaces,
    channelsBySpace,
    dms,
    orphanRooms,
    invites,
    roomsById,
    unreadByRoom,
    highlightByRoom,
    threadUnreadByRoom,
    selectedSpaceId,
    selectedRoomId,
    lastRoomBySpace,
    pendingRoomId,
    pendingSpaceId,
    version: prev.version + 1,
  });
}

/** Clear everything (logout). Keeps `version` monotonic. */
export function resetRooms(): void {
  useRoomStore.setState((s) => ({ ...emptyState, version: s.version + 1 }));
}

/**
 * Resolve once a room id shows up in the store (after createRoom/createDm the room only appears
 * when the next /sync delivers it). Resolves with false on timeout.
 */
export function waitForRoom(roomId: string, timeoutMs = 8000): Promise<boolean> {
  if (useRoomStore.getState().roomsById[roomId]) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useRoomStore.subscribe((s) => {
      if (s.roomsById[roomId]) {
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      }
    });
  });
}
