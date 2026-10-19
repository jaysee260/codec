/**
 * DEV-B-38: a call line in the timeline (`message-call[data-kind]`): "bob started a voice call", "Call ended,
 * 12 min", "bob declined", "Missed call from bob" (red, with `call-back`) / "No answer from alice" for the caller.
 * The text and kind come from the call layer's `describeCallEvent` (ring, decline, the membership that opened a
 * drop-in call, and Codec's `dev.matrixpoc.call` ended / missed event); anything it does not describe renders
 * nothing. A grey centred system row like the day divider: no avatar, no grouping, no actions, no reactions, no
 * reply quote. Never rendered inside a thread (MessageList skips call events there).
 */
import type { MatrixEvent } from 'matrix-js-sdk';
import { Phone, PhoneMissed, PhoneOff, PhoneIncoming } from 'lucide-react';
import { describeCallEvent } from '@/lib/rtc';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { displayNameOf } from '@/lib/matrix/utils.ts';
import { formatFullTime, formatTime } from '@/lib/format.ts';
import { startCallFromUi } from '@/features/call';
import styles from './CallLineRow.module.css';

export { isCallLineEvent } from '../callEvents.ts';

/** The fields of `describeCallEvent`'s row this component reads (the extras arrive with the Wave 2 call layer). */
interface CallRow {
  kind: string;
  text: string;
  userId: string;
  missedByMe?: boolean;
  participants?: string[];
}

export type CallLineKind = 'started' | 'ended' | 'declined' | 'missed';

export interface CallLine {
  kind: CallLineKind;
  text: string;
  missedByMe: boolean;
}

/** Describe a call event for the row, or null (render nothing). */
export function callLineOf(event: MatrixEvent, roomId: string): CallLine | null {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId) ?? null;
  const me = client?.getUserId() ?? undefined;
  const sender = event.getSender() ?? '';
  const opts = { displayName: displayNameOf(room, sender), myUserId: me, nameOf: (userId: string) => displayNameOf(room, userId) };
  let row: CallRow | null;
  try {
    row = describeCallEvent(event, opts) as CallRow | null;
  } catch {
    return null;
  }
  if (!row || !row.text) return null;
  const kind: CallLineKind | null =
    row.kind === 'busy' || row.kind === 'declined' ? 'declined' : row.kind === 'started' || row.kind === 'ended' || row.kind === 'missed' ? row.kind : null;
  if (!kind) return null;
  const missedByMe =
    kind === 'missed' &&
    (row.missedByMe ?? (!!me && sender !== me && Array.isArray(row.participants) && row.participants.includes(me)));
  return { kind, text: row.text, missedByMe };
}

const ICONS = { started: PhoneIncoming, ended: PhoneOff, declined: PhoneOff, missed: PhoneMissed } as const;

export function CallLineRow({ event, roomId, flash = false }: { event: MatrixEvent; roomId: string; flash?: boolean }) {
  const line = callLineOf(event, roomId);
  if (!line) return null;
  const eventId = event.getId() ?? '';
  const ts = event.getTs();
  const Icon = ICONS[line.kind];
  return (
    <div
      className={`${styles.row} ${line.missedByMe ? styles.missed : ''} ${flash ? styles.flash : ''}`}
      data-testid="message-call"
      data-kind={line.kind}
      data-missed={line.missedByMe ? 'true' : undefined}
      data-event-id={eventId}
      data-sender={event.getSender()}
      role="note"
    >
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>{line.text}</span>
      <time className={styles.time} dateTime={new Date(ts).toISOString()} title={formatFullTime(ts)}>
        {formatTime(ts)}
      </time>
      {line.missedByMe && (
        <button type="button" className={styles.callBack} data-testid="call-back" onClick={() => void startCallFromUi(roomId)}>
          <Phone size={14} aria-hidden="true" />
          Call back
        </button>
      )}
    </div>
  );
}
