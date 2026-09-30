/**
 * Placeholder ChannelHeader (Dev A replaces the internals). Column-3 top bar.
 * testids: channel-header, channel-header-name, channel-header-topic, member-toggle
 */
import { AtSign, Hash, Users } from 'lucide-react';
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
      <span className={styles.icon} aria-hidden="true">
        {room.isDm ? <AtSign size={20} /> : <Hash size={20} />}
      </span>
      <span className={`${styles.name} u-truncate`} data-testid="channel-header-name">
        {room.name}
      </span>
      {room.topic && (
        <>
          <span className={styles.divider} />
          <span className={`${styles.topic} u-truncate`} data-testid="channel-header-topic" title={room.topic}>
            {room.topic}
          </span>
        </>
      )}
      <span className={styles.spacer} />
      {!room.isDm && (
        <button
          className={`${styles.toggle} ${membersOpen ? styles.toggleActive : ''}`}
          data-testid="member-toggle"
          title={membersOpen ? 'Hide member list' : 'Show member list'}
          aria-pressed={membersOpen}
          onClick={toggleMembers}
        >
          <Users size={20} />
        </button>
      )}
    </div>
  );
}
