/**
 * Reply quote block above a message (DEV-B-6). The target is looked up in the loaded timeline and
 * fetched from the server when it is not loaded (`fetchEvent`), then cached for the session.
 * Clicking the quote asks the list to scroll to and flash the target. `uiKey` is the source key of the
 * list that should do the scrolling (room id, or thread root id inside the panel).
 */
import { useEffect, useMemo, useState } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { fetchEvent } from '@/lib/matrix/actions.ts';
import { displayNameOf, previewText } from '@/lib/matrix/utils.ts';
import { colorFor } from '@/lib/format.ts';
import { useTimelineStore } from '@/store/timeline.ts';
import { useConversationUi } from '../hooks/useConversationUi.ts';
import styles from './ReplyQuote.module.css';

interface TargetPreview {
  sender: string;
  text: string;
}

/**
 * Events fetched from the server for a quote, per id, for the session. The *event* is cached rather than its
 * preview text (Phase 5): a fetched encrypted event decrypts asynchronously (and again after a late key or a
 * backup restore), so the text is re-read from it on every timeline `version` bump - a cached string would
 * stay "Decrypting..." / "Unable to decrypt" forever.
 */
const eventCache = new Map<string, MatrixEvent>();

function preview(event: MatrixEvent): TargetPreview {
  return { sender: event.getSender() ?? '', text: previewText(event, 120) };
}

/** Author + short text of the replied-to event, from the timeline or the server. */
function useReplyTarget(roomId: string, eventId: string): TargetPreview | undefined {
  const version = useTimelineStore((s) => s.version);
  const [fetched, setFetched] = useState<MatrixEvent | undefined>(() => eventCache.get(eventId));
  const local = useMemo(() => getClientOrNull()?.getRoom(roomId)?.findEventById(eventId), [eventId, roomId, version]);

  useEffect(() => {
    if (local || eventCache.has(eventId)) return;
    let alive = true;
    void fetchEvent(roomId, eventId).then((event) => {
      if (!event) return;
      eventCache.set(eventId, event);
      if (alive) setFetched(event);
    });
    return () => {
      alive = false;
    };
  }, [roomId, eventId, local]);

  const event = local ?? fetched ?? eventCache.get(eventId);
  // `version` bumps when the bridge sees `MatrixEventEvent.Decrypted`, including for fetched events.
  return useMemo(() => (event ? preview(event) : undefined), [event, version]);
}

export function ReplyQuote({ roomId, eventId, uiKey }: { roomId: string; eventId: string; uiKey: string }) {
  const target = useReplyTarget(roomId, eventId);
  const jumpTo = useConversationUi((s) => s.jumpTo);
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const author = target?.sender ? displayNameOf(room, target.sender) : 'Unknown user';

  return (
    <button
      type="button"
      className={styles.quote}
      data-testid="message-reply-quote"
      title="Jump to the replied message"
      onClick={() => jumpTo(uiKey, eventId)}
    >
      <span className={styles.spine} aria-hidden="true" />
      <span className={styles.author} data-testid="message-reply-quote-author" style={{ color: colorFor(target?.sender ?? eventId) }}>
        {author}
      </span>
      <span className={`${styles.text} u-truncate`}>{target ? target.text : 'Original message not available'}</span>
    </button>
  );
}
