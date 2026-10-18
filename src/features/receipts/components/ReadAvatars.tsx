/**
 * Read avatars under a row (DEV-A-R2, AC-R2-*, AC-R5-1/3, AC-R8-1/2): the users whose latest read point is this
 * row, newest first, max 3 stacked circles + "+N".
 *
 *   receipt-avatars[data-count][data-event-id]  role=group, aria-label "Seen by A, B, C and N others", tabindex 0
 *   receipt-avatar[data-user-id]                img or initial fallback, alt=""
 *   receipt-more                                "+N"
 *
 * Desktop (fine pointer): hover opens a preview of the Seen-by list, click / Enter / Space pins it (click again
 * closes). Phone: tap opens the bottom sheet. Fixed-height strip so rows do not jump as readers come and go; on
 * phone the 44 px hit area comes from padding + negative margins, not extra layout height.
 */
import { memo, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { colorFor, initialsOf } from '@/lib/format.ts';
import type { Reader } from '@/lib/matrix/receipts.ts';
import { useIsPhone } from '@/store/layout.ts';
import {
  cancelHoverClose,
  closeSeenBy,
  isSameList,
  openSeenBy,
  scheduleHoverClose,
  useSeenByStore,
} from '../seenBy.tsx';
import type { ReadAvatarsProps } from '../types.ts';
import { avatarStack, seenByLabel } from '../labels.ts';
import styles from './ReadAvatars.module.css';

/** One reader's circle: the avatar image, or the coloured initial when there is none / it fails to load. */
export function ReaderAvatar({
  reader,
  className,
  testId,
  z,
}: {
  reader: Reader;
  className?: string;
  testId?: string;
  z?: number;
}) {
  const [broken, setBroken] = useState(false);
  const name = reader.displayName || reader.userId;
  const showImg = !!reader.avatarUrl && !broken;
  return (
    <span
      className={`u-avatar ${className ?? ''}`}
      style={{ background: colorFor(reader.userId), zIndex: z }}
      data-testid={testId}
      data-user-id={reader.userId}
      aria-hidden="true"
    >
      {showImg ? (
        <img src={reader.avatarUrl!} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        initialsOf(name).slice(0, 1)
      )}
    </span>
  );
}

function ReadAvatarsImpl({ source, eventId, readers, className }: ReadAvatarsProps) {
  const isPhone = useIsPhone();
  const mine = useSeenByStore((s) => isSameList(s.open, source, eventId));
  if (!readers || readers.length === 0) return null;
  const { shown, more } = avatarStack(readers);

  const toggle = (trigger: HTMLElement): void => {
    const open = useSeenByStore.getState().open;
    if (isSameList(open, source, eventId) && open?.mode === 'pinned') closeSeenBy();
    else openSeenBy({ source, eventId, trigger, mode: 'pinned' });
  };
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    toggle(e.currentTarget);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggle(e.currentTarget);
    }
  };
  // Hover preview: mouse only, never on phone (touch fires pointerenter right before the tap).
  const onPointerEnter = (e: PointerEvent<HTMLDivElement>): void => {
    if (isPhone || e.pointerType !== 'mouse') return;
    cancelHoverClose();
    openSeenBy({ source, eventId, trigger: e.currentTarget, mode: 'hover' });
  };
  const onPointerLeave = (e: PointerEvent<HTMLDivElement>): void => {
    if (isPhone || e.pointerType !== 'mouse') return;
    scheduleHoverClose();
  };

  return (
    <div
      className={`${styles.strip} ${isPhone ? styles.phone : ''} ${mine ? styles.active : ''} ${className ?? ''}`}
      data-testid="receipt-avatars"
      data-count={readers.length}
      data-event-id={eventId}
      role="group"
      aria-label={seenByLabel(readers)}
      aria-expanded={mine}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // A long-press on the strip must not open the row's action sheet / context menu.
      onContextMenu={(e) => e.stopPropagation()}
    >
      <span className={styles.stack}>
        {shown.map((r, i) => (
          <ReaderAvatar
            key={r.userId}
            reader={r}
            className={styles.avatar}
            testId="receipt-avatar"
            z={shown.length - i}
          />
        ))}
      </span>
      {more > 0 && (
        <span className={styles.more} data-testid="receipt-more" aria-hidden="true">
          +{more}
        </span>
      )}
    </div>
  );
}

/**
 * Memoised: rows re-render often; `readers` keeps its identity while unchanged (core guarantees it). `source` is
 * compared by value, so passing a fresh `{ roomId, threadRootId }` object per render is fine.
 */
export const ReadAvatars = memo(
  ReadAvatarsImpl,
  (a, b) =>
    a.eventId === b.eventId &&
    a.readers === b.readers &&
    a.className === b.className &&
    a.source.roomId === b.source.roomId &&
    (a.source.threadRootId ?? null) === (b.source.threadRootId ?? null),
);
