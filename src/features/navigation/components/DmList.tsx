/**
 * Placeholder DM list (Dev A replaces the internals). Shown when Home is selected.
 * testids: dm-list, dm-item-{roomId}, dm-unread-{roomId}, dm-new
 */
import { Plus } from 'lucide-react';
import { useRoomStore, waitForRoom } from '@/store/rooms.ts';
import { createDm, joinRoom } from '@/lib/matrix/actions.ts';
import { withToast } from '@/store/toast.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import styles from './DmList.module.css';

export function DmList() {
  const dms = useRoomStore((s) => s.dms);
  const invites = useRoomStore((s) => s.invites);
  const orphanRooms = useRoomStore((s) => s.orphanRooms);
  const selectedRoomId = useRoomStore((s) => s.selectedRoomId);
  const unreadByRoom = useRoomStore((s) => s.unreadByRoom);
  const selectRoom = useRoomStore((s) => s.selectRoom);

  const onNewDm = (): void => {
    const userId = window.prompt('User id (e.g. @dave:localhost)');
    if (!userId?.trim()) return;
    void withToast(async () => {
      const roomId = await createDm(userId.trim());
      await waitForRoom(roomId);
      useRoomStore.getState().selectRoom(roomId);
    }, 'Start DM failed');
  };

  const onAcceptInvite = (roomId: string): void => {
    void withToast(async () => {
      await joinRoom(roomId);
      await waitForRoom(roomId);
      useRoomStore.getState().selectRoom(roomId);
    }, 'Join failed');
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Direct Messages</span>
      </div>
      <div className={styles.list} data-testid="dm-list">
        <div className={styles.sectionRow}>
          <span className="u-section-title">Direct messages</span>
          <button className={styles.sectionAdd} data-testid="dm-new" title="Start a DM" onClick={onNewDm}>
            <Plus size={16} />
          </button>
        </div>
        {dms.map((dm) => {
          const unread = unreadByRoom[dm.roomId] ?? 0;
          const selected = dm.roomId === selectedRoomId;
          const seed = dm.dmUserId ?? dm.roomId;
          return (
            <button
              key={dm.roomId}
              className={`${styles.item} ${selected ? styles.itemSelected : ''} ${unread > 0 ? styles.itemUnread : ''}`}
              data-testid={`dm-item-${dm.roomId}`}
              data-name={dm.name}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => selectRoom(dm.roomId)}
            >
              <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(seed) }}>
                {dm.avatarUrl ? <img src={dm.avatarUrl} alt="" /> : initialsOf(dm.name)}
              </span>
              <span className={`${styles.itemName} u-truncate`}>{dm.name}</span>
              {unread > 0 && (
                <span className={styles.badge} data-testid={`dm-unread-${dm.roomId}`} data-count={unread}>
                  {unread}
                </span>
              )}
            </button>
          );
        })}
        {dms.length === 0 && <div className={styles.emptyHint}>No direct messages yet</div>}

        {invites.length > 0 && (
          <>
            <span className="u-section-title">Invites</span>
            {invites.map((inv) => (
              <button
                key={inv.roomId}
                className={styles.item}
                data-testid={`invite-item-${inv.roomId}`}
                data-name={inv.name}
                onClick={() => onAcceptInvite(inv.roomId)}
                title="Click to accept"
              >
                <span className={`${styles.itemName} u-truncate`}>{inv.name}</span>
                <span className={styles.accept}>Accept</span>
              </button>
            ))}
          </>
        )}

        {orphanRooms.length > 0 && (
          <>
            <span className="u-section-title">Other rooms</span>
            {orphanRooms.map((room) => {
              const selected = room.roomId === selectedRoomId;
              return (
                <button
                  key={room.roomId}
                  className={`${styles.item} ${selected ? styles.itemSelected : ''}`}
                  data-testid={`room-item-${room.roomId}`}
                  data-name={room.name}
                  data-selected={selected ? 'true' : 'false'}
                  onClick={() => selectRoom(room.roomId)}
                >
                  <span className={`${styles.itemName} u-truncate`}>{room.name}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
