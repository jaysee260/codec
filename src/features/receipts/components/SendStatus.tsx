/**
 * Send status of my own row (DEV-A-R1, AC-R1-*, AC-R8-1): `receipt-status[data-status]`.
 *   sending  hollow circle, "Sending…"
 *   sent     check in a filled circle, "Sent" (Dev B renders it only on `latestOwnSentId`)
 *   failed   wraps the row's existing failed UI (children keep their testids); a small alert icon otherwise
 */
import { Check, CircleAlert } from 'lucide-react';
import type { SendStatusProps } from '../types.ts';
import styles from './SendStatus.module.css';

const LABEL = {
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Failed to send',
} as const;

export function SendStatus({ status, children, className }: SendStatusProps) {
  if (!status) return null;
  const cls = `${styles.status} ${styles[status] ?? ''} ${className ?? ''}`;
  if (status === 'failed') {
    const hasChildren = children !== undefined && children !== null && children !== false;
    return (
      <span
        className={cls}
        data-testid="receipt-status"
        data-status="failed"
        {...(hasChildren ? {} : { role: 'img', 'aria-label': LABEL.failed, title: LABEL.failed })}
      >
        {hasChildren ? children : <CircleAlert size={14} aria-hidden="true" />}
      </span>
    );
  }
  return (
    <span
      className={cls}
      data-testid="receipt-status"
      data-status={status}
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
    >
      {status === 'sending' ? (
        <span className={styles.ring} aria-hidden="true" />
      ) : (
        <span className={styles.check} aria-hidden="true">
          <Check size={10} strokeWidth={3.5} />
        </span>
      )}
    </span>
  );
}
