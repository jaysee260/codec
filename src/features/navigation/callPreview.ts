/**
 * DEV-A-34: "is this room's last message a missed call for me?" for the sidebar rows (`data-preview="missed-call"`).
 *
 * Pure (no SDK / React / `@/` imports; `lines.ts` is pure too) so `node --test` loads it. Contract: docs/PHASE7_ACCEPTANCE.md "Wire shapes":
 * a `dev.matrixpoc.call` event `{ kind: 'missed', call_id, participants: [<rung members who did not answer>] }` is a
 * missed call for every user in `participants`. The ring (`org.matrix.msc4075.rtc.notification`) and the decline
 * (`org.matrix.msc4310.rtc.decline`) are timeline lines too, so a later one of them means the missed call is no longer
 * the room's last message.
 * The parse is the Principal's `getCallLine` + `isMissedForViewer` (src/lib/rtc/lines.ts): never for the caller.
 */
import { CALL_LINE_TYPE, getCallLine, isMissedForViewer, RING_TYPE, type CallLineEventLike } from '../../lib/rtc/lines.ts';

const CALL_LINE_TYPES = new Set([CALL_LINE_TYPE, RING_TYPE, 'org.matrix.msc4310.rtc.decline']);

/** The slice of `MatrixEvent` this module reads (decrypted type / content once decrypted). */
export interface PreviewEventLike extends CallLineEventLike {
  isRedacted(): boolean;
  isState(): boolean;
}

/** True for a `dev.matrixpoc.call` `missed` line that lists `me` (and was not sent by me). */
export function isMissedCallForMe(event: PreviewEventLike, me: string | null | undefined): boolean {
  if (!me || event.isRedacted()) return false;
  const line = getCallLine(event);
  return !!line && isMissedForViewer(line, me);
}

/** Call line events count as rows for the "last message" question even before `isDisplayableEvent` knows them. */
export function isCallLineType(type: string): boolean {
  return CALL_LINE_TYPES.has(type);
}

/**
 * Walk `events` (oldest first, as `room.getLiveTimeline().getEvents()`) from the end to the last row
 * (`isRow(event)` or a call line event, never a state event) and report whether it is a missed call for `me`.
 */
export function lastRowIsMissedCall(
  events: readonly PreviewEventLike[],
  me: string | null | undefined,
  isRow: (event: PreviewEventLike) => boolean,
): boolean {
  if (!me) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.isState()) continue;
    if (isCallLineType(event.getType()) || isRow(event)) return isMissedCallForMe(event, me);
  }
  return false;
}
