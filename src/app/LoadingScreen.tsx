import { useSessionStore } from '@/store/session.ts';
import styles from './LoadingScreen.module.css';

/** Full-screen loading state shown until the initial sync is PREPARED. */
export function LoadingScreen() {
  const error = useSessionStore((s) => s.error);
  const userId = useSessionStore((s) => s.userId);
  return (
    <div className={styles.root} data-testid="app-loading">
      <div className={styles.logo} aria-hidden="true">
        A
      </div>
      <div className={styles.spinner} aria-hidden="true" />
      <div className={styles.text}>{userId ? `Syncing as ${userId}...` : 'Connecting...'}</div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
