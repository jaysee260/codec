/**
 * Outgoing typing notifications (DEV-B-2). `sendTyping(true)` at most once every 4 s while the user
 * keeps typing, `sendTyping(false)` on send, blur, 5 s of silence, room change and unmount.
 */
import { useCallback, useEffect, useRef } from 'react';
import { sendTyping } from '@/lib/matrix/actions.ts';

const THROTTLE_MS = 4000;
const IDLE_MS = 5000;

export interface TypingNotifier {
  /** Call on every keystroke that leaves non-empty content. */
  onInput(): void;
  /** Call on send / blur / escape. */
  stop(): void;
}

export function useTypingNotifier(roomId: string): TypingNotifier {
  const lastSent = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;

  const stop = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (lastSent.current) {
      lastSent.current = 0;
      void sendTyping(activeRoom.current, false).catch(() => undefined);
    }
  }, []);

  const onInput = useCallback(() => {
    const now = Date.now();
    if (now - lastSent.current > THROTTLE_MS) {
      lastSent.current = now;
      void sendTyping(activeRoom.current, true, THROTTLE_MS + 2000).catch(() => undefined);
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stop, IDLE_MS);
  }, [stop]);

  // Stop typing when the room changes or the composer unmounts.
  useEffect(() => {
    const room = roomId;
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = null;
      if (lastSent.current) {
        lastSent.current = 0;
        void sendTyping(room, false).catch(() => undefined);
      }
    };
  }, [roomId]);

  return { onInput, stop };
}
