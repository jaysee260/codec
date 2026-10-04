/**
 * Read-only helpers over SDK objects (rooms, members, events). Safe to call during render.
 */
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixEvent,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import { getClientOrNull } from './client.ts';
import { localpartOf } from './config.ts';
import { mxcToHttp } from './mxc.ts';
import { sanitizeWaveform } from '../audio/analysis.ts';
import { isAudioMimeType } from '../audio/mime.ts';

export { mxcToHttp } from './mxc.ts';
export { formatTime, formatFullTime, formatDayDivider, isSameDay, initialsOf, colorFor } from '../format.ts';
export { localpartOf, serverNameOf } from './config.ts';

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
  const client = getClientOrNull();
  if (!client) return '';
  return room.getAvatarUrl(client.baseUrl, size, size, 'crop', true) ?? '';
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
 * Keeps: m.room.message (incl. redacted ones, rendered as "Message deleted"), m.sticker.
 * Drops: reactions, edits (aggregated onto their target), state events, everything else.
 */
export function isDisplayableEvent(event: MatrixEvent): boolean {
  const type = event.getType();
  if (type === EventType.Sticker) return true;
  if (type !== EventType.RoomMessage) return false;
  if (isEditEvent(event)) return false;
  return true;
}

/** Event id this event replies to (from `m.relates_to.m.in_reply_to`), or undefined. */
export function getReplyTargetId(event: MatrixEvent): string | undefined {
  const rel = event.getWireContent()['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined;
  return rel?.['m.in_reply_to']?.event_id ?? undefined;
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
  /** For m.image / m.file / m.video / m.audio: the media mxc url and info block. */
  url?: string;
  info?: { w?: number; h?: number; mimetype?: string; size?: number; thumbnail_url?: string; duration?: number };
  /** `m.mentions.user_ids` when present. */
  mentions: string[];
  /** Present for `m.audio` events that carry playable media (voice notes and plain audio files). */
  voice?: VoiceMessageInfo;
}

interface MessageContent {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  url?: string;
  info?: DisplayBody['info'];
  'm.mentions'?: { user_ids?: string[] };
}

// ---------------------------------------------------------------------------
// Voice messages (Phase 2, PRIN-5)
// ---------------------------------------------------------------------------

export interface VoiceMessageInfo {
  /** http(s) download URL (`mxcToHttp(mxc)`), for `<audio src>`. */
  url: string;
  mxc: string;
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
  'org.matrix.msc1767.file'?: { url?: string; name?: string; mimetype?: string; size?: number };
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
  const mxc = (typeof c.url === 'string' && c.url) || (typeof file?.url === 'string' ? file.url : '');
  if (!mxc.startsWith('mxc://')) return null;
  return {
    url: mxcToHttp(mxc),
    mxc,
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

/**
 * What to render for a message event, with edits already applied (the SDK swaps `getContent()`
 * to the latest `m.new_content` once the replacement event has been seen).
 */
export function getDisplayBody(event: MatrixEvent): DisplayBody {
  const isRedacted = event.isRedacted();
  const content = event.getContent<MessageContent>();
  const msgtype = content.msgtype ?? (event.getType() === EventType.Sticker ? 'm.sticker' : MsgType.Text);
  const replyTo = getReplyTargetId(event);
  const rawText = isRedacted ? '' : (content.body ?? '');
  const text = replyTo ? stripReplyFallback(rawText) : rawText;
  let html: string | undefined;
  if (!isRedacted && content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string') {
    html = replyTo ? stripHtmlReplyFallback(content.formatted_body) : content.formatted_body;
  }
  const voice = !isRedacted && msgtype === MsgType.Audio ? (getVoiceMessage(event) ?? undefined) : undefined;
  return {
    text: voice?.isVoice && !text ? 'Voice message' : text,
    html,
    msgtype,
    isEdited: !isRedacted && !!event.replacingEvent(),
    isRedacted,
    replyTo,
    url: isRedacted ? undefined : content.url,
    info: isRedacted ? undefined : content.info,
    mentions: content['m.mentions']?.user_ids ?? [],
    voice,
  };
}

/** Short preview text for a message (used by reply quotes, DM list previews). */
export function previewText(event: MatrixEvent, max = 120): string {
  const body = getDisplayBody(event);
  if (body.isRedacted) return 'Message deleted';
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
