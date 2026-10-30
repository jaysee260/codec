/**
 * Mac app (desktop/): the pure rules behind the Dock badge and the message notifications, kept free of the SDK so
 * node:test can run them. `index.ts` wires them to the stores and the client.
 */

/** What the Electron preload exposes on `window.codecDesktop` (desktop/src/preload.cjs). Absent in a browser. */
export interface CodecDesktopBridge {
  platform: string;
  /** Dock badge: 0 clears it. */
  setBadge(count: number): void;
  /** Show and focus the app window (it may be hidden in the menu bar). */
  focus(): void;
  /** Bounce the Dock icon until the app is focused (incoming call). */
  attention(): void;
}

export interface BadgeRoomLike {
  isSpace: boolean;
  unread: number;
}

/** Dock badge number: unread notifications across joined rooms (spaces carry none of their own) plus pending invites. */
export function badgeCount(rooms: Iterable<BadgeRoomLike>, inviteCount: number): number {
  let total = 0;
  for (const room of rooms) {
    if (!room.isSpace && room.unread > 0) total += room.unread;
  }
  return total + Math.max(0, inviteCount);
}

/** Older events are catch-up after the Mac slept or went offline: they move the badge but do not pop notifications. */
export const NOTIFY_MAX_AGE_MS = 2 * 60_000;
export const NOTIFY_BODY_MAX = 140;

export interface NotifyInput {
  /** Decrypted event type. */
  type: string;
  content: Record<string, unknown>;
  sender: string;
  senderName: string;
  roomName: string;
  isDm: boolean;
  originServerTs: number;
  myUserId: string;
  /** The push rules say this event notifies (`client.getPushActionsForEvent(event).notify`). */
  pushNotify: boolean;
  /** The room is on screen and the app window has focus: the user is already reading it. */
  viewing: boolean;
  now: number;
}

export interface DesktopNotification {
  title: string;
  body: string;
}

/** The notification for a new live event, or null when it should stay silent. */
export function notificationFor(input: NotifyInput): DesktopNotification | null {
  if (input.type !== 'm.room.message') return null;
  if (input.sender === input.myUserId || !input.pushNotify || input.viewing) return null;
  if (input.now - input.originServerTs > NOTIFY_MAX_AGE_MS) return null;
  const relation = input.content['m.relates_to'] as { rel_type?: string } | undefined;
  if (relation?.rel_type === 'm.replace') return null; // edits
  const body = describeMessage(input.content);
  if (body === null) return null;
  return {
    title: input.isDm ? input.senderName : `${input.senderName} in ${input.roomName}`,
    body: truncate(body, NOTIFY_BODY_MAX),
  };
}

function describeMessage(content: Record<string, unknown>): string | null {
  const msgtype = content.msgtype;
  const text = typeof content.body === 'string' ? content.body : '';
  if (content['dev.matrixpoc.gif']) return 'Sent a GIF';
  switch (msgtype) {
    case 'm.text':
    case 'm.notice':
      return stripReplyFallback(text);
    case 'm.emote':
      return `* ${text}`;
    case 'm.image':
      return 'Sent an image';
    case 'm.video':
      return 'Sent a video';
    case 'm.file':
      return 'Sent a file';
    case 'm.audio':
      return content['org.matrix.msc3245.voice'] !== undefined ? 'Sent a voice message' : 'Sent an audio file';
    default:
      return null;
  }
}

/** Older replies quote the parent as "> ..." lines followed by a blank line; keep only the reply itself. */
function stripReplyFallback(text: string): string {
  if (!text.startsWith('> ')) return text;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i < lines.length && lines[i] === '') i++;
  return i < lines.length ? lines.slice(i).join('\n') : text;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
