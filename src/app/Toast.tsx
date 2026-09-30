import { useToastStore } from '@/store/toast.ts';
import styles from './Toast.module.css';

/** Global toasts (bottom centre). testid: toast (one per visible toast). */
export function Toast() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`} data-testid="toast" data-kind={t.kind}>
          <span>{t.text}</span>
          <button className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            x
          </button>
        </div>
      ))}
    </div>
  );
}
