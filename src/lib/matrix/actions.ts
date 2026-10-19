/**
 * Every write operation the UI performs against Matrix, plus a few synchronous readers over
 * SDK aggregates (members, reactions). Names and signatures are the contract in
 * docs/ARCHITECTURE.md; devs call these and never talk to the SDK for writes.
 *
 * Phase 3 (threads): sends accept `{ threadRoot }` and then carry the spec thread relation
 *   m.relates_to: { rel_type: 'm.thread', event_id: <root>, is_falling_back: true,
 *                   'm.in_reply_to': { event_id: <latest reply in the thread, else the root> } }
 * (`replyTo` + `threadRoot` is rejected with `ThreadReplyConflictError`: no quote replies inside threads, AC-T2-3).
 * Reactions, edits and redactions keep relating to their target; when the target is a thread reply they are
 * sent with the SDK's `threadId` argument so the local echo lands in the thread timeline. Receipts carry
 * `thread_id` ('main' or the root id) - the SDK derives it from the event. Threads never nest:
 * `resolveThreadRoot()` collapses any reply id to its root.
 */
import {
  Direction,
  EventStatus,
  EventType,
  KnownMembership,
  MatrixError,
  MatrixEvent,
  MsgType,
  Preset,
  ReceiptType,
  RelationType,
  Visibility,
  type Room,
  type RoomMember,
  type Thread,
} from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js';
import { getSendReadReceipts } from './receipts.ts';
import { getClient, getClientOrNull } from './client.ts';
import { serverNameOf } from './config.ts';
import { encryptAttachment, type EncryptedFile } from './attachments.ts';
import { getThreadRelation, isGifEvent, isRoomEncrypted, isThreadReply, MEGOLM_ALGORITHM } from './utils.ts';
import { sanitizeWaveform } from '../audio/analysis.ts';
import { containerMimeType, voiceFileName } from '../audio/mime.ts';
import { buildGifContent } from '../gif/message.ts';
import { CALL_POWER_LEVELS } from '../rtc/permissions.ts';
import type { GifResult } from '../gif/types.ts';

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
// Threads (Phase 3) - helpers shared by the send paths
// ---------------------------------------------------------------------------

/** `{ threadRoot }`: send into the thread rooted at that event (any reply id is collapsed to its root). */
export interface ThreadOptions {
  threadRoot?: string;
}

/** `m.relates_to` of a thread reply as sent on the wire (docs/CORE_API.md "Threads", "Wire shapes"). */
export interface ThreadRelationContent {
  rel_type: 'm.thread';
  event_id: string;
  is_falling_back: boolean;
  'm.in_reply_to': { event_id: string };
}

/**
 * Collapse an event id to the root of the thread it lives in (threads do not nest): a reply id becomes its
 * root, a root or plain message id is returned unchanged. Unknown (not loaded) ids are returned as given.
 */
export function resolveThreadRoot(roomId: string, eventId: string): string {
  const ev = getClientOrNull()?.getRoom(roomId)?.findEventById(eventId);
  return getThreadRelation(ev)?.event_id ?? ev?.threadRootId ?? eventId;
}

/** Root id of the thread a *reply* lives in (from its wire relation); undefined for roots and plain messages. */
export function threadRootOf(roomId: string, eventId: string): string | undefined {
  return getThreadRelation(getClientOrNull()?.getRoom(roomId)?.findEventById(eventId))?.event_id;
}

/**
 * Get the SDK `Thread` model for a root, creating it when the SDK does not know it yet (a message nobody has
 * replied to, or a root outside the loaded window - the root event is fetched then). Creating the model also
 * triggers its initial `/relations` fetch; the bridge mirrors the result into the timeline store. Resolves
 * with null when the root event cannot be found or is a state event.
 */
export async function ensureThread(roomId: string, rootId: string): Promise<Thread | null> {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return null;
  const existing = room.getThread(rootId);
  if (existing) return existing;
  let root = room.findEventById(rootId);
  if (!root) {
    try {
      root = client.getEventMapper()(await client.fetchRoomEvent(roomId, rootId));
    } catch {
      return null;
    }
  }
  if (root.isState()) return null;
  return room.createThread(rootId, root, [], false);
}

/**
 * Build the spec relation for a message sent into a thread. `m.in_reply_to` is the newest *sent* reply the
 * SDK knows (never a local echo), else the root - always the fallback (`is_falling_back: true`): quote replies
 * inside threads are out of scope for the POC (docs/archive/PHASE3_ACCEPTANCE.md AC-T2-3).
 */
function threadRelation(room: Room | null | undefined, rootId: string): ThreadRelationContent {
  const thread = room?.getThread(rootId);
  const latest = thread?.lastReply((ev) => ev.isRelation(RelationType.Thread) && !ev.status)?.getId() ?? rootId;
  return { rel_type: 'm.thread', event_id: rootId, is_falling_back: true, 'm.in_reply_to': { event_id: latest } };
}

/** Thrown (before anything is sent) when `replyTo` and `threadRoot` are combined (AC-T2-3). */
export class ThreadReplyConflictError extends Error {
  constructor() {
    super('replyTo and threadRoot cannot be combined: threads do not nest and have no quote replies (AC-T2-3)');
    this.name = 'ThreadReplyConflictError';
  }
}

/**
 * Phase 5: thrown before anything is sent when the room is encrypted but this session has no crypto engine
 * (`getCryptoError()` says why). The SDK would throw its own error at send time; this one is predictable.
 */
export class EncryptionNotReadyError extends Error {
  constructor() {
    super('This room is encrypted, but encryption is not available in this session');
    this.name = 'EncryptionNotReadyError';
  }
}

/** Send a room message, into a thread when `threadRoot` is given (local echo lands in that thread). */
async function sendRoomMessage(roomId: string, content: Record<string, unknown>, threadRoot?: string): Promise<string> {
  const client = getClient();
  if (isRoomEncrypted(roomId) && !client.getCrypto()) throw new EncryptionNotReadyError();
  if (!threadRoot) {
    const res = await client.sendMessage(roomId, content as unknown as RoomMessageEventContent);
    return res.event_id;
  }
  const root = resolveThreadRoot(roomId, threadRoot);
  await ensureThread(roomId, root);
  content['m.relates_to'] = threadRelation(client.getRoom(roomId), root);
  const res = await client.sendMessage(roomId, root, content as unknown as RoomMessageEventContent);
  return res.event_id;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SendTextOptions extends ThreadOptions {
  /** Sanitised-on-render HTML body; sent as `formatted_body` with `format: org.matrix.custom.html`. */
  html?: string;
  /** Event (or event id) this message replies to. Sets `m.relates_to.m.in_reply_to`. */
  replyTo?: MatrixEvent | string;
  /** User ids for `m.mentions.user_ids`. */
  mentions?: string[];
}

function buildTextContent(body: string, opts: SendTextOptions): Record<string, unknown> {
  const content: Record<string, unknown> = { msgtype: MsgType.Text, body };
  if (opts.html) {
    content.format = HTML_FORMAT;
    content.formatted_body = opts.html;
  }
  if (opts.mentions?.length) content['m.mentions'] = { user_ids: opts.mentions };
  const replyId = typeof opts.replyTo === 'string' ? opts.replyTo : opts.replyTo?.getId();
  if (replyId) content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyId } };
  return content;
}

/**
 * Send an `m.text` message. Resolves with the event id. Local echo appears in the timeline immediately.
 * With `threadRoot` the message goes into that thread (main timeline untouched). `replyTo` together with
 * `threadRoot` throws `ThreadReplyConflictError` before anything is sent (AC-T2-3: no quote replies in threads).
 */
export async function sendText(roomId: string, body: string, opts: SendTextOptions = {}): Promise<string> {
  if (opts.threadRoot && opts.replyTo) throw new ThreadReplyConflictError();
  return sendRoomMessage(roomId, buildTextContent(body, opts), opts.threadRoot);
}

/** `sendText` with an HTML body (Phase 3 convenience; same options). */
export async function sendHtml(roomId: string, body: string, html: string, opts: Omit<SendTextOptions, 'html'> = {}): Promise<string> {
  return sendText(roomId, body, { ...opts, html });
}

/**
 * Edit a message: sends an `m.replace` relation with `m.new_content`. Resolves with the edit event id.
 * Editing a thread reply routes the edit through the thread (`threadRoot` is derived from the target when
 * omitted).
 */
export async function editText(
  roomId: string,
  targetEventId: string,
  body: string,
  html?: string,
  opts: ThreadOptions = {},
): Promise<string> {
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
  const threadId = opts.threadRoot ?? threadRootOf(roomId, targetEventId) ?? null;
  const res = await getClient().sendMessage(roomId, threadId, content as unknown as RoomMessageEventContent);
  return res.event_id;
}

/** Redact (delete) any event: messages, reactions, edits. Thread replies are redacted through their thread. */
export async function redactEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
  const threadId = threadRootOf(roomId, eventId) ?? null;
  await getClient().redactEvent(roomId, threadId, eventId, undefined, reason ? { reason } : undefined);
}

/**
 * Add an `m.reaction` (annotation) to an event. To remove one, redact `myEventId` from getReactions().
 * Reacting to a thread reply routes through the thread (derived from the target when `threadRoot` is omitted).
 */
export async function sendReaction(roomId: string, targetEventId: string, key: string, opts: ThreadOptions = {}): Promise<string> {
  const threadId = opts.threadRoot ?? threadRootOf(roomId, targetEventId) ?? null;
  const res = await getClient().sendEvent(roomId, threadId, EventType.Reaction, {
    'm.relates_to': { rel_type: RelationType.Annotation, event_id: targetEventId, key },
  });
  return res.event_id;
}

/** Convenience: add my reaction if I have not reacted with `key`, otherwise remove it. */
export async function toggleReaction(roomId: string, targetEventId: string, key: string, opts: ThreadOptions = {}): Promise<void> {
  const mine = getReactions(roomId, targetEventId).find((r) => r.key === key && r.mine);
  if (mine?.myEventId) await redactEvent(roomId, mine.myEventId);
  else await sendReaction(roomId, targetEventId, key, opts);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface UploadResult {
  /** The uploaded content's mxc url: the plaintext for plain uploads, the ciphertext when `file` is set. */
  mxc: string;
  /** Phase 5: the spec `EncryptedFile` (`file` for the event) when the upload was encrypted. */
  file?: EncryptedFile;
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

/**
 * Raw media upload: `POST /_matrix/media/v3/upload?filename=<name>`. Used instead of `client.uploadContent()`
 * because the SDK's browser (XMLHttpRequest) branch encodes the filename twice (`encodeURIComponent` and then
 * `URLSearchParams.set`), so Synapse stores `Voice%20message.webm` in Content-Disposition for any name with a
 * space (matrix-js-sdk v43, `http-api/index.js`; the Node/fetch branch encodes once, which is why scripts never
 * showed it). Rate limits are retried; errors are `MatrixError` like the SDK's. Resolves with the mxc URL.
 */
export async function uploadMedia(blob: Blob, opts: { name?: string; type?: string } = {}): Promise<string> {
  const client = getClient();
  const base = client.baseUrl.replace(/\/+$/, '');
  const url = `${base}/_matrix/media/v3/upload${opts.name ? `?filename=${encodeURIComponent(opts.name)}` : ''}`;
  return retryOnRateLimit(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.getAccessToken() ?? ''}`,
        'Content-Type': opts.type || blob.type || 'application/octet-stream',
      },
      body: blob,
    });
    const text = await res.text();
    let json: { content_uri?: string; errcode?: string; error?: string } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      json = { error: text };
    }
    if (!res.ok || !json.content_uri) throw new MatrixError(json, res.status, url);
    return json.content_uri;
  }, 'Uploading');
}

/**
 * Phase 5: encrypt a blob (AES-256-CTR, spec "Sending encrypted attachments") and upload the ciphertext as
 * `application/octet-stream` under a neutral name, so the server sees neither content, type nor filename.
 * Resolves with the `file` object for the event (`{ url, key, iv, hashes, v }`). Needs a secure context.
 */
export async function uploadEncryptedMedia(blob: Blob): Promise<EncryptedFile> {
  const { data, info } = await encryptAttachment(await blob.arrayBuffer());
  const url = await uploadMedia(new Blob([data], { type: 'application/octet-stream' }), { name: 'encrypted', type: 'application/octet-stream' });
  return { url, ...info };
}

/**
 * Upload a file to the media repo. Returns the mxc URL plus metadata for the `info` block. Phase 5: with
 * `opts.encrypt` (the default when `opts.roomId` is an encrypted room) the bytes are encrypted first and the
 * result carries `file`; put `file` (not `url`) in the event.
 */
export async function uploadFile(file: File, opts: { encrypt?: boolean; roomId?: string } = {}): Promise<UploadResult> {
  const mimetype = file.type || 'application/octet-stream';
  const dims = mimetype.startsWith('image/') ? await imageDimensions(file) : undefined;
  const encrypt = opts.encrypt ?? isRoomEncrypted(opts.roomId);
  if (encrypt) {
    const enc = await uploadEncryptedMedia(file);
    return { mxc: enc.url, file: enc, mimetype, size: file.size, name: file.name, ...(dims ?? {}) };
  }
  const mxc = await uploadMedia(file, { name: file.name, type: mimetype });
  return { mxc, mimetype, size: file.size, name: file.name, ...(dims ?? {}) };
}

/**
 * Upload then send: `m.image` for image/*, `m.file` otherwise. Resolves with the event id. `threadRoot` sends it
 * into a thread. Phase 5: in an encrypted room the upload is encrypted and the event carries `file` instead of `url`.
 */
export async function sendFile(roomId: string, file: File, opts: ThreadOptions = {}): Promise<string> {
  const up = await uploadFile(file, { roomId });
  const isImage = up.mimetype.startsWith('image/');
  const info: Record<string, unknown> = { mimetype: up.mimetype, size: up.size };
  if (isImage && up.w && up.h) {
    info.w = up.w;
    info.h = up.h;
  }
  const content: Record<string, unknown> = { msgtype: isImage ? MsgType.Image : MsgType.File, body: up.name, info };
  if (up.file) content.file = up.file;
  else content.url = up.mxc;
  return sendRoomMessage(roomId, content, opts.threadRoot);
}

// ---------------------------------------------------------------------------
// Voice messages (Phase 2, PRIN-5)
// ---------------------------------------------------------------------------

export interface VoiceMessageOptions extends ThreadOptions {
  /** Integer milliseconds (from `analyzeAudio`, else the recorder's wall-clock timing). */
  durationMs: number;
  /** About 100 ints in 0..1024 (`analyzeAudio().waveform`). Sanitised here; `[]` is allowed. */
  waveform: number[];
  /**
   * The real mimetype of `blob`, i.e. what is uploaded: `encodeToOggOpus().mimetype` (audio/ogg after the
   * WebM -> Ogg remux), never the recorder's when they differ. Codec parameters are stripped for the event.
   */
  mimetype: string;
}

/**
 * Upload a recorded blob and send it as a Matrix voice message. The content is exactly the contract in
 * docs/archive/PHASE2_ACCEPTANCE.md ("Voice message event"), i.e. Element's `createVoiceMessageContent` shape:
 *
 *   msgtype m.audio, body "Voice message", url, info { duration, mimetype, size },
 *   org.matrix.msc1767.text "Voice message", org.matrix.msc1767.file { url, name, mimetype, size },
 *   org.matrix.msc1767.audio { duration, waveform }, org.matrix.msc3245.voice {}
 *
 * `blob` is the encoded upload (`encodeToOggOpus` output); `opts.mimetype` is its mimetype and drives the
 * upload Content-Type, `info.mimetype`, the msc1767 file mimetype and the file name (`voiceFileName`, e.g.
 * `Voice message.ogg`). `size` is `blob.size`, so it always matches the uploaded bytes.
 * Resolves with the event id. Throws on upload/send failure (Dev B shows `recording-error`, AC-V5-2).
 * Phase 3: `opts.threadRoot` sends the voice note into a thread (the thread relation is added to the content).
 * Phase 5: in an encrypted room the audio is encrypted before upload and `file` replaces `url` (top level and
 * inside `org.matrix.msc1767.file`, Element's shape).
 */
export async function sendVoiceMessage(roomId: string, blob: Blob, opts: VoiceMessageOptions): Promise<string> {
  const mimetype = containerMimeType(opts.mimetype || blob.type) || 'audio/webm';
  const name = voiceFileName(mimetype);
  const duration = Math.max(0, Math.round(opts.durationMs || 0));
  const waveform = sanitizeWaveform(opts.waveform);
  const size = blob.size;

  const content: Record<string, unknown> = {
    msgtype: MsgType.Audio,
    body: 'Voice message',
    info: { duration, mimetype, size },
    'org.matrix.msc1767.text': 'Voice message',
    'org.matrix.msc1767.audio': { duration, waveform },
    'org.matrix.msc3245.voice': {},
  };
  if (isRoomEncrypted(roomId)) {
    const file = await uploadEncryptedMedia(blob);
    content.file = file;
    content['org.matrix.msc1767.file'] = { file, name, mimetype, size };
  } else {
    const url = await uploadMedia(blob, { name, type: mimetype });
    content.url = url;
    content['org.matrix.msc1767.file'] = { url, name, mimetype, size };
  }
  return sendRoomMessage(roomId, content, opts.threadRoot);
}

// ---------------------------------------------------------------------------
// GIFs (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Send a picked GIF (`GifResult` from `getGifProvider().search()/trending()`). Nothing is uploaded: Klipy's
 * integration terms forbid re-hosting its media, so the message is `m.text` with body "<title> <url>" (Element
 * shows the link and unfurls it with URL previews) plus the structured `dev.matrixpoc.gif` field this client
 * renders inline (`getGifContent(event)` / `getDisplayBody(event).gif`). Exact shape: `src/lib/gif/message.ts`.
 * `threadRoot` sends it into a thread like every other send. Resolves with the event id.
 */
export async function sendGif(roomId: string, gif: GifResult, opts: ThreadOptions = {}): Promise<string> {
  const content: Record<string, unknown> = { ...buildGifContent(gif) };
  return sendRoomMessage(roomId, content, opts.threadRoot);
}

// ---------------------------------------------------------------------------
// Typing & receipts
// ---------------------------------------------------------------------------

/**
 * Send a typing notification. The server auto-expires it after `timeoutMs`.
 * Phase 3: `opts.threadRoot` is accepted for symmetry but **typing is room-scoped in Matrix** (there is no
 * thread-scoped typing in the spec or in Synapse); the notification is the same room-wide one.
 */
export async function sendTyping(roomId: string, typing: boolean, timeoutMs = 5000, _opts: ThreadOptions = {}): Promise<void> {
  await getClient().sendTyping(roomId, typing, timeoutMs);
}

export interface ReceiptOptions {
  /**
   * Thread the receipt is for: the root id, or 'main'. Informational: the SDK derives `thread_id` from the
   * event itself ('main' for main-timeline events and thread roots, the root id for thread replies), so the
   * event always wins. Pass it when `event` is an id that is not loaded locally.
   */
  threadId?: string;
}

/**
 * Send a read receipt for an event (usually the last one in the timeline). Clears unread counts.
 * Phase 3: the receipt carries `thread_id` ('main' or the thread root), so a receipt on a thread reply clears
 * that thread's unread count and a receipt on the main timeline no longer touches threads.
 * Read receipts: the type follows the "Send read receipts" setting (`getSendReadReceipts`): `m.read` when ON,
 * `m.read.private` when OFF. Both clear my unread counts (Synapse and the SDK's `clearNotificationsOnReceipt`
 * treat them alike, and the SDK adds the local-echo receipt for either type); only `m.read` is shown to others.
 * The thread id is derived from the event by the SDK for both types. Every receipt send goes through here.
 */
export async function sendReadReceipt(roomId: string, event: MatrixEvent | string, opts: ReceiptOptions = {}): Promise<void> {
  const client = getClient();
  const room = client.getRoom(roomId);
  let ev = typeof event === 'string' ? room?.findEventById(event) : event;
  if (!ev && typeof event === 'string' && !event.startsWith('~')) {
    ev = await fetchEvent(roomId, event);
    if (ev && opts.threadId && opts.threadId !== 'main' && !getThreadRelation(ev)) ev.setThreadId(opts.threadId);
  }
  if (!ev || !ev.getId() || ev.getId()!.startsWith('~')) return; // skip local echoes
  await client.sendReadReceipt(ev, getSendReadReceipts(client) ? ReceiptType.Read : ReceiptType.ReadPrivate);
}

/** Newest event with a server id and sent status, scanning backwards. */
function newestSent(events: MatrixEvent[], skipId?: string): MatrixEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const id = ev.getId();
    if (ev.status === null && id && !id.startsWith('~') && id !== skipId) return ev;
  }
  return undefined;
}

/** Mark a room fully read using the newest event in its live timeline (main timeline; threads keep their own). */
export async function markRoomRead(roomId: string): Promise<void> {
  const room = getClient().getRoom(roomId);
  const ev = newestSent(room?.getLiveTimeline().getEvents() ?? []);
  if (ev) await sendReadReceipt(roomId, ev);
}

/** Phase 3: mark a thread read with a receipt on its newest reply (no-op when no reply is loaded). */
export async function markThreadRead(roomId: string, threadRootId: string): Promise<void> {
  const thread = getClient().getRoom(roomId)?.getThread(threadRootId);
  const ev = thread ? newestSent(thread.events, threadRootId) : undefined;
  if (ev && isThreadReply(ev)) await sendReadReceipt(roomId, ev, { threadId: threadRootId });
}

// ---------------------------------------------------------------------------
// Rooms, spaces, DMs
// ---------------------------------------------------------------------------

function viaFor(): string[] {
  return [serverNameOf(getClient().getSafeUserId())];
}

/** Phase 5: the `m.room.encryption` state event new rooms and DMs are created with. */
export const ENCRYPTION_INITIAL_STATE = { type: EventType.RoomEncryption, state_key: '', content: { algorithm: MEGOLM_ALGORITHM } } as const;

/**
 * Create a channel inside a space (sets m.space.parent + m.space.child). Phase 5: **encrypted by default**
 * (`m.room.encryption` in `initial_state`); pass `encrypted: false` for a plaintext channel. Join rule stays
 * public within the space, history `shared`, as before.
 */
export async function createChannel(opts: { spaceId: string; name: string; topic?: string; encrypted?: boolean }): Promise<string> {
  const client = getClient();
  const via = viaFor();
  const encrypted = opts.encrypted ?? true;
  const { room_id } = await retryOnRateLimit(
    () =>
      client.createRoom({
        room_version: ROOM_VERSION,
        name: opts.name,
        topic: opts.topic,
        preset: Preset.PublicChat,
        visibility: Visibility.Private,
        initial_state: [
          { type: EventType.SpaceParent, state_key: opts.spaceId, content: { via, canonical: true } },
          ...(encrypted ? [ENCRYPTION_INITIAL_STATE] : []),
        ],
        // Phase 7: calls are state events; let every member start / join one (the public preset needs PL 50 otherwise).
        power_level_content_override: { events: { ...CALL_POWER_LEVELS } },
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

/** Create a space (spaces are never encrypted, as in Element) with one `general` channel (encrypted by default). Resolves with the space room id. */
export async function createSpace(opts: { name: string; topic?: string; encrypted?: boolean }): Promise<string> {
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
  await createChannel({ spaceId: room_id, name: 'general', encrypted: opts.encrypted });
  return room_id;
}

/** Phase 5: turn encryption on in an existing room (irreversible, as the spec says). No-op when already on. */
export async function enableRoomEncryption(roomId: string): Promise<void> {
  if (isRoomEncrypted(roomId)) return;
  await retryOnRateLimit(
    () => getClient().sendStateEvent(roomId, EventType.RoomEncryption, { algorithm: MEGOLM_ALGORITHM }, ''),
    'Enabling encryption',
  );
}

/**
 * Phase 5: start preparing the Megolm session for a room (member list + device keys + key shares) before the
 * user hits Enter, so the first encrypted send is fast. Call it on composer focus; harmless in plaintext rooms.
 */
export function prepareToEncrypt(roomId: string): void {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  const crypto = client?.getCrypto();
  if (!room || !crypto || !room.hasEncryptionStateEvent()) return;
  crypto.prepareToEncrypt(room);
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

/**
 * Reuse the existing DM with `userId` or create one (is_direct + trusted_private_chat) and record it in m.direct.
 * Phase 5: new DMs are **encrypted by default** (`encrypted: false` opts out); an existing DM is reused as is.
 */
export async function createDm(userId: string, opts: { encrypted?: boolean } = {}): Promise<string> {
  const existing = findDmRoomId(userId);
  if (existing) return existing;
  const encrypted = opts.encrypted ?? true;
  const { room_id } = await retryOnRateLimit(
    () =>
      getClient().createRoom({
        room_version: ROOM_VERSION,
        is_direct: true,
        preset: Preset.TrustedPrivateChat,
        invite: [userId],
        initial_state: encrypted ? [ENCRYPTION_INITIAL_STATE] : [],
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

/**
 * Aggregated reactions for an event, from the SDK's relations container. Safe to call in render.
 * Phase 3: reactions to thread replies are aggregated in the thread's own timeline set; this looks there
 * when the target is a thread reply, so one call works for both timelines.
 */
export function getReactions(roomId: string, eventId: string): ReactionSummary[] {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return [];
  const target = room.findEventById(eventId);
  const thread = target && isThreadReply(target) ? target.getThread() : undefined;
  const container = thread ? thread.timelineSet.relations : room.getUnfilteredTimelineSet().relations;
  const relations = container.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction);
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

/** Find an event in the room's loaded timelines (main and threads) or fetch it from the server (for reply quotes). */
export async function fetchEvent(roomId: string, eventId: string): Promise<MatrixEvent | undefined> {
  const client = getClient();
  const local = client.getRoom(roomId)?.findEventById(eventId);
  if (local) return local;
  try {
    const raw = await client.fetchRoomEvent(roomId, eventId);
    return client.getEventMapper()(raw);
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
  // Phase 4: GIF messages are not editable (docs/archive/PHASE4_ACCEPTANCE.md; `message-action-edit` hidden on GIF rows).
  // Phase 5: nor are events still encrypted / undecryptable (`getType()` is the clear type once decrypted).
  return (
    !!me &&
    event.getSender() === me &&
    !event.isRedacted() &&
    event.getType() === EventType.RoomMessage &&
    !event.isDecryptionFailure() &&
    !isGifEvent(event)
  );
}

/** Current user's power level in a room (0 when unknown). */
export function myPowerLevel(roomId: string): number {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return 0;
  return room.getMember(client.getSafeUserId())?.powerLevel ?? 0;
}

// ---------------------------------------------------------------------------
// Thread list (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Load the room's thread list from the server (`GET /_matrix/client/v1/rooms/{id}/threads`, `include=all` and
 * `include=participated`, newest 30 by last activity) into the SDK: creates `room.threadsTimelineSets` on
 * first use and runs `room.fetchRoomThreads()`, which instantiates a `Thread` model per root. Idempotent: the
 * SDK fetches once per room (`threadsReady`); later activity arrives through /sync. After it resolves,
 * `room.getThreads()` lists every known thread (also those discovered from the live timeline).
 */
export async function fetchRoomThreads(roomId: string): Promise<void> {
  const room = roomOrNull(roomId);
  if (!room) return;
  await room.createThreadsTimelineSets();
  await room.fetchRoomThreads();
}

/** True when the server has more (older) threads than the list loaded so far. */
export function hasMoreRoomThreads(roomId: string): boolean {
  const set = roomOrNull(roomId)?.threadsTimelineSets[0];
  if (!set) return true; // not fetched yet
  return set.getLiveTimeline().getPaginationToken(Direction.Backward) !== null;
}

/** Load the next (older) page of the thread list (30 threads). Resolves false when there was nothing more. */
export async function loadMoreRoomThreads(roomId: string, limit = 30): Promise<boolean> {
  const room = roomOrNull(roomId);
  if (!room) return false;
  await fetchRoomThreads(roomId);
  const set = room.threadsTimelineSets[0];
  if (!set) return false;
  const timeline = set.getLiveTimeline();
  if (!timeline.getPaginationToken(Direction.Backward)) return false;
  return getClient().paginateEventTimeline(timeline, { backwards: true, limit });
}

/** Pending (unsent / failed) status of an event, for completeness of the thread local-echo story. */
export function isSending(event: MatrixEvent): boolean {
  return event.status === EventStatus.SENDING || event.status === EventStatus.QUEUED || event.status === EventStatus.ENCRYPTING;
}
