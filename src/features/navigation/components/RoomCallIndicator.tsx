/**
 * DEV-A-34 / DEV-A-35 sidebar call bits shared by `ChannelList` and `DmList`.
 *
 * - `RoomCallIndicator`: `room-call-indicator[data-count]`, a green speaker (lucide `Volume2`) + the number of users in
 *   the room's live call, placed before the unread badge. `aria-label` / `title` "n in voice" (AC-R8-4).
 * - `MissedCallPreview`: the red "Missed call" preview text of a row whose last message is a missed call for me
 *   (the row itself carries `data-preview="missed-call"`, AC-R7-3). `block` = its own line under the name (DM rows).
 */
import { Volume2 } from 'lucide-react';
import styles from './RoomCallIndicator.module.css';

export function RoomCallIndicator({ count }: { count: number }) {
  const label = `${count} in voice`;
  return (
    <span className={styles.indicator} data-testid="room-call-indicator" data-count={count} role="img" aria-label={label} title={label}>
      <Volume2 size={14} aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
    </span>
  );
}

export function MissedCallPreview({ block = false }: { block?: boolean }) {
  return <span className={`${styles.missed} ${block ? styles.missedBlock : ''} u-truncate`}>Missed call</span>;
}
