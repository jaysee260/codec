/**
 * Message actions as a bottom sheet (DEV-B-16). Phone replacement for the desktop hover toolbar:
 * opened by a 500 ms long-press on a row, closed by its own backdrop, Escape, or picking an action.
 *
 *   message-action-sheet            the sheet
 *   message-action-sheet-backdrop   its own overlay (the Principal owns `drawer-backdrop`)
 *   message-action-react / -reply / -thread / -edit / -delete   the same testids as the desktop toolbar, so
 *       only one of the two is ever mounted for a row (MessageRow branches on `useIsPhone()`).
 *   message-action-sheet-reaction-{emoji}   quick reactions inside the sheet (addition to the registry)
 *
 * Rendered in a portal: the message list is an `overflow: auto` container and would clip a sheet
 * anchored to the viewport.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FaceSlightlySmilingPlus, MessageSquareReply, Pencil, Reply, Trash } from 'lucide-react';
import { hapticTap } from '@/lib/native.ts';
import { REACTION_KEYS } from './ReactionPicker.tsx';
import styles from './MessageActionSheet.module.css';

export interface MessageActionSheetProps {
  canEdit: boolean;
  canDelete: boolean;
  /** Reaction keys already applied by me, so the sheet can mark them. */
  myReactions: readonly string[];
  onClose(): void;
  /** Quick reaction from the row inside the sheet. */
  onReact(key: string): void;
  /** Open the full picker (anchored to the tapped button). */
  onMoreReactions(anchor: HTMLElement): void;
  /** Quote reply in the same timeline. Omitted inside the thread panel (AC-T5-3). */
  onReply?(): void;
  /** Open this message as a thread (DEV-B-19). Omitted inside the thread panel: threads do not nest. */
  onThread?(): void;
  onEdit(): void;
  onDelete(): void;
}

export function MessageActionSheet({
  canEdit,
  canDelete,
  myReactions,
  onClose,
  onReact,
  onMoreReactions,
  onReply,
  onThread,
  onEdit,
  onDelete,
}: MessageActionSheetProps) {
  // Haptic confirmation that the press registered (no-op on the web).
  useEffect(() => {
    hapticTap();
  }, []);

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

  return createPortal(
    <>
      <div className={styles.backdrop} data-testid="message-action-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className={styles.sheet} data-testid="message-action-sheet" role="dialog" aria-modal="true" aria-label="Message actions">
        <div className={styles.handle} aria-hidden="true" />

        <div className={styles.reactions}>
          {REACTION_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`${styles.quick} ${myReactions.includes(key) ? styles.quickMine : ''}`}
              data-testid={`message-action-sheet-reaction-${key}`}
              title={`React with ${key}`}
              aria-label={`React with ${key}`}
              onClick={() => onReact(key)}
            >
              {key}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={styles.action}
          data-testid="message-action-react"
          onClick={(e) => onMoreReactions(e.currentTarget)}
        >
          <FaceSlightlySmilingPlus size={20} aria-hidden="true" />
          <span>More reactions</span>
        </button>
        {onReply && (
          <button type="button" className={styles.action} data-testid="message-action-reply" onClick={onReply}>
            <Reply size={20} aria-hidden="true" />
            <span>Reply</span>
          </button>
        )}
        {onThread && (
          <button type="button" className={styles.action} data-testid="message-action-thread" onClick={onThread}>
            <MessageSquareReply size={20} aria-hidden="true" />
            <span>Reply in thread</span>
          </button>
        )}
        {canEdit && (
          <button type="button" className={styles.action} data-testid="message-action-edit" onClick={onEdit}>
            <Pencil size={20} aria-hidden="true" />
            <span>Edit</span>
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className={`${styles.action} ${styles.danger}`}
            data-testid="message-action-delete"
            onClick={onDelete}
          >
            <Trash size={20} aria-hidden="true" />
            <span>Delete</span>
          </button>
        )}
      </div>
    </>,
    document.body,
  );
}
