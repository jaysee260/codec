/**
 * Conversation root (Dev B). Mounted by the shell under the channel header with nothing but `roomId`.
 * Keyed on the room so every piece of per-room state (scroll anchors, drafts, reply/edit targets)
 * starts clean when the user switches channels.
 *
 * Phase 3: the list and the composer are addressed by a `TimelineSource`; the room's source is
 * `{ roomId }`, which is what they already did in Phase 1/2 (`sourceKey({ roomId }) === roomId`).
 * The thread panel mounts the same two components with a thread source - see `ThreadView`.
 *
 * Phase 7 (DEV-B-37 / DEV-B-39): the in-call bar lives here, outside the scroll area: right above the composer
 * on desktop, at the top under the header on phone (the keyboard never covers it). It renders nothing unless a
 * call is live with its screen minimised.
 */
import { useMemo } from 'react';
import { useIsPhone, type TimelineSource } from '@/store/hooks.ts';
import { InCallBar } from '@/features/call';
import { MessageList } from './MessageList.tsx';
import { TypingIndicator } from './TypingIndicator.tsx';
import { Composer } from './Composer.tsx';
import styles from './Conversation.module.css';

export function Conversation({ roomId }: { roomId: string }) {
  const source = useMemo<TimelineSource>(() => ({ roomId }), [roomId]);
  const isPhone = useIsPhone();
  return (
    <div className={styles.root}>
      {isPhone && <InCallBar />}
      <MessageList key={`list-${roomId}`} source={source} />
      <TypingIndicator roomId={roomId} />
      {!isPhone && <InCallBar />}
      <Composer key={`composer-${roomId}`} source={source} />
    </div>
  );
}
