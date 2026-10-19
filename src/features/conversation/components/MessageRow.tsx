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
 * Phase 6: `LinkPreviews` renders the link cards under the body, before the reactions (DEV-B-32).
 *
 * Read receipts (DEV-B-R1 / R2): the list computes `useReadPointsResult` once and hands each row its
 * `readers` and whether it is the single `isLatestOwnSent` row. The row renders one right-aligned receipt
 * strip under everything else (after reactions and the thread summary, Element's position): my send status
 * (`sending` while the echo is pending, the `sent` check only on the latest-own-sent row, `failed` on rows
 * without the header's "failed to send" tag) and/or Dev A's `ReadAvatars`. The strip has a fixed height
 * whatever it holds, so the check being replaced by avatars never changes the row's height (AC-R9-1), and
 * the strip exists from the first frame of a send (`sending`), so sending -> sent -> read is height-stable.
 * The thread root inside the panel shows none of it (its avatars are on its main-timeline row) but keeps the
 * "Seen by" action, which opens the *main* timeline's list for it (the root is a main-timeline event).
 *
 * Rows are deliberately NOT memoised: the SDK mutates events in place for edits, redactions and
 * reaction aggregation, so the whole list re-renders on the store's `version` bump.
 */
import { useMemo, useState } from 'react';
import { EventStatus, type MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { canEditEvent, canRedactEvent, getReactions, sendReaction } from '@/lib/matrix/actions.ts';
import { avatarUrlOf, displayNameOf, getDisplayBody, isPendingEvent } from '@/lib/matrix/utils.ts';
import { colorFor, formatFullTime, formatTime, initialsOf } from '@/lib/format.ts';
import {
  sourceKey,
  useIsPhone,
  useSendStatus,
  useThreadStore,
  useThreadSummary,
  type Reader,
  type TimelineSource,
} from '@/store/hooks.ts';
import { openSeenBy, ReadAvatars, SendStatus, useSeenByStore } from '@/features/receipts';
import { withToast } from '@/store/toast.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import { useLongPress } from '../hooks/useLongPress.ts';
import { MessageActions } from './MessageActions.tsx';
import { MessageActionSheet } from './MessageActionSheet.tsx';
import { MessageBody } from './MessageBody.tsx';
import { LinkPreviews } from './LinkPreviews.tsx';
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
  /** Read receipts: the users whose latest read point is this row (`readPoints.get(id)` from the list). */
  readers?: readonly Reader[];
  /** This row is the list's `latestOwnSentId`: the one own message that shows the "sent" check. */
  isLatestOwnSent?: boolean;
}

export function MessageRow({
  source,
  event,
  groupStart,
  flash,
  asThreadRoot = false,
  readers,
  isLatestOwnSent = false,
}: MessageRowProps) {
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

  // Read receipts. `status` is null for other people's rows. The thread root in the panel shows nothing.
  const status = useSendStatus(event);
  const showStatus =
    !asThreadRoot &&
    (status === 'sending' ||
      (status === 'sent' && isLatestOwnSent) ||
      // A group-start row already has the "failed to send" tag in its header (wrapped there instead).
      (status === 'failed' && !groupStart));
  const shownReaders = asThreadRoot ? undefined : readers;
  const hasReceiptStrip = showStatus || (shownReaders?.length ?? 0) > 0;
  // "Seen by" for the thread root asks the main timeline: the root is a main event and its readers are there.
  const seenBySource = useMemo<TimelineSource>(
    () => (asThreadRoot ? { roomId } : source),
    [asThreadRoot, roomId, source],
  );
  const canSeenBy = !body.isRedacted && !!eventId && !eventId.startsWith('~');
  // While this row's list is open from the toolbar button, keep the toolbar shown: it is the popover's anchor.
  const seenByOpen = useSeenByStore(
    (s) =>
      !!s.open &&
      s.open.eventId === eventId &&
      s.open.source.roomId === seenBySource.roomId &&
      (s.open.source.threadRootId ?? null) === (seenBySource.threadRootId ?? null),
  );
  const seenBy = (trigger: HTMLElement | null): void => {
    openSeenBy({ source: seenBySource, eventId, trigger });
  };

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
      data-active={pickerAnchor || confirmDelete || sheetOpen || seenByOpen ? 'true' : undefined}
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
            {failed &&
              (asThreadRoot ? (
                <span className={styles.failedTag}>failed to send</span>
              ) : (
                <SendStatus status="failed">
                  <span className={styles.failedTag}>failed to send</span>
                </SendStatus>
              ))}
          </div>
        )}
        <MessageBody roomId={roomId} body={body} />
        {/* Phase 6: link preview cards (main timeline, thread replies and the thread root; never quotes). */}
        <LinkPreviews roomId={roomId} event={event} body={body} />
        <ReactionRow roomId={roomId} eventId={eventId} reactions={reactions} onAdd={setPickerAnchor} />
        {threadSummary && <ThreadSummary roomId={roomId} summary={threadSummary} />}
        {hasReceiptStrip && (
          <div className={styles.receipts} data-receipt-strip="">
            {shownReaders && shownReaders.length > 0 && (
              <ReadAvatars source={source} eventId={eventId} readers={shownReaders} />
            )}
            {showStatus && (
              <SendStatus status={status}>
                {status === 'failed' ? <span className={styles.failedTag}>failed to send</span> : null}
              </SendStatus>
            )}
          </div>
        )}
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
          onSeenBy={canSeenBy ? seenBy : undefined}
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
          onSeenBy={
            canSeenBy
              ? () => {
                  setSheetOpen(false);
                  seenBy(null);
                }
              : undefined
          }
        />
      )}

      {pickerAnchor && <ReactionPicker anchor={pickerAnchor} onPick={pick} onClose={() => setPickerAnchor(null)} />}
      {confirmDelete && <DeleteDialog roomId={roomId} event={event} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}
