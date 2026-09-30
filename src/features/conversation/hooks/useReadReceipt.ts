/**
 * Read receipts (DEV-B-7). Sends an `m.read` receipt for the newest event in the open room when
 * the tab is visible and the list is at the bottom, debounced 500 ms. This is what clears the
 * unread badges in the sidebar (they are server-computed and echo back on the next /sync).
 */
import { useEffect, useRef, useState } from 'react';
import { sendReadReceipt } from '@/lib/matrix/actions.ts';
import { useRoomTimeline } from '@/store/hooks.ts';

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** `atBottom` comes from the message list's scroll position. */
export function useReadReceipt(roomId: string, atBottom: boolean): void {
  const { events } = useRoomTimeline(roomId);
  const visible = useTabVisible();
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    sentRef.current = null;
  }, [roomId]);

  // Newest event that actually exists on the server (local echoes have `~` ids).
  let lastId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i]!.getId();
    if (events[i]!.status === null && id && !id.startsWith('~')) {
      lastId = id;
      break;
    }
  }

  useEffect(() => {
    if (!lastId || !atBottom || !visible) return;
    if (sentRef.current === lastId) return;
    const timer = setTimeout(() => {
      sentRef.current = lastId;
      void sendReadReceipt(roomId, lastId).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
    // `version` is deliberately NOT a dependency: it bumps on every timeline/typing commit, and
    // re-running the effect would clear the pending timer before it ever fires in a busy room.
  }, [roomId, lastId, atBottom, visible]);
}
