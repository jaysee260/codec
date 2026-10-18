/**
 * Scrolling timeline (DEV-B-1 / B-3 / B-6 / B-7 / B-20).
 *
 * Scroll rules:
 * - on source change: jump to the bottom and re-arm pagination;
 * - new events: only follow the bottom when the user is within 40 px of it ("stick to bottom");
 * - backwards pagination: pin the top-most row before the request and then, for a short window, keep
 *   nudging `scrollTop` by however far *that row* has drifted from where it was, so the row the user
 *   was reading stays put while the taller content settles (`paginateBack` replaces the events array
 *   wholesale). The correction is relative and repeated rather than a single "restore the captured
 *   scrollTop plus the delta": a short page leaves the top sentinel in view, so a second page lands
 *   while the first correction is still settling and any captured base is stale by then. Measuring the
 *   row live also removes the need to reason about its own `margin-top`, which flips with
 *   `message-group-start` when an older message from the same sender arrives above it;
 * - a reply-quote jump scrolls to the target, paginating back until it is loaded, then flashes it;
 * - Phase 6 (DEV-B-34): rows that grow *after* their commit (link preview cards arriving, their images
 *   loading, any late-mounting child) fire no scroll event and no React commit here. A ResizeObserver on
 *   the list's content box catches them: stuck to the bottom -> re-pin; a pagination pin live -> let it
 *   correct; scrolled up -> hold the row at the top of the viewport where the reader last saw it
 *   (`reading`, captured on every scroll), so growth above the viewport never moves what they read.
 *
 * Phase 3: the same component renders a channel (`source = { roomId }`) and the replies inside a
 * thread panel (`{ roomId, threadRootId }`). Three differences, all driven by the source:
 *
 *  - **ids.** Inside the panel every id this component owns goes through `tid()` and comes out
 *    prefixed (`thread-message-list`, `thread-timeline-start`, `thread-timeline-loading`), because
 *    both lists are on the page at once. Row ids are untouched (`message-{eventId}`).
 *  - **pagination gate.** A thread's backward token only exists after the SDK's initial
 *    `/relations` fetch; until then the store reports "more, unknown" and a short list would ask for
 *    history on every commit. `isThreadReady` holds the sentinel until the first page has landed.
 *  - **read receipts.** On phone the panel covers the conversation, so the channel's instance pauses:
 *    alice must not "read" rows she cannot see (AC-T3-4). The panel's own instance never pauses and
 *    receipts carry the thread id (AC-T6-8).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Hash } from 'lucide-react';
import { sourceKey, useIsPhone, useOpenThreadRootId, useRoomSummary, type TimelineSource } from '@/store/hooks.ts';
import { isThreadReady } from '@/store/threads.ts';
import { initialsOf } from '@/lib/format.ts';
import { useRoomEvents } from '../hooks/useRoomEvents.ts';
import { usePagination } from '../hooks/usePagination.ts';
import { useReadReceipt } from '../hooks/useReadReceipt.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import { makeTid, type Tid } from '../tid.ts';
import { DayDivider } from './DayDivider.tsx';
import { MessageRow } from './MessageRow.tsx';
import { CallLineRow, isCallLineEvent } from './CallLineRow.tsx';
import styles from './MessageList.module.css';

const NEAR_BOTTOM_PX = 40;
const FLASH_MS = 2600;

/** Scroll position pinned across a backwards pagination. */
interface ScrollAnchor {
  /** The row to keep still. */
  eventId: string;
  /** Where its border box sat in the viewport when the pagination started - the thing to restore. */
  viewportTop: number;
  /** Keep correcting until this timestamp (`performance.now()` scale). */
  until: number;
}

/**
 * How long after a pagination the anchor keeps correcting itself. Long enough to cover a second page
 * landing back-to-back (the top sentinel is still in view right after a short page, so `usePagination`
 * fires again) and anything that mounts a frame or two late inside the prepended rows.
 */
const ANCHOR_WINDOW_MS = 600;

export interface MessageListProps {
  source: TimelineSource;
  /** Id prefix for this list's own testids (`'thread-'` inside the panel). */
  testIdPrefix?: string;
}

export function MessageList({ source, testIdPrefix }: MessageListProps) {
  const roomId = source.roomId;
  const threadRootId = source.threadRootId;
  const key = sourceKey(source);
  const tid: Tid = useMemo(() => makeTid(testIdPrefix), [testIdPrefix]);

  const { items, hasMore, isPaginating, paginateBack, version } = useRoomEvents(source);
  const summary = useRoomSummary(roomId);
  const jump = useConversationUi((s) => s.jump);
  const clearJump = useConversationUi((s) => s.clearJump);
  const isPhone = useIsPhone();
  const openThreadRootId = useOpenThreadRootId();

  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  /** Nonce of the jump currently being resolved; a newer jump supersedes it. */
  const jumpRunRef = useRef(0);
  /** Frame handle of the live anchor re-check. */
  const rafRef = useRef(0);
  /** The scrollTop we last set ourselves, so `onScroll` can tell our own nudges from the reader's. */
  const correctedTo = useRef(0);
  /** The list's content box (every row), observed for late growth (Phase 6 link cards). */
  const contentRef = useRef<HTMLDivElement>(null);
  /** The row at the top of the viewport and where it sat, refreshed on every scroll (scrolled-up case). */
  const reading = useRef<{ eventId: string; viewportTop: number } | null>(null);

  const [armed, setArmed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);

  // The channel list stops receipting while a thread covers it on phone (AC-T3-4); the panel's own
  // list always receipts, into the thread (AC-T6-8).
  useReadReceipt(source, atBottom, { paused: isPhone && !threadRootId && openThreadRootId !== null });

  /** A thread can only be paginated once its first `/relations` page has landed. */
  const canStartPaginating = useMemo(
    () => (threadRootId ? isThreadReady(roomId, threadRootId) : true),
    [roomId, threadRootId, version],
  );

  const scrollToBottom = useCallback((smooth = false): void => {
    const el = containerRef.current;
    if (!el) return;
    stick.current = true;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Source change: bottom, reset every scroll flag, re-arm the pagination sentinel after first paint.
  useLayoutEffect(() => {
    anchor.current = null;
    reading.current = null;
    stick.current = true;
    setAtBottom(true);
    setArmed(false);
    setFlashId(null);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    const timer = setTimeout(() => setArmed(true), 200);
    return () => clearTimeout(timer);
  }, [key]);

  /**
   * Put the pinned row back where it was. Measured live and applied as a *relative* `scrollTop` nudge,
   * never as "restore the scrollTop I captured plus how far the row moved".
   *
   * The captured-base version is what drifted (AC-B3-2, 23 px): a short page leaves the top sentinel in
   * view, so a second `paginateBack` lands while the first correction is still settling, and the second
   * restore computes its target from a base that is already stale. It also had to reason about the
   * pinned row's own `margin-top`, which flips with `message-group-start` when an older message from the
   * same sender arrives above it. Reading "where is this row now vs where should it be" needs neither:
   * whatever happened in between - another page, a group-start flip, a day divider appearing or
   * disappearing, a child mounting late - the error is measured and cancelled.
   */
  const applyAnchor = useCallback((): void => {
    const el = containerRef.current;
    const pin = anchor.current;
    if (!el || !pin) return;
    const row = el.querySelector<HTMLElement>(`[data-event-id="${pin.eventId}"]`);
    if (!row) {
      anchor.current = null; // the pinned row is gone (timeline reset); nothing to hold on to
      return;
    }
    const delta = row.getBoundingClientRect().top - pin.viewportTop;
    if (Math.abs(delta) > 0.5) {
      el.scrollTop += delta;
      correctedTo.current = el.scrollTop;
    }
    if (performance.now() >= pin.until) anchor.current = null;
  }, []);

  /** Re-check every frame while the pin is live, so a layout change React never commits is caught too. */
  const watchAnchor = useCallback((): void => {
    if (rafRef.current) return;
    const step = (): void => {
      rafRef.current = 0;
      applyAnchor();
      if (anchor.current) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [applyAnchor]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, []);

  // Keep the viewport stable across every timeline commit.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // `load()` only records a pin when the list really was scrolled away from the bottom, so a pin here
    // always means "the reader is reading history, keep that row still" (BUG-6).
    if (anchor.current) {
      applyAnchor();
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, isPaginating, version, applyAnchor]);

  /*
   * Stay pinned when the list's own box changes size (BUG-28). The list pins to the bottom on open; the 48 px
   * security banner then mounts above the header and shrinks it, which fires no scroll event, so the newest
   * message ended up cut off by exactly the banner's height. Same for a viewport resize or the phone keyboard.
   * Only while stuck to the bottom and no history pin is live: a reader scrolled up keeps their row
   * (`applyAnchor` owns that case), so pagination anchoring (AC-B3-*) and the thread panel are untouched.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (stick.current && !anchor.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Remember which row is at the top of the viewport and where. Cheap path: hit-test just inside the list's
   * top-left (the gutter column, clear of the centred pagination spinner); fallback: the first row whose bottom
   * is below the list's top edge.
   */
  const captureReading = useCallback((): void => {
    const el = containerRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    let row: HTMLElement | null = null;
    if (typeof document.elementFromPoint === 'function') {
      const hit = document.elementFromPoint(box.left + 24, box.top + 1);
      const candidate = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-event-id]') : null;
      if (candidate && el.contains(candidate)) row = candidate;
    }
    if (!row) {
      for (const r of Array.from(el.querySelectorAll<HTMLElement>('[data-event-id]'))) {
        if (r.getBoundingClientRect().bottom > box.top) {
          row = r;
          break;
        }
      }
    }
    reading.current = row?.dataset.eventId
      ? {
          eventId: row.dataset.eventId,
          viewportTop: row.getBoundingClientRect().top,
        }
      : null;
  }, []);

  /*
   * Late growth inside the list (Phase 6, DEV-B-34). A link card resolving from its one-line placeholder, or its
   * image box, changes the content height after the commit that mounted it, so neither the layout effect above
   * nor the BUG-28 observer (which watches the list's own box) sees it. Same three cases as a commit:
   *  - a pagination pin is live: it owns the position (`applyAnchor`);
   *  - stuck to the bottom: stay there (AC-L7-3);
   *  - scrolled up: put the row the reader had at the top back where it was (AC-L7-4). Growth below that row
   *    (a new message, a card under the very row being read) measures a zero delta and changes nothing.
   * Our own `scrollTop` writes fire `onScroll`, which re-captures `reading` at the corrected spot.
   */
  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (anchor.current) {
        applyAnchor();
        return;
      }
      if (stick.current) {
        el.scrollTop = el.scrollHeight;
        return;
      }
      const pin = reading.current;
      if (!pin) return;
      const row = el.querySelector<HTMLElement>(`[data-event-id="${pin.eventId}"]`);
      if (!row) {
        reading.current = null;
        return;
      }
      const delta = row.getBoundingClientRect().top - pin.viewportTop;
      if (Math.abs(delta) > 0.5) {
        el.scrollTop += delta;
        correctedTo.current = el.scrollTop;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [applyAnchor]);

  const onScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    captureReading();
    // A scroll we did not cause while a pin is live means the reader took over: drop the pin rather
    // than fight them for the rest of the correction window.
    if (anchor.current && Math.abs(el.scrollTop - correctedTo.current) > 2) anchor.current = null;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stick.current = near;
    setAtBottom(near);
  };

  const load = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>('[data-event-id]');
    /*
     * Pin only when there is a row to pin *and* the list is genuinely scrolled away from the bottom
     * (BUG-6). A thread's first pages land in a list still shorter than the viewport, so the top
     * sentinel is in view while we are sitting at the bottom: pinning there and restoring
     * `scrollTop + moved` afterwards would walk the panel off the newest reply, and with an empty
     * snapshot it would restore an offset for a row that does not exist.
     *
     * The test is live geometry, not `stick.current`: that ref is updated by React's `onScroll`, which
     * runs a frame *after* a programmatic `scrollTop = 0` (what AC-B3-2 / AC-T6-4 do), while the
     * IntersectionObserver can fire first - so the ref is stale here and would wrongly report "at the
     * bottom" for a list the test has just scrolled to the top.
     */
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom) {
      anchor.current = null;
    } else {
      const live = anchor.current;
      // A second page right after a short one: keep holding the row we already promised to hold, and
      // just extend the window. Re-pinning to the new top row is what let the first row slip (AC-B3-2).
      if (live && el.querySelector(`[data-event-id="${live.eventId}"]`)) {
        live.until = performance.now() + ANCHOR_WINDOW_MS;
      } else if (first?.dataset.eventId) {
        anchor.current = {
          eventId: first.dataset.eventId,
          viewportTop: first.getBoundingClientRect().top,
          until: performance.now() + ANCHOR_WINDOW_MS,
        };
      } else {
        anchor.current = null;
      }
    }
    correctedTo.current = el.scrollTop;
    void paginateBack(30);
    watchAnchor();
  }, [paginateBack]);

  usePagination({
    containerRef,
    sentinelRef,
    enabled: armed && hasMore && !isPaginating && canStartPaginating,
    load,
    revision: version,
  });

  // Jump to (and flash) a message, loading history until it exists.
  const jumpNonce = jump && jump.key === key ? jump.nonce : 0;
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
  const hasRows = items.some((item) => item.kind === 'message');

  return (
    <div className={styles.wrap}>
      {/*
       * The spinner floats over the list instead of sitting in the scroll flow: adding a row above
       * the viewport while a pagination is in flight would shift the content the user is reading.
       */}
      {isPaginating && (
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} data-testid={tid('timeline-loading')} role="status" aria-label="Loading older messages" />
        </div>
      )}

      <div className={styles.list} data-testid={tid('message-list')} ref={containerRef} onScroll={onScroll}>
        {/* Block wrapper (not a flex column, see the CSS): only here so its size can be observed. */}
        <div ref={contentRef}>
          <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />

          {!hasMore && (
            <div className={`${styles.start} ${threadRootId ? styles.startThread : ''}`}>
              {/* The panel is 400 px wide and the root is already pinned above it, so the thread's
                "beginning of" block is one muted line rather than the channel's badge + headline. */}
              {!threadRootId && (
                <div className={styles.startIcon} aria-hidden="true">
                  {isDm ? initialsOf(summary?.name ?? '?') : <Hash size={40} />}
                </div>
              )}
              <h2 className={styles.startTitle} data-testid={tid('timeline-start')}>
                {threadRootId
                  ? 'This is the beginning of the thread'
                  : isDm
                    ? `This is the beginning of your direct message history with ${label}`
                    : `This is the beginning of ${label}`}
              </h2>
              {threadRootId
                ? !hasRows && <p className={styles.startTopic}>No replies yet - start the thread below.</p>
                : summary?.topic && <p className={styles.startTopic}>{summary.topic}</p>}
            </div>
          )}

          {items.map((item) =>
            item.kind === 'day' ? (
              <DayDivider key={item.key} ts={item.ts} />
            ) : isCallLineEvent(item.event) ? (
              // Phase 7 (DEV-B-38): call lines are main-timeline only (never in a thread panel).
              threadRootId ? null : (
                <CallLineRow key={item.key} event={item.event} roomId={roomId} flash={flashId === item.event.getId()} />
              )
            ) : (
              <MessageRow
                key={item.key}
                source={source}
                event={item.event}
                groupStart={item.groupStart}
                flash={flashId === item.event.getId()}
              />
            ),
          )}

          <div className={styles.bottomSpacer} />
        </div>
      </div>

      {!atBottom && (
        <button type="button" className={styles.jumpBottom} data-testid={tid('scroll-to-bottom')} onClick={() => scrollToBottom(true)}>
          <ArrowDown size={14} aria-hidden="true" />
          Jump to present
        </button>
      )}
    </div>
  );
}
