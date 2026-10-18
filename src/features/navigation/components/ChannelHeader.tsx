/**
 * DEV-A-2 / DEV-A-12 / DEV-A-17 / DEV-A-18 channel header (mounted by the shell above <Conversation/>).
 *
 * Desktop (unchanged from Phase 1 except the Threads button): `#name` (or `@name` for a DM), the
 * topic, `header-threads` and the `member-toggle` that shows/hides the inline member panel through
 * `useNavUiStore` (AC-A4-3). `header-back` is never rendered here (AC-T8-3).
 *
 * Phone (DEV-A-12): a 56 px (`--phone-header-h`) bar with `header-menu` on the left opening the nav
 * drawer (`useLayoutStore.openNav()`), the room name on one line, then `header-threads` and
 * `member-toggle` on the right opening the member drawer (`openMembers()`). The topic is not
 * rendered (AC-M3-1 "hidden"); the member toggle is still absent for DMs (AC-M3-3). Every button is
 * >= 44x44 (AC-M5-1).
 * Safe areas: `.phoneShell` already pads top/left/right, so the header adds none of its own - its
 * height must stay <= 56 px (AC-M3-1).
 *
 * `header-menu-unread` (DEV-A-16) is a dot on the menu button while any room other than the one on
 * screen has unread messages, so a closed drawer still shows there is something to see.
 *
 * DEV-A-17 Threads: `header-threads` sits left of `member-toggle` (at the right edge in a DM, which
 * has no member toggle) in channels and DMs. It carries `header-threads-unread` while
 * `useThreadUnread(roomId)` is true (server `unread_thread_notifications`; a threaded read receipt
 * clears it) and opens `<ThreadList/>` - a popover anchored under the button on desktop, a bottom
 * sheet on phone. On phone, opening it closes whichever drawer is open (AC-T7-7); the list closes
 * itself on Escape, an outside click / backdrop tap, `thread-list-close`, picking an item, and when
 * a drawer opens.
 *
 * DEV-A-18 phone thread header: while a thread is open in **this** room on phone the bar becomes
 * `header-back` (-> `closeThread()`), the title `Thread` and `header-thread-room` with the room's
 * `#name` / `@name`; `header-menu`, `header-threads` and `member-toggle` are not rendered (AC-T8-1).
 * Desktop is untouched by this branch (AC-T8-3).
 *
 * testids: channel-header, channel-header-name, channel-header-topic, member-toggle, header-menu,
 *          header-menu-unread, header-threads, header-threads-unread, header-back,
 *          header-thread-room, channel-header-lock
 *
 * DEV-A-27 (Phase 5): `channel-header-lock` (14 px lock, `title="End-to-end encrypted"`) right after the name
 * while `RoomSummary.encrypted`; absent in plain rooms. It appears live when a room turns encrypted (AC-E6-6).
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Lock, Menu, MessageSquareText, Users } from 'lucide-react';
import { useRoomSummary, useIsPhone } from '@/store/hooks.ts';
import { useLayoutStore } from '@/store/layout.ts';
import { useOpenThread, useThreadStore, useThreadUnread } from '@/store/threads.ts';
import { useOtherRoomsUnread } from '../hooks/useUnread.ts';
import { useNavUiStore } from '../state.ts';
import { ThreadList } from './ThreadList.tsx';
import styles from './ChannelHeader.module.css';

export function ChannelHeader({ roomId }: { roomId: string }) {
  const room = useRoomSummary(roomId);
  const isPhone = useIsPhone();
  const membersOpen = useNavUiStore((s) => s.membersOpen);
  const toggleMembers = useNavUiStore((s) => s.toggleMembers);
  const otherUnread = useOtherRoomsUnread();

  const openThread = useOpenThread();
  const threadUnread = useThreadUnread(roomId);
  // The anchor lives in state rather than a ref so the popover re-places itself once the button is
  // mounted (a ref mutation would not re-render ThreadList).
  const [threadsAnchor, setThreadsAnchor] = useState<HTMLButtonElement | null>(null);
  const [listOpen, setListOpen] = useState(false);

  // The header is not remounted on a room switch, so the list must not survive one (it is per-room).
  useEffect(() => setListOpen(false), [roomId]);

  // A thread opening hides the button the list is anchored to (phone) / replaces the column it sits
  // over (desktop); either way the list is done.
  const threadRootId = openThread?.threadRootId ?? null;
  useEffect(() => {
    if (threadRootId) setListOpen(false);
  }, [threadRootId]);

  if (!room) return <div className={styles.header} data-testid="channel-header" />;

  // DEV-A-18: only this room's thread turns this header into the thread header, and only on phone.
  const inThread = isPhone && openThread?.roomId === roomId;
  const sigil = room.isDm ? '@' : '#';

  if (inThread) {
    return (
      <div className={styles.header} data-testid="channel-header">
        <button
          type="button"
          className={styles.back}
          data-testid="header-back"
          title="Back to the conversation"
          aria-label="Back to the conversation"
          onClick={() => useThreadStore.getState().closeThread()}
        >
          <ArrowLeft size={24} />
        </button>

        <span className={styles.threadTitles}>
          {/* AC-T8-1 asserts this reads exactly `Thread`, so the room name is its own element. */}
          <span className={styles.threadTitle} data-testid="channel-header-name">
            Thread
          </span>
          <span className={`${styles.threadRoom} u-truncate`} data-testid="header-thread-room">
            {sigil}
            {room.name}
          </span>
        </span>
      </div>
    );
  }

  // Phone: open the right drawer (layout store). Desktop: toggle the inline panel (nav UI store).
  const onMembers = isPhone ? () => useLayoutStore.getState().openMembers() : toggleMembers;
  const membersLabel = isPhone ? 'Show Members' : membersOpen ? 'Hide Member List' : 'Show Member List';

  const onThreads = (): void => {
    // AC-T7-7 "on phone opening it closes any drawer": do it before the sheet mounts, so the sheet's
    // own "a drawer opened -> close me" subscription cannot see the transition and close it again.
    if (isPhone) useLayoutStore.getState().closeAll();
    setListOpen((open) => !open);
  };

  return (
    <div className={styles.header} data-testid="channel-header">
      {isPhone && (
        <button
          type="button"
          className={styles.menu}
          data-testid="header-menu"
          title="Open navigation"
          aria-label="Open navigation"
          onClick={() => useLayoutStore.getState().openNav()}
        >
          <Menu size={24} />
          {otherUnread && <span className={styles.menuDot} data-testid="header-menu-unread" aria-hidden="true" />}
        </button>
      )}

      <span className={styles.sigil} aria-hidden="true">
        {sigil}
      </span>
      <span className={`${styles.name} u-truncate`} data-testid="channel-header-name">
        {room.name}
      </span>
      {room.encrypted && <EncryptedLock />}

      {/* The topic is desktop-only: at 412 px it would push the name out of the bar (AC-M3-1). */}
      {!isPhone && room.topic && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <span className={`${styles.topic} u-truncate`} data-testid="channel-header-topic" title={room.topic}>
            {room.topic}
          </span>
        </>
      )}

      <span className={styles.spacer} />

      <button
        type="button"
        className={`${styles.threads} ${listOpen ? styles.threadsActive : ''}`}
        data-testid="header-threads"
        title="Threads"
        aria-label="Threads"
        aria-haspopup="dialog"
        aria-expanded={listOpen}
        ref={setThreadsAnchor}
        onClick={onThreads}
      >
        <MessageSquareText size={20} />
        {threadUnread && (
          <span className={styles.threadsDot} data-testid="header-threads-unread" aria-label="Unread threads" />
        )}
      </button>

      {!room.isDm && (
        <button
          type="button"
          className={`${styles.toggle} ${!isPhone && membersOpen ? styles.toggleActive : ''}`}
          data-testid="member-toggle"
          title={membersLabel}
          aria-label={membersLabel}
          aria-pressed={isPhone ? undefined : membersOpen}
          onClick={onMembers}
        >
          <Users size={20} />
        </button>
      )}

      {listOpen && (
        <ThreadList roomId={roomId} anchor={threadsAnchor} onClose={() => setListOpen(false)} />
      )}
    </div>
  );
}

/** DEV-A-27: lock after the room name (both layouts). The wrapper carries the testid + tooltip (an SVG `title` attribute is not a tooltip). */
function EncryptedLock() {
  return (
    <span className={styles.lock} data-testid="channel-header-lock" title="End-to-end encrypted" aria-label="End-to-end encrypted" role="img">
      <Lock size={14} aria-hidden="true" />
    </span>
  );
}
