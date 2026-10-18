/**
 * Phase 7: what the chat timeline shows for call events (pure, unit-tested; Dev B renders the rows).
 *
 * MatrixRTC leaves these events in the room:
 *   - `org.matrix.msc4075.rtc.notification`  the caller rang (DM ring / room ring)           -> "X started a voice call"
 *   - `org.matrix.msc4310.rtc.decline`       a callee declined (m.reference to the above)    -> "X declined"
 *   - `org.matrix.msc3401.call.member`       state: a device joined / left (hidden from the timeline, too chatty)
 *   - `org.matrix.msc4143.rtc.slot`          state: unused by Codec (Element-only semantics), hidden if ever seen
 *   - `dev.matrixpoc.call`                   Codec's own line: `ended` (with duration) / `missed` (who was rung)   -> "Call ended, 12 min" / "Missed call from X"
 * Wave 2 (orchestrator ruling): every device renders the same rows from these events; the local history
 * (`useCallStore().history`) is a cache only. A drop-in call that rang nobody gets its "started" row from the
 * membership state event that opened the session (`isCallOpeningMembership`, lines.ts).
 */
import { EventType } from 'matrix-js-sdk';
import { CALL_LINE_TYPE, callLinePreviewText, formatCallLine, getCallLine, isMissedForViewer, isOpeningMembershipInRoom, type MembershipEventLike } from './lines.ts';

export const CALL_NOTIFICATION_TYPE: string = EventType.RTCNotification; // org.matrix.msc4075.rtc.notification
export const CALL_DECLINE_TYPE: string = EventType.RTCDecline; // org.matrix.msc4310.rtc.decline
export const CALL_MEMBER_TYPE: string = EventType.GroupCallMemberPrefix; // org.matrix.msc3401.call.member
export const CALL_SLOT_TYPE: string = EventType.RTCSlot; // org.matrix.msc4143.rtc.slot
/** Codec-only extra on a decline: why ("busy" = the callee was in another call). */
export const DECLINE_REASON_KEY = 'io.codec.decline_reason';

export type CallEventKind = 'started' | 'declined' | 'busy' | 'ended' | 'missed';

export interface CallEventRow {
  kind: CallEventKind;
  /** Sender of the event. */
  userId: string;
  /** Ready-made text, with display names substituted. */
  text: string;
  /** The `rtc.notification` event id (the notification itself, or the one a decline references). */
  notifyEventId: string | null;
  /** The call this row belongs to: the ring event id, or the opening membership event id (`dev.matrixpoc.call`'s `call_id`). */
  callId: string | null;
  /** `ended` only. */
  durationMs?: number;
  /** `missed` only: who was rung and did not answer. */
  participants?: string[];
  /** `missed` addressed to `myUserId` (Dev B: `data-missed`, red tint, Call back). */
  missedByMe: boolean;
  /** Room-list preview text for this row ("Missed call", "Call ended", ...). */
  previewText: string;
}

/** Minimal event shape (a MatrixEvent satisfies it; tests pass plain objects). */
export interface EventLike {
  getType(): string;
  getSender(): string | undefined;
  getId(): string | undefined;
  getContent(): Record<string, unknown>;
  isState?(): boolean;
}

/**
 * True for the call events that are rows: notification, decline, `dev.matrixpoc.call`, and the membership state
 * event that opened a session nobody was rung for (needs the timeline resolver installed by the store; other
 * membership / slot state is not a row).
 */
export function isCallTimelineEvent(event: EventLike): boolean {
  const t = event.getType();
  if (t === CALL_NOTIFICATION_TYPE || t === CALL_DECLINE_TYPE || t === CALL_LINE_TYPE) return true;
  if (t === CALL_MEMBER_TYPE) return isOpeningMembershipInRoom(event as unknown as MembershipEventLike);
  return false;
}

/** True for every MatrixRTC / Codec call event type (to hide the state ones from "unknown event" fallbacks). */
export function isCallEvent(event: EventLike): boolean {
  const t = event.getType();
  return t === CALL_NOTIFICATION_TYPE || t === CALL_DECLINE_TYPE || t === CALL_MEMBER_TYPE || t === CALL_SLOT_TYPE || t === CALL_LINE_TYPE;
}

/**
 * Describe a call timeline event for a grey system row. `displayName` is the sender's name as the UI shows it;
 * `myUserId` turns "X started a voice call" into "You started a voice call"; `nameOf(userId)` names the other users of a
 * `missed` row ("No answer from bob and carol"), defaulting to the user id. Null for non-call events, hidden state
 * and malformed `dev.matrixpoc.call` content (AC-R7-4: render nothing).
 */
export function describeCallEvent(event: EventLike, opts: { displayName: string; myUserId?: string; nameOf?: (userId: string) => string }): CallEventRow | null {
  const sender = event.getSender();
  if (!sender) return null;
  const who = sender === opts.myUserId ? 'You' : opts.displayName;
  const nameOf = (u: string): string => (u === sender ? opts.displayName : u === opts.myUserId ? 'you' : (opts.nameOf?.(u) ?? u));
  const type = event.getType();
  const content = event.getContent();
  if (type === CALL_NOTIFICATION_TYPE) {
    const id = event.getId() ?? null;
    return { kind: 'started', userId: sender, text: `${who} started a voice call`, notifyEventId: id, callId: id, missedByMe: false, previewText: 'Voice call' };
  }
  if (type === CALL_DECLINE_TYPE) {
    const rel = content['m.relates_to'] as { event_id?: string } | undefined;
    const busy = content[DECLINE_REASON_KEY] === 'busy';
    const notifyEventId = typeof rel?.event_id === 'string' ? rel.event_id : null;
    return {
      kind: busy ? 'busy' : 'declined',
      userId: sender,
      text: busy ? `${who} declined (busy)` : `${who} declined`,
      notifyEventId,
      callId: notifyEventId,
      missedByMe: false,
      previewText: 'Call declined',
    };
  }
  if (type === CALL_LINE_TYPE) {
    const line = getCallLine(event);
    if (!line) return null;
    return {
      kind: line.kind,
      userId: sender,
      text: formatCallLine(line, opts.myUserId, nameOf),
      notifyEventId: null,
      callId: line.callId,
      durationMs: line.durationMs,
      participants: line.participants,
      missedByMe: isMissedForViewer(line, opts.myUserId),
      previewText: callLinePreviewText(line, opts.myUserId),
    };
  }
  if (type === CALL_MEMBER_TYPE && isOpeningMembershipInRoom(event as unknown as MembershipEventLike)) {
    const id = event.getId() ?? null;
    return { kind: 'started', userId: sender, text: `${who} started a voice call`, notifyEventId: null, callId: id, missedByMe: false, previewText: 'Voice call' };
  }
  return null;
}

/** "12 min", "45 s", "1 h 05 min" for the "Call ended, 12 min" row. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}
