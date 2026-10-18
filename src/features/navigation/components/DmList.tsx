/**
 * DEV-A-3 / DEV-A-5 DM list, rendered by the sidebar when Home is selected. One item per room in
 * `m.direct` with a colour-hashed initials avatar (or the other user's avatar), the display name and
 * a numeric unread badge. Pending invites and space-less rooms are listed underneath so nothing is
 * unreachable.
 *
 * testids: dm-list, dm-item-{roomId} (+data-encrypted, Phase 5), dm-unread-{roomId}, dm-new
 * DEV-A-27: encrypted rooms carry a small muted lock after the name.
 * DEV-A-34 (Phase 7): `room-call-indicator[data-count]` before the unread badge while a call is live in the room;
 * `data-preview="missed-call"` + a red "Missed call" line under the name while the last row is a missed call for me.
 */
import { useState } from 'react';
import { Lock, Search } from 'lucide-react';
import { useRoomStore, waitForRoom, type RoomSummary } from '@/store/rooms.ts';
import { joinRoom } from '@/lib/matrix/actions.ts';
import { hapticTap } from '@/lib/native.ts';
import { withToast } from '@/store/toast.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { badgeText, useUnread } from '../hooks/useUnread.ts';
import { useLiveCallCount, useMissedCallPreview } from '../hooks/useRoomCall.ts';
import { MissedCallPreview, RoomCallIndicator } from './RoomCallIndicator.tsx';
import { NewDmDialog } from './NewDmDialog.tsx';
import { SidebarSection } from './SidebarSection.tsx';
import styles from './DmList.module.css';

export function DmList() {
  const dms = useRoomStore((s) => s.dms);
  const invites = useRoomStore((s) => s.invites);
  const orphanRooms = useRoomStore((s) => s.orphanRooms);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className={styles.header}>
        <button type="button" className={styles.search} title="Find or start a conversation" onClick={() => setCreating(true)}>
          <Search size={14} />
          <span className="u-truncate">Find or start a conversation</span>
        </button>
      </div>

      <div className={styles.list} data-testid="dm-list">
        <SidebarSection
          id="direct-messages"
          label="Direct Messages"
          addTestId="dm-new"
          addTitle="Start a DM"
          onAdd={() => setCreating(true)}
        >
          {dms.map((dm) => (
            <DmItem key={dm.roomId} room={dm} />
          ))}
          {dms.length === 0 && <div className={styles.empty}>No direct messages yet</div>}
        </SidebarSection>

        {invites.length > 0 && (
          <SidebarSection id="invites" label={`Invites - ${invites.length}`}>
            {invites.map((invite) => (
              <InviteItem key={invite.roomId} room={invite} />
            ))}
          </SidebarSection>
        )}

        {orphanRooms.length > 0 && (
          <SidebarSection id="other-rooms" label="Other Rooms">
            {orphanRooms.map((room) => (
              <DmItem key={room.roomId} room={room} testIdPrefix="room-item" />
            ))}
          </SidebarSection>
        )}
      </div>

      {creating && <NewDmDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function DmItem({ room, testIdPrefix = 'dm-item' }: { room: RoomSummary; testIdPrefix?: string }) {
  const selectedRoomId = useRoomStore((s) => s.selectedRoomId);
  const selectRoom = useRoomStore((s) => s.selectRoom);
  const unread = useUnread(room.roomId);
  const selected = room.roomId === selectedRoomId;
  const bold = unread > 0 && !selected;
  const seed = room.dmUserId ?? room.roomId;
  const callCount = useLiveCallCount(room.roomId);
  const missed = useMissedCallPreview(room.roomId);

  return (
    <button
      type="button"
      className={`${styles.item} ${selected ? styles.itemSelected : ''} ${bold ? styles.itemUnread : ''}`}
      data-testid={`${testIdPrefix}-${room.roomId}`}
      data-preview={missed ? 'missed-call' : undefined}
      data-name={room.name}
      data-selected={selected ? 'true' : 'false'}
      data-encrypted={room.encrypted ? 'true' : 'false'}
      title={room.dmUserId ?? room.name}
      // selectRoom only: the layout store closes the nav drawer on phone (docs/ARCHITECTURE.md).
      onClick={() => {
        hapticTap(); // DEV-A-16; no-op in a browser
        selectRoom(room.roomId);
      }}
    >
      <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(seed) }}>
        {room.avatarUrl ? <img src={room.avatarUrl} alt="" /> : initialsOf(room.name)}
      </span>
      {missed ? (
        <span className={styles.nameStack}>
          <span className={`${styles.nameLine} u-truncate`}>{room.name}</span>
          <MissedCallPreview block />
        </span>
      ) : (
        <span className={`${styles.name} u-truncate`}>{room.name}</span>
      )}
      {room.encrypted && <Lock className={styles.lock} size={12} aria-hidden="true" />}
      {callCount > 0 && <RoomCallIndicator count={callCount} />}
      {unread > 0 && (
        <span className={styles.badge} data-testid={`dm-unread-${room.roomId}`} data-count={unread}>
          {badgeText(unread)}
        </span>
      )}
    </button>
  );
}

function InviteItem({ room }: { room: RoomSummary }) {
  const [busy, setBusy] = useState(false);
  const accept = (): void => {
    setBusy(true);
    void withToast(async () => {
      await joinRoom(room.roomId);
      await waitForRoom(room.roomId);
      useRoomStore.getState().selectRoom(room.roomId);
    }, 'Join failed').finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      className={`${styles.item} ${styles.itemUnread}`}
      data-testid={`invite-item-${room.roomId}`}
      data-name={room.name}
      title={`Accept the invite to ${room.name}`}
      disabled={busy}
      onClick={accept}
    >
      <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(room.roomId) }}>
        {initialsOf(room.name)}
      </span>
      <span className={`${styles.name} u-truncate`}>{room.name}</span>
      <span className={styles.accept}>{busy ? '...' : 'Accept'}</span>
    </button>
  );
}
