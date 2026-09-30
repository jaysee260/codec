/**
 * Scrolling timeline (DEV-B-1 / B-3 / B-6 / B-7).
 *
 * Scroll rules:
 * - on room change: jump to the bottom and re-arm pagination;
 * - new events: only follow the bottom when the user is within 40 px of it ("stick to bottom");
 * - backwards pagination: pin the top-most row before the request and restore `scrollTop` by however
 *   far *that row* moved once the taller content lands, so the row the user was reading stays put
 *   (`paginateBack` replaces the events array wholesale). The row's own offset is the anchor rather
 *   than the container's `scrollHeight` delta, because a page of history can also re-render the
 *   pinned row itself: an older message from the same sender turns its group header off, which makes
 *   the container grow by less than the content above the row did;
 * - a reply-quote jump scrolls to the target, paginating back until it is loaded, then flashes it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Hash } from 'lucide-react';
import { useRoomSummary } from '@/store/hooks.ts';
import { initialsOf } from '@/lib/format.ts';
import { useRoomEvents } from '../hooks/useRoomEvents.ts';
import { usePagination } from '../hooks/usePagination.ts';
import { useReadReceipt } from '../hooks/useReadReceipt.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import { DayDivider } from './DayDivider.tsx';
import { MessageRow } from './MessageRow.tsx';
import styles from './MessageList.module.css';

const NEAR_BOTTOM_PX = 40;
const FLASH_MS = 2600;

/** Scroll position pinned across a backwards pagination. */
interface ScrollAnchor {
  /** The row to keep still; empty when the list had no rows yet. */
  eventId: string;
  /** Its `offsetTop` before the request. */
  offsetTop: number;
  scrollTop: number;
  /** Fallback for when the pinned row is gone from the new snapshot (timeline reset). */
  scrollHeight: number;
}

export function MessageList({ roomId }: { roomId: string }) {
  const { items, hasMore, isPaginating, paginateBack, version } = useRoomEvents(roomId);
  const summary = useRoomSummary(roomId);
  const jump = useConversationUi((s) => s.jump);
  const clearJump = useConversationUi((s) => s.clearJump);

  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  /** Nonce of the jump currently being resolved; a newer jump supersedes it. */
  const jumpRunRef = useRef(0);

  const [armed, setArmed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);

  useReadReceipt(roomId, atBottom);

  const scrollToBottom = useCallback((smooth = false): void => {
    const el = containerRef.current;
    if (!el) return;
    stick.current = true;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Room change: bottom, reset every scroll flag, re-arm the pagination sentinel after first paint.
  useLayoutEffect(() => {
    anchor.current = null;
    stick.current = true;
    setAtBottom(true);
    setArmed(false);
    setFlashId(null);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    const timer = setTimeout(() => setArmed(true), 200);
    return () => clearTimeout(timer);
  }, [roomId]);

  // Keep the viewport stable across every timeline commit.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pin = anchor.current;
    if (pin) {
      const row = pin.eventId ? el.querySelector<HTMLElement>(`[data-event-id="${pin.eventId}"]`) : null;
      // How far the pinned row moved down; fall back to the container delta if it is gone.
      const moved = row ? row.offsetTop - pin.offsetTop : el.scrollHeight - pin.scrollHeight;
      if (moved > 0) {
        el.scrollTop = pin.scrollTop + moved;
        anchor.current = null;
      } else if (!isPaginating) {
        anchor.current = null; // the request came back without new rows
      }
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, isPaginating, version]);

  const onScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stick.current = near;
    setAtBottom(near);
  };

  const load = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>('[data-event-id]');
    anchor.current = {
      eventId: first?.dataset.eventId ?? '',
      offsetTop: first?.offsetTop ?? 0,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
    };
    void paginateBack(30);
  }, [paginateBack]);

  usePagination({
    containerRef,
    sentinelRef,
    enabled: armed && hasMore && !isPaginating,
    load,
    revision: version,
  });

  // Jump to (and flash) a message, loading history until it exists.
  const jumpNonce = jump && jump.roomId === roomId ? jump.nonce : 0;
  const jumpEventId = jump?.eventId;
  useEffect(() => {
    if (!jumpNonce || !jumpEventId) return;
    // One jump per request: clearing it means re-opening the room does not replay the last one.
    // Cancellation goes through a ref (not the effect cleanup), because clearing the store
    // re-runs this effect immediately and would otherwise abort the run it just started.
    const myNonce = jumpNonce;
    jumpRunRef.current = myNonce;
    clearJump();
    const run = async (): Promise<void> => {
      for (let attempt = 0; attempt < 8 && jumpRunRef.current === myNonce; attempt++) {
        const target = containerRef.current?.querySelector<HTMLElement>(`[data-event-id="${jumpEventId}"]`);
        if (target) {
          stick.current = false;
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setFlashId(jumpEventId);
          setTimeout(() => setFlashId((current) => (current === jumpEventId ? null : current)), FLASH_MS);
          return;
        }
        if (!hasMoreRef.current) return;
        await paginateBack(50);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    };
    void run();
  }, [jumpNonce, jumpEventId, paginateBack, clearJump]);

  const isDm = summary?.isDm ?? false;
  const label = summary ? (isDm ? summary.name : `#${summary.name}`) : 'this room';

  return (
    <div className={styles.wrap}>
      {/*
       * The spinner floats over the list instead of sitting in the scroll flow: adding a row above
       * the viewport while a pagination is in flight would shift the content the user is reading.
       */}
      {isPaginating && (
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} data-testid="timeline-loading" role="status" aria-label="Loading older messages" />
        </div>
      )}

      <div className={styles.list} data-testid="message-list" ref={containerRef} onScroll={onScroll}>
        <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />

        {!hasMore && (
          <div className={styles.start}>
            <div className={styles.startIcon} aria-hidden="true">
              {isDm ? initialsOf(summary?.name ?? '?') : <Hash size={40} />}
            </div>
            <h2 className={styles.startTitle} data-testid="timeline-start">
              {isDm ? `This is the beginning of your direct message history with ${label}` : `This is the beginning of ${label}`}
            </h2>
            {summary?.topic && <p className={styles.startTopic}>{summary.topic}</p>}
          </div>
        )}

        {items.map((item) =>
          item.kind === 'day' ? (
            <DayDivider key={item.key} ts={item.ts} />
          ) : (
            <MessageRow
              key={item.key}
              roomId={roomId}
              event={item.event}
              groupStart={item.groupStart}
              flash={flashId === item.event.getId()}
            />
          ),
        )}

        <div className={styles.bottomSpacer} />
      </div>

      {!atBottom && (
        <button type="button" className={styles.jumpBottom} data-testid="scroll-to-bottom" onClick={() => scrollToBottom(true)}>
          <ArrowDown size={14} aria-hidden="true" />
          Jump to present
        </button>
      )}
    </div>
  );
}
