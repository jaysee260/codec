/**
 * Phase 7 (DEV-B-38): which timeline events are call events. Pure and Node-loadable (no `@/lib/rtc` import: its
 * barrel pulls in the LiveKit worker), so the timeline grouping can use it; the names match `@/lib/rtc`'s
 * `CALL_NOTIFICATION_TYPE` / `CALL_DECLINE_TYPE` / `CALL_MEMBER_TYPE` / `CALL_SLOT_TYPE` / `CALL_LINE_TYPE`.
 */
export const CALL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'org.matrix.msc4075.rtc.notification',
  'org.matrix.msc4310.rtc.decline',
  'org.matrix.msc3401.call.member',
  'org.matrix.msc4143.rtc.slot',
  'dev.matrixpoc.call',
]);

/**
 * True for every call event type: such an event is a call line or nothing, never a message row. A redacted call
 * event is left to `MessageRow` ("Message deleted", AC-R7-4).
 */
export function isCallLineEvent(event: { getType(): string; isRedacted(): boolean }): boolean {
  return CALL_EVENT_TYPES.has(event.getType()) && !event.isRedacted();
}
