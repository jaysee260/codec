/** `@mention` popup above the composer (DEV-B-10). */
import { colorFor, initialsOf } from '@/lib/format.ts';
import type { MentionOption } from '../hooks/useMentions.ts';
import styles from './MentionAutocomplete.module.css';

export function MentionAutocomplete({
  options,
  activeIndex,
  onPick,
  onHover,
}: {
  options: MentionOption[];
  activeIndex: number;
  onPick(option: MentionOption): void;
  onHover(index: number): void;
}) {
  return (
    <div className={styles.popup} data-testid="mention-autocomplete" role="listbox" aria-label="Members">
      <div className={styles.header}>Members</div>
      {options.map((option, index) => (
        <button
          key={option.userId}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`${styles.option} ${index === activeIndex ? styles.active : ''}`}
          data-testid={`mention-option-${option.userId}`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the caret in the textarea
            onPick(option);
          }}
        >
          <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(option.userId) }}>
            {option.avatarUrl ? <img src={option.avatarUrl} alt="" /> : initialsOf(option.name)}
          </span>
          <span className={styles.name}>{option.name}</span>
          <span className={styles.userId}>{option.userId}</span>
        </button>
      ))}
    </div>
  );
}
