import { useSessionStore } from '@/store/session.ts';
import styles from './LoadingScreen.module.css';

/**
 * Full-screen loading state shown until the initial sync is PREPARED. Phase 5: `data-stage` is `crypto` while
 * the encryption engine loads (WASM + key store), then `sync`.
 */
export function LoadingScreen() {
  const error = useSessionStore((s) => s.error);
  const userId = useSessionStore((s) => s.userId);
  const stage = useSessionStore((s) => s.loadingStage) ?? 'sync';
  const text = stage === 'crypto' ? 'Setting up encryption...' : userId ? `Syncing as ${userId}...` : 'Connecting...';
  return (
    <div className={styles.root} data-testid="app-loading" data-stage={stage}>
      <div className={styles.logo} aria-hidden="true">
        A
      </div>
      <div className={styles.spinner} aria-hidden="true" />
      <div className={styles.text}>{text}</div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
