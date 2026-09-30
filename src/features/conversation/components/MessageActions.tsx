/**
 * Hover toolbar on the right of a row (DEV-B-5 / B-6 / B-9). Edit only on my own messages,
 * delete when the homeserver power levels allow redacting that event.
 */
import { FaceSlightlySmilingPlus, Pencil, Reply, Trash } from 'lucide-react';
import styles from './MessageActions.module.css';

export interface MessageActionsProps {
  canEdit: boolean;
  canDelete: boolean;
  onReact(anchor: HTMLElement): void;
  onReply(): void;
  onEdit(): void;
  onDelete(): void;
}

export function MessageActions({ canEdit, canDelete, onReact, onReply, onEdit, onDelete }: MessageActionsProps) {
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
