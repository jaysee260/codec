/**
 * Placeholder ChannelSidebar (Dev A replaces the internals). Shows the DM list when Home is selected,
 * otherwise the selected space's header + channel list.
 * testids: channel-sidebar, space-header, space-header-name, space-menu, space-menu-invite,
 *          space-menu-create-channel, channel-list, channel-item-{roomId}, channel-unread-{roomId}, channel-add
 */
import { useState } from 'react';
import { ChevronDown, Hash, Plus, X } from 'lucide-react';
import { useRoomStore, waitForRoom } from '@/store/rooms.ts';
import { createChannel, inviteUser } from '@/lib/matrix/actions.ts';
import { showToast, withToast } from '@/store/toast.ts';
import { DmList } from './DmList.tsx';
import styles from './ChannelSidebar.module.css';

export function ChannelSidebar() {
  const spaceId = useRoomStore((s) => s.selectedSpaceId);
  return (
    <div className={styles.sidebar} data-testid="channel-sidebar">
      {spaceId === 'home' ? <DmList /> : <SpaceChannels spaceId={spaceId} />}
    </div>
  );
}

function SpaceChannels({ spaceId }: { spaceId: string }) {
  const space = useRoomStore((s) => s.roomsById[spaceId]);
  const channels = useRoomStore((s) => s.channelsBySpace[spaceId]) ?? [];
  const selectedRoomId = useRoomStore((s) => s.selectedRoomId);
  const unreadByRoom = useRoomStore((s) => s.unreadByRoom);
  const selectRoom = useRoomStore((s) => s.selectRoom);
  const [menuOpen, setMenuOpen] = useState(false);

  const onCreateChannel = (): void => {
    setMenuOpen(false);
    const raw = window.prompt('Channel name');
    if (!raw?.trim()) return;
    const name = raw.trim().toLowerCase().replace(/\s+/g, '-');
    const topic = window.prompt('Topic (optional)') ?? undefined;
    void withToast(async () => {
      const roomId = await createChannel({ spaceId, name, topic: topic?.trim() || undefined });
      await waitForRoom(roomId);
      useRoomStore.getState().selectRoom(roomId);
    }, 'Create channel failed');
  };

  const onInvite = (): void => {
    setMenuOpen(false);
    const userId = window.prompt('User id to invite (e.g. @carol:localhost)');
    if (!userId?.trim()) return;
    void withToast(async () => {
      await inviteUser(spaceId, userId.trim());
      for (const c of channels) await inviteUser(c.roomId, userId.trim()).catch(() => undefined);
      showToast(`Invited ${userId.trim()}`, 'success');
    }, 'Invite failed');
  };

  return (
    <>
      <div className={styles.header} data-testid="space-header">
        <button className={styles.headerButton} data-testid="space-menu" onClick={() => setMenuOpen((o) => !o)}>
          <span className={`${styles.headerName} u-truncate`} data-testid="space-header-name">
            {space?.name ?? 'Space'}
          </span>
          {menuOpen ? <X size={18} /> : <ChevronDown size={18} />}
        </button>
        {menuOpen && (
          <div className={styles.menu} role="menu">
            <button className={styles.menuItem} data-testid="space-menu-invite" onClick={onInvite}>
              Invite people
            </button>
            <button className={styles.menuItem} data-testid="space-menu-create-channel" onClick={onCreateChannel}>
              Create channel
            </button>
          </div>
        )}
      </div>
      <div className={styles.list} data-testid="channel-list">
        <div className={styles.sectionRow}>
          <span className="u-section-title">Text channels</span>
          <button className={styles.sectionAdd} data-testid="channel-add" title="Create channel" onClick={onCreateChannel}>
            <Plus size={16} />
          </button>
        </div>
        {channels.map((c) => {
          const unread = unreadByRoom[c.roomId] ?? 0;
          const selected = c.roomId === selectedRoomId;
          return (
            <button
              key={c.roomId}
              className={`${styles.item} ${selected ? styles.itemSelected : ''} ${unread > 0 ? styles.itemUnread : ''}`}
              data-testid={`channel-item-${c.roomId}`}
              data-name={c.name}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => selectRoom(c.roomId)}
              title={c.topic}
            >
              <Hash size={18} className={styles.hash} />
              <span className={`${styles.itemName} u-truncate`}>{c.name}</span>
              {unread > 0 && (
                <span className={styles.badge} data-testid={`channel-unread-${c.roomId}`} data-count={unread}>
                  {unread}
                </span>
              )}
            </button>
          );
        })}
        {channels.length === 0 && <div className={styles.emptyHint}>No channels yet</div>}
      </div>
    </>
  );
}
