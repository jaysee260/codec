/** Prop types of the receipts UI (Dev A). Documented in ./index.ts. */
import type { ReactNode } from 'react';
import type { Reader, SendStatus } from '@/lib/matrix/receipts.ts';
import type { TimelineSource } from '@/store/timeline.ts';

export interface SendStatusProps {
  /** `useSendStatus(event)`. `null` renders nothing. */
  status: SendStatus;
  /** `failed` only: the row's existing failed UI (retry etc.), wrapped so its own testids stay intact. */
  children?: ReactNode;
  className?: string;
}

export interface ReadAvatarsProps {
  /** The timeline the row belongs to (main `{ roomId }` or thread `{ roomId, threadRootId }`). */
  source: TimelineSource;
  /** The row's event id (`event.getId()`). */
  eventId: string;
  /** `readPoints.get(eventId)`. Empty / undefined renders nothing. */
  readers: readonly Reader[] | undefined;
  className?: string;
}

/** How a list was opened: `hover` closes again when the pointer leaves; `pinned` stays until Escape / outside click. */
/** Why the list closed. */
export type SeenByCloseReason = 'escape' | 'outside' | 'backdrop' | 'button' | 'back';

export type SeenByOpenMode = 'hover' | 'pinned';

export interface OpenSeenByArgs {
  source: TimelineSource;
  eventId: string;
  /** Element the popover anchors to and focus returns to on close (the avatars or the "Seen by" button). */
  trigger?: HTMLElement | null;
  /** Default `pinned`. */
  mode?: SeenByOpenMode;
}

export interface SeenByListProps {
  source: TimelineSource;
  eventId: string;
  /** Desktop popover anchor; ignored on phone (bottom sheet). Null = centred near the top-right of the viewport. */
  anchor: HTMLElement | null;
  /** `outside` = a pointer-down elsewhere: the opener should not pull focus back from where the user clicked. */
  onClose(reason?: SeenByCloseReason): void;
  /** Default `pinned`: focus moves into the list on open. `hover` leaves focus where it is. */
  mode?: SeenByOpenMode;
  /** Pointer entered / left the popover (hover mode keeps the list open while the pointer is over it). */
  onPointerEnter?(): void;
  onPointerLeave?(): void;
}
