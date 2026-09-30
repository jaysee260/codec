import { LogOut } from 'lucide-react';
import { useSessionStore } from '@/store/session.ts';
import { mxcToHttp } from '@/lib/matrix/mxc.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { localpartOf } from '@/lib/matrix/config.ts';
import styles from './UserFooter.module.css';

/** Bottom-left user pill: avatar, display name, user id, logout. testids: current-user, logout-button */
export function UserFooter() {
  const userId = useSessionStore((s) => s.userId) ?? '';
  const displayName = useSessionStore((s) => s.displayName) || localpartOf(userId);
  const avatarMxc = useSessionStore((s) => s.avatarUrl);
  const logout = useSessionStore((s) => s.logout);
  const syncState = useSessionStore((s) => s.syncState);
  const avatar = mxcToHttp(avatarMxc, 32, 32, 'crop');
  const reconnecting = syncState === 'ERROR' || syncState === 'RECONNECTING';

  return (
    <div className={styles.footer}>
      <div className={styles.user} data-testid="current-user" title={userId}>
        <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(userId) }}>
          {avatar ? <img src={avatar} alt="" /> : initialsOf(displayName)}
          <span className={`${styles.status} ${reconnecting ? styles.statusOff : ''}`} aria-hidden="true" />
        </span>
        <span className={styles.names}>
          <span className={`${styles.name} u-truncate`}>{displayName}</span>
          <span className={`${styles.sub} u-truncate`}>{reconnecting ? 'Reconnecting...' : userId}</span>
        </span>
      </div>
      <button className={styles.logout} data-testid="logout-button" title="Log out" onClick={() => void logout()}>
        <LogOut size={18} />
      </button>
    </div>
  );
}
