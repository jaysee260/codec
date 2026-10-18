/**
 * Phase 7 (Wave 2): the chat lines of a call, as one encrypted Codec room event, `dev.matrixpoc.call`
 * (docs/PHASE7_ACCEPTANCE.md "Wire shapes"; orchestrator ruling Wave 2). Pure, Node-loadable, unit-tested.
 *
 *   { kind: 'ended' | 'missed', call_id, duration_ms?, participants? }
 *
 * Who sends what (the store does the sending, `src/store/call.ts`):
 *   - "started"  is NOT this event: it is the Codec-built ring (`org.matrix.msc4075.rtc.notification`), or, for a
 *                drop-in call that rang nobody, the membership state event that opened the session (`isCallOpeningMembership`).
 *   - "declined" is NOT this event either: MSC4310 `org.matrix.msc4310.rtc.decline` (+ `io.codec.decline_reason: busy`).
 *   - "missed"   the caller sends it when its ring ends (60 s timeout, or the caller hanging up) with nobody joined and
 *                nobody declined; `participants` = who was rung.
 *   - "ended"    the last participant to leave sends it, best effort, with `duration_ms` = its own connected time and
 *                `participants` = everyone who was in the call.
 * `getCallLine` also accepts `kind: 'started' | 'declined'` on the wire (the PM contract allows them) so a future sender
 * renders; Codec never sends those two. The event is never a thread root or reply; `previewText` shows "Missed call"
 * when a missed event lists the viewer (`callLinePreviewText`).
 */

export const CALL_LINE_TYPE = 'dev.matrixpoc.call';

export type CallLineKind = 'started' | 'ended' | 'declined' | 'missed';

export interface CallLine {
  kind: CallLineKind;
  /** The ring event id, or the sender's first membership event id when there was no ring. */
  callId: string;
  sender: string;
  /** `ended` only: the sender's connected time. */
  durationMs?: number;
  /** `missed` only: who was rung and did not answer. */
  participants?: string[];
  /** `declined` only (wire compatibility; Codec sends MSC4310 declines instead). */
  reason?: string;
}

/** Minimal event shape (a MatrixEvent satisfies it; tests pass plain objects). */
export interface CallLineEventLike {
  getType(): string;
  getSender(): string | undefined;
  getId(): string | undefined;
  getContent(): Record<string, unknown>;
}

const KINDS: readonly CallLineKind[] = ['started', 'ended', 'declined', 'missed'];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Pure: the content of the event the store sends. `participants` = who was in the call (`ended`, BUG-34) or who was
 * rung and did not answer (`missed`); `duration_ms` for `ended`.
 */
export function buildCallLineContent(
  line: { kind: 'ended'; callId: string; durationMs: number; participants: string[] } | { kind: 'missed'; callId: string; participants: string[] },
): Record<string, unknown> {
  const participants = [...new Set(line.participants)];
  if (line.kind === 'ended') return { kind: 'ended', call_id: line.callId, duration_ms: Math.max(0, Math.round(line.durationMs)), participants };
  return { kind: 'missed', call_id: line.callId, participants };
}

/**
 * Pure (BUG-35): which line a caller / leaver owes when its call ends. `missed` when we rang and nobody ever joined or
 * declined (the 60 s timeout, or hanging up while still ringing); `ended` when we were the last one out of a call that
 * had connected; nothing otherwise (a decline / busy end has its own MSC4310 event; a mid-call leaver sends nothing).
 */
export function endLineFor(end: {
  endReason: string | null;
  rang: readonly string[];
  answered: boolean;
  lastToLeave: boolean;
  connectedAt: number | null;
}): 'missed' | 'ended' | null {
  if (end.rang.length > 0 && !end.answered && (end.endReason === 'no-answer' || end.endReason === 'hangup')) return 'missed';
  if (end.lastToLeave && end.connectedAt !== null && (end.endReason === 'hangup' || end.endReason === 'remote-hangup' || end.endReason === 'error')) return 'ended';
  return null;
}

/**
 * Parse a `dev.matrixpoc.call` event. Null for other event types, unknown `kind`, a bad `call_id`, a non-array
 * `missed` / `participants` or a negative `duration_ms` (AC-R3-7: rendered as nothing).
 */
export function getCallLine(event: CallLineEventLike): CallLine | null {
  if (event.getType() !== CALL_LINE_TYPE) return null;
  const sender = event.getSender();
  if (!sender) return null;
  const c = event.getContent();
  const kind = c['kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
  const callId = c['call_id'];
  if (typeof callId !== 'string' || callId.length === 0) return null;
  const line: CallLine = { kind: kind as CallLineKind, callId, sender };
  if ('duration_ms' in c && c['duration_ms'] !== undefined) {
    const d = c['duration_ms'];
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) return null;
    line.durationMs = d;
  }
  // `participants` (orchestrator ruling) with `missed` (PM contract) accepted as an alias.
  const who = c['participants'] !== undefined ? c['participants'] : c['missed'];
  if (who !== undefined) {
    if (!isStringArray(who)) return null;
    line.participants = who;
  }
  if (kind === 'missed' && !line.participants) return null;
  if (typeof c['reason'] === 'string') line.reason = c['reason'];
  return line;
}

/** "12 min", "< 1 min", "1 h 05 min" for the "Call ended, 12 min" row (AC-R7-1 rounding). */
export function formatCallLineDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return '< 1 min';
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Is this `missed` line addressed to `viewerId` (rung and did not answer; never the caller)? */
export function isMissedForViewer(line: CallLine, viewerId: string | null | undefined): boolean {
  return line.kind === 'missed' && !!viewerId && line.sender !== viewerId && (line.participants ?? []).includes(viewerId);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'everyone';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The row text, the same on every device: "Call ended, 12 min", "Missed call from bob" (viewer was rung),
 * "No answer from alice" (the caller and bystanders), "bob declined" / "bob declined (busy)", "bob started a voice call".
 * `nameOf(userId)` gives display names; defaults to the user id.
 */
export function formatCallLine(line: CallLine, viewerId: string | null | undefined, nameOf: (userId: string) => string = (u) => u): string {
  switch (line.kind) {
    case 'ended':
      return `Call ended, ${formatCallLineDuration(line.durationMs ?? 0)}`;
    case 'missed': {
      if (isMissedForViewer(line, viewerId)) return `Missed call from ${nameOf(line.sender)}`;
      const others = (line.participants ?? []).filter((u) => u !== viewerId);
      return `No answer from ${joinNames(others.map(nameOf))}`;
    }
    case 'declined':
      return line.reason === 'busy' ? `${nameOf(line.sender)} declined (busy)` : `${nameOf(line.sender)} declined`;
    case 'started':
      return `${nameOf(line.sender)} started a voice call`;
  }
}

/** Room-list preview (AC-R3-7 / AC-R7-3): "Missed call" for a missed line naming me, else a neutral label. */
export function callLinePreviewText(line: CallLine, viewerId: string | null | undefined): string {
  switch (line.kind) {
    case 'missed':
      return isMissedForViewer(line, viewerId) ? 'Missed call' : 'No answer';
    case 'ended':
      return 'Call ended';
    case 'declined':
      return 'Call declined';
    case 'started':
      return 'Voice call';
  }
}

// ---------------------------------------------------------------------------
// "started" for a drop-in call: the membership that opened the session
// ---------------------------------------------------------------------------

/** What `isCallOpeningMembership` reads of a timeline event (a MatrixEvent satisfies it). */
export interface MembershipEventLike extends CallLineEventLike {
  getTs(): number;
  getStateKey?(): string | undefined;
  getPrevContent?(): Record<string, unknown>;
}

export const MEMBER_TYPE = 'org.matrix.msc3401.call.member';
export const RING_TYPE = 'org.matrix.msc4075.rtc.notification';

function isJoinMembership(event: MembershipEventLike): boolean {
  if (event.getType() !== MEMBER_TYPE) return false;
  const c = event.getContent();
  if (c['application'] !== 'm.call') return false;
  const prev = event.getPrevContent?.() ?? {};
  return prev['application'] === undefined; // an update / leave of an existing membership is not a join
}

function membershipExpiry(event: MembershipEventLike): number {
  const c = event.getContent();
  const expires = typeof c['expires'] === 'number' ? c['expires'] : 4 * 3600_000;
  const createdTs = typeof c['created_ts'] === 'number' ? c['created_ts'] : event.getTs();
  return createdTs + expires;
}

/**
 * Pure: does this membership state event open a call session (nobody else held a live membership when it was sent),
 * with no Codec ring referencing it (the ring is the "started" row then)? `timeline` is the room's live timeline,
 * oldest first (`room.getLiveTimeline().getEvents()`); the event itself may or may not be in it.
 */
export function isCallOpeningMembership(event: MembershipEventLike, timeline: readonly MembershipEventLike[]): boolean {
  if (!isJoinMembership(event)) return false;
  const id = event.getId();
  const ts = event.getTs();
  const live = new Map<string, MembershipEventLike>(); // state key -> latest membership before `ts`
  for (const e of timeline) {
    if (e.getId() === id) continue;
    const t = e.getType();
    if (t === RING_TYPE) {
      const rel = e.getContent()['m.relates_to'] as { event_id?: unknown } | undefined;
      if (id && rel?.event_id === id) return false;
      continue;
    }
    if (t !== MEMBER_TYPE || e.getTs() > ts) continue;
    const key = e.getStateKey?.() ?? `${e.getSender()}`;
    live.set(key, e);
  }
  const ownKey = event.getStateKey?.() ?? `${event.getSender()}`;
  for (const [key, e] of live) {
    if (key === ownKey) continue;
    if (e.getContent()['application'] !== 'm.call') continue; // a leave (empty content)
    if (membershipExpiry(e) > ts) return false; // someone was already in the call
  }
  return true;
}

/**
 * The timeline resolver the app installs (`src/store/call.ts`), so `describeCallEvent` / `isDisplayableEvent` can
 * judge a membership event without importing the client here (keeps this module Node-loadable).
 */
let timelineResolver: ((roomId: string) => readonly MembershipEventLike[] | undefined) | null = null;

export function setCallTimelineResolver(fn: typeof timelineResolver): void {
  timelineResolver = fn;
}

/** `isCallOpeningMembership` through the installed resolver; false without one (or for an event without a room). */
export function isOpeningMembershipInRoom(event: MembershipEventLike & { getRoomId?(): string | undefined }): boolean {
  if (event.getType() !== MEMBER_TYPE) return false;
  const roomId = event.getRoomId?.();
  const timeline = roomId && timelineResolver ? timelineResolver(roomId) : undefined;
  if (!timeline) return false;
  return isCallOpeningMembership(event, timeline);
}
