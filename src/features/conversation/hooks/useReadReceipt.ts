/**
 * Read receipts (DEV-B-7, extended for threads in DEV-B-20). Sends an `m.read` receipt for the newest
 * event of the open **source** when the tab is visible and the list is at the bottom. This is what
 * clears the unread badges in the sidebar (they are server-computed and echo back on the next /sync).
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
 *
 * Phase 3:
 *  - a **thread** source receipts the newest reply with `thread_id` = the root (the SDK derives it
 *    from the event; `threadId` is passed too for the case where the event is not loaded locally), so
 *    the thread's unread count and the header "Threads" dot clear while the main timeline's `main`
 *    receipt stays where it was (AC-T6-8);
 *  - the **room** instance pauses while a thread covers the conversation on phone (`paused`): alice
 *    must not "read" rows she cannot see, which is what AC-T3-4 asserts. On desktop the channel stays
 *    visible next to the panel, so nothing pauses there.
 */
import { useEffect, useRef, useState } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { sendReadReceipt } from '@/lib/matrix/actions.ts';
import { useTimeline, type TimelineSource } from '@/store/hooks.ts';

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

export interface ReadReceiptOptions {
  /** Stop sending receipts (the list is covered by a thread panel on phone, AC-T3-4). */
  paused?: boolean;
}

/** `atBottom` comes from the message list's scroll position. */
export function useReadReceipt(source: string | TimelineSource, atBottom: boolean, opts: ReadReceiptOptions = {}): void {
  const roomId = typeof source === 'string' ? source : source.roomId;
  const threadRootId = typeof source === 'string' ? undefined : source.threadRootId;
  const paused = !!opts.paused;
  const { events } = useTimeline({ roomId, threadRootId });
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
  }, [roomId, threadRootId]);

  // Newest event that actually exists on the server (local echoes have `~` ids).
  let lastId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (!isLocalEcho(events[i]!)) {
      lastId = events[i]!.getId()!;
      break;
    }
  }

  useEffect(() => {
    if (!lastId || !atBottom || !visible || paused) return;
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
        void sendReadReceipt(roomId, target, threadRootId ? { threadId: threadRootId } : {}).then(
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
  }, [roomId, threadRootId, lastId, atBottom, visible, paused, retryTick]);
}
