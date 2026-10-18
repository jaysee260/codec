/**
 * Read receipts: the pure part (no client, no React, no `@/` imports, nothing touching `import.meta.env`), so
 * plain Node can import it for `src/lib/matrix/receipts-core.test.ts`. `receipts.ts` binds these to the SDK's
 * `Room` / `Thread` receipt holders and re-exports everything here.
 *
 * Vocabulary (docs/RECEIPTS_PLAN.md):
 *  - a user's **read point** is the newest event their latest receipt (or a later message of theirs) covers;
 *  - a **displayed row** is an event the list renders (`useTimeline().events`); receipts often point at hidden
 *    events (reactions, edits, redactions, state), so a read point is attached to the nearest displayed row at or
 *    before it;
 *  - the **sent check** is shown on exactly one row: my newest sent message, when it is the newest displayed row
 *    and nobody else has read it yet (Advisor risk 2).
 */
import { EventStatus, type MatrixEvent } from 'matrix-js-sdk';

/** Send status of one of **my** rows; `null` for other people's messages. */
export type SendStatus = 'sending' | 'sent' | 'failed' | null;

/** A user who has read up to a row, with the receipt's timestamp (0 when the SDK has no timestamp for it). */
export interface Reader {
  userId: string;
  displayName: string;
  /** http(s) URL (already sized for a small avatar), or null when the user has none. */
  avatarUrl: string | null;
  ts: number;
}

/**
 * Send status of an event for the current user (`null` unless I sent it). Local-echo lifecycle in v43 (E2EE
 * rooms included): `ENCRYPTING -> QUEUED / SENDING -> SENT -> null`; the id swaps from `~txnId` to `$event` at
 * `SENT`, and the remote echo sets `status` to `null`. `SENT` already means the homeserver has the message
 * ("delivered" in Matrix), so it maps to `'sent'`; `NOT_SENT` / `CANCELLED` map to `'failed'` (Dev B keeps the
 * existing failed UI); everything else is `'sending'`.
 */
export function getSendStatus(event: MatrixEvent | null | undefined, myUserId: string | null | undefined): SendStatus {
  if (!event || !myUserId || event.getSender() !== myUserId) return null;
  const status = event.status;
  if (status === null || status === EventStatus.SENT) return 'sent';
  if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) return 'failed';
  return 'sending';
}

/** One user's read point before it is mapped onto a row: the event id their receipt resolves to. */
export interface ReadPoint {
  userId: string;
  eventId: string;
}

/**
 * Map read points onto displayed rows. `orderedIds` is the holder's whole live timeline (oldest first; hidden
 * events included) and `displayedIds` the subset the list renders, in the same order. A read point lands on the
 * nearest displayed row at or before it; points at events outside `orderedIds` (not loaded) or before the first
 * displayed row are dropped. Each row's user list keeps the input order (callers pass readers sorted by ts).
 */
export function mapReadPointsToRows(orderedIds: readonly string[], displayedIds: readonly string[], points: readonly ReadPoint[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!points.length || !displayedIds.length) return out;
  const position = new Map<string, number>();
  orderedIds.forEach((id, i) => position.set(id, i));
  // Positions of the displayed rows inside the ordered timeline, ascending (a displayed id missing from the
  // timeline is skipped rather than guessed).
  const rows: { pos: number; id: string }[] = [];
  for (const id of displayedIds) {
    const pos = position.get(id);
    if (pos !== undefined) rows.push({ pos, id });
  }
  rows.sort((a, b) => a.pos - b.pos);
  for (const point of points) {
    const pos = position.get(point.eventId);
    if (pos === undefined) continue;
    const row = rowAtOrBefore(rows, pos);
    if (!row) continue;
    const list = out.get(row);
    if (list) list.push(point.userId);
    else out.set(row, [point.userId]);
  }
  return out;
}

/** Binary search: the id of the last row whose position is <= pos, or null. */
function rowAtOrBefore(rows: readonly { pos: number; id: string }[], pos: number): string | null {
  let lo = 0;
  let hi = rows.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.pos <= pos) {
      found = rows[mid]!.id;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The row that shows the single "sent" check (Element rule, Advisor risk 2): the newest displayed row, when it is
 * mine, has a server id and status `sent`, and no other user's read point sits on it. Otherwise `null` (while my
 * newest message is still sending the row shows the "sending" indicator from `getSendStatus` instead; once
 * someone reads it their avatars replace the check; once someone else posts after it there is nothing to show).
 */
export function pickLatestOwnSentId(
  displayedEvents: readonly MatrixEvent[],
  myUserId: string | null | undefined,
  readPoints: ReadonlyMap<string, readonly unknown[]>,
): string | null {
  if (!myUserId || !displayedEvents.length) return null;
  const last = displayedEvents[displayedEvents.length - 1]!;
  const id = last.getId();
  if (!id || id.startsWith('~')) return null;
  if (getSendStatus(last, myUserId) !== 'sent') return null;
  if ((readPoints.get(id)?.length ?? 0) > 0) return null;
  return id;
}

// ---------------------------------------------------------------------------
// "Send read receipts" setting (account data `im.vector.web.settings`, key `sendReadReceipts`; Element's home)
// ---------------------------------------------------------------------------

/** Element's account-data event type for web settings; Codec shares it so the setting follows the user. */
export const RECEIPT_SETTINGS_EVENT_TYPE = 'im.vector.web.settings';
/** The key inside that event. `false` = send `m.read.private`; missing / anything else = public `m.read`. */
export const SEND_READ_RECEIPTS_KEY = 'sendReadReceipts';

/** Default ON: only an explicit `false` turns public receipts off. */
export function readSendReadReceipts(content: Record<string, unknown> | null | undefined): boolean {
  return content?.[SEND_READ_RECEIPTS_KEY] !== false;
}

/** The content to write back: every other key of `im.vector.web.settings` is preserved (merge, never clobber). */
export function mergeSendReadReceipts(content: Record<string, unknown> | null | undefined, on: boolean): Record<string, unknown> {
  return { ...(content ?? {}), [SEND_READ_RECEIPTS_KEY]: on };
}

/** Sort helper for readers: newest receipt first, then user id for a stable order. */
export function compareReaders(a: Reader, b: Reader): number {
  return b.ts - a.ts || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
}

/** True when two reader lists are the same users with the same data, in the same order (identity reuse). */
export function sameReaders(a: readonly Reader[] | undefined, b: readonly Reader[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.userId !== y.userId || x.ts !== y.ts || x.displayName !== y.displayName || x.avatarUrl !== y.avatarUrl) return false;
  }
  return true;
}
