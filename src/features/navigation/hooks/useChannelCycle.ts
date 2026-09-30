/**
 * DEV-A-10 keyboard polish: Alt+ArrowUp / Alt+ArrowDown cycle through the current sidebar list
 * (the selected space's channels, or the DM list when Home is selected), wrapping at both ends.
 *
 * Alt is used rather than Ctrl so the shortcut never collides with the composer or the browser.
 */
import { useEffect } from 'react';
import { useRoomStore } from '@/store/rooms.ts';

export function useChannelCycle(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const state = useRoomStore.getState();
      const list = state.selectedSpaceId === 'home' ? state.dms : (state.channelsBySpace[state.selectedSpaceId] ?? []);
      if (list.length === 0) return;

      e.preventDefault();
      const current = list.findIndex((r) => r.roomId === state.selectedRoomId);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? 0 : (current + step + list.length) % list.length;
      state.selectRoom(list[next]!.roomId);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
