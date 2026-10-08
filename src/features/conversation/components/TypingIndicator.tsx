/**
 * Typing indicator under the composer (DEV-B-7). Names come from `useTyping`, which resolves the
 * `m.typing` user ids against room members and never includes me.
 *
 * Phase 3: typing is **room-scoped** in Matrix (there is no thread-scoped typing in the spec or in
 * Synapse), so the thread panel renders this same room-wide list under the id `thread-typing`
 * (AC-T6-7, docs/PHASE3_PLAN.md "Typing"). The id is renamed rather than prefixed, hence the prop.
 */
import { useTyping, type TimelineSource } from '@/store/hooks.ts';
import styles from './TypingIndicator.module.css';

function phrase(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing...`;
  return 'Several people are typing...';
}

export function TypingIndicator({
  roomId,
  testId = 'typing-indicator',
}: {
  roomId: string | TimelineSource;
  testId?: string;
}) {
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
          <span className={styles.text} data-testid={testId} aria-live="polite">
            {phrase(names)}
          </span>
        </>
      )}
    </div>
  );
}
