/**
 * Typing indicator under the composer (DEV-B-7). Names come from `useTyping`, which resolves the
 * `m.typing` user ids against room members and never includes me.
 */
import { useTyping } from '@/store/hooks.ts';
import styles from './TypingIndicator.module.css';

function phrase(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing...`;
  return 'Several people are typing...';
}

export function TypingIndicator({ roomId }: { roomId: string }) {
  const names = useTyping(roomId);
  return (
    <div className={styles.bar}>
      {names.length > 0 && (
        <>
          <span className={styles.dots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={styles.text} data-testid="typing-indicator" aria-live="polite">
            {phrase(names)}
          </span>
        </>
      )}
    </div>
  );
}
