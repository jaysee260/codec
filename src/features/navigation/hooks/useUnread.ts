/**
 * DEV-A-5: unread selectors over `useRoomStore.unreadByRoom` (server-computed
 * `unread_notifications.notification_count`; it clears one /sync after the read receipt lands).
 *
 * Every selector returns a primitive so zustand's default equality check keeps re-renders to the
 * bursts that actually change a badge.
 */
import { useRoomStore } from '@/store/rooms.ts';

/** Unread notification count for one room (0 when read or unknown). */
export function useUnread(roomId: string | null | undefined): number {
  return useRoomStore((s) => (roomId ? (s.unreadByRoom[roomId] ?? 0) : 0));
}

/** Highlight (mention) count for one room. */
export function useHighlight(roomId: string | null | undefined): number {
  return useRoomStore((s) => (roomId ? (s.highlightByRoom[roomId] ?? 0) : 0));
}

/** Total unread across a space's joined child channels (drives the rail badge). */
export function useSpaceUnread(spaceId: string): number {
  return useRoomStore((s) => {
    let total = 0;
    for (const channel of s.channelsBySpace[spaceId] ?? []) total += s.unreadByRoom[channel.roomId] ?? 0;
    return total;
  });
}

/** Total unread across DMs plus pending invites (drives the Home rail badge). */
export function useHomeUnread(): number {
  return useRoomStore((s) => {
    let total = 0;
    for (const dm of s.dms) total += s.unreadByRoom[dm.roomId] ?? 0;
    for (const room of s.orphanRooms) total += s.unreadByRoom[room.roomId] ?? 0;
    total += s.invites.length;
    return total;
  });
}

/**
 * DEV-A-16: does any room *other than* the one on screen have unread messages? Drives
 * `header-menu-unread` on the phone header, where the sidebar badges are behind a closed drawer.
 * Returns a boolean (not a count) so the header re-renders only when the dot appears or disappears.
 */
export function useOtherRoomsUnread(): boolean {
  return useRoomStore((s) => {
    for (const [roomId, count] of Object.entries(s.unreadByRoom)) {
      if (count > 0 && roomId !== s.selectedRoomId) return true;
    }
    return false;
  });
}

/** Badge text: the raw count up to 99, then "99+" like Discord. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
