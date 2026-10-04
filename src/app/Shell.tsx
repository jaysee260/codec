/**
 * App shell. Two layouts, one component tree for the features (they receive nothing but `roomId`):
 *
 * Desktop (`useLayoutStore.isPhone === false`): the Phase 1 three-column grid, unchanged.
 *  | rail 72px | sidebar 240px            | main (flex)                     | members 240px (optional) |
 *  | SpaceRail | ChannelSidebar           | ChannelHeader                    | MemberPanel              |
 *  |           | (channels or DMs)        | Conversation (list + composer)   |                          |
 *  |           | UserFooter               |                                  |                          |
 *
 * Phone (PRIN-3): the conversation column fills the screen; the rail + sidebar live in a left drawer
 * (`nav-drawer`, `useLayoutStore.navOpen`) and the member panel in a right drawer (`member-drawer`,
 * `useLayoutStore.membersOpen`), both over a shared `drawer-backdrop`. The Shell owns the containers, the
 * backdrop, Escape, the edge-swipe gestures and the animation; Dev A owns the header buttons that call
 * `openNav()` / `toggleMembers()` and the contents. `data-layout` on `app-shell` says which branch rendered.
 */
import { useEffect, useRef, type TouchEvent } from 'react';
import { useRoomStore } from '@/store/rooms.ts';
import { useLayoutStore } from '@/store/layout.ts';
import { SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel } from '@/features/navigation';
import { Conversation } from '@/features/conversation';
import { UserFooter } from './UserFooter.tsx';
import { Drawer } from './Drawer.tsx';
import styles from './Shell.module.css';

/** Touches starting within this many px of a screen edge may open a drawer. */
const EDGE_PX = 28;
/** Horizontal travel that counts as a swipe. */
const SWIPE_PX = 56;

export function Shell() {
  const roomId = useRoomStore((s) => s.selectedRoomId);
  const isPhone = useLayoutStore((s) => s.isPhone);
  return isPhone ? <PhoneShell roomId={roomId} /> : <DesktopShell roomId={roomId} />;
}

/** Column 1 + 2: shared between the desktop grid and the phone nav drawer. */
function Navigation() {
  return (
    <>
      <nav className={styles.rail} aria-label="Spaces">
        <SpaceRail />
      </nav>
      <aside className={styles.sidebar} aria-label="Channels">
        <div className={styles.sidebarBody}>
          <ChannelSidebar />
        </div>
        <UserFooter />
      </aside>
    </>
  );
}

function MainColumn({ roomId }: { roomId: string | null }) {
  if (!roomId) {
    return (
      <div className={styles.empty} data-testid="empty-state">
        <div className={styles.emptyTitle}>No channel selected</div>
        <div className={styles.emptyText}>Pick a channel on the left, or start a DM.</div>
      </div>
    );
  }
  return (
    <>
      <ChannelHeader roomId={roomId} />
      <Conversation roomId={roomId} />
    </>
  );
}

function DesktopShell({ roomId }: { roomId: string | null }) {
  return (
    <div className={styles.shell} data-testid="app-shell" data-layout="desktop">
      <Navigation />
      <main className={styles.main}>
        <MainColumn roomId={roomId} />
      </main>
      {roomId && (
        <aside className={styles.members} aria-label="Members">
          <MemberPanel roomId={roomId} />
        </aside>
      )}
    </div>
  );
}

interface TouchStart {
  x: number;
  y: number;
  edge: 'left' | 'right' | null;
}

function PhoneShell({ roomId }: { roomId: string | null }) {
  const navOpen = useLayoutStore((s) => s.navOpen);
  const membersOpen = useLayoutStore((s) => s.membersOpen);
  const isDm = useRoomStore((s) => (roomId ? !!s.roomsById[roomId]?.isDm : false));
  const anyOpen = navOpen || membersOpen;
  const touch = useRef<TouchStart | null>(null);

  // Escape closes whichever drawer is open (keyboards exist on phones too, and in Playwright).
  useEffect(() => {
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useLayoutStore.getState().closeDrawers();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyOpen]);

  const onTouchStart = (e: TouchEvent<HTMLDivElement>): void => {
    const t = e.touches[0];
    if (!t) return;
    const width = e.currentTarget.clientWidth;
    const edge = t.clientX <= EDGE_PX ? 'left' : t.clientX >= width - EDGE_PX ? 'right' : null;
    touch.current = { x: t.clientX, y: t.clientY, edge };
  };

  const onTouchMove = (e: TouchEvent<HTMLDivElement>): void => {
    const start = touch.current;
    const t = e.touches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < SWIPE_PX) return; // scrolling, or not far enough yet
    const layout = useLayoutStore.getState();
    if (layout.navOpen && dx < 0) layout.closeNav();
    else if (layout.membersOpen && dx > 0) layout.closeMembers();
    else if (!anyOpen && start.edge === 'left' && dx > 0) layout.openNav();
    else if (!anyOpen && start.edge === 'right' && dx < 0 && roomId && !isDm) layout.openMembers();
    touch.current = null;
  };

  const onTouchEnd = (): void => {
    touch.current = null;
  };

  return (
    <div
      className={styles.phoneShell}
      data-testid="app-shell"
      data-layout="phone"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <main className={styles.phoneMain}>
        <MainColumn roomId={roomId} />
      </main>
      <div
        className={`${styles.backdrop} ${anyOpen ? styles.backdropOpen : ''}`}
        data-testid="drawer-backdrop"
        data-open={anyOpen ? 'true' : 'false'}
        onClick={() => useLayoutStore.getState().closeDrawers()}
        aria-hidden="true"
      />
      <Drawer side="left" open={navOpen} label="Navigation" testId="nav-drawer">
        <Navigation />
      </Drawer>
      <Drawer side="right" open={membersOpen} label="Members" testId="member-drawer">
        {roomId && <MemberPanel roomId={roomId} />}
      </Drawer>
    </div>
  );
}
