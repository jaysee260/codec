import { LogOut, ShieldCheck } from 'lucide-react';
import { useSessionStore } from '@/store/session.ts';
import { useSecurityStore } from '@/store/security.ts';
import { mxcToHttp } from '@/lib/matrix/mxc.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { localpartOf } from '@/lib/matrix/config.ts';
import styles from './UserFooter.module.css';

/**
 * Bottom-left user pill: avatar, display name, user id, logout. testids: current-user, logout-button.
 * Phase 5: `data-verified` mirrors `useSecurityStore.status.verified` (`unknown` until the first status snapshot);
 * a verified session shows "Verified" with a shield under the name instead of the user id.
 */
export function UserFooter() {
  const userId = useSessionStore((s) => s.userId) ?? '';
  const displayName = useSessionStore((s) => s.displayName) || localpartOf(userId);
  const avatarMxc = useSessionStore((s) => s.avatarUrl);
  const logout = useSessionStore((s) => s.logout);
  const syncState = useSessionStore((s) => s.syncState);
  const verified = useSecurityStore((s) => s.status?.verified ?? null);
  const avatar = mxcToHttp(avatarMxc, 32, 32, 'crop');
  const reconnecting = syncState === 'ERROR' || syncState === 'RECONNECTING';

  return (
    <div className={styles.footer}>
      <div className={styles.user} data-testid="current-user" data-verified={verified === null ? 'unknown' : String(verified)} title={userId}>
        <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(userId) }}>
          {avatar ? <img src={avatar} alt="" /> : initialsOf(displayName)}
          <span className={`${styles.status} ${reconnecting ? styles.statusOff : ''}`} aria-hidden="true" />
        </span>
        <span className={styles.names}>
          <span className={`${styles.name} u-truncate`}>{displayName}</span>
          <span className={`${styles.sub} u-truncate`}>
            {reconnecting ? (
              'Reconnecting...'
            ) : verified ? (
              <span className={styles.verified} data-testid="current-user-verified">
                <ShieldCheck size={12} aria-hidden="true" /> Verified
              </span>
            ) : (
              userId
            )}
          </span>
        </span>
      </div>
      <button className={styles.logout} data-testid="logout-button" title="Log out" onClick={() => void logout()}>
        <LogOut size={18} />
      </button>
    </div>
  );
}
