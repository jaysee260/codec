/**
 * Discord three-column layout. Mounts the feature components and passes nothing but `roomId`.
 *
 *  | rail 72px | sidebar 240px            | main (flex)                     | members 240px (optional) |
 *  | SpaceRail | ChannelSidebar           | ChannelHeader                    | MemberPanel              |
 *  |           | (channels or DMs)        | Conversation (list + composer)   |                          |
 *  |           | UserFooter               |                                  |                          |
 */
import { useRoomStore } from '@/store/rooms.ts';
import { SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel } from '@/features/navigation';
import { Conversation } from '@/features/conversation';
import { UserFooter } from './UserFooter.tsx';
import styles from './Shell.module.css';

export function Shell() {
  const roomId = useRoomStore((s) => s.selectedRoomId);
  return (
    <div className={styles.shell} data-testid="app-shell">
      <nav className={styles.rail} aria-label="Spaces">
        <SpaceRail />
      </nav>
      <aside className={styles.sidebar} aria-label="Channels">
        <div className={styles.sidebarBody}>
          <ChannelSidebar />
        </div>
        <UserFooter />
      </aside>
      <main className={styles.main}>
        {roomId ? (
          <>
            <ChannelHeader roomId={roomId} />
            <Conversation roomId={roomId} />
          </>
        ) : (
          <div className={styles.empty} data-testid="empty-state">
            <div className={styles.emptyTitle}>No channel selected</div>
            <div className={styles.emptyText}>Pick a channel on the left, or start a DM.</div>
          </div>
        )}
      </main>
      {roomId && (
        <aside className={styles.members} aria-label="Members">
          <MemberPanel roomId={roomId} />
        </aside>
      )}
    </div>
  );
}
