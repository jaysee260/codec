/**
 * Placeholder Conversation root (Dev B replaces the internals): message list + typing + composer.
 */
import { useTyping } from '@/store/hooks.ts';
import { MessageList } from './MessageList.tsx';
import { Composer } from './Composer.tsx';
import styles from './Conversation.module.css';

export function Conversation({ roomId }: { roomId: string }) {
  const typing = useTyping(roomId);
  return (
    <div className={styles.root}>
      <MessageList roomId={roomId} />
      <div className={styles.typing} data-testid={typing.length ? 'typing-indicator' : undefined}>
        {typing.length > 0 && (
          <>
            <span className={styles.dots} aria-hidden="true" />
            <strong>{typing.join(' and ')}</strong>&nbsp;{typing.length === 1 ? 'is' : 'are'} typing...
          </>
        )}
      </div>
      <Composer roomId={roomId} />
    </div>
  );
}
