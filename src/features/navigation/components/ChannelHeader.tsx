/**
 * DEV-A-2 / DEV-A-12 channel header (mounted by the shell above <Conversation/>).
 *
 * Desktop (unchanged from Phase 1): `#name` (or `@name` for a DM), the topic, and the `member-toggle`
 * that shows/hides the inline member panel through `useNavUiStore` (AC-A4-3).
 *
 * Phone (DEV-A-12): a 56 px (`--phone-header-h`) bar with `header-menu` on the left opening the nav
 * drawer (`useLayoutStore.openNav()`), the room name on one line, and `member-toggle` on the right
 * opening the member drawer (`openMembers()`). The topic is not rendered (AC-M3-1 "hidden"); the
 * toggle is still absent for DMs (AC-M3-3). Both buttons are >= 44x44 (AC-M5-1).
 * Safe areas: `.phoneShell` already pads top/left/right, so the header adds none of its own - its
 * height must stay <= 56 px (AC-M3-1).
 *
 * `header-menu-unread` (DEV-A-16) is a dot on the menu button while any room other than the one on
 * screen has unread messages, so a closed drawer still shows there is something to see.
 *
 * testids: channel-header, channel-header-name, channel-header-topic, member-toggle, header-menu,
 *          header-menu-unread
 */
import { Menu, Users } from 'lucide-react';
import { useRoomSummary, useIsPhone } from '@/store/hooks.ts';
import { useLayoutStore } from '@/store/layout.ts';
import { useOtherRoomsUnread } from '../hooks/useUnread.ts';
import { useNavUiStore } from '../state.ts';
import styles from './ChannelHeader.module.css';

export function ChannelHeader({ roomId }: { roomId: string }) {
  const room = useRoomSummary(roomId);
  const isPhone = useIsPhone();
  const membersOpen = useNavUiStore((s) => s.membersOpen);
  const toggleMembers = useNavUiStore((s) => s.toggleMembers);
  const otherUnread = useOtherRoomsUnread();

  if (!room) return <div className={styles.header} data-testid="channel-header" />;

  // Phone: open the right drawer (layout store). Desktop: toggle the inline panel (nav UI store).
  const onMembers = isPhone ? () => useLayoutStore.getState().openMembers() : toggleMembers;
  const membersLabel = isPhone ? 'Show Members' : membersOpen ? 'Hide Member List' : 'Show Member List';

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
        {room.isDm ? '@' : '#'}
      </span>
      <span className={`${styles.name} u-truncate`} data-testid="channel-header-name">
        {room.name}
      </span>

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
    </div>
  );
}
