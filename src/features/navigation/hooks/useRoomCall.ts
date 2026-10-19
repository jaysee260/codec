/**
 * Phase 7 (DEV-A-33 / DEV-A-34 / DEV-A-35) selectors for the header chip and the sidebar rows.
 *
 * - `useLiveCallCount(roomId)`: users in a live call in the room (from `useRoomCallSummary`, which mirrors
 *   `useCallStore.liveSessions`), 0 when none. Drives `room-call-indicator[data-count]`.
 * - `useMissedCallPreview(roomId)`: the room's last main-timeline row is a `dev.matrixpoc.call` `missed` line naming
 *   me (docs/PHASE7_ACCEPTANCE.md "Wire shapes"). Re-read on every room-store snapshot (`version`), which the bridge
 *   bumps for live events and decryptions, so an encrypted missed line flips the row once it decrypts.
 * - `callNames(roomId, userIds)`: display names for the chip tooltip (AC-R8-4).
 */
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { displayNameOf, isMainTimelineEvent } from '@/lib/matrix/utils.ts';
import { useRoomCallSummary } from '@/store/call.ts';
import { useRoomStore } from '@/store/rooms.ts';
import { useSessionStore } from '@/store/session.ts';
import type { MatrixEvent } from 'matrix-js-sdk';
import { lastRowIsMissedCall, type PreviewEventLike } from '../callPreview.ts';

export function useLiveCallCount(roomId: string | null | undefined): number {
  const summary = useRoomCallSummary(roomId);
  return summary.live ? summary.userIds.length : 0;
}

export function useMissedCallPreview(roomId: string | null | undefined): boolean {
  const me = useSessionStore((s) => s.userId);
  return useRoomStore((s) => {
    void s.version; // re-evaluate on every snapshot (new events, decryptions)
    if (!roomId || !me) return false;
    const room = getClientOrNull()?.getRoom(roomId);
    if (!room) return false;
    const events = room.getLiveTimeline().getEvents();
    return lastRowIsMissedCall(events, me, (e: PreviewEventLike) => isMainTimelineEvent(e as MatrixEvent));
  });
}

export function callNames(roomId: string, userIds: readonly string[]): string[] {
  const room = getClientOrNull()?.getRoom(roomId);
  return userIds.map((id) => displayNameOf(room, id));
}
