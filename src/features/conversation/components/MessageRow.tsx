/**
 * One timeline row (DEV-B-1 / DEV-B-15 / DEV-B-16). Avatar + author + timestamp on group starts,
 * hover timestamp in the gutter otherwise; reply quote, body, reaction pills, per-row picker and
 * delete dialog.
 *
 * Desktop keeps the hover toolbar (`MessageActions`). Phone has no hover, so the row gets a 500 ms
 * long-press that opens the same actions as a bottom sheet (`MessageActionSheet`). Exactly one of the
 * two is mounted - they share the `message-action-*` testids, and two of each inside one row would be
 * ambiguous for a test.
 *
 * Rows are deliberately NOT memoised: the SDK mutates events in place for edits, redactions and
 * reaction aggregation, so the whole list re-renders on the store's `version` bump.
 */
import { useState } from 'react';
import { EventStatus, type MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { canEditEvent, canRedactEvent, getReactions, sendReaction } from '@/lib/matrix/actions.ts';
import { avatarUrlOf, displayNameOf, getDisplayBody, isPendingEvent } from '@/lib/matrix/utils.ts';
import { colorFor, formatFullTime, formatTime, initialsOf } from '@/lib/format.ts';
import { useIsPhone } from '@/store/hooks.ts';
import { withToast } from '@/store/toast.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import { useLongPress } from '../hooks/useLongPress.ts';
import { MessageActions } from './MessageActions.tsx';
import { MessageActionSheet } from './MessageActionSheet.tsx';
import { MessageBody } from './MessageBody.tsx';
import { ReactionPicker } from './ReactionPicker.tsx';
import { ReactionRow } from './ReactionRow.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';
import { DeleteDialog } from './DeleteDialog.tsx';
import styles from './MessageRow.module.css';

export interface MessageRowProps {
  roomId: string;
  event: MatrixEvent;
  groupStart: boolean;
  /** Briefly highlighted after a jump from a reply quote. */
  flash: boolean;
}

export function MessageRow({ roomId, event, groupStart, flash }: MessageRowProps) {
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isPhone = useIsPhone();
  const startReply = useConversationUi((s) => s.startReply);
  const startEdit = useConversationUi((s) => s.startEdit);

  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const eventId = event.getId() ?? '';
  const sender = event.getSender() ?? '';
  const name = displayNameOf(room, sender);
  const avatar = avatarUrlOf(room, sender, 40);
  const body = getDisplayBody(event);
  const reactions = getReactions(roomId, eventId);
  const pending = isPendingEvent(event);
  const failed = event.status === EventStatus.NOT_SENT;
  const canEdit = !pending && canEditEvent(event);
  const canDelete = !pending && !body.isRedacted && canRedactEvent(roomId, event);

  // The picker only ever adds: re-picking an emoji I already used is a no-op (the pill toggles it off),
  // which keeps "pick 🎉 -> count 1, mine" true however many times the flow runs on one seed.
  const pick = (key: string): void => {
    setPickerAnchor(null);
    setSheetOpen(false);
    if (reactions.some((reaction) => reaction.key === key && reaction.mine)) return;
    void withToast(() => sendReaction(roomId, eventId, key), 'Could not add the reaction');
  };

  // Long-press opens the action sheet on phone; the desktop toolbar is hover-driven (AC-V6-3/4).
  const longPress = useLongPress({
    enabled: isPhone && !pending,
    onLongPress: () => setSheetOpen(true),
  });

  const classes = [
    styles.row,
    groupStart ? styles.groupStart : styles.grouped,
    pending ? styles.pending : '',
    failed ? styles.failed : '',
    flash ? styles.flash : '',
    longPress.pressing ? styles.pressing : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-testid={`message-${eventId}`}
      data-sender={sender}
      data-event-id={eventId}
      data-group-start={groupStart ? 'true' : 'false'}
      data-active={pickerAnchor || confirmDelete || sheetOpen ? 'true' : undefined}
      data-flash={flash ? 'true' : undefined}
      {...longPress.handlers}
    >
      <div className={styles.gutter}>
        {groupStart ? (
          <span
            className={`u-avatar ${styles.avatar}`}
            style={{ background: colorFor(sender) }}
            data-testid="message-avatar"
            title={name}
          >
            {avatar ? <img src={avatar} alt="" /> : initialsOf(name)}
          </span>
        ) : (
          <span className={styles.gutterTime} data-testid="message-timestamp" title={formatFullTime(event.getTs())}>
            {formatTime(event.getTs())}
          </span>
        )}
      </div>

      <div className={styles.content}>
        {body.replyTo && <ReplyQuote roomId={roomId} eventId={body.replyTo} />}
        {groupStart && (
          <div className={styles.meta} data-testid="message-group-start">
            <span className={styles.author} data-testid="message-author" style={{ color: colorFor(sender) }}>
              {name}
            </span>
            <span className={styles.time} data-testid="message-timestamp" title={formatFullTime(event.getTs())}>
              {formatTime(event.getTs())}
            </span>
            {failed && <span className={styles.failedTag}>failed to send</span>}
          </div>
        )}
        <MessageBody roomId={roomId} body={body} />
        <ReactionRow roomId={roomId} eventId={eventId} reactions={reactions} onAdd={setPickerAnchor} />
      </div>

      {!pending && !isPhone && (
        <MessageActions
          canEdit={canEdit}
          canDelete={canDelete}
          onReact={setPickerAnchor}
          onReply={() => startReply(roomId, eventId)}
          onEdit={() => startEdit(roomId, eventId)}
          onDelete={() => setConfirmDelete(true)}
        />
      )}

      {sheetOpen && isPhone && (
        <MessageActionSheet
          canEdit={canEdit}
          canDelete={canDelete}
          myReactions={reactions.filter((r) => r.mine).map((r) => r.key)}
          onClose={() => setSheetOpen(false)}
          onReact={pick}
          onMoreReactions={setPickerAnchor}
          onReply={() => {
            setSheetOpen(false);
            startReply(roomId, eventId);
          }}
          onEdit={() => {
            setSheetOpen(false);
            startEdit(roomId, eventId);
          }}
          onDelete={() => {
            setSheetOpen(false);
            setConfirmDelete(true);
          }}
        />
      )}

      {pickerAnchor && <ReactionPicker anchor={pickerAnchor} onPick={pick} onClose={() => setPickerAnchor(null)} />}
      {confirmDelete && <DeleteDialog roomId={roomId} event={event} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}
