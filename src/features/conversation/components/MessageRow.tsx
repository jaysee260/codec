/**
 * One timeline row (DEV-B-1 / DEV-B-15 / DEV-B-16 / DEV-B-18 / DEV-B-19 / DEV-B-21). Avatar + author +
 * timestamp on group starts, hover timestamp in the gutter otherwise; reply quote, body, reaction
 * pills, thread summary row, per-row picker and delete dialog.
 *
 * Desktop keeps the hover toolbar (`MessageActions`). Phone has no hover, so the row gets a 500 ms
 * long-press that opens the same actions as a bottom sheet (`MessageActionSheet`). Exactly one of the
 * two is mounted - they share the `message-action-*` testids, and two of each inside one row would be
 * ambiguous for a test.
 *
 * Phase 3: the row is addressed by a `TimelineSource`, which decides three things.
 *
 *  - **Where its UI state lives.** Reply/edit targets and focus requests are keyed by
 *    `sourceKey(source)`, so starting an edit on a reply in the panel fills the *thread* composer and
 *    leaves the channel composer alone (AC-T6-9).
 *  - **Whether threading is offered.** `message-action-thread` and `message-action-reply` are rendered
 *    only in a main timeline: threads do not nest and in-thread quote replies are out of scope
 *    (AC-T5-3). The thread action always opens *this* message's own id as the root - a thread reply
 *    can never reach a main timeline, so there is nothing to collapse here (the store collapses a
 *    reply id to its root anyway).
 *  - **Whether the summary row shows.** Only in a main timeline, and only when `useThreadSummary`
 *    reports an actual thread (AC-T4-1).
 *
 * `asThreadRoot` renders the root message at the top of the panel: its testid is `thread-root` rather
 * than `message-{rootId}` so the root is not duplicated on the page (AC-T6-1), and it carries no
 * `message-group-start` marker, so counting group starts inside the panel counts replies only
 * (AC-T6-3). Author, body and timestamp are rendered exactly as in a normal group start.
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
import { sourceKey, useIsPhone, useThreadStore, useThreadSummary, type TimelineSource } from '@/store/hooks.ts';
import { withToast } from '@/store/toast.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import { useLongPress } from '../hooks/useLongPress.ts';
import { MessageActions } from './MessageActions.tsx';
import { MessageActionSheet } from './MessageActionSheet.tsx';
import { MessageBody } from './MessageBody.tsx';
import { ReactionPicker } from './ReactionPicker.tsx';
import { ReactionRow } from './ReactionRow.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';
import { ThreadSummary } from './ThreadSummary.tsx';
import { DeleteDialog } from './DeleteDialog.tsx';
import styles from './MessageRow.module.css';

export interface MessageRowProps {
  /** Which timeline this row belongs to: a room (`{ roomId }`) or a thread (`{ roomId, threadRootId }`). */
  source: TimelineSource;
  event: MatrixEvent;
  groupStart: boolean;
  /** Briefly highlighted after a jump from a reply quote. */
  flash: boolean;
  /** Render as the thread panel's root message (`thread-root`) instead of a timeline row. */
  asThreadRoot?: boolean;
}

export function MessageRow({ source, event, groupStart, flash, asThreadRoot = false }: MessageRowProps) {
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isPhone = useIsPhone();
  const startReply = useConversationUi((s) => s.startReply);
  const startEdit = useConversationUi((s) => s.startEdit);
  const openThread = useThreadStore((s) => s.openThread);

  const roomId = source.roomId;
  const uiKey = sourceKey(source);
  /** True inside the thread panel: no nested threads, no quote replies, no summary row. */
  const inThread = !!source.threadRootId;

  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const eventId = event.getId() ?? '';
  const sender = event.getSender() ?? '';
  const name = displayNameOf(room, sender);
  const avatar = avatarUrlOf(room, sender, 40);
  const body = getDisplayBody(event);
  const reactions = getReactions(roomId, eventId);
  const pending = isPendingEvent(event);
  const failed = event.status === EventStatus.NOT_SENT;
  // Phase 4: editing a GIF is out of scope (there is no text to change and an edit would not touch the
  // `dev.matrixpoc.gif` field), so `message-action-edit` is absent on GIF rows (AC-G8-2). Reacting,
  // replying, threading and deleting work exactly as for any other message.
  const canEdit = !pending && !body.gif && canEditEvent(event);
  const canDelete = !pending && !body.isRedacted && canRedactEvent(roomId, event);
  // Non-null only for a thread root with at least one reply, and never inside the panel.
  const threadSummary = useThreadSummary(inThread ? null : event);

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
    asThreadRoot ? styles.asThreadRoot : '',
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
      data-testid={asThreadRoot ? 'thread-root' : `message-${eventId}`}
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
        {body.replyTo && <ReplyQuote roomId={roomId} eventId={body.replyTo} uiKey={uiKey} />}
        {groupStart && (
          <div className={styles.meta} data-testid={asThreadRoot ? undefined : 'message-group-start'}>
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
        {threadSummary && <ThreadSummary roomId={roomId} summary={threadSummary} />}
      </div>

      {!pending && !isPhone && (
        <MessageActions
          canEdit={canEdit}
          canDelete={canDelete}
          onReact={setPickerAnchor}
          onReply={inThread ? undefined : () => startReply(uiKey, eventId)}
          onThread={inThread ? undefined : () => openThread(eventId, roomId)}
          onEdit={() => startEdit(uiKey, eventId)}
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
          onReply={
            inThread
              ? undefined
              : () => {
                  setSheetOpen(false);
                  startReply(uiKey, eventId);
                }
          }
          onThread={
            inThread
              ? undefined
              : () => {
                  setSheetOpen(false);
                  openThread(eventId, roomId);
                }
          }
          onEdit={() => {
            setSheetOpen(false);
            startEdit(uiKey, eventId);
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
