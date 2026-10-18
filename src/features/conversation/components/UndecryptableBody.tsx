/**
 * Placeholder bodies for encrypted events (DEV-B-27, AC-E2-2 / AC-E2-3 / AC-E2-8).
 *
 *   message-decrypting       the event is still being decrypted (normally a frame or two); same line height
 *                            as a one-line message, so settling into the text causes no layout jump
 *   message-undecryptable    decryption failed; `data-reason` per `utd.ts`, the copy per reason, and
 *                            `message-undecryptable-action` ("Unlock" / "Verify") for the two reasons the user
 *                            can fix from here. Replaces `message-body`: avatar, author, timestamp unchanged.
 *
 * The reason re-reads the security store (`status`, `recovery.busy`), so starting an unlock flips the rows to
 * `restoring` and the bridge's `MatrixEventEvent.Decrypted` refresh turns them into messages (AC-E2-6).
 */
import { Lock, LockOpen, ShieldAlert } from 'lucide-react';
import type { DecryptionState } from '@/lib/matrix/utils.ts';
import { useSecurityStore } from '@/store/hooks.ts';
import { openSecurityDialog } from '../securityDialog.ts';
import { UTD_ACTION, UTD_COPY, utdReason } from '../utd.ts';
import styles from './UndecryptableBody.module.css';

export function DecryptingBody() {
  return (
    <div className={styles.line}>
      <div className={`${styles.body} ${styles.decrypting}`} data-testid="message-decrypting" role="status">
        <Lock size={13} className={styles.icon} aria-hidden="true" />
        <span>Decrypting...</span>
      </div>
    </div>
  );
}

export function UndecryptableBody({ decryption }: { decryption: DecryptionState }) {
  const status = useSecurityStore((s) => s.status);
  const busy = useSecurityStore((s) => s.recovery.busy);
  const reason = utdReason(decryption, { status, recovery: { busy } });
  const action = UTD_ACTION[reason];
  const Icon = reason === 'unverified' ? ShieldAlert : reason === 'restoring' ? LockOpen : Lock;

  return (
    <div className={styles.line}>
      <div
        className={`${styles.body} ${reason === 'restoring' ? styles.restoring : ''}`}
        data-testid="message-undecryptable"
        data-reason={reason}
        data-code={decryption.code}
        // The SDK-level detail ("Waiting for this message's key") behind the short copy.
        title={decryption.message}
      >
        <Icon size={13} className={styles.icon} aria-hidden="true" />
        <span className={styles.text}>{UTD_COPY[reason]}</span>
        {action && (
          <button
            type="button"
            className={styles.action}
            data-testid="message-undecryptable-action"
            onClick={() => openSecurityDialog(action.dialog)}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
