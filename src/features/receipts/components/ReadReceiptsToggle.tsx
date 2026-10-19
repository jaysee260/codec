/**
 * "Send read receipts" setting (DEV-A-R4, AC-R7-1/5, AC-R5-3): `settings-send-read-receipts`, a `role="switch"`
 * button with `aria-checked`, over `useSendReadReceiptsSetting()` (account data `im.vector.web.settings`, shared
 * with Element). The hook reflects the new value immediately and reverts on failure; a failure also toasts.
 * Mounted in the UserFooter area (desktop sidebar and the phone nav drawer: same component). 44 px on phone.
 */
import { useId, useState } from 'react';
import { EyeOff, Eye } from 'lucide-react';
import { useIsPhone } from '@/store/layout.ts';
import { useSendReadReceiptsSetting } from '@/store/receipts.ts';
import { showToast } from '@/store/toast.ts';
import styles from './ReadReceiptsToggle.module.css';

export const READ_RECEIPTS_HINT = "When off, others can't see what you've read";

export function ReadReceiptsToggle({ className }: { className?: string }) {
  const [on, setOn] = useSendReadReceiptsSetting();
  const [busy, setBusy] = useState(false);
  const isPhone = useIsPhone();
  const hintId = useId();

  const toggle = (): void => {
    if (busy) return;
    setBusy(true);
    setOn(!on)
      .catch((e: unknown) =>
        showToast(`Couldn't change read receipts: ${e instanceof Error ? e.message : String(e)}`, 'error'),
      )
      .finally(() => setBusy(false));
  };

  const Icon = on ? Eye : EyeOff;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-describedby={hintId}
      aria-busy={busy || undefined}
      data-testid="settings-send-read-receipts"
      className={`${styles.row} ${isPhone ? styles.phone : ''} ${className ?? ''}`}
      title={READ_RECEIPTS_HINT}
      onClick={toggle}
    >
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>
        <span className={styles.label}>Send read receipts</span>
        <span id={hintId} className={`${styles.hint} u-truncate`}>
          {READ_RECEIPTS_HINT}
        </span>
      </span>
      <span className={`${styles.track} ${on ? styles.on : ''}`} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}
