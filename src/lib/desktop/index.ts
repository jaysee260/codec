/**
 * Mac app integration. The Electron shell (desktop/) loads the live site and exposes `window.codecDesktop`; in a
 * browser it is absent and nothing here runs. While the shell is mounted this keeps the Dock badge on the unread
 * total, pops a macOS notification for each new message the push rules say notifies (clicking it opens the room),
 * and bounces the Dock icon on an incoming call.
 */
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { displayNameOf } from '@/lib/matrix/utils.ts';
import { whenCallEventReadable } from '@/lib/rtc/ringing.ts';
import { useRoomStore } from '@/store/rooms.ts';
import { useCallStore } from '@/store/call.ts';
import { badgeCount, notificationFor, type CodecDesktopBridge, type DesktopNotification } from './model.ts';

export type { CodecDesktopBridge } from './model.ts';

declare global {
  interface Window {
    codecDesktop?: CodecDesktopBridge;
  }
}

export function desktopBridge(): CodecDesktopBridge | null {
  return typeof window !== 'undefined' && window.codecDesktop ? window.codecDesktop : null;
}

/** Start the integration; returns the disposer. A no-op outside the Mac app. */
export function startDesktopIntegration(): () => void {
  const bridge = desktopBridge();
  const client = getClientOrNull();
  if (!bridge || !client) return () => undefined;

  let lastBadge = -1;
  const syncBadge = (): void => {
    const { roomsById, invites } = useRoomStore.getState();
    const count = badgeCount(Object.values(roomsById), invites.length);
    if (count === lastBadge) return;
    lastBadge = count;
    bridge.setBadge(count);
  };
  syncBadge();
  const unsubRooms = useRoomStore.subscribe(syncBadge);

  const show = (n: DesktopNotification, roomId: string): void => {
    if (typeof Notification === 'undefined') return;
    const note = new Notification(n.title, { body: n.body, tag: roomId, silent: false });
    note.onclick = () => {
      bridge.focus();
      useRoomStore.getState().selectRoom(roomId);
    };
  };

  const pending = new Set<() => void>();
  const onTimeline = (event: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: { liveEvent?: boolean }): void => {
    if (!room || toStart || !data?.liveEvent) return;
    let done = false;
    let dispose: () => void = () => undefined;
    dispose = whenCallEventReadable(event, (readable) => {
      done = true;
      pending.delete(dispose);
      const myUserId = client.getUserId() ?? '';
      const summary = useRoomStore.getState().roomsById[room.roomId];
      const n = notificationFor({
        type: readable.getType(),
        content: readable.getContent(),
        sender: readable.getSender() ?? '',
        senderName: displayNameOf(room, readable.getSender() ?? ''),
        roomName: summary?.name ?? room.name,
        isDm: summary?.isDm ?? false,
        originServerTs: readable.getTs(),
        myUserId,
        pushNotify: !!client.getPushActionsForEvent(readable, true)?.notify,
        viewing: document.hasFocus() && useRoomStore.getState().selectedRoomId === room.roomId,
        now: Date.now(),
      });
      if (n) show(n, room.roomId);
    });
    if (!done) pending.add(dispose);
  };
  client.on(RoomEvent.Timeline, onTimeline);

  let ringing = new Set(useCallStore.getState().incoming.map((c) => c.roomId));
  const unsubCalls = useCallStore.subscribe((state) => {
    const now = new Set(state.incoming.map((c) => c.roomId));
    for (const call of state.incoming) {
      if (ringing.has(call.roomId)) continue;
      bridge.attention();
      const room = client.getRoom(call.roomId);
      show({ title: 'Incoming call', body: `${displayNameOf(room, call.from)} is calling` }, call.roomId);
    }
    ringing = now;
  });

  return () => {
    unsubRooms();
    unsubCalls();
    client.off(RoomEvent.Timeline, onTimeline);
    for (const dispose of pending) dispose();
    pending.clear();
    bridge.setBadge(0);
  };
}
