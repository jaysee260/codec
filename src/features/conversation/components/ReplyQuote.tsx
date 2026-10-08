/**
 * Reply quote block above a message (DEV-B-6). The target is looked up in the loaded timeline and
 * fetched from the server when it is not loaded (`fetchEvent`), then cached for the session.
 * Clicking the quote asks the list to scroll to and flash the target. `uiKey` is the source key of the
 * list that should do the scrolling (room id, or thread root id inside the panel).
 */
import { useEffect, useMemo, useState } from 'react';
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

const previewCache = new Map<string, TargetPreview>();

function toPreview(eventId: string, roomId: string): TargetPreview | undefined {
  const event = getClientOrNull()?.getRoom(roomId)?.findEventById(eventId);
  if (!event) return undefined;
  return { sender: event.getSender() ?? '', text: previewText(event, 120) };
}

/** Author + short text of the replied-to event, from the timeline or the server. */
function useReplyTarget(roomId: string, eventId: string): TargetPreview | undefined {
  const version = useTimelineStore((s) => s.version);
  const [fetched, setFetched] = useState<TargetPreview | undefined>(() => previewCache.get(eventId));
  const local = useMemo(() => toPreview(eventId, roomId), [eventId, roomId, version]);

  useEffect(() => {
    if (local || previewCache.has(eventId)) return;
    let alive = true;
    void fetchEvent(roomId, eventId).then((event) => {
      if (!event) return;
      const value: TargetPreview = { sender: event.getSender() ?? '', text: previewText(event, 120) };
      previewCache.set(eventId, value);
      if (alive) setFetched(value);
    });
    return () => {
      alive = false;
    };
  }, [roomId, eventId, local]);

  return local ?? fetched ?? previewCache.get(eventId);
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
