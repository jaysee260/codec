/**
 * DEV-A-4 member panel (column 4, 240 px). Hidden for DMs and when `member-toggle` is off.
 * Members are lazy-loaded: `useMembers` calls `loadMembers(roomId)` and re-reads the SDK room on every
 * `useRoomStore.version` bump, so the list fills in a moment after the room is opened.
 *
 * Presence is out of scope for the POC, so every joined member is listed under ONLINE (AC-A4-1).
 *
 * testids: member-list, member-count, member-section-online, member-section-invited, member-item-{userId}
 */
import { Crown, Shield } from 'lucide-react';
import { useMembers, useRoomSummary, type MemberInfo } from '@/store/hooks.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { useNavUiStore } from '../state.ts';
import styles from './MemberPanel.module.css';

export function MemberPanel({ roomId }: { roomId: string }) {
  const room = useRoomSummary(roomId);
  const open = useNavUiStore((s) => s.membersOpen);
  const { joined, invited } = useMembers(roomId);

  // Returning null collapses the shell's grid column.
  if (!open || !room || room.isDm) return null;

  return (
    <div className={styles.panel} data-testid="member-list">
      <div className={styles.section} data-testid="member-section-online">
        <h3 className={styles.sectionTitle}>
          Online &mdash;{' '}
          <span className={styles.count} data-testid="member-count">
            {joined.length}
          </span>
        </h3>
        {joined.map((member) => (
          <MemberRow key={member.userId} member={member} />
        ))}
        {joined.length === 0 && <div className={styles.empty}>Loading members...</div>}
      </div>

      {invited.length > 0 && (
        <div className={styles.section} data-testid="member-section-invited">
          <h3 className={styles.sectionTitle}>Invited &mdash; {invited.length}</h3>
          {invited.map((member) => (
            <MemberRow key={member.userId} member={member} pending />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberRow({ member, pending = false }: { member: MemberInfo; pending?: boolean }) {
  const isAdmin = member.powerLevel >= 100;
  const isMod = !isAdmin && member.powerLevel >= 50;
  return (
    <div
      className={`${styles.row} ${pending ? styles.rowPending : ''}`}
      data-testid={`member-item-${member.userId}`}
      data-name={member.name}
      title={`${member.name} (${member.userId})`}
    >
      <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(member.userId) }}>
        {member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : initialsOf(member.name)}
        <span className={`${styles.presence} ${pending ? styles.offline : styles.online}`} aria-hidden="true" />
      </span>
      <span className={`${styles.name} u-truncate`}>{member.name}</span>
      {isAdmin && <Crown size={14} className={styles.crown} aria-label="Admin" />}
      {isMod && <Shield size={14} className={styles.shield} aria-label="Moderator" />}
    </div>
  );
}
