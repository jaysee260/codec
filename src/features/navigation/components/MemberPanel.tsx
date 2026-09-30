/**
 * Placeholder MemberPanel (Dev A replaces the internals). Right column; hidden for DMs and when toggled off.
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
  if (!open || !room || room.isDm) return null;

  return (
    <div className={styles.panel} data-testid="member-list">
      <span className="u-sr-only" data-testid="member-count">
        {joined.length}
      </span>
      <div className={styles.section} data-testid="member-section-online">
        <div className="u-section-title">Members - {joined.length}</div>
        {joined.map((m) => (
          <MemberRow key={m.userId} member={m} />
        ))}
      </div>
      {invited.length > 0 && (
        <div className={styles.section} data-testid="member-section-invited">
          <div className="u-section-title">Invited - {invited.length}</div>
          {invited.map((m) => (
            <MemberRow key={m.userId} member={m} dim />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberRow({ member, dim = false }: { member: MemberInfo; dim?: boolean }) {
  return (
    <div
      className={`${styles.row} ${dim ? styles.rowDim : ''}`}
      data-testid={`member-item-${member.userId}`}
      data-name={member.name}
      title={member.userId}
    >
      <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(member.userId) }}>
        {member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : initialsOf(member.name)}
        <span className={`${styles.presence} ${styles[member.presence] ?? ''}`} aria-hidden="true" />
      </span>
      <span className={`${styles.name} u-truncate`}>{member.name}</span>
      {member.powerLevel >= 100 && <Crown size={14} className={styles.crown} aria-label="Admin" />}
      {member.powerLevel >= 50 && member.powerLevel < 100 && (
        <Shield size={14} className={styles.shield} aria-label="Moderator" />
      )}
    </div>
  );
}
