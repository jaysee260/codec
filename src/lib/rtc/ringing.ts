/**
 * Phase 7: incoming calls. `org.matrix.msc4075.rtc.notification` room events arrive over /sync. Codec applies its
 * own receiving rules (Advisor Wave 19, F2: the SDK's parser needs an `rtc.slot` state event we never send and the
 * `@room` power level): not sent by us, well-formed, not expired (`sender_ts + lifetime`, capped at 60 s), mentions
 * us by user id (or `@room` from a sender allowed to), we are not already a member of that call, the caller still is.
 * This watcher turns the valid ones into `IncomingCall`s plus the reasons a ring stops: the timeout, the caller
 * leaving, one of our other devices answering (Advisor C3: Codec client logic, not spec), a decline we sent.
 * `sendDecline` sends the MSC4310 decline (sticky where the server supports it), with a Codec-only
 * `io.codec.decline_reason: "busy"` when we were in another call.
 */
import { MatrixEventEvent, RelationType, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { EventType } from 'matrix-js-sdk';
import type { IRoomTimelineData } from 'matrix-js-sdk/lib/models/event-timeline-set.js';
import { UnsupportedStickyEventsEndpointError } from 'matrix-js-sdk/lib/errors.js';
import { MatrixRTCSessionEvent, type MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc/index.js';
import { RING_TIMEOUT_MS } from './constants.ts';
import { LEGACY_SLOT_ID } from './livekit-token.ts';
import { answeredElsewhere, type MembershipLike } from './participants.ts';
import { DECLINE_REASON_KEY } from './timeline.ts';
import type { IncomingCall } from './types.ts';

/** Pure: the `org.matrix.msc4075.rtc.notification` content Codec sends (unit-tested). */
export function buildRingContent(opts: { membershipEventId: string; userIds: string[]; lifetimeMs: number; now: number }): Record<string, unknown> {
  return {
    'slot_id': LEGACY_SLOT_ID,
    'notification_type': 'ring',
    'm.call.intent': 'audio',
    'm.mentions': { user_ids: [...opts.userIds] },
    'm.relates_to': { rel_type: RelationType.Reference, event_id: opts.membershipEventId },
    'sender_ts': opts.now,
    'lifetime': opts.lifetimeMs,
  };
}

/** MSC4075: a `lifetime` beyond this is capped; a `sender_ts` further ahead of the server timestamp is distrusted. */
export const RING_MAX_LIFETIME_MS = 120_000;
export const RING_MAX_SENDER_AHEAD_MS = 20_000;

export interface RingContent {
  slot_id: string;
  sender_ts: number;
  lifetime: number;
  mentions: { user_ids: string[]; room: boolean };
  membershipEventId: string | null;
}

/** Pure: MSC4075 schema check of a notification's content. Null when malformed. */
export function parseRingContent(content: Record<string, unknown>): RingContent | null {
  const senderTs = content['sender_ts'];
  const lifetime = content['lifetime'];
  if (typeof senderTs !== 'number' || !Number.isInteger(senderTs) || senderTs < 0) return null;
  if (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < 0) return null;
  const slot = content['slot_id'];
  if (slot !== undefined && typeof slot !== 'string') return null;
  const mentions = content['m.mentions'];
  if (!mentions || typeof mentions !== 'object') return null;
  const m = mentions as { user_ids?: unknown; room?: unknown };
  const userIds = Array.isArray(m.user_ids) && m.user_ids.every((u) => typeof u === 'string') ? (m.user_ids as string[]) : [];
  const room = m.room === true;
  if (!room && userIds.length === 0) return null;
  const rel = content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined;
  const membershipEventId = rel?.rel_type === RelationType.Reference && typeof rel.event_id === 'string' ? rel.event_id : null;
  return { slot_id: typeof slot === 'string' ? slot : 'm.call#ROOM', sender_ts: senderTs, lifetime: Math.min(lifetime, RING_MAX_LIFETIME_MS), mentions: { user_ids: userIds, room }, membershipEventId };
}

/** Pure: MSC4075 expiry (lifetime from `sender_ts`, or from `origin_server_ts` when `sender_ts` is too far ahead). */
export function ringExpiry(content: Pick<RingContent, 'sender_ts' | 'lifetime'>, originServerTs: number): number {
  const base = content.sender_ts - originServerTs > RING_MAX_SENDER_AHEAD_MS ? originServerTs : content.sender_ts;
  return base + content.lifetime;
}

export type RingRejection = 'self' | 'malformed' | 'expired' | 'not-mentioned' | 'already-joined' | 'caller-gone';

/**
 * Pure: should this notification ring on this device? Returns the parsed content, or why not.
 * `memberships` are the room's live call memberships (unexpired); `senderMayMentionRoom` answers the `@room` rule.
 */
export function evaluateRing(input: {
  content: Record<string, unknown>;
  sender: string;
  originServerTs: number;
  userId: string;
  deviceId: string;
  now: number;
  memberships: MembershipLike[];
  senderMayMentionRoom: boolean;
  ringTimeoutMs?: number;
}): { ok: true; content: RingContent; expiresAt: number } | { ok: false; reason: RingRejection } {
  if (input.sender === input.userId) return { ok: false, reason: 'self' };
  const content = parseRingContent(input.content);
  if (!content) return { ok: false, reason: 'malformed' };
  const expiresAt = Math.min(ringExpiry(content, input.originServerTs), input.now + (input.ringTimeoutMs ?? RING_TIMEOUT_MS));
  if (input.now >= expiresAt) return { ok: false, reason: 'expired' };
  const mentioned = content.mentions.user_ids.includes(input.userId) || (content.mentions.room && input.senderMayMentionRoom);
  if (!mentioned) return { ok: false, reason: 'not-mentioned' };
  if (input.memberships.some((m) => m.userId === input.userId)) return { ok: false, reason: 'already-joined' };
  return { ok: true, content, expiresAt };
}

export type RingStopReason = 'expired' | 'caller-left' | 'declined' | 'answered-elsewhere' | 'busy' | 'accepted';

export interface RingHandlers {
  onRing(call: IncomingCall): void;
  onStop(roomId: string, reason: RingStopReason): void;
}

export interface RingWatcher {
  /** Stop ringing for `roomId` with `reason` (accept / decline / dismiss call this). */
  stop(roomId: string, reason: RingStopReason): void;
  dispose(): void;
}

/**
 * Subscribe to the client's timeline for ring notifications. One active ring per room; a second notification for a
 * room already ringing is ignored. Returns the watcher (dispose on logout).
 */
/**
 * Rings and declines are encrypted room events: `RoomEvent.Timeline` fires while they are still `m.room.encrypted`
 * (`getType()` is the wire type until the SDK decrypts), so call-event listeners must wait for the decryption. Runs
 * `fn` now when the event is already readable, else once it decrypts (a late Megolm session counts: the SDK retries
 * UTDs and fires `Decrypted` again). Returns a disposer.
 */
export function whenCallEventReadable(event: MatrixEvent, fn: (event: MatrixEvent) => void): () => void {
  const readable = (): boolean => !event.isBeingDecrypted() && !event.isDecryptionFailure() && event.getType() !== 'm.room.encrypted';
  if (readable()) {
    fn(event);
    return () => undefined;
  }
  if (!event.isEncrypted()) return () => undefined;
  const onDecrypted = (): void => {
    if (!readable()) return;
    event.off(MatrixEventEvent.Decrypted, onDecrypted);
    fn(event);
  };
  event.on(MatrixEventEvent.Decrypted, onDecrypted);
  return () => event.off(MatrixEventEvent.Decrypted, onDecrypted);
}

export function watchIncomingCalls(client: MatrixClient, handlers: RingHandlers, opts: { ringTimeoutMs?: number } = {}): RingWatcher {
  const userId = client.getUserId() ?? '';
  const deviceId = client.getDeviceId() ?? '';
  const active = new Map<string, { call: IncomingCall; timer: ReturnType<typeof setTimeout>; session: MatrixRTCSession; onMembers: () => void }>();

  const stop = (roomId: string, reason: RingStopReason): void => {
    const entry = active.get(roomId);
    if (!entry) return;
    active.delete(roomId);
    clearTimeout(entry.timer);
    entry.session.off(MatrixRTCSessionEvent.MembershipsChanged, entry.onMembers);
    handlers.onStop(roomId, reason);
  };

  const startRing = async (room: Room, event: MatrixEvent): Promise<void> => {
    const roomId = room.roomId;
    if (active.has(roomId)) return;
    const session = client.matrixRTC.getRoomSession(room);
    await session.ensureRecalculateSessionMembers();
    const sender = event.getSender() ?? '';
    const verdict = evaluateRing({
      content: event.getContent(),
      sender,
      originServerTs: event.getTs(),
      userId,
      deviceId,
      now: Date.now(),
      memberships: session.memberships.filter((m) => !m.isExpired()),
      senderMayMentionRoom: room.currentState.mayTriggerNotifOfType('room', sender),
      ringTimeoutMs: opts.ringTimeoutMs,
    });
    if (!verdict.ok || active.has(roomId)) return;
    const now = Date.now();
    const call: IncomingCall = {
      roomId,
      notifyEventId: event.getId()!,
      from: sender,
      slotId: verdict.content.slot_id,
      expiresAt: verdict.expiresAt,
      receivedAt: now,
    };
    const onMembers = (): void => {
      const memberships = session.memberships.filter((m) => !m.isExpired());
      if (answeredElsewhere(memberships, { userId, deviceId })) return stop(roomId, 'answered-elsewhere');
      // The caller (or everyone) left before we answered: missed.
      if (!memberships.some((m) => m.userId === call.from)) return stop(roomId, 'caller-left');
    };
    session.on(MatrixRTCSessionEvent.MembershipsChanged, onMembers);
    const timer = setTimeout(() => stop(roomId, 'expired'), Math.max(0, call.expiresAt - now));
    active.set(roomId, { call, timer, session, onMembers });
    handlers.onRing(call);
    // The caller's membership may already be gone (notification delivered late): then this stops it at once.
    onMembers();
  };

  const onTimeline = (raw: MatrixEvent, room: Room | undefined, _toStart: boolean | undefined, _removed: boolean, data: IRoomTimelineData): void => {
    if (!room || !data.liveEvent) return;
    whenCallEventReadable(raw, (event) => onReadable(event, room));
  };
  const onReadable = (event: MatrixEvent, room: Room): void => {
    const type = event.getType();
    if (type === EventType.RTCNotification) {
      if (event.getSender() === userId) return;
      void startRing(room, event).catch(() => undefined);
      return;
    }
    if (type === EventType.RTCDecline && event.getSender() === userId) {
      // Another of our devices declined: stop ringing here too.
      const rel = event.getContent()['m.relates_to'] as { event_id?: string } | undefined;
      const entry = active.get(room.roomId);
      if (entry && rel?.event_id === entry.call.notifyEventId) stop(room.roomId, 'declined');
    }
  };
  client.on(RoomEvent.Timeline, onTimeline);

  return {
    stop,
    dispose() {
      client.off(RoomEvent.Timeline, onTimeline);
      for (const roomId of [...active.keys()]) {
        const entry = active.get(roomId)!;
        active.delete(roomId);
        clearTimeout(entry.timer);
        entry.session.off(MatrixRTCSessionEvent.MembershipsChanged, entry.onMembers);
      }
    },
  };
}

/** Pure: the decline event content (MSC4310 + the Codec busy marker). */
export function buildDeclineContent(notifyEventId: string, reason?: 'busy'): Record<string, unknown> {
  return {
    'm.relates_to': { rel_type: RelationType.Reference, event_id: notifyEventId },
    msc4354_sticky_key: notifyEventId,
    ...(reason ? { [DECLINE_REASON_KEY]: reason } : {}),
  };
}

/** Send the decline for an incoming call (sticky when the server supports MSC4354, else a plain room event). */
export async function sendDecline(client: MatrixClient, call: Pick<IncomingCall, 'roomId' | 'notifyEventId'>, reason?: 'busy'): Promise<void> {
  const content = buildDeclineContent(call.notifyEventId, reason);
  try {
    await client._unstable_sendStickyEvent(call.roomId, RING_TIMEOUT_MS * 2, null, EventType.RTCDecline, content as never);
  } catch (e) {
    if (!(e instanceof UnsupportedStickyEventsEndpointError)) throw e;
    await client.sendEvent(call.roomId, EventType.RTCDecline, content as never);
  }
}
