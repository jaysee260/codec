/**
 * Hover toolbar on the right of a row (DEV-B-5 / B-6 / B-9 / B-19). Edit only on my own messages,
 * delete when the homeserver power levels allow redacting that event.
 *
 * Phase 3: `message-action-thread` ("Reply in thread") sits **after** `message-action-reply`
 * (AC-T5-1). Both are omitted inside the thread panel - threads do not nest and in-thread quote
 * replies are out of scope - so `onThread`/`onReply` are optional and the button follows the handler
 * (AC-T5-3).
 */
import { FaceSlightlySmilingPlus, MessageSquareReply, Pencil, Reply, Trash } from 'lucide-react';
import styles from './MessageActions.module.css';

export interface MessageActionsProps {
  canEdit: boolean;
  canDelete: boolean;
  onReact(anchor: HTMLElement): void;
  /** Quote reply in the same timeline. Omitted inside the thread panel. */
  onReply?(): void;
  /** Open this message as a thread. Omitted inside the thread panel. */
  onThread?(): void;
  onEdit(): void;
  onDelete(): void;
}

export function MessageActions({ canEdit, canDelete, onReact, onReply, onThread, onEdit, onDelete }: MessageActionsProps) {
  return (
    <div className={styles.actions} data-testid="message-actions">
      <button
        type="button"
        className={styles.action}
        data-testid="message-action-react"
        title="Add reaction"
        aria-label="Add reaction"
        onClick={(e) => onReact(e.currentTarget)}
      >
        <FaceSlightlySmilingPlus size={18} />
      </button>
      {onReply && (
        <button
          type="button"
          className={styles.action}
          data-testid="message-action-reply"
          title="Reply"
          aria-label="Reply"
          onClick={onReply}
        >
          <Reply size={18} />
        </button>
      )}
      {onThread && (
        <button
          type="button"
          className={styles.action}
          data-testid="message-action-thread"
          title="Reply in thread"
          aria-label="Reply in thread"
          onClick={onThread}
        >
          <MessageSquareReply size={18} />
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          className={styles.action}
          data-testid="message-action-edit"
          title="Edit"
          aria-label="Edit"
          onClick={onEdit}
        >
          <Pencil size={18} />
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className={`${styles.action} ${styles.danger}`}
          data-testid="message-action-delete"
          title="Delete"
          aria-label="Delete"
          onClick={onDelete}
        >
          <Trash size={18} />
        </button>
      )}
    </div>
  );
}
