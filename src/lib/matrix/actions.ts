/**
 * Every write operation the UI performs against Matrix, plus a few synchronous readers over
 * SDK aggregates (members, reactions). Names and signatures are the contract in
 * docs/ARCHITECTURE.md; devs call these and never talk to the SDK for writes.
 */
import {
  EventType,
  KnownMembership,
  MatrixError,
  MatrixEvent,
  MsgType,
  Preset,
  RelationType,
  Visibility,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js';
import { getClient, getClientOrNull } from './client.ts';
import { serverNameOf } from './config.ts';

const HTML_FORMAT = 'org.matrix.custom.html';
/** Room version 11 keeps explicit creator power levels (100). v12 (Synapse >= 1.162 default) makes creators
 * "infinite" and rejects them in power_level_content_override.users; the seed pins 11 too. */
const ROOM_VERSION = '11';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Longest we keep a dialog "busy" waiting on 429s for one user action before giving up. */
const RATE_LIMIT_WAIT_BUDGET_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Thrown by `retryOnRateLimit` when the server's `retry_after_ms` exceeds the wait budget. */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(label: string, retryAfterMs: number) {
    super(`${label} is rate limited by the homeserver; try again in ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Retry an SDK call on 429 (M_LIMIT_EXCEEDED) honouring `retry_after_ms`, up to a total budget.
 * The SDK only retries `m.room.message` sends by itself; `createRoom`, state events, invites and
 * joins throw straight away. Synapse's `rc_room_creation` (default 10 rooms, then one per minute)
 * is the limiter that bites here unless the homeserver config relaxes it.
 */
export async function retryOnRateLimit<T>(fn: () => Promise<T>, label = 'This action'): Promise<T> {
  let waited = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof MatrixError) || !e.isRateLimitError()) throw e;
      const retryAfter = e.getRetryAfterMs() ?? 2000;
      if (waited + retryAfter > RATE_LIMIT_WAIT_BUDGET_MS) throw new RateLimitedError(label, retryAfter);
      await sleep(retryAfter);
      waited += retryAfter;
    }
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SendTextOptions {
  /** Sanitised-on-render HTML body; sent as `formatted_body` with `format: org.matrix.custom.html`. */
  html?: string;
  /** Event (or event id) this message replies to. Sets `m.relates_to.m.in_reply_to`. */
  replyTo?: MatrixEvent | string;
  /** User ids for `m.mentions.user_ids`. */
  mentions?: string[];
}

function buildTextContent(body: string, opts: SendTextOptions): RoomMessageEventContent {
  const content: Record<string, unknown> = { msgtype: MsgType.Text, body };
  if (opts.html) {
    content.format = HTML_FORMAT;
    content.formatted_body = opts.html;
  }
  if (opts.mentions?.length) content['m.mentions'] = { user_ids: opts.mentions };
  const replyId = typeof opts.replyTo === 'string' ? opts.replyTo : opts.replyTo?.getId();
  if (replyId) content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyId } };
  return content as unknown as RoomMessageEventContent;
}

/** Send an `m.text` message. Resolves with the event id. Local echo appears in the timeline immediately. */
export async function sendText(roomId: string, body: string, opts: SendTextOptions = {}): Promise<string> {
  const res = await getClient().sendMessage(roomId, buildTextContent(body, opts));
  return res.event_id;
}

/** Edit a message: sends an `m.replace` relation with `m.new_content`. Resolves with the edit event id. */
export async function editText(roomId: string, targetEventId: string, body: string, html?: string): Promise<string> {
  const newContent: Record<string, unknown> = { msgtype: MsgType.Text, body };
  if (html) {
    newContent.format = HTML_FORMAT;
    newContent.formatted_body = html;
  }
  const content: Record<string, unknown> = {
    msgtype: MsgType.Text,
    body: `* ${body}`,
    'm.new_content': newContent,
    'm.relates_to': { rel_type: RelationType.Replace, event_id: targetEventId },
  };
  if (html) {
    content.format = HTML_FORMAT;
    content.formatted_body = `* ${html}`;
  }
  const res = await getClient().sendMessage(roomId, content as unknown as RoomMessageEventContent);
  return res.event_id;
}

/** Redact (delete) any event: messages, reactions, edits. */
export async function redactEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
  await getClient().redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
}

/** Add an `m.reaction` (annotation) to an event. To remove one, redact `myEventId` from getReactions(). */
export async function sendReaction(roomId: string, targetEventId: string, key: string): Promise<string> {
  const res = await getClient().sendEvent(roomId, EventType.Reaction, {
    'm.relates_to': { rel_type: RelationType.Annotation, event_id: targetEventId, key },
  });
  return res.event_id;
}

/** Convenience: add my reaction if I have not reacted with `key`, otherwise remove it. */
export async function toggleReaction(roomId: string, targetEventId: string, key: string): Promise<void> {
  const mine = getReactions(roomId, targetEventId).find((r) => r.key === key && r.mine);
  if (mine?.myEventId) await redactEvent(roomId, mine.myEventId);
  else await sendReaction(roomId, targetEventId, key);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface UploadResult {
  mxc: string;
  mimetype: string;
  size: number;
  name: string;
  w?: number;
  h?: number;
}

async function imageDimensions(file: File): Promise<{ w: number; h: number } | undefined> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('not an image'));
      img.src = url;
    });
    return { w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload a file to the media repo. Returns the mxc URL plus metadata for the `info` block. */
export async function uploadFile(file: File): Promise<UploadResult> {
  const mimetype = file.type || 'application/octet-stream';
  const dims = mimetype.startsWith('image/') ? await imageDimensions(file) : undefined;
  const res = await getClient().uploadContent(file, { name: file.name, type: mimetype, includeFilename: true });
  return { mxc: res.content_uri, mimetype, size: file.size, name: file.name, ...(dims ?? {}) };
}

/** Upload then send: `m.image` for image/*, `m.file` otherwise. Resolves with the event id. */
export async function sendFile(roomId: string, file: File): Promise<string> {
  const up = await uploadFile(file);
  const isImage = up.mimetype.startsWith('image/');
  const info: Record<string, unknown> = { mimetype: up.mimetype, size: up.size };
  if (isImage && up.w && up.h) {
    info.w = up.w;
    info.h = up.h;
  }
  const content = { msgtype: isImage ? MsgType.Image : MsgType.File, body: up.name, url: up.mxc, info };
  const res = await getClient().sendMessage(roomId, content as unknown as RoomMessageEventContent);
  return res.event_id;
}

// ---------------------------------------------------------------------------
// Typing & receipts
// ---------------------------------------------------------------------------

/** Send a typing notification. The server auto-expires it after `timeoutMs`. */
export async function sendTyping(roomId: string, typing: boolean, timeoutMs = 5000): Promise<void> {
  await getClient().sendTyping(roomId, typing, timeoutMs);
}

/** Send an `m.read` receipt for an event (usually the last one in the timeline). Clears unread counts. */
export async function sendReadReceipt(roomId: string, event: MatrixEvent | string): Promise<void> {
  const client = getClient();
  const ev = typeof event === 'string' ? client.getRoom(roomId)?.findEventById(event) : event;
  if (!ev || !ev.getId() || ev.getId()!.startsWith('~')) return; // skip local echoes
  await client.sendReadReceipt(ev);
}

/** Mark a room fully read using the newest event in its live timeline. */
export async function markRoomRead(roomId: string): Promise<void> {
  const room = getClient().getRoom(roomId);
  const events = room?.getLiveTimeline().getEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.status === null && ev.getId() && !ev.getId()!.startsWith('~')) {
      await sendReadReceipt(roomId, ev);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Rooms, spaces, DMs
// ---------------------------------------------------------------------------

function viaFor(): string[] {
  return [serverNameOf(getClient().getSafeUserId())];
}

/** Create a public, unencrypted channel inside a space (sets m.space.parent + m.space.child). */
export async function createChannel(opts: { spaceId: string; name: string; topic?: string }): Promise<string> {
  const client = getClient();
  const via = viaFor();
  const { room_id } = await retryOnRateLimit(
    () =>
      client.createRoom({
        room_version: ROOM_VERSION,
        name: opts.name,
        topic: opts.topic,
        preset: Preset.PublicChat,
        visibility: Visibility.Private,
        initial_state: [{ type: EventType.SpaceParent, state_key: opts.spaceId, content: { via, canonical: true } }],
      }),
    'Creating a channel',
  );
  const space = client.getRoom(opts.spaceId);
  const existing = (space?.currentState.getStateEvents(EventType.SpaceChild) ?? []).filter((ev) => {
    const via = ev.getContent<{ via?: string[] }>().via;
    return Array.isArray(via) && via.length > 0;
  });
  const order = String(existing.length + 1).padStart(2, '0');
  await retryOnRateLimit(
    () => client.sendStateEvent(opts.spaceId, EventType.SpaceChild, { via, order }, room_id),
    'Adding the channel to the space',
  );
  return room_id;
}

/** Create a space (public, unencrypted) with one `general` channel. Resolves with the space room id. */
export async function createSpace(opts: { name: string; topic?: string }): Promise<string> {
  const client = getClient();
  const { room_id } = await retryOnRateLimit(
    () =>
      client.createRoom({
        room_version: ROOM_VERSION,
        name: opts.name,
        topic: opts.topic,
        creation_content: { type: 'm.space' },
        preset: Preset.PublicChat,
        visibility: Visibility.Private,
      }),
    'Creating a space',
  );
  await createChannel({ spaceId: room_id, name: 'general' });
  return room_id;
}

/** Invite a user to a room or space. Throws MatrixError (e.g. M_NOT_FOUND for unknown users). */
export async function inviteUser(roomId: string, userId: string): Promise<void> {
  await retryOnRateLimit(() => getClient().invite(roomId, userId), 'Inviting');
}

/** `m.direct` account data as { userId: roomId[] }. */
export function getDirectMap(): Record<string, string[]> {
  const ev = getClientOrNull()?.getAccountData(EventType.Direct);
  const content = ev?.getContent<Record<string, string[]>>() ?? {};
  return content;
}

/** Existing joined DM room with a user, if any. */
export function findDmRoomId(userId: string): string | undefined {
  const client = getClient();
  for (const roomId of getDirectMap()[userId] ?? []) {
    const room = client.getRoom(roomId);
    if (room && room.getMyMembership() === KnownMembership.Join) return roomId;
  }
  return undefined;
}

async function addToDirectMap(userId: string, roomId: string): Promise<void> {
  const map = { ...getDirectMap() };
  map[userId] = Array.from(new Set([...(map[userId] ?? []), roomId]));
  await retryOnRateLimit(() => getClient().setAccountData(EventType.Direct, map), 'Saving the DM');
}

/** Reuse the existing DM with `userId` or create one (is_direct + trusted_private_chat) and record it in m.direct. */
export async function createDm(userId: string): Promise<string> {
  const existing = findDmRoomId(userId);
  if (existing) return existing;
  const { room_id } = await retryOnRateLimit(
    () =>
      getClient().createRoom({
        room_version: ROOM_VERSION,
        is_direct: true,
        preset: Preset.TrustedPrivateChat,
        invite: [userId],
      }),
    'Starting a DM',
  );
  await addToDirectMap(userId, room_id);
  return room_id;
}

/** Join a room by id or alias. Resolves with the room id. */
export async function joinRoom(roomIdOrAlias: string): Promise<string> {
  const room = await retryOnRateLimit(() => getClient().joinRoom(roomIdOrAlias), 'Joining');
  return room.roomId;
}

export async function leaveRoom(roomId: string): Promise<void> {
  await getClient().leave(roomId);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function roomOrNull(roomId: string): Room | null {
  return getClientOrNull()?.getRoom(roomId) ?? null;
}

/** Joined members (lazy-loaded; call `loadMembers(roomId)` once per room for the full list). */
export function getJoinedMembers(roomId: string): RoomMember[] {
  return roomOrNull(roomId)?.getJoinedMembers() ?? [];
}

export function getInvitedMembers(roomId: string): RoomMember[] {
  return roomOrNull(roomId)?.getMembersWithMembership(KnownMembership.Invite) ?? [];
}

/** With lazyLoadMembers the initial sync only carries senders; this fetches the rest (idempotent). */
export async function loadMembers(roomId: string): Promise<void> {
  await roomOrNull(roomId)?.loadMembersIfNeeded();
}

export interface ReactionSummary {
  key: string;
  count: number;
  /** True when the current user is among the senders. */
  mine: boolean;
  senders: string[];
  /** My reaction event id (redact it to remove my reaction). */
  myEventId?: string;
}

/** Aggregated reactions for an event, from the SDK's relations container. Safe to call in render. */
export function getReactions(roomId: string, eventId: string): ReactionSummary[] {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return [];
  const relations = room
    .getUnfilteredTimelineSet()
    .relations.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction);
  const sorted = relations?.getSortedAnnotationsByKey() ?? [];
  const me = client.getSafeUserId();
  const out: ReactionSummary[] = [];
  for (const [key, events] of sorted) {
    const senders: string[] = [];
    let myEventId: string | undefined;
    for (const ev of events) {
      if (ev.isRedacted()) continue;
      const sender = ev.getSender();
      if (!sender) continue;
      if (sender === me) myEventId = ev.getId();
      if (!senders.includes(sender)) senders.push(sender);
    }
    if (senders.length === 0) continue;
    out.push({ key, count: senders.length, mine: !!myEventId, senders, myEventId });
  }
  return out;
}

/** Find an event in the room's loaded timeline or fetch it from the server (for reply quotes). */
export async function fetchEvent(roomId: string, eventId: string): Promise<MatrixEvent | undefined> {
  const client = getClient();
  const local = client.getRoom(roomId)?.findEventById(eventId);
  if (local) return local;
  try {
    const raw = await client.fetchRoomEvent(roomId, eventId);
    return new MatrixEvent(raw);
  } catch {
    return undefined;
  }
}

/** Can the current user redact this event (own message, or power level >= redact level)? */
export function canRedactEvent(roomId: string, event: MatrixEvent): boolean {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return false;
  return room.currentState.maySendRedactionForEvent(event, client.getSafeUserId());
}

/** Only the original sender can edit a message. */
export function canEditEvent(event: MatrixEvent): boolean {
  const me = getClientOrNull()?.getUserId();
  return !!me && event.getSender() === me && !event.isRedacted() && event.getType() === EventType.RoomMessage;
}

/** Current user's power level in a room (0 when unknown). */
export function myPowerLevel(roomId: string): number {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return 0;
  return room.getMember(client.getSafeUserId())?.powerLevel ?? 0;
}
