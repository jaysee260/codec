/**
 * The Seen-by list for one row (DEV-A-R3, AC-R3-*, AC-R4-1, AC-R5-1/2, AC-R8-1/2): desktop popover anchored to
 * its trigger, phone bottom sheet. Data from `useSeenBy(source, eventId)` (core; joined members loaded lazily).
 *
 *   receipt-list[data-event-id][data-mode="popover|sheet"]  role=dialog, aria-label "Seen by" (aria-modal on phone)
 *   receipt-list-seen      "Seen by" section, newest first; replaced by receipt-list-empty when nobody has
 *   receipt-list-unseen    "Not seen yet"; only receipt-list-unseen-count "N others haven't seen it yet" when truncated
 *   receipt-list-item[data-user-id][data-section]  (+ receipt-list-time, title = full date-time, seen only)
 *   receipt-list-backdrop  phone
 *
 * Escape and an outside pointer-down (or the backdrop / Android back on phone) call `onClose`. In `pinned` mode
 * focus moves into the dialog and Tab stays inside; the opener (seenBy.tsx) returns focus on close.
 * Normally rendered by the host in seenBy.tsx; use `openSeenBy` rather than mounting this yourself.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { formatFullTime, formatRelative } from '@/lib/format.ts';
import type { Reader } from '@/lib/matrix/receipts.ts';
import { registerBackHandler, useIsPhone } from '@/store/layout.ts';
import { useSeenBy } from '@/store/receipts.ts';
import type { SeenByListProps } from '../types.ts';
import { unseenCountLabel } from '../labels.ts';
import { ReaderAvatar } from './ReadAvatars.tsx';
import styles from './SeenByList.module.css';

const POPOVER_W = 280;
const POPOVER_MAX_H = 360;
const GAP = 6;
const EDGE = 8;

type Pos = Pick<CSSProperties, 'left' | 'top' | 'bottom' | 'maxHeight'>;

/** Fixed-position popover next to the anchor: above it when there is room, else below; right edges aligned. */
function placePopover(anchor: HTMLElement | null): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!anchor || !anchor.isConnected) {
    return {
      left: Math.max(EDGE, vw - POPOVER_W - 24),
      top: 64,
      maxHeight: Math.min(POPOVER_MAX_H, vh - 64 - EDGE),
    };
  }
  const r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(EDGE, r.right - POPOVER_W), vw - POPOVER_W - EDGE);
  const above = r.top - GAP - EDGE;
  const below = vh - r.bottom - GAP - EDGE;
  if (above >= Math.min(POPOVER_MAX_H, 200) || above >= below) {
    return {
      left,
      bottom: vh - r.top + GAP,
      maxHeight: Math.min(POPOVER_MAX_H, Math.max(120, above)),
    };
  }
  return {
    left,
    top: r.bottom + GAP,
    maxHeight: Math.min(POPOVER_MAX_H, Math.max(120, below)),
  };
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Item({ reader, section }: { reader: Reader; section: 'seen' | 'unseen' }) {
  return (
    <li className={styles.item} data-testid="receipt-list-item" data-user-id={reader.userId} data-section={section}>
      <ReaderAvatar reader={reader} className={styles.avatar} />
      <span className={styles.names}>
        <span className={`${styles.name} u-truncate`}>{reader.displayName || reader.userId}</span>
        {reader.displayName && reader.displayName !== reader.userId && (
          <span className={`${styles.userId} u-truncate`}>{reader.userId}</span>
        )}
      </span>
      {section === 'seen' && reader.ts > 0 && (
        <time
          className={styles.time}
          data-testid="receipt-list-time"
          dateTime={new Date(reader.ts).toISOString()}
          title={formatFullTime(reader.ts)}
        >
          {formatRelative(reader.ts)}
        </time>
      )}
    </li>
  );
}

export function SeenByList({
  source,
  eventId,
  anchor,
  onClose,
  mode = 'pinned',
  onPointerEnter,
  onPointerLeave,
}: SeenByListProps) {
  const isPhone = useIsPhone();
  const { seen, notSeen, notSeenCount, truncated } = useSeenBy(source, eventId);
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [pos, setPos] = useState<Pos>(() => (isPhone ? {} : placePopover(anchor)));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Read by the document-level Escape handler: the mode flips hover -> pinned without a remount.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Popover position follows the anchor while the timeline scrolls / the window resizes.
  useLayoutEffect(() => {
    if (isPhone) return;
    const update = (): void => {
      if (anchor && !anchor.isConnected) return; // trigger unmounted (hover toolbar): keep the last position
      setPos(placePopover(anchor));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, isPhone]);

  // Escape (capture; pinned lists stop it so the thread panel / drawers do not also close) and outside pointer-down.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // A hover preview closes but lets the key through (cancel an edit, close the thread panel, ...); only a
      // pinned list (the user opened it on purpose) consumes Escape.
      if (modeRef.current === 'pinned') {
        e.preventDefault();
        e.stopPropagation();
      }
      onCloseRef.current('escape');
    };
    const onDown = (e: globalThis.PointerEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      // The trigger handles its own click (toggle / pin); the backdrop closes via its own handler.
      if (anchor?.contains(t)) return;
      onCloseRef.current(isPhone ? 'backdrop' : 'outside');
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [anchor]);

  // Android back closes the sheet first.
  useEffect(() => registerBackHandler(() => (onCloseRef.current('back'), true)), []);

  // Focus into the dialog when pinned (click / keyboard / action menu); a hover preview leaves focus alone.
  useEffect(() => {
    if (mode !== 'pinned' || !ref.current) return;
    if (!ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
  }, [mode]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const showUnseen = truncated ? notSeenCount > 0 : notSeen.length > 0;
  const body = (
    <>
      {seen.length > 0 ? (
        <section className={styles.section} data-testid="receipt-list-seen" aria-labelledby={`${uid}-seen`}>
          <h3 className={styles.heading}>
            <span id={`${uid}-seen`}>Seen by</span>
            <span className={styles.count} aria-hidden="true">
              {seen.length}
            </span>
          </h3>
          <ul className={styles.items}>
            {seen.map((r) => (
              <Item key={r.userId} reader={r} section="seen" />
            ))}
          </ul>
        </section>
      ) : (
        <p className={styles.empty} data-testid="receipt-list-empty">
          Nobody has seen this yet
        </p>
      )}
      {showUnseen && (
        <section className={styles.section} data-testid="receipt-list-unseen" aria-labelledby={`${uid}-unseen`}>
          <h3 className={styles.heading}>
            <span id={`${uid}-unseen`}>Not seen yet</span>
            {!truncated && (
              <span className={styles.count} aria-hidden="true">
                {notSeen.length}
              </span>
            )}
          </h3>
          {truncated ? (
            <p className={styles.unseenCount} data-testid="receipt-list-unseen-count">
              {unseenCountLabel(notSeenCount)}
            </p>
          ) : (
            <ul className={styles.items}>
              {notSeen.map((r) => (
                <Item key={r.userId} reader={r} section="unseen" />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );

  if (isPhone) {
    return createPortal(
      <>
        <div
          className={styles.backdrop}
          data-testid="receipt-list-backdrop"
          aria-hidden="true"
          onClick={() => onCloseRef.current('backdrop')}
        />
        <div
          ref={ref}
          className={`${styles.list} ${styles.sheet}`}
          data-testid="receipt-list"
          data-event-id={eventId}
          data-mode="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Seen by"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className={styles.handle} aria-hidden="true" />
          <div className={styles.sheetHeader}>
            <span className={styles.sheetTitle}>Read receipts</span>
            <button
              type="button"
              className={styles.close}
              aria-label="Close"
              onClick={() => onCloseRef.current('button')}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          {body}
        </div>
      </>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={ref}
      className={`${styles.list} ${styles.popover}`}
      style={pos}
      data-testid="receipt-list"
      data-event-id={eventId}
      data-mode="popover"
      role="dialog"
      aria-label="Seen by"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onPointerEnter?.()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onPointerLeave?.()}
    >
      {body}
    </div>,
    document.body,
  );
}
