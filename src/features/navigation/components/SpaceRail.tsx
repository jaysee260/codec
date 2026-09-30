/**
 * DEV-A-1 space rail (column 1, 72 px). Home (DMs) button, divider, one 48 px round icon per joined
 * space that morphs to a rounded square on hover/selection, the white Discord pill on the left, and
 * a red numeric badge when any child channel is unread (DEV-A-5).
 *
 * testids: space-rail, space-item-home, space-item-{spaceId}, space-unread-{spaceId},
 *          space-unread-home, space-add
 */
import { useState, type ReactNode } from 'react';
import { MessagesSquare, Plus } from 'lucide-react';
import { useRoomStore } from '@/store/rooms.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { badgeText, useHomeUnread, useSpaceUnread } from '../hooks/useUnread.ts';
import { CreateSpaceDialog } from './CreateSpaceDialog.tsx';
import styles from './SpaceRail.module.css';

export function SpaceRail() {
  const spaces = useRoomStore((s) => s.spaces);
  const selected = useRoomStore((s) => s.selectedSpaceId);
  const selectSpace = useRoomStore((s) => s.selectSpace);
  const homeUnread = useHomeUnread();
  const [creating, setCreating] = useState(false);

  return (
    <div className={styles.rail} data-testid="space-rail">
      <RailItem
        testId="space-item-home"
        name="Home"
        title="Direct Messages"
        selected={selected === 'home'}
        unread={homeUnread}
        unreadTestId="space-unread-home"
        onClick={() => selectSpace('home')}
        className={styles.home}
      >
        <MessagesSquare size={26} strokeWidth={2} />
      </RailItem>

      <div className={styles.divider} role="separator" />

      {spaces.map((space) => (
        <SpaceRailItem key={space.roomId} spaceId={space.roomId} name={space.name} avatarUrl={space.avatarUrl} selected={selected === space.roomId} />
      ))}

      <RailItem
        testId="space-add"
        name="Add a space"
        title="Create a space"
        selected={false}
        unread={0}
        onClick={() => setCreating(true)}
        className={styles.add}
      >
        <Plus size={24} />
      </RailItem>

      {creating && <CreateSpaceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function SpaceRailItem({
  spaceId,
  name,
  avatarUrl,
  selected,
}: {
  spaceId: string;
  name: string;
  avatarUrl?: string;
  selected: boolean;
}) {
  const selectSpace = useRoomStore((s) => s.selectSpace);
  const unread = useSpaceUnread(spaceId);
  return (
    <RailItem
      testId={`space-item-${spaceId}`}
      name={name}
      title={name}
      selected={selected}
      unread={unread}
      unreadTestId={`space-unread-${spaceId}`}
      onClick={() => selectSpace(spaceId)}
      style={avatarUrl ? undefined : { background: colorFor(spaceId) }}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" /> : initialsOf(name)}
    </RailItem>
  );
}

function RailItem({
  testId,
  name,
  title,
  selected,
  unread,
  unreadTestId,
  onClick,
  children,
  className = '',
  style,
}: {
  testId: string;
  name: string;
  title: string;
  selected: boolean;
  unread: number;
  unreadTestId?: string;
  onClick(): void;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const hasUnread = unread > 0;
  return (
    <div className={styles.item}>
      <span
        className={`${styles.pill} ${selected ? styles.pillSelected : ''} ${hasUnread && !selected ? styles.pillUnread : ''}`}
        aria-hidden="true"
      />
      <button
        type="button"
        className={`${styles.button} ${selected ? styles.selected : ''} ${className}`}
        data-testid={testId}
        data-name={name}
        data-selected={selected ? 'true' : 'false'}
        title={title}
        aria-label={title}
        aria-current={selected ? 'true' : undefined}
        style={style}
        onClick={onClick}
      >
        {children}
      </button>
      {hasUnread && unreadTestId && (
        <span className={styles.badge} data-testid={unreadTestId} data-count={unread} title={`${unread} unread`}>
          {badgeText(unread)}
        </span>
      )}
    </div>
  );
}
