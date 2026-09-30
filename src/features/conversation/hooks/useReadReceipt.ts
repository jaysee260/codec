/**
 * Read receipts (DEV-B-7). Sends an `m.read` receipt for the newest event in the open room when the
 * tab is visible and the list is at the bottom. This is what clears the unread badges in the sidebar
 * (they are server-computed and echo back on the next /sync).
 *
 * Which event: the newest *displayable* event that already has a server event id. Reactions, edits
 * and redactions never bump `notification_count`, so a receipt on the last visible row clears the
 * room just as well as one on a trailing reaction, and it is the row the reader actually saw last.
 *
 * The delay is a *deadline*, not a plain trailing debounce: the timer is armed once per unsent event
 * and is not pushed back when a newer event lands while it is pending, so a room being written to
 * faster than DEADLINE_MS can never starve the receipt. Whatever is newest when the timer fires is
 * what gets receipted, and the effect runs again if the timeline moved on in the meantime.
 *
 * A failed POST is retried (bounded): the "already sent" marker is only set once the request has
 * actually resolved, so a dropped receipt cannot leave the room looking permanently unread.
 */
import { useEffect, useRef, useState } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { sendReadReceipt } from '@/lib/matrix/actions.ts';
import { useRoomTimeline } from '@/store/hooks.ts';

const DEADLINE_MS = 400;
const RETRY_MS = 1_500;
const MAX_ATTEMPTS = 3;

/** True while the event is only a local echo: its id is a transaction id, not a server event id. */
function isLocalEcho(event: MatrixEvent): boolean {
  const id = event.getId();
  return !id || id.startsWith('~');
}

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
  /** Newest event id the server has acknowledged a receipt for. */
  const sentRef = useRef<string | null>(null);
  /** Event id a request is in flight for, so a re-render cannot send it twice. */
  const inFlightRef = useRef<string | null>(null);
  /** Epoch ms the pending receipt is due at; 0 when nothing is armed. */
  const dueRef = useRef(0);
  const failedRef = useRef<{ eventId: string; attempts: number }>({ eventId: '', attempts: 0 });
  /** Bumped by a failed send so the effect re-runs and retries. */
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    sentRef.current = null;
    inFlightRef.current = null;
    dueRef.current = 0;
    failedRef.current = { eventId: '', attempts: 0 };
  }, [roomId]);

  // Newest event that actually exists on the server (local echoes have `~` ids).
  let lastId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (!isLocalEcho(events[i]!)) {
      lastId = events[i]!.getId()!;
      break;
    }
  }

  useEffect(() => {
    if (!lastId || !atBottom || !visible) return;
    if (sentRef.current === lastId || inFlightRef.current === lastId) return;
    const attempts = failedRef.current.eventId === lastId ? failedRef.current.attempts : 0;
    if (attempts >= MAX_ATTEMPTS) return; // give up on this event; a newer one starts over

    const target = lastId;
    const now = Date.now();
    if (!dueRef.current) dueRef.current = now + (attempts ? RETRY_MS : DEADLINE_MS);
    const timer = setTimeout(
      () => {
        dueRef.current = 0;
        inFlightRef.current = target;
        void sendReadReceipt(roomId, target).then(
          () => {
            inFlightRef.current = null;
            sentRef.current = target;
            failedRef.current = { eventId: '', attempts: 0 };
          },
          () => {
            inFlightRef.current = null;
            failedRef.current = { eventId: target, attempts: attempts + 1 };
            setRetryTick((tick) => tick + 1);
          },
        );
      },
      Math.max(0, dueRef.current - now),
    );
    return () => clearTimeout(timer);
    // `version` is deliberately NOT a dependency: it also bumps for typing notifications, and the
    // events array identity already changes whenever the timeline does.
  }, [roomId, lastId, atBottom, visible, retryTick]);
}
