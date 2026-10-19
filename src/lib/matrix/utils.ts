/**
 * Read-only helpers over SDK objects (rooms, members, events). Safe to call during render.
 */
import {
  EventType,
  MatrixEvent,
  MsgType,
  RelationType,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { getClientOrNull } from './client.ts';
import { localpartOf } from './config.ts';
import { mxcToHttp } from './mxc.ts';
import { isEncryptedFile, type EncryptedFile } from './attachments.ts';
import { sanitizeWaveform } from '../audio/analysis.ts';
import { isAudioMimeType } from '../audio/mime.ts';
import { parseGifContent } from '../gif/message.ts';
import { describeCallEvent, isCallTimelineEvent } from '../rtc/timeline.ts';
import type { GifMessage } from '../gif/types.ts';

export { mxcToHttp } from './mxc.ts';
export { formatTime, formatFullTime, formatDayDivider, formatRelative, isSameDay, initialsOf, colorFor } from '../format.ts';
export { localpartOf, serverNameOf } from './config.ts';
export { isEncryptedFile, type EncryptedFile } from './attachments.ts';

/** Phase 5: `m.room.encryption` algorithm every encrypted room uses. */
export const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';

/** Phase 5: true when the room has an `m.room.encryption` state event (sends are encrypted, history is Megolm). */
export function isRoomEncrypted(roomId: string | null | undefined): boolean {
  if (!roomId) return false;
  return getClientOrNull()?.getRoom(roomId)?.hasEncryptionStateEvent() ?? false;
}

// ---------------------------------------------------------------------------
// Rooms & members
// ---------------------------------------------------------------------------

/** Display name of a user in the context of a room (falls back to the global profile, then the localpart). */
export function displayNameOf(room: Room | null | undefined, userId: string): string {
  const member = room?.getMember(userId);
  if (member?.name) return member.name;
  const user = getClientOrNull()?.getUser(userId);
  return user?.displayName || localpartOf(userId);
}

/** Avatar URL (http) of a user in the context of a room, or '' when they have none. */
export function avatarUrlOf(room: Room | null | undefined, userId: string, size = 40): string {
  const mxc = room?.getMember(userId)?.getMxcAvatarUrl() ?? getClientOrNull()?.getUser(userId)?.avatarUrl;
  return mxcToHttp(mxc, size, size, 'crop');
}

/** Avatar URL of a member object. */
export function memberAvatarUrl(member: RoomMember, size = 40): string {
  return mxcToHttp(member.getMxcAvatarUrl(), size, size, 'crop');
}

/** Room avatar (http). For DMs without an explicit avatar, falls back to the other member's avatar. */
export function roomAvatarUrl(room: Room, size = 48): string {
  // Through mxcToHttp (not room.getAvatarUrl, which always builds unauthenticated v3 URLs).
  const mxc = room.getMxcAvatarUrl() ?? room.getAvatarFallbackMember()?.getMxcAvatarUrl();
  return mxcToHttp(mxc, size, size, 'crop');
}

/** Topic of a room or undefined. */
export function roomTopic(room: Room): string | undefined {
  const ev = room.currentState.getStateEvents(EventType.RoomTopic, '');
  const topic = ev?.getContent<{ topic?: string }>().topic;
  return topic?.trim() ? topic : undefined;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** True for `m.replace` relation events (edits). The SDK aggregates them onto the target. */
export function isEditEvent(event: MatrixEvent): boolean {
  return event.isRelation(RelationType.Replace);
}

/** True for `m.reaction` events. The SDK aggregates them via `timelineSet.relations`. */
export function isReactionEvent(event: MatrixEvent): boolean {
  return event.getType() === EventType.Reaction;
}

/**
 * Should this timeline event get its own row?
 * Keeps: m.room.message (incl. redacted ones, rendered as "Message deleted"), m.sticker, and (Phase 5) events
 * that are still encrypted (`m.room.encrypted`: being decrypted, or undecryptable - rendered as a placeholder;
 * `getType()` becomes the clear type once decrypted, so a decrypted reaction/edit drops out of the rows then),
 * except encrypted reactions / edits (`isEncryptedRelation`: wire relation, or redacted after being one).
 * Phase 7: keeps the call rows (the ring, the decline, `dev.matrixpoc.call`, and the membership state event that
 * opened a session nobody was rung for: `isCallTimelineEvent`); none of them can be a thread root or reply.
 * Drops: reactions, edits (aggregated onto their target), other state events, everything else.
 */
export function isDisplayableEvent(event: MatrixEvent): boolean {
  const type = event.getType();
  if (type === EventType.Sticker) return true;
  if (isCallTimelineEvent(event)) return !event.isRedacted() || type === 'dev.matrixpoc.call';
  if (type === EventType.RoomMessageEncrypted) return !isEncryptedRelation(event);
  if (type !== EventType.RoomMessage) return false;
  if (isEditEvent(event)) return false;
  return true;
}

/**
 * Ids of encrypted events known to be relations (reactions / edits), remembered for the session. Needed because a
 * **redacted** encrypted relation loses both its decrypted content and its wire `m.relates_to` (`makeRedacted`
 * prunes the content; MSC3389 is not in room v11), leaving a bare `m.room.encrypted` that would otherwise
 * render as "Message deleted". The bridge calls `noteEncryptedRelation` for every timeline / decrypted event.
 * Residual: a relation redacted before this session loaded cannot be told apart from a deleted message.
 */
const encryptedRelationIds = new Set<string>();

function isWireRelation(event: MatrixEvent): boolean {
  // `isRelation` reads `getWireContent()`, so an undecryptable edit / reaction is still recognised.
  return event.isRelation(RelationType.Replace) || event.isRelation(RelationType.Annotation) || event.getType() === EventType.Reaction;
}

/** Remember an encrypted event that is a reaction or an edit (call for every event the timeline sees). */
export function noteEncryptedRelation(event: MatrixEvent): void {
  if (!event.isEncrypted() || event.isRedacted()) return;
  const id = event.getId();
  if (id && !id.startsWith('~') && isWireRelation(event)) encryptedRelationIds.add(id);
}

/** Logout: forget the remembered ids. */
export function resetEncryptedRelations(): void {
  encryptedRelationIds.clear();
}

/**
 * True for an encrypted edit / reaction that must never be a row: still encrypted (decrypting or undecryptable)
 * with its relation in the clear on the wire, or redacted after this session saw it as a relation. Same rule as
 * `isHiddenEncryptedRelation` in Dev B's `useRoomEvents` (kept in step; the feature one also runs).
 */
export function isEncryptedRelation(event: MatrixEvent): boolean {
  if (!event.isEncrypted()) return false;
  if (event.isRedacted()) return encryptedRelationIds.has(event.getId() ?? '');
  return isWireRelation(event);
}

// ---------------------------------------------------------------------------
// Decryption (Phase 5)
// ---------------------------------------------------------------------------

/** What the row should show for an encrypted event. `'none'` = the event was never encrypted. */
export type DecryptionStatus = 'none' | 'decrypting' | 'decrypted' | 'failed';

export interface DecryptionState {
  status: DecryptionStatus;
  /** SDK reason code when `status === 'failed'` (`DecryptionFailureCode`). */
  code?: DecryptionFailureCode;
  /** Short user text for a failed row ("Waiting for this message's key"). */
  message?: string;
  /** Failed because the message predates this device: the recovery key / backup is the fix, not waiting. */
  historical?: boolean;
}

/** Row text per failure code; `historical` marks codes a backup restore (recovery key) can fix. */
export function describeDecryptionFailure(code: DecryptionFailureCode | null | undefined): { message: string; historical: boolean } {
  switch (code) {
    case DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID:
    case DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX:
      return { message: "Waiting for this message's key", historical: false };
    case DecryptionFailureCode.MEGOLM_KEY_WITHHELD:
      return { message: 'The sender withheld the key for this message', historical: false };
    case DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE:
      return { message: 'The sender only shares keys with verified sessions. Verify this session', historical: false };
    case DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP:
      return { message: 'Sent before you signed in here, and this account has no key backup', historical: true };
    case DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED:
      return { message: 'Sent before you signed in here. Enter your recovery key to read it', historical: true };
    case DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP:
      return { message: 'Sent before you signed in here. Restoring from backup...', historical: true };
    case DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED:
      return { message: "You weren't in the room when this was sent", historical: true };
    case DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED:
      return { message: "The sender's verified identity has changed", historical: false };
    case DecryptionFailureCode.UNSIGNED_SENDER_DEVICE:
    case DecryptionFailureCode.UNKNOWN_SENDER_DEVICE:
      return { message: 'Sent from an unverified or unknown device', historical: false };
    default:
      return { message: 'Unable to decrypt this message', historical: false };
  }
}

/**
 * Decryption state of an event, safe in render. Re-read on every `version` bump: the SDK mutates the event in
 * place and the bridge refreshes the timeline on `MatrixEventEvent.Decrypted` (late keys turn a failed row into a
 * message without any new timeline entry).
 */
export function getDecryptionState(event: MatrixEvent): DecryptionState {
  if (!event.isEncrypted()) return { status: 'none' };
  if (event.isDecryptionFailure()) {
    const code = event.decryptionFailureReason ?? DecryptionFailureCode.UNKNOWN_ERROR;
    return { status: 'failed', code, ...describeDecryptionFailure(code) };
  }
  if (event.isBeingDecrypted() || event.getType() === EventType.RoomMessageEncrypted) return { status: 'decrypting', message: 'Decrypting...' };
  return { status: 'decrypted' };
}

/**
 * Event id this event replies to (from `m.relates_to.m.in_reply_to`), or undefined.
 *
 * Phase 3: a thread reply carries `m.in_reply_to` pointing at the previous reply **as a fallback for clients
 * without thread support** (`is_falling_back: true`, spec 11.6.3). That is not a quote the user made, so it
 * is ignored here (Element's `shouldDisplayReply`); only an explicit reply inside a thread
 * (`is_falling_back: false`) is reported.
 */
export function getReplyTargetId(event: MatrixEvent): string | undefined {
  const rel = event.getWireContent()['m.relates_to'] as
    | { 'm.in_reply_to'?: { event_id?: string }; rel_type?: string; is_falling_back?: boolean }
    | undefined;
  const target = rel?.['m.in_reply_to']?.event_id;
  if (!target) return undefined;
  if (rel?.rel_type === RelationType.Thread && rel.is_falling_back === true) return undefined;
  return target;
}

// ---------------------------------------------------------------------------
// Threads (Phase 3)
// ---------------------------------------------------------------------------

/** Wire shape of `m.relates_to` on a thread reply (spec v1.4+, "Threading"). */
export interface ThreadRelation {
  rel_type: 'm.thread';
  /** The thread root event id. */
  event_id: string;
  /** True when `m.in_reply_to` is only the fallback for non-threaded clients (the normal case). */
  is_falling_back?: boolean;
  'm.in_reply_to'?: { event_id?: string };
}

/** The `m.thread` relation of a reply, or undefined for anything that is not a thread reply. */
export function getThreadRelation(event: MatrixEvent | null | undefined): ThreadRelation | undefined {
  const rel = event?.getWireContent()?.['m.relates_to'] as Partial<ThreadRelation> | undefined;
  return rel?.rel_type === RelationType.Thread && typeof rel.event_id === 'string' ? (rel as ThreadRelation) : undefined;
}

/** True for events sent *into* a thread (`m.relates_to.rel_type === 'm.thread'`). Never true for the root. */
export function isThreadReply(event: MatrixEvent): boolean {
  return !!getThreadRelation(event);
}

/**
 * True for a thread root: the server bundled an `m.thread` aggregation (`unsigned.m.relations.m.thread`) or the
 * SDK knows a `Thread` for it. A message nobody has replied to yet is not a root.
 */
export function isThreadRoot(event: MatrixEvent): boolean {
  return event.isThreadRoot;
}

/**
 * Root id of the thread an event belongs to: the relation target for replies, the event's own id for roots,
 * undefined for plain main-timeline events. Threads never nest, so this is always a main-timeline event id.
 */
export function getThreadRootId(event: MatrixEvent): string | undefined {
  return getThreadRelation(event)?.event_id ?? event.threadRootId ?? (event.isThreadRoot ? event.getId() : undefined);
}

/** Server-side `m.thread` aggregation on a root event (`unsigned.m.relations.m.thread`), parsed. */
export interface ThreadServerSummary {
  count: number;
  /** The newest reply as sent by the server (a bare MatrixEvent: no room state, no thread metadata). */
  latestEvent?: MatrixEvent;
  participated: boolean;
}

/**
 * `unsigned.m.relations.m.thread` of a root event -> `{ count, latestEvent, participated } | null`. Present on
 * roots from /sync, /messages, /threads and /event; this is what the summary row shows before the SDK `Thread`
 * model has loaded (docs/PHASE3_TICKETS.md Shared API).
 */
export function getThreadServerSummary(event: MatrixEvent | null | undefined): ThreadServerSummary | null {
  const bundle = event?.getServerAggregatedRelation<{
    count?: number;
    current_user_participated?: boolean;
    latest_event?: Record<string, unknown>;
  }>(RelationType.Thread);
  if (!bundle) return null;
  const latest = bundle.latest_event;
  const roomId = event?.getRoomId();
  return {
    count: typeof bundle.count === 'number' ? bundle.count : 0,
    latestEvent: latest ? new MatrixEvent({ ...latest, room_id: roomId } as never) : undefined,
    participated: !!bundle.current_user_participated,
  };
}

/**
 * Row filter for the **main** timeline: `isDisplayableEvent` minus thread replies. The SDK already keeps
 * `m.thread` replies out of `room.getLiveTimeline()` when `threadSupport` is on; this is the explicit
 * guarantee for `useRoomTimeline` / `useTimeline({ roomId })`.
 */
export function isMainTimelineEvent(event: MatrixEvent): boolean {
  return isDisplayableEvent(event) && !isThreadReply(event);
}

/** Strip the (legacy) plain-text reply fallback: leading "> " quoted lines up to the first blank line. */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) i++;
  if (i < lines.length && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

/** Strip the (legacy) HTML reply fallback `<mx-reply>...</mx-reply>`. */
export function stripHtmlReplyFallback(html: string): string {
  return html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '');
}

export interface DisplayBody {
  /** Plain text body (reply fallback removed; latest edit applied). */
  text: string;
  /** Sanitise with `sanitizeHtml()` before rendering. Only present for org.matrix.custom.html bodies. */
  html?: string;
  msgtype: string;
  isEdited: boolean;
  isRedacted: boolean;
  /** Event id of the message this one replies to. */
  replyTo?: string;
  /** For **unencrypted** m.image / m.file / m.video / m.audio: the media mxc url. Undefined for encrypted media (see `file`). */
  url?: string;
  info?: { w?: number; h?: number; mimetype?: string; size?: number; thumbnail_url?: string; thumbnail_file?: EncryptedFile; duration?: number };
  /**
   * Phase 5: for **encrypted** media, the spec `EncryptedFile` (`file` in the content) instead of `url`. Decrypt
   * with `fetchDecryptedMedia(file, info?.mimetype)` / `useDecryptedMediaUrl(body)`; there are no server thumbnails.
   */
  file?: EncryptedFile;
  /** Phase 5: encrypted thumbnail when the sender made one (`info.thumbnail_file`). */
  thumbnailFile?: EncryptedFile;
  /** `m.mentions.user_ids` when present. */
  mentions: string[];
  /** Present for `m.audio` events that carry playable media (voice notes and plain audio files). */
  voice?: VoiceMessageInfo;
  /** Phase 3: root event id when this message is a thread reply (`m.relates_to.rel_type === 'm.thread'`). */
  threadRoot?: string;
  /** Phase 4: present for GIF messages (`dev.matrixpoc.gif` validated). Render `<img src={gif.url}>`, not `text`. */
  gif?: GifMessage;
  /** Phase 5: true for events that arrived as `m.room.encrypted` (decrypted or not). */
  isEncrypted: boolean;
  /**
   * Phase 5: present when the event is still being decrypted or could not be decrypted. Render `decryption.message`
   * instead of `text` (`msgtype` is `m.bad.encrypted` for failures, `m.room.encrypted` while decrypting).
   */
  decryption?: DecryptionState;
}

interface MessageContent {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  url?: string;
  file?: unknown;
  info?: DisplayBody['info'];
  'm.mentions'?: { user_ids?: string[] };
}

// ---------------------------------------------------------------------------
// Voice messages (Phase 2, PRIN-5)
// ---------------------------------------------------------------------------

export interface VoiceMessageInfo {
  /** http(s) download URL (`mxcToHttp(mxc)`), for `<audio src>`. **Empty for encrypted notes**: use `file`. */
  url: string;
  /** The mxc url (of the ciphertext when encrypted). */
  mxc: string;
  /** Phase 5: set for encrypted notes; `fetchDecryptedMedia(file, mimetype)` gives the playable blob URL. */
  file?: EncryptedFile;
  /** Integer ms: `org.matrix.msc1767.audio.duration`, else `info.duration`, else 0 (player reads `<audio>`). */
  durationMs: number;
  /** Ints 0..1024; `[]` when the sender gave none (render flat bars). */
  waveform: number[];
  /** `info.mimetype`, else `msc1767.file.mimetype`, else `audio/ogg`; may carry codec parameters. */
  mimetype: string;
  size?: number;
  /** True when `org.matrix.msc3245.voice` is present (a voice note, not just an audio file). */
  isVoice: boolean;
  /** `msc1767.file.name`, else `body`. */
  name: string;
}

interface VoiceContent extends MessageContent {
  'org.matrix.msc3245.voice'?: Record<string, never>;
  'org.matrix.msc1767.audio'?: { duration?: number; waveform?: unknown };
  'org.matrix.msc1767.file'?: { url?: string; file?: unknown; name?: string; mimetype?: string; size?: number };
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/**
 * Parse an `m.audio` event (voice note or plain audio file) for playback. Returns null for anything else,
 * for redacted events and when there is no mxc url. Tolerates other clients' variants: the msc3245 key
 * alone, or an audio mimetype, is enough; missing waveform -> `[]`, missing duration -> 0.
 */
export function getVoiceMessage(event: MatrixEvent): VoiceMessageInfo | null {
  if (event.getType() !== EventType.RoomMessage || event.isRedacted()) return null;
  const c = event.getContent<VoiceContent>();
  const file = c['org.matrix.msc1767.file'];
  const audio = c['org.matrix.msc1767.audio'];
  const isVoice = Object.prototype.hasOwnProperty.call(c, 'org.matrix.msc3245.voice');
  const mimetype = c.info?.mimetype ?? file?.mimetype;
  if (c.msgtype !== MsgType.Audio && !isVoice && !isAudioMimeType(mimetype)) return null;
  // Phase 5: encrypted notes carry `file` (top level, Element also mirrors it under msc1767.file) instead of `url`.
  const encrypted = isEncryptedFile(c.file) ? c.file : isEncryptedFile(file?.file) ? file.file : undefined;
  const mxc = encrypted?.url ?? ((typeof c.url === 'string' && c.url) || (typeof file?.url === 'string' ? file.url : ''));
  if (!mxc.startsWith('mxc://')) return null;
  return {
    url: encrypted ? '' : mxcToHttp(mxc),
    mxc,
    file: encrypted,
    durationMs: asInt(audio?.duration) ?? asInt(c.info?.duration) ?? 0,
    waveform: sanitizeWaveform(audio?.waveform),
    mimetype: mimetype || 'audio/ogg',
    size: asInt(c.info?.size) ?? asInt(file?.size),
    isVoice,
    name: file?.name || c.body || 'Voice message',
  };
}

/** `m:ss` for a duration in ms (3120 -> "0:03"); rounds to the nearest second like the playback bubble. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// GIFs (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Parsed `dev.matrixpoc.gif` field of a GIF message (sent by `sendGif`), or null for anything else, for redacted
 * events, and for fields that fail validation (non-https / unknown host, missing or > 2000 px dimensions):
 * those fall back to the plain text row ("<title> <url>", auto-linked). Wire shape: `src/lib/gif/message.ts`.
 */
export function getGifContent(event: MatrixEvent): GifMessage | null {
  if (event.getType() !== EventType.RoomMessage || event.isRedacted()) return null;
  const content = event.getContent<MessageContent>();
  if (content.msgtype !== MsgType.Text) return null;
  return parseGifContent(content);
}

/** True when the event renders as an inline animated GIF (`getGifContent(event) !== null`). */
export function isGifEvent(event: MatrixEvent): boolean {
  return getGifContent(event) !== null;
}

/**
 * What to render for a message event, with edits already applied (the SDK swaps `getContent()`
 * to the latest `m.new_content` once the replacement event has been seen).
 */
export function getDisplayBody(event: MatrixEvent): DisplayBody {
  const isRedacted = event.isRedacted();
  const isEncrypted = event.isEncrypted();
  const replyTo = getReplyTargetId(event);
  const threadRoot = getThreadRelation(event)?.event_id;
  // Phase 5: still encrypted (decrypting) or undecryptable: a placeholder row, no content to read.
  const decryption = isEncrypted && !isRedacted ? getDecryptionState(event) : undefined;
  if (decryption && decryption.status !== 'decrypted') {
    return {
      text: decryption.message ?? '',
      msgtype: decryption.status === 'failed' ? 'm.bad.encrypted' : EventType.RoomMessageEncrypted,
      isEdited: false,
      isRedacted: false,
      replyTo,
      mentions: [],
      threadRoot,
      isEncrypted: true,
      decryption,
    };
  }
  const content = event.getContent<MessageContent>();
  const msgtype = content.msgtype ?? (event.getType() === EventType.Sticker ? 'm.sticker' : MsgType.Text);
  const rawText = isRedacted ? '' : (content.body ?? '');
  const text = replyTo ? stripReplyFallback(rawText) : rawText;
  let html: string | undefined;
  if (!isRedacted && content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string') {
    html = replyTo ? stripHtmlReplyFallback(content.formatted_body) : content.formatted_body;
  }
  const voice = !isRedacted && msgtype === MsgType.Audio ? (getVoiceMessage(event) ?? undefined) : undefined;
  const gif = !isRedacted && msgtype === MsgType.Text ? (parseGifContent(content) ?? undefined) : undefined;
  const file = !isRedacted && isEncryptedFile(content.file) ? content.file : undefined;
  const thumbnailFile = !isRedacted && isEncryptedFile(content.info?.thumbnail_file) ? content.info!.thumbnail_file : undefined;
  return {
    text: voice?.isVoice && !text ? 'Voice message' : text,
    html,
    msgtype,
    isEdited: !isRedacted && !!event.replacingEvent(),
    isRedacted,
    replyTo,
    url: isRedacted || file ? undefined : content.url,
    info: isRedacted ? undefined : content.info,
    file,
    thumbnailFile,
    mentions: content['m.mentions']?.user_ids ?? [],
    voice,
    threadRoot,
    gif,
    isEncrypted,
    decryption,
  };
}

/** Short preview text for a message (used by reply quotes, DM list previews). */
export function previewText(event: MatrixEvent, max = 120): string {
  if (isCallTimelineEvent(event)) {
    // AC-R3-7 / AC-R7-3: "Missed call" when the missed line names me; else "Call ended" / "Call declined" / "Voice call".
    if (event.isRedacted()) return 'Message deleted';
    const row = describeCallEvent(event, { displayName: event.getSender() ?? '', myUserId: getClientOrNull()?.getUserId() ?? undefined });
    return row?.previewText ?? '';
  }
  const body = getDisplayBody(event);
  if (body.isRedacted) return 'Message deleted';
  if (body.decryption && body.decryption.status !== 'decrypted') return body.decryption.status === 'failed' ? 'Unable to decrypt' : 'Decrypting...';
  if (body.gif) return `[gif] ${body.gif.title}`;
  if (body.msgtype === MsgType.Image) return `[image] ${body.text}`;
  if (body.msgtype === MsgType.File) return `[file] ${body.text}`;
  if (body.msgtype === MsgType.Audio) {
    if (body.voice?.isVoice) return '[voice message]';
    return `[audio] ${body.text}`;
  }
  const text = body.text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

/** Local-echo status helper: true while the event is still being sent (or failed). */
export function isPendingEvent(event: MatrixEvent): boolean {
  return event.status !== null;
}
