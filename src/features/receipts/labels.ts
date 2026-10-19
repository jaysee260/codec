/**
 * Pure helpers of the receipts UI (no React, no CSS, no `@/` imports) so `npm run test:unit` can import them
 * from plain Node. Used by ReadAvatars / SeenByList.
 */

/** Avatars drawn in a strip; the rest collapse into "+N". */
export const MAX_SHOWN_AVATARS = 3;

interface Named {
  userId: string;
  displayName: string;
}

/** Split readers (newest first) into the circles shown and the "+N" overflow count. */
export function avatarStack<T>(readers: readonly T[], max: number = MAX_SHOWN_AVATARS): { shown: T[]; more: number } {
  const shown = readers.slice(0, Math.max(0, max));
  return { shown, more: readers.length - shown.length };
}

/** "Seen by Bob Ruiz, Carol Nguyen" / "Seen by A, B, C and 2 others" (max 3 names, newest reader first). */
export function seenByLabel(readers: readonly Named[]): string {
  const { shown, more } = avatarStack(readers);
  const names = shown.map((r) => r.displayName || r.userId).join(', ');
  if (more <= 0) return `Seen by ${names}`;
  return `Seen by ${names} and ${more} ${more === 1 ? 'other' : 'others'}`;
}

/** "N others haven't seen it yet" (truncated rooms, > 50 members). */
export function unseenCountLabel(n: number): string {
  return `${n} ${n === 1 ? "other hasn't" : "others haven't"} seen it yet`;
}
