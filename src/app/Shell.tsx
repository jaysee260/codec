/**
 * App shell. Two layouts, one component tree for the features (they receive nothing but `roomId`):
 *
 * Desktop (`useLayoutStore.isPhone === false`): the Phase 1 three-column grid, plus the Phase 3 thread column.
 *  | rail 72px | sidebar 240px            | main (flex)                     | members 240px (optional)    |
 *  | SpaceRail | ChannelSidebar           | ChannelHeader                    | MemberPanel                 |
 *  |           | (channels or DMs)        | Conversation (list + composer)   |  -or, while a thread is-    |
 *  |           | UserFooter               |                                  |  open: ThreadView 400px     |
 *
 * Phone (PRIN-3): the conversation column fills the screen; the rail + sidebar live in a left drawer
 * (`nav-drawer`, `useLayoutStore.navOpen`) and the member panel in a right drawer (`member-drawer`,
 * `useLayoutStore.membersOpen`), both over a shared `drawer-backdrop`. The Shell owns the containers, the
 * backdrop, Escape, the edge-swipe gestures and the animation; Dev A owns the header buttons that call
 * `openNav()` / `toggleMembers()` and the contents. `data-layout` on `app-shell` says which branch rendered.
 *
 * Threads (Phase 3, `useThreadStore.openThreadRootId`): the shell mounts `<ThreadView roomId rootId />` in
 * `thread-panel-container` - a 400 px right column on desktop (the member panel is not rendered while a thread
 * is open and comes back when it closes; Dev A's `useNavUiStore.membersOpen` is untouched) and, on phone, a
 * layer covering the conversation **below the channel header** (Dev A turns the header into back + "Thread");
 * the covered conversation stays mounted (scroll kept) and is `inert` + `aria-hidden`; drawers still work on top.
 * `app-shell[data-thread-open]` mirrors the state. Android back closes the thread first, then drawers.
 */
import { lazy, Suspense, useEffect, useRef, type ComponentType, type TouchEvent } from 'react';
import { useRoomStore } from '@/store/rooms.ts';
import { useLayoutStore } from '@/store/layout.ts';
import { useThreadStore } from '@/store/threads.ts';
import { SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel } from '@/features/navigation';
import { Conversation, ThreadView } from '@/features/conversation';
import { UserFooter } from './UserFooter.tsx';
import { Drawer } from './Drawer.tsx';
import styles from './Shell.module.css';

/**
 * Phase 5: Dev A's security UI (`@/features/security`: `SecurityBanner` above the channel header on both layouts,
 * `SecurityDialogs` once per page). Resolved through a glob so the shell builds before that module exists: an
 * empty glob renders nothing, and the module is code-split when present.
 */
type SecurityModule = { SecurityBanner?: ComponentType; SecurityDialogs?: ComponentType };
const securityModules = import.meta.glob<SecurityModule>('../features/security/index.ts');
const loadSecurity = Object.values(securityModules)[0];
const Nothing: ComponentType = () => null;
const SecurityBanner = loadSecurity ? lazy(async () => ({ default: (await loadSecurity()).SecurityBanner ?? Nothing })) : Nothing;
const SecurityDialogs = loadSecurity ? lazy(async () => ({ default: (await loadSecurity()).SecurityDialogs ?? Nothing })) : Nothing;

function SecurityBannerHost() {
  return (
    <div data-testid="security-banner-host">
      <Suspense fallback={null}>
        <SecurityBanner />
      </Suspense>
    </div>
  );
}

function SecurityDialogsHost() {
  return (
    <div data-testid="security-dialogs-host">
      <Suspense fallback={null}>
        <SecurityDialogs />
      </Suspense>
    </div>
  );
}

/** Touches starting within this many px of a screen edge may open a drawer. */
const EDGE_PX = 28;
/** Horizontal travel that counts as a swipe. */
const SWIPE_PX = 56;

export function Shell() {
  const roomId = useRoomStore((s) => s.selectedRoomId);
  const isPhone = useLayoutStore((s) => s.isPhone);
  return isPhone ? <PhoneShell roomId={roomId} /> : <DesktopShell roomId={roomId} />;
}

/** The open thread's root id when it belongs to the room on screen (the store closes it on room change anyway). */
function useOpenThreadFor(roomId: string | null): string | null {
  const rootId = useThreadStore((s) => s.openThreadRootId);
  const threadRoomId = useThreadStore((s) => s.openThreadRoomId);
  return roomId && rootId && threadRoomId === roomId ? rootId : null;
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
      <SecurityBannerHost />
      <ChannelHeader roomId={roomId} />
      <Conversation roomId={roomId} />
    </>
  );
}

function DesktopShell({ roomId }: { roomId: string | null }) {
  const threadRootId = useOpenThreadFor(roomId);
  return (
    <div className={styles.shell} data-testid="app-shell" data-layout="desktop" data-thread-open={threadRootId ? 'true' : 'false'}>
      <Navigation />
      <main className={styles.main}>
        <MainColumn roomId={roomId} />
      </main>
      <SecurityDialogsHost />
      {roomId && threadRootId && (
        <aside className={styles.threadPanel} aria-label="Thread" data-testid="thread-panel-container">
          <ThreadView key={`${roomId}|${threadRootId}`} roomId={roomId} rootId={threadRootId} />
        </aside>
      )}
      {roomId && !threadRootId && (
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
  const threadRootId = useOpenThreadFor(roomId);
  const anyOpen = navOpen || membersOpen;
  const touch = useRef<TouchStart | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  // `inert` has no typed React 18 prop; set it imperatively while a thread covers the conversation.
  useEffect(() => {
    const el = conversationRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (el) el.inert = !!threadRootId;
  }, [threadRootId]);

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
      data-thread-open={threadRootId ? 'true' : 'false'}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <main className={styles.phoneMain}>
        {roomId ? (
          <>
            <SecurityBannerHost />
            <ChannelHeader roomId={roomId} />
            <div className={styles.phoneBody}>
              {/* The conversation stays mounted under the thread (scroll position kept); inert while covered. */}
              <div ref={conversationRef} className={styles.phoneConversation} aria-hidden={threadRootId ? true : undefined}>
                <Conversation roomId={roomId} />
              </div>
              {threadRootId && (
                <div className={styles.phoneThread} data-testid="thread-panel-container" role="region" aria-label="Thread">
                  <ThreadView key={`${roomId}|${threadRootId}`} roomId={roomId} rootId={threadRootId} />
                </div>
              )}
            </div>
          </>
        ) : (
          <MainColumn roomId={null} />
        )}
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
      <SecurityDialogsHost />
    </div>
  );
}
