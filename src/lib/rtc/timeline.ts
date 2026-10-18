/**
 * Phase 7: what the chat timeline shows for call events (pure, unit-tested; Dev B renders the rows).
 *
 * MatrixRTC leaves these events in the room:
 *   - `org.matrix.msc4075.rtc.notification`  the caller rang (DM ring / room ring)           -> "X started a call"
 *   - `org.matrix.msc4310.rtc.decline`       a callee declined (m.reference to the above)    -> "X declined"
 *   - `org.matrix.msc3401.call.member`       state: a device joined / left (hidden from the timeline, too chatty)
 *   - `org.matrix.msc4143.rtc.slot`          state: unused by Codec (Element-only semantics), hidden if ever seen
 * "Call ended, 12 min" / "Missed call" rows come from `useCallStore().history` (local, per device): MSC4075 has no
 * end or missed event, so those lines are Codec-only (Advisor C7).
 */
import { EventType } from 'matrix-js-sdk';

export const CALL_NOTIFICATION_TYPE: string = EventType.RTCNotification; // org.matrix.msc4075.rtc.notification
export const CALL_DECLINE_TYPE: string = EventType.RTCDecline; // org.matrix.msc4310.rtc.decline
export const CALL_MEMBER_TYPE: string = EventType.GroupCallMemberPrefix; // org.matrix.msc3401.call.member
export const CALL_SLOT_TYPE: string = EventType.RTCSlot; // org.matrix.msc4143.rtc.slot
/** Codec-only extra on a decline: why ("busy" = the callee was in another call). */
export const DECLINE_REASON_KEY = 'io.codec.decline_reason';

export type CallEventKind = 'started' | 'declined' | 'busy';

export interface CallEventRow {
  kind: CallEventKind;
  /** Sender of the event. */
  userId: string;
  /** Ready-made text, with `displayName` substituted. */
  text: string;
  /** The `rtc.notification` event id (the notification itself, or the one a decline references). */
  notifyEventId: string | null;
}

/** Minimal event shape (a MatrixEvent satisfies it; tests pass plain objects). */
export interface EventLike {
  getType(): string;
  getSender(): string | undefined;
  getId(): string | undefined;
  getContent(): Record<string, unknown>;
  isState?(): boolean;
}

/** True for the call events that are rows (notification, decline); member / slot state is not. */
export function isCallTimelineEvent(event: EventLike): boolean {
  const t = event.getType();
  return t === CALL_NOTIFICATION_TYPE || t === CALL_DECLINE_TYPE;
}

/** True for every MatrixRTC event type (to hide the state ones from "unknown event" fallbacks). */
export function isCallEvent(event: EventLike): boolean {
  const t = event.getType();
  return t === CALL_NOTIFICATION_TYPE || t === CALL_DECLINE_TYPE || t === CALL_MEMBER_TYPE || t === CALL_SLOT_TYPE;
}

/**
 * Describe a call timeline event for a grey system row. `displayName` is the sender's name as the UI shows it;
 * `myUserId` turns "X started a call" into "You started a call". Null for non-call events and hidden state.
 */
export function describeCallEvent(event: EventLike, opts: { displayName: string; myUserId?: string }): CallEventRow | null {
  const sender = event.getSender();
  if (!sender) return null;
  const who = sender === opts.myUserId ? 'You' : opts.displayName;
  const type = event.getType();
  const content = event.getContent();
  if (type === CALL_NOTIFICATION_TYPE) {
    return { kind: 'started', userId: sender, text: `${who} started a call`, notifyEventId: event.getId() ?? null };
  }
  if (type === CALL_DECLINE_TYPE) {
    const rel = content['m.relates_to'] as { event_id?: string } | undefined;
    const busy = content[DECLINE_REASON_KEY] === 'busy';
    return {
      kind: busy ? 'busy' : 'declined',
      userId: sender,
      text: busy ? `${who} ${sender === opts.myUserId ? 'were' : 'is'} busy` : `${who} declined`,
      notifyEventId: typeof rel?.event_id === 'string' ? rel.event_id : null,
    };
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
