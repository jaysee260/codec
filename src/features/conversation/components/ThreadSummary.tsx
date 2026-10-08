/**
 * Thread summary row under a thread root in the channel timeline (DEV-B-18).
 *
 *   thread-summary-{rootId}   the row itself, `data-count` = reply count; click/Enter opens the thread
 *   thread-summary-avatars    up to 3 participant avatars
 *   thread-summary-count      "1 reply" / "N replies" (accent colour, like Slack's "N replies")
 *   thread-summary-time       relative time of the latest reply ("just now", "4 min ago", ...)
 *   thread-summary-unread     the subtle dot while this thread has unread replies
 *
 * Mounted by `MessageRow` only when `useThreadSummary(event)` is non-null, which the core guarantees
 * to mean "this event is a thread root with at least one reply" (AC-T4-1: nothing is rendered for a
 * message nobody has replied to). The hook re-reads the SDK `Thread` (or the server bundle before the
 * thread is loaded) on every thread/timeline/room version bump, so bob's API reply ticks the count
 * live without a reload (AC-T4-3) and a fresh page shows the count from the bundle (AC-T4-5).
 *
 * It is a real `<button>`: the row is reachable by Tab and activates on Enter/Space for free, and the
 * 44 px minimum height on phone comes from the stylesheet (AC-T4-6).
 */
import { ChevronRight } from 'lucide-react';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { avatarUrlOf, displayNameOf } from '@/lib/matrix/utils.ts';
import { colorFor, formatRelative, initialsOf } from '@/lib/format.ts';
import { useThreadStore, type ThreadSummary as ThreadSummaryData } from '@/store/hooks.ts';
import { useNow } from '../hooks/useNow.ts';
import styles from './ThreadSummary.module.css';

const MAX_AVATARS = 3;

export function ThreadSummary({ roomId, summary }: { roomId: string; summary: ThreadSummaryData }) {
  const openThread = useThreadStore((s) => s.openThread);
  const now = useNow();
  const room = getClientOrNull()?.getRoom(roomId) ?? null;

  const { rootId, count, latestTs, participants, hasUnread } = summary;
  const faces = participants.slice(0, MAX_AVATARS);
  const label = count === 1 ? '1 reply' : `${count} replies`;

  return (
    <button
      type="button"
      className={styles.row}
      data-testid={`thread-summary-${rootId}`}
      data-count={count}
      data-unread={hasUnread ? 'true' : 'false'}
      title={`${label} - open the thread`}
      aria-label={`${label}. Open the thread`}
      onClick={() => openThread(rootId, roomId)}
    >
      <span className={styles.avatars} data-testid="thread-summary-avatars">
        {faces.map((userId) => {
          const name = displayNameOf(room, userId);
          const url = avatarUrlOf(room, userId, 24);
          return (
            <span key={userId} className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(userId) }} title={name}>
              {url ? <img src={url} alt="" /> : initialsOf(name)}
            </span>
          );
        })}
      </span>

      <span className={styles.count} data-testid="thread-summary-count">
        {label}
      </span>
      <span className={styles.time} data-testid="thread-summary-time">
        {formatRelative(latestTs, now)}
      </span>
      {hasUnread && <span className={styles.dot} data-testid="thread-summary-unread" aria-label="Unread replies" />}
      <ChevronRight className={styles.chevron} size={14} aria-hidden="true" />
    </button>
  );
}
