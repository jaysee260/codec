/**
 * DEV-A-2 / DEV-A-5 channel list. Items are sorted by `m.space.child` order then name by the store,
 * rendered with a literal `#` prefix, a hover/selected background, a bold white name while unread and
 * a numeric red badge.
 *
 * testids: channel-list, channel-item-{roomId} (+data-encrypted, Phase 5), channel-unread-{roomId}, channel-add
 * DEV-A-27: encrypted rooms carry a small muted lock after the name (no text, so innerText stays `#name`).
 * DEV-A-34 (Phase 7): `room-call-indicator[data-count]` (speaker + count) before the unread badge while a call is live
 * in the channel; `data-preview="missed-call"` + a red "Missed call" after the name while the last row is a missed
 * call for me (only then: innerText stays `#name` otherwise).
 */
import { Lock } from 'lucide-react';
import { useRoomStore, type RoomSummary } from '@/store/rooms.ts';
import { hapticTap } from '@/lib/native.ts';
import { badgeText, useUnread } from '../hooks/useUnread.ts';
import { useLiveCallCount, useMissedCallPreview } from '../hooks/useRoomCall.ts';
import { MissedCallPreview, RoomCallIndicator } from './RoomCallIndicator.tsx';
import { SidebarSection } from './SidebarSection.tsx';
import styles from './ChannelList.module.css';

export function ChannelList({ spaceId, onAddChannel }: { spaceId: string; onAddChannel(): void }) {
  const channels = useRoomStore((s) => s.channelsBySpace[spaceId]) ?? [];

  return (
    <div className={styles.list} data-testid="channel-list">
      <SidebarSection
        id={`text-channels:${spaceId}`}
        label="Text Channels"
        addTestId="channel-add"
        addTitle="Create channel"
        onAdd={onAddChannel}
      >
        {channels.map((channel) => (
          <ChannelItem key={channel.roomId} channel={channel} />
        ))}
        {channels.length === 0 && <div className={styles.empty}>No channels yet</div>}
      </SidebarSection>
    </div>
  );
}

function ChannelItem({ channel }: { channel: RoomSummary }) {
  const selectedRoomId = useRoomStore((s) => s.selectedRoomId);
  const selectRoom = useRoomStore((s) => s.selectRoom);
  const unread = useUnread(channel.roomId);
  const selected = channel.roomId === selectedRoomId;
  const bold = unread > 0 && !selected;
  const callCount = useLiveCallCount(channel.roomId);
  const missed = useMissedCallPreview(channel.roomId);

  return (
    <button
      type="button"
      className={`${styles.item} ${selected ? styles.itemSelected : ''} ${bold ? styles.itemUnread : ''}`}
      data-testid={`channel-item-${channel.roomId}`}
      data-preview={missed ? 'missed-call' : undefined}
      data-name={channel.name}
      data-selected={selected ? 'true' : 'false'}
      data-encrypted={channel.encrypted ? 'true' : 'false'}
      title={channel.topic ? `#${channel.name} - ${channel.topic}` : `#${channel.name}`}
      // `selectRoom` only: the layout store closes the nav drawer on phone via `onRoomSelected`
      // (docs/ARCHITECTURE.md). Never close it here - a space tap must leave it open (AC-M2-4).
      onClick={() => {
        hapticTap(); // DEV-A-16; no-op in a browser
        selectRoom(channel.roomId);
      }}
    >
      {/* The `#` is nested inside the label span (inline-block) so innerText stays `#general`
          on one line for QA's text assertions, while still rendering as Discord's large glyph. */}
      <span className={`${styles.name} u-truncate`}>
        <span className={styles.hash} aria-hidden="true">
          #
        </span>
        {channel.name}
      </span>
      {channel.encrypted && <Lock className={styles.lock} size={12} aria-hidden="true" />}
      {missed && <MissedCallPreview />}
      {callCount > 0 && <RoomCallIndicator count={callCount} />}
      {unread > 0 && (
        <span className={styles.badge} data-testid={`channel-unread-${channel.roomId}`} data-count={unread}>
          {badgeText(unread)}
        </span>
      )}
    </button>
  );
}
