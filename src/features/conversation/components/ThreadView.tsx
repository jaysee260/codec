/**
 * Thread panel (DEV-B-20 / DEV-B-21 / DEV-B-22). The shell mounts `<ThreadView roomId rootId />` in
 * `thread-panel-container` - a 400 px right column on desktop (replacing the member panel) and a
 * full-screen layer over the still-mounted conversation on phone - and passes nothing else.
 *
 * Top to bottom (AC-T6-1):
 *
 *   thread-panel[data-root]
 *     header            `thread-title` "Thread", the room name, `thread-close` (desktop only: on
 *                       phone `header-back` in the channel header is the single close, per
 *                       docs/archive/PHASE3_PLAN.md "Phone close")
 *     thread-root       the root message, rendered by the normal `MessageRow` in root mode, so it
 *                       gets the real avatar/author/body/reactions and can be edited, reacted to and
 *                       deleted like any other row - but not re-threaded or quote-replied (AC-T5-3)
 *     thread-replies-divider   "No replies yet" / "N replies"
 *     thread-message-list      the replies: the normal `MessageList` against
 *                              `useTimeline({ roomId, threadRootId })`, so grouping, day dividers,
 *                              pagination, anchoring, reactions, edits, redactions, images and voice
 *                              notes are the Phase 1/2 behaviour for free
 *     thread-typing            the room's typing indicator (Matrix has no thread-scoped typing)
 *     thread-composer          the normal `Composer` with `threadRoot`, placeholder "Replying in thread"
 *
 * Everything inside the panel is keyed by `sourceKey(source)` (the root id), so the panel's draft,
 * edit target and scroll anchor are independent of the channel's.
 *
 * The root event may not be in the loaded window (a thread opened from Dev A's list): `useThreadRoot`
 * fetches it. While that is in flight the panel shows a placeholder, and if it never arrives we show
 * `thread-error` rather than an empty box - the composer keeps working either way, because sending
 * only needs the root *id*.
 */
import { useEffect, useMemo, useState } from 'react';
import { MessagesSquare, X } from 'lucide-react';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { sourceKey, useIsPhone, useRoomSummary, useThreadRoot, useThreadStore, useThreadSummary, useTimeline, type TimelineSource } from '@/store/hooks.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import { MessageList } from './MessageList.tsx';
import { MessageRow } from './MessageRow.tsx';
import { TypingIndicator } from './TypingIndicator.tsx';
import { Composer } from './Composer.tsx';
import styles from './ThreadView.module.css';

/** How long to wait for the root event before calling it an error (`/event` plus a retry). */
const ROOT_TIMEOUT_MS = 6000;

function dividerLabel(count: number): string {
  if (count <= 0) return 'No replies yet';
  return count === 1 ? '1 reply' : `${count} replies`;
}

export function ThreadView({ roomId, rootId }: { roomId: string; rootId: string }) {
  const source = useMemo<TimelineSource>(() => ({ roomId, threadRootId: rootId }), [roomId, rootId]);
  const key = sourceKey(source);

  const root = useThreadRoot(roomId, rootId);
  const summary = useThreadSummary(root ?? null);
  const { events } = useTimeline(source);
  const closeThread = useThreadStore((s) => s.closeThread);
  const focusComposer = useConversationUi((s) => s.focusComposer);
  const roomSummary = useRoomSummary(roomId);
  const isPhone = useIsPhone();

  const [rootTimedOut, setRootTimedOut] = useState(false);

  // A summary only exists once the thread has at least one reply, so an empty thread falls back to
  // the panel's own snapshot (which holds a local echo the instant alice sends the first reply).
  const count = summary ? summary.count : events.length;

  // Opening the panel moves the caret into its composer; closing it hands focus back to the channel
  // composer on desktop (AC-T6-11). On phone the channel composer is behind a full-screen layer, so
  // focusing it would pop the keyboard over the room the user just came back to.
  useEffect(() => {
    focusComposer(key);
    return () => {
      if (!isPhone) focusComposer(roomId);
    };
    // `isPhone` is read at cleanup time on purpose via the closure; re-running on a layout flip
    // would steal the caret back into the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, roomId, focusComposer]);

  useEffect(() => {
    setRootTimedOut(false);
    if (root) return;
    const timer = setTimeout(() => setRootTimedOut(true), ROOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [roomId, rootId, root]);

  const roomLabel = roomSummary ? (roomSummary.isDm ? roomSummary.name : `#${roomSummary.name}`) : '';
  const hasRoom = !!getClientOrNull()?.getRoom(roomId);

  return (
    <section
      className={styles.panel}
      data-testid="thread-panel"
      data-root={rootId}
      data-count={count}
      aria-label="Thread"
      onKeyDown={(e) => {
        // Escape closes the panel on desktop. The composer owns Escape while it has the focus (it
        // cancels an edit, then clears the draft, and only then closes) - see Composer.onKeyDown.
        if (e.key !== 'Escape' || isPhone) return;
        if ((e.target as HTMLElement | null)?.closest('[data-testid="thread-composer"]')) return;
        e.stopPropagation();
        closeThread();
      }}
    >
      {/*
       * Desktop only. On phone the panel is full-screen under `channel-header`, which Dev A turns into
       * the thread's own header while a thread is open (`header-back`, the title "Thread",
       * `header-thread-room`, DEV-A-18) - a second title bar here would just be a duplicate, and
       * `header-back` is by decision the single close on phone (docs/archive/PHASE3_PLAN.md "Phone close").
       */}
      {!isPhone && (
        <header className={styles.header}>
          <MessagesSquare className={styles.headerIcon} size={18} aria-hidden="true" />
          <span className={styles.title} data-testid="thread-title">
            Thread
          </span>
          {roomLabel && <span className={`${styles.room} u-truncate`}>{roomLabel}</span>}
          <button
            type="button"
            className={styles.close}
            data-testid="thread-close"
            title="Close thread"
            aria-label="Close thread"
            onClick={() => closeThread()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
      )}

      <div className={styles.rootWrap}>
        {root ? (
          <MessageRow source={source} event={root} groupStart flash={false} asThreadRoot />
        ) : rootTimedOut || !hasRoom ? (
          <div className={styles.error} data-testid="thread-error" role="alert">
            This message could not be loaded. The thread below is still live.
          </div>
        ) : (
          <div className={styles.rootLoading} aria-busy="true">
            Loading the message...
          </div>
        )}
      </div>

      <div className={styles.divider} data-testid="thread-replies-divider" data-count={count}>
        <span className={styles.dividerText}>{dividerLabel(count)}</span>
      </div>

      <MessageList source={source} testIdPrefix="thread-" />
      <TypingIndicator roomId={source} testId="thread-typing" />
      <Composer source={source} testIdPrefix="thread-" />
    </section>
  );
}
