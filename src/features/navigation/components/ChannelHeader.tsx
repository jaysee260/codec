/**
 * DEV-A-2 channel header (column 3 top bar, mounted by the shell above <Conversation/>).
 * `#name` (or `@name` for a DM), the topic, and the `member-toggle` that shows/hides the member panel.
 * The toggle and the panel are both hidden for DMs (AC-A3-3).
 *
 * testids: channel-header, channel-header-name, channel-header-topic, member-toggle
 */
import { Users } from 'lucide-react';
import { useRoomSummary } from '@/store/hooks.ts';
import { useNavUiStore } from '../state.ts';
import styles from './ChannelHeader.module.css';

export function ChannelHeader({ roomId }: { roomId: string }) {
  const room = useRoomSummary(roomId);
  const membersOpen = useNavUiStore((s) => s.membersOpen);
  const toggleMembers = useNavUiStore((s) => s.toggleMembers);

  if (!room) return <div className={styles.header} data-testid="channel-header" />;

  return (
    <div className={styles.header} data-testid="channel-header">
      <span className={styles.sigil} aria-hidden="true">
        {room.isDm ? '@' : '#'}
      </span>
      <span className={`${styles.name} u-truncate`} data-testid="channel-header-name">
        {room.name}
      </span>

      {room.topic && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <span className={`${styles.topic} u-truncate`} data-testid="channel-header-topic" title={room.topic}>
            {room.topic}
          </span>
        </>
      )}

      <span className={styles.spacer} />

      {!room.isDm && (
        <button
          type="button"
          className={`${styles.toggle} ${membersOpen ? styles.toggleActive : ''}`}
          data-testid="member-toggle"
          title={membersOpen ? 'Hide Member List' : 'Show Member List'}
          aria-label={membersOpen ? 'Hide Member List' : 'Show Member List'}
          aria-pressed={membersOpen}
          onClick={toggleMembers}
        >
          <Users size={20} />
        </button>
      )}
    </div>
  );
}
