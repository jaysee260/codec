/**
 * Conversation root (Dev B). Mounted by the shell under the channel header with nothing but `roomId`.
 * Keyed on the room so every piece of per-room state (scroll anchors, drafts, reply/edit targets)
 * starts clean when the user switches channels.
 *
 * Phase 3: the list and the composer are addressed by a `TimelineSource`; the room's source is
 * `{ roomId }`, which is what they already did in Phase 1/2 (`sourceKey({ roomId }) === roomId`).
 * The thread panel mounts the same two components with a thread source - see `ThreadView`.
 */
import { useMemo } from 'react';
import type { TimelineSource } from '@/store/hooks.ts';
import { MessageList } from './MessageList.tsx';
import { TypingIndicator } from './TypingIndicator.tsx';
import { Composer } from './Composer.tsx';
import styles from './Conversation.module.css';

export function Conversation({ roomId }: { roomId: string }) {
  const source = useMemo<TimelineSource>(() => ({ roomId }), [roomId]);
  return (
    <div className={styles.root}>
      <MessageList key={`list-${roomId}`} source={source} />
      <TypingIndicator roomId={roomId} />
      <Composer key={`composer-${roomId}`} source={source} />
    </div>
  );
}
