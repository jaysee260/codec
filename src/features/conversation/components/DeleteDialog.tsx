/**
 * Delete confirmation (DEV-B-9). Portal + overlay, Escape/backdrop closes, `delete-confirm` redacts.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { redactEvent } from '@/lib/matrix/actions.ts';
import { displayNameOf, previewText } from '@/lib/matrix/utils.ts';
import { colorFor, formatTime } from '@/lib/format.ts';
import { withToast } from '@/store/toast.ts';
import styles from './DeleteDialog.module.css';

export function DeleteDialog({ roomId, event, onClose }: { roomId: string; event: MatrixEvent; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const sender = event.getSender() ?? '';

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const confirm = (): void => {
    const eventId = event.getId();
    if (!eventId || busy) return;
    setBusy(true);
    void withToast(() => redactEvent(roomId, eventId), 'Could not delete the message').finally(onClose);
  };

  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        data-testid="delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Delete message"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className={styles.title}>Delete Message</h2>
        <p className={styles.text}>Are you sure you want to delete this message?</p>
        <div className={styles.preview}>
          <div className={styles.previewMeta}>
            <span style={{ color: colorFor(sender) }}>{displayNameOf(room, sender)}</span>
            <span className={styles.previewTime}>{formatTime(event.getTs())}</span>
          </div>
          <div className={styles.previewBody}>{previewText(event, 200)}</div>
        </div>
        <div className={styles.footer}>
          <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="u-btn u-btn--danger" data-testid="delete-confirm" disabled={busy} onClick={confirm}>
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
