/**
 * Conversation root (Dev B). Mounted by the shell under the channel header with nothing but `roomId`.
 * Keyed on the room so every piece of per-room state (scroll anchors, drafts, reply/edit targets)
 * starts clean when the user switches channels.
 */
import { MessageList } from './MessageList.tsx';
import { TypingIndicator } from './TypingIndicator.tsx';
import { Composer } from './Composer.tsx';
import styles from './Conversation.module.css';

export function Conversation({ roomId }: { roomId: string }) {
  return (
    <div className={styles.root}>
      <MessageList key={`list-${roomId}`} roomId={roomId} />
      <TypingIndicator roomId={roomId} />
      <Composer key={`composer-${roomId}`} roomId={roomId} />
    </div>
  );
}
