/**
 * Placeholder SpaceRail (Dev A replaces the internals, keeps the name and testids).
 * testids: space-rail, space-item-home, space-item-{spaceId}, space-unread-{spaceId}, space-add
 */
import { MessageCircle, Plus } from 'lucide-react';
import { useRoomStore, waitForRoom } from '@/store/rooms.ts';
import { createSpace } from '@/lib/matrix/actions.ts';
import { withToast } from '@/store/toast.ts';
import { initialsOf } from '@/lib/format.ts';
import styles from './SpaceRail.module.css';

export function SpaceRail() {
  const spaces = useRoomStore((s) => s.spaces);
  const channelsBySpace = useRoomStore((s) => s.channelsBySpace);
  const dms = useRoomStore((s) => s.dms);
  const unreadByRoom = useRoomStore((s) => s.unreadByRoom);
  const selected = useRoomStore((s) => s.selectedSpaceId);
  const selectSpace = useRoomStore((s) => s.selectSpace);

  const homeUnread = dms.some((d) => (unreadByRoom[d.roomId] ?? 0) > 0);

  const onCreateSpace = (): void => {
    const name = window.prompt('Space name');
    if (!name?.trim()) return;
    void withToast(async () => {
      const spaceId = await createSpace({ name: name.trim() });
      await waitForRoom(spaceId);
      useRoomStore.getState().selectSpace(spaceId);
    }, 'Create space failed');
  };

  return (
    <div className={styles.rail} data-testid="space-rail">
      <div className={styles.item}>
        {homeUnread && <span className={styles.unreadDot} data-testid="space-unread-home" />}
        <button
          className={`${styles.button} ${styles.home} ${selected === 'home' ? styles.selected : ''}`}
          data-testid="space-item-home"
          data-name="Home"
          data-selected={selected === 'home' ? 'true' : 'false'}
          title="Direct Messages"
          onClick={() => selectSpace('home')}
        >
          <MessageCircle size={26} />
        </button>
      </div>
      <div className={styles.divider} />
      {spaces.map((space) => {
        const unread = (channelsBySpace[space.roomId] ?? []).some((c) => (unreadByRoom[c.roomId] ?? 0) > 0);
        const isSelected = selected === space.roomId;
        return (
          <div className={styles.item} key={space.roomId}>
            {unread && <span className={styles.unreadDot} data-testid={`space-unread-${space.roomId}`} />}
            <button
              className={`${styles.button} ${isSelected ? styles.selected : ''}`}
              data-testid={`space-item-${space.roomId}`}
              data-name={space.name}
              data-selected={isSelected ? 'true' : 'false'}
              title={space.name}
              onClick={() => selectSpace(space.roomId)}
            >
              {space.avatarUrl ? <img src={space.avatarUrl} alt="" /> : initialsOf(space.name)}
            </button>
          </div>
        );
      })}
      <div className={styles.item}>
        <button className={`${styles.button} ${styles.add}`} data-testid="space-add" title="Create a space" onClick={onCreateSpace}>
          <Plus size={24} />
        </button>
      </div>
    </div>
  );
}
