/**
 * Phase 7: room permissions for calls. MatrixRTC memberships are *state* events; a room created with
 * the public-chat preset needs power level 50 for state, so ordinary members could never join a call there. Codec's
 * `createChannel` / `createDm` grant these event types to everyone (`CALL_POWER_LEVELS`), and `ensureCallPowerLevels`
 * patches older rooms lazily when the caller is an admin (seeded rooms, rooms from before Phase 7).
 */
import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { CALL_DECLINE_TYPE, CALL_MEMBER_TYPE, CALL_NOTIFICATION_TYPE } from './timeline.ts';

/** `power_levels.events` entries that let every member start / join / decline calls. */
export const CALL_POWER_LEVELS: Record<string, number> = {
  [CALL_MEMBER_TYPE]: 0,
  [CALL_NOTIFICATION_TYPE]: 0,
  [CALL_DECLINE_TYPE]: 0,
  // js-sdk's to-device key transport needs nothing in the room; the room-event fallback would send this type.
  'io.element.call.encryption_keys': 0,
};

/** Can `userId` send the membership state event (join a call) and the ring notification in this room right now? */
export function canSendCallState(room: Pick<Room, 'currentState'>, userId: string): boolean {
  return room.currentState.maySendStateEvent(CALL_MEMBER_TYPE, userId) && room.currentState.maySendEvent(CALL_NOTIFICATION_TYPE, userId);
}

/** Which of `CALL_POWER_LEVELS` the room's power levels lack (pure over the content; unit-testable). */
export function missingCallPowerLevels(powerLevels: { events?: Record<string, number>; state_default?: number; events_default?: number } | undefined): string[] {
  const events = powerLevels?.events ?? {};
  const stateDefault = powerLevels?.state_default ?? 50;
  const eventsDefault = powerLevels?.events_default ?? 0;
  const missing: string[] = [];
  for (const [type, wanted] of Object.entries(CALL_POWER_LEVELS)) {
    const current = events[type] ?? (type === CALL_MEMBER_TYPE ? stateDefault : eventsDefault);
    if (current > wanted) missing.push(type);
  }
  return missing;
}

/**
 * Grant the call event types to everyone when this user may edit power levels and something is missing.
 * Returns true when the room now allows calls for this user (patched or already fine), false when it cannot be fixed.
 */
export async function ensureCallPowerLevels(client: MatrixClient, room: Room): Promise<boolean> {
  const userId = client.getUserId();
  if (!userId) return false;
  if (canSendCallState(room, userId)) return true;
  const plEvent = room.currentState.getStateEvents(EventType.RoomPowerLevels, '');
  const content = (plEvent?.getContent() ?? {}) as { events?: Record<string, number>; state_default?: number; events_default?: number };
  const missing = missingCallPowerLevels(content);
  if (missing.length === 0) return canSendCallState(room, userId);
  if (!room.currentState.maySendStateEvent(EventType.RoomPowerLevels, userId)) return false;
  const next = { ...content, events: { ...(content.events ?? {}) } };
  for (const type of missing) next.events[type] = CALL_POWER_LEVELS[type]!;
  await client.sendStateEvent(room.roomId, EventType.RoomPowerLevels, next, '');
  return true;
}
