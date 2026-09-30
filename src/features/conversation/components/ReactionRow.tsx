/**
 * Reaction pills under a message (DEV-B-5). Aggregates come from `getReactions()`, which reads the
 * SDK's relations container, so the row updates on every timeline `version` bump (incoming
 * reactions from other users included).
 */
import { FaceSlightlySmilingPlus } from 'lucide-react';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { toggleReaction, type ReactionSummary } from '@/lib/matrix/actions.ts';
import { displayNameOf } from '@/lib/matrix/utils.ts';
import { withToast } from '@/store/toast.ts';
import styles from './ReactionRow.module.css';

function titleFor(roomId: string, reaction: ReactionSummary): string {
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const names = reaction.senders.map((id) => displayNameOf(room, id));
  return `${names.join(', ')} reacted with ${reaction.key}`;
}

export function ReactionRow({
  roomId,
  eventId,
  reactions,
  onAdd,
}: {
  roomId: string;
  eventId: string;
  reactions: ReactionSummary[];
  onAdd(anchor: HTMLElement): void;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className={styles.reactions} data-testid="message-reactions">
      {reactions.map((reaction) => (
        <button
          key={reaction.key}
          type="button"
          className={`${styles.pill} ${reaction.mine ? styles.mine : ''}`}
          data-testid={`reaction-${reaction.key}`}
          data-count={reaction.count}
          data-mine={reaction.mine ? 'true' : 'false'}
          title={titleFor(roomId, reaction)}
          onClick={() => void withToast(() => toggleReaction(roomId, eventId, reaction.key), 'Could not update the reaction')}
        >
          <span className={styles.emoji}>{reaction.key}</span>
          <span className={styles.count}>{reaction.count}</span>
        </button>
      ))}
      <button
        type="button"
        className={styles.add}
        data-testid="reaction-add"
        title="Add reaction"
        aria-label="Add reaction"
        onClick={(e) => onAdd(e.currentTarget)}
      >
        <FaceSlightlySmilingPlus size={16} />
      </button>
    </div>
  );
}
