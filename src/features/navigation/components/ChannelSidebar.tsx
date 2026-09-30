/**
 * DEV-A-2 channel sidebar (column 2, 240 px). Renders the DM list when Home is selected, otherwise
 * the selected space's header (with its dropdown menu) and channel list.
 *
 * Selection/persistence lives in the room store (`selectSpace` / `selectRoom` auto-select the last or
 * first channel and persist `nav.selection`), so this component only dispatches.
 *
 * testids: channel-sidebar, space-header, space-header-name, space-menu, space-menu-invite,
 *          space-menu-create-channel
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, UserPlus, X } from 'lucide-react';
import { useRoomStore } from '@/store/rooms.ts';
import { ChannelList } from './ChannelList.tsx';
import { CreateChannelDialog } from './CreateChannelDialog.tsx';
import { DmList } from './DmList.tsx';
import { InviteDialog } from './InviteDialog.tsx';
import { useChannelCycle } from '../hooks/useChannelCycle.ts';
import styles from './ChannelSidebar.module.css';

export function ChannelSidebar() {
  const spaceId = useRoomStore((s) => s.selectedSpaceId);
  useChannelCycle();
  return (
    <div className={styles.sidebar} data-testid="channel-sidebar">
      {spaceId === 'home' ? <DmList /> : <SpaceView spaceId={spaceId} />}
    </div>
  );
}

type DialogKind = 'create-channel' | 'invite' | null;

function SpaceView({ spaceId }: { spaceId: string }) {
  const space = useRoomStore((s) => s.roomsById[spaceId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (!headerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const open = (kind: Exclude<DialogKind, null>) => (): void => {
    setMenuOpen(false);
    setDialog(kind);
  };

  return (
    <>
      <div className={styles.header} data-testid="space-header" ref={headerRef}>
        <button
          type="button"
          className={styles.headerButton}
          data-testid="space-menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={space?.topic ?? space?.name ?? 'Space'}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className={`${styles.headerName} u-truncate`} data-testid="space-header-name">
            {space?.name ?? 'Space'}
          </span>
          {menuOpen ? <X size={18} className={styles.headerIcon} /> : <ChevronDown size={18} className={styles.headerIcon} />}
        </button>

        {menuOpen && (
          <div className={styles.menu} role="menu">
            <button type="button" className={styles.menuItem} role="menuitem" data-testid="space-menu-invite" onClick={open('invite')}>
              <span>Invite People</span>
              <UserPlus size={16} />
            </button>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              data-testid="space-menu-create-channel"
              onClick={open('create-channel')}
            >
              <span>Create Channel</span>
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>

      <ChannelList spaceId={spaceId} onAddChannel={open('create-channel')} />

      {dialog === 'create-channel' && <CreateChannelDialog spaceId={spaceId} onClose={() => setDialog(null)} />}
      {dialog === 'invite' && <InviteDialog spaceId={spaceId} onClose={() => setDialog(null)} />}
    </>
  );
}
