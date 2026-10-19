/**
 * DEV-A-17 Threads list: the per-room thread index behind `header-threads`.
 *
 * One component, two presentations (docs/archive/PHASE3_ACCEPTANCE.md `thread-list[data-variant]`):
 *  - desktop `popover`: anchored under the button, right-aligned, 380 px wide.
 *  - phone `sheet`: a bottom sheet with the same geometry as `Dialog`'s sheet variant (full width,
 *    flush with the viewport bottom + `--safe-bottom`, grab handle, slide-up).
 *
 * Both render in a **portal on document.body**. The channel header has `z-index: 1` and is a flex item,
 * which makes it a stacking context (see the long comment in ChannelHeader.module.css), so an
 * in-header `position: absolute` popover - the `space-menu` pattern - would be trapped at level 1,
 * underneath the conversation's own stacked boxes. The popover therefore positions itself from the
 * anchor button's `getBoundingClientRect()` with `position: fixed`.
 *
 * Closing (AC-T7-7): Escape (captured, like `Dialog`, so the composer's own Escape does not also
 * fire), a click outside, `thread-list-close`, picking an item, and - on phone - opening a drawer.
 * Opening the list closes any open drawer (`useLayoutStore.closeAll()`); `ChannelHeader` does that
 * before mounting this.
 *
 * Data: `useRoomThreads(roomId)` (`src/store/threads.ts`), which runs `GET /rooms/{id}/threads` on
 * mount - and this component is only mounted while the list is open, so every open refreshes - then
 * reads `room.getThreads()` live on `threadVersion`. Redacted roots are filtered here: the hook does
 * not drop them (docs/archive/PHASE3_PLAN.md "the list hides redacted roots").
 *
 * Times and the `N replies` wording come from `@/lib/format.ts` (`formatRelative`) and the local
 * `replyCountText` below - the pinned strings Dev B's summary row uses too (docs/BUGS.md D-2).
 *
 * testids: thread-list, thread-list-close, thread-list-empty, thread-list-item-{rootId},
 *          thread-list-item-author, thread-list-item-snippet, thread-list-item-count,
 *          thread-list-item-time, thread-list-item-avatars, thread-list-backdrop (phone scrim;
 *          `drawer-backdrop` belongs to the Shell and only shows while a drawer is open)
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { colorFor, formatRelative, initialsOf } from '@/lib/format.ts';
import { avatarUrlOf, displayNameOf, previewText } from '@/lib/matrix/utils.ts';
import { hapticTap } from '@/lib/native.ts';
import { useIsPhone } from '@/store/hooks.ts';
import { useLayoutStore } from '@/store/layout.ts';
import { useRoomThreads, useThreadStore, type ThreadSummary } from '@/store/threads.ts';
import styles from './ThreadList.module.css';

/** Popover geometry (desktop). Kept in sync with `.popover` in the stylesheet. */
const POPOVER_W = 380;
const VIEWPORT_MARGIN = 8;
/** Distance from the bottom of the scroller that triggers `loadMore()`. */
const LOAD_MORE_SLACK = 64;
/** Max participant avatars per item (registry: "up to 3 avatars"). */
const MAX_AVATARS = 3;

/**
 * `1 reply` / `N replies` for `thread-list-item-count` (AC-T7-2) - the strings pinned in
 * docs/archive/PHASE3_PLAN.md. Dev B inlines the same two words for `thread-replies-divider` /
 * `thread-summary-count`; `@/lib/format.ts` is the Principal's file and only `formatRelative` was
 * asked for there (docs/BUGS.md D-2), so each owner keeps this one-liner rather than importing
 * across a feature boundary.
 */
function replyCountText(count: number): string {
  return count === 1 ? '1 reply' : `${count} replies`;
}

export interface ThreadListProps {
  roomId: string;
  /** The `header-threads` button, used to place the desktop popover and to ignore its own clicks. */
  anchor: HTMLElement | null;
  onClose(): void;
}

export function ThreadList({ roomId, anchor, onClose }: ThreadListProps) {
  const isPhone = useIsPhone();
  const { threads, loading, hasMore, loadMore } = useRoomThreads(roomId);
  const openThread = useThreadStore((s) => s.openThread);
  const openRootId = useThreadStore((s) => s.openThreadRootId);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Redacted roots are hidden (PHASE3_PLAN risk table); the hook keeps them.
  const items = useMemo(
    () => threads.filter((t) => !!t.rootEvent && !t.rootEvent.isRedacted()),
    [threads],
  );

  // DEV-A-19: relative times go stale in an open list, so re-render once a minute.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Escape closes. Capture phase + stopPropagation so the conversation composer's Escape (AC-B6-4,
  // AC-T6-9) does not also act on it while the list is in front.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // Outside click (desktop popover; the sheet has its own backdrop). The anchor counts as "inside",
  // otherwise this mousedown would close the list and the button's own click would reopen it.
  useEffect(() => {
    if (isPhone) return;
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isPhone, anchor, onClose]);

  // AC-T7-7 "and vice versa": a drawer opening on phone closes the list.
  useEffect(() => {
    if (!isPhone) return;
    return useLayoutStore.subscribe((s) => {
      if (s.navOpen || s.membersOpen) onClose();
    });
  }, [isPhone, onClose]);

  // Focus the first item so Escape/arrow keys work without a click (DEV-A-19 keyboard navigation).
  useEffect(() => {
    const first = cardRef.current?.querySelector<HTMLElement>('[data-thread-item="true"]');
    (first ?? cardRef.current)?.focus();
  }, [items.length === 0]);

  const onOpenItem = useCallback(
    (rootId: string): void => {
      hapticTap();
      useLayoutStore.getState().closeAll();
      openThread(rootId, roomId);
      onClose();
    },
    [openThread, roomId, onClose],
  );

  const onScroll = useCallback((): void => {
    const el = listRef.current;
    if (!el || !hasMore || loading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_SLACK) void loadMore();
  }, [hasMore, loading, loadMore]);

  // Arrow keys / Home / End move between items; Enter and Space are the button's own.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const nodes = [...(cardRef.current?.querySelectorAll<HTMLElement>('[data-thread-item="true"]') ?? [])];
    if (nodes.length === 0) return;
    e.preventDefault();
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? nodes.length - 1
      : e.key === 'ArrowDown' ? Math.min(nodes.length - 1, current + 1)
      : Math.max(0, current <= 0 ? 0 : current - 1);
    nodes[next]?.focus();
  }, []);

  // Unconditional hook call (`isPhone` is stable within a mount, but a rotation / resize across the
  // phone breakpoint must not change the hook order). The sheet ignores the style.
  const popoverStyle = usePopoverStyle(isPhone ? null : anchor);

  const card = (
    <div
      className={`${styles.card} ${isPhone ? styles.sheet : styles.popover}`}
      style={isPhone ? undefined : popoverStyle}
      data-testid="thread-list"
      data-variant={isPhone ? 'sheet' : 'popover'}
      data-loading={loading ? 'true' : 'false'}
      data-count={items.length}
      role="dialog"
      aria-label="Threads"
      tabIndex={-1}
      ref={cardRef}
      onKeyDown={onKeyDown}
    >
      {isPhone && <span className={styles.handle} aria-hidden="true" />}

      <header className={styles.header}>
        <span className={styles.title}>Threads</span>
        <button
          type="button"
          className={styles.close}
          data-testid="thread-list-close"
          title="Close"
          aria-label="Close threads"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className={styles.scroller} ref={listRef} onScroll={onScroll} role="list">
        {items.map((thread) => (
          <ThreadListItem
            key={thread.rootId}
            thread={thread}
            selected={thread.rootId === openRootId}
            onOpen={onOpenItem}
          />
        ))}

        {items.length === 0 && loading && <div className={styles.status}>Loading threads...</div>}

        {items.length === 0 && !loading && (
          <div className={styles.empty}>
            {/* AC-T7-5 asserts `toHaveText('No threads yet')`, so the testid carries that string and
             * nothing else; the hint is a sibling. */}
            <span className={styles.emptyTitle} data-testid="thread-list-empty">
              No threads yet
            </span>
            <span className={styles.emptyText} data-testid="thread-list-empty-hint">
              Hover a message and pick &ldquo;Reply in thread&rdquo; to start one.
            </span>
          </div>
        )}

        {items.length > 0 && loading && <div className={styles.status}>Loading more...</div>}
      </div>
    </div>
  );

  return createPortal(
    isPhone ? (
      <div
        className={styles.backdrop}
        /* Its own testid: `drawer-backdrop` is the Shell's (it only shows while a *drawer* is open),
         * the same split Dev B's `message-action-sheet-backdrop` uses. */
        data-testid="thread-list-backdrop"
        /* `mousedown` + `click` like Dialog: `pointerdown` would dismiss the sheet at touch-start and
         * the synthesized click would land on whatever is underneath (a ghost tap). */
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {card}
      </div>
    ) : (
      card
    ),
    document.body,
  );
}

/** Fixed position under the anchor, right-aligned, clamped to the viewport. Follows resize/scroll. */
function usePopoverStyle(anchor: HTMLElement | null): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const place = useCallback((): void => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - r.right);
    const top = r.bottom + 6;
    setStyle({
      top: Math.round(top),
      right: Math.round(right),
      width: Math.min(POPOVER_W, window.innerWidth - 2 * VIEWPORT_MARGIN),
      maxHeight: Math.max(160, Math.round(window.innerHeight - top - VIEWPORT_MARGIN)),
    });
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  return style;
}

function ThreadListItem({
  thread,
  selected,
  onOpen,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onOpen(rootId: string): void;
}) {
  const root = thread.rootEvent as MatrixEvent;
  const room = getClientOrNull()?.getRoom(thread.roomId) ?? null;
  const authorId = root.getSender() ?? '';
  const author = displayNameOf(room, authorId);
  const snippet = previewText(root, 160);
  // Newest participants first, so the avatars match the "who spoke last" reading of the row.
  const avatars = [...thread.participants].reverse().slice(0, MAX_AVATARS);

  return (
    <button
      type="button"
      className={`${styles.item} ${selected ? styles.itemSelected : ''}`}
      data-testid={`thread-list-item-${thread.rootId}`}
      data-thread-item="true"
      data-count={thread.count}
      data-ts={thread.latestTs}
      data-unread={thread.hasUnread ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      role="listitem"
      title={snippet}
      onClick={() => onOpen(thread.rootId)}
    >
      <Avatar roomId={thread.roomId} userId={authorId} name={author} size={32} className={styles.rootAvatar} />

      <span className={styles.body}>
        <span className={styles.top}>
          <span className={`${styles.author} u-truncate`} data-testid="thread-list-item-author">
            {author}
          </span>
          <span className={styles.time} data-testid="thread-list-item-time">
            {formatRelative(thread.latestTs)}
          </span>
          {thread.hasUnread && <span className={styles.unread} aria-label="Unread replies" />}
        </span>

        <span className={styles.snippet} data-testid="thread-list-item-snippet">
          {snippet}
        </span>

        <span className={styles.meta}>
          <span className={styles.count} data-testid="thread-list-item-count">
            {replyCountText(thread.count)}
          </span>
          <span className={styles.avatars} data-testid="thread-list-item-avatars">
            {avatars.map((userId) => (
              <Avatar
                key={userId}
                roomId={thread.roomId}
                userId={userId}
                name={displayNameOf(room, userId)}
                size={20}
                className={styles.participant}
              />
            ))}
          </span>
        </span>
      </span>
    </button>
  );
}

function Avatar({
  roomId,
  userId,
  name,
  size,
  className = '',
}: {
  roomId: string;
  userId: string;
  name: string;
  size: number;
  className?: string;
}) {
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const url = userId ? avatarUrlOf(room, userId, size) : '';
  return (
    <span
      className={`u-avatar ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: colorFor(userId) }}
      title={name}
    >
      {url ? <img src={url} alt="" /> : initialsOf(name)}
    </span>
  );
}
