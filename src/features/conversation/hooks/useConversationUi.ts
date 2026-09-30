/**
 * Conversation UI state shared between the message list and the composer (Dev B only).
 *
 * Kept in a tiny zustand store instead of React context because the composer and the rows that
 * trigger reply/edit/jump live in different subtrees and must not re-render each other.
 * All state is keyed by room id so switching rooms never leaks a reply/edit target.
 */
import { create } from 'zustand';

export interface JumpRequest {
  roomId: string;
  eventId: string;
  /** Bumped on every request so repeat jumps to the same event still fire. */
  nonce: number;
}

export interface ConversationUiState {
  /** Event id the composer is replying to, per room. */
  replyTo: Record<string, string | undefined>;
  /** Event id the composer is editing, per room. */
  editing: Record<string, string | undefined>;
  /** Bumped whenever the composer should take focus. */
  focusTick: number;
  /** Latest "scroll the list to this event" request. */
  jump: JumpRequest | null;
  startReply(roomId: string, eventId: string): void;
  cancelReply(roomId: string): void;
  startEdit(roomId: string, eventId: string): void;
  cancelEdit(roomId: string): void;
  /** Clear reply + edit state for a room (after a successful send, or on room change). */
  clearComposerTargets(roomId: string): void;
  focusComposer(): void;
  jumpTo(roomId: string, eventId: string): void;
  /** Called by the list once it has taken the request, so re-mounting a room does not re-jump. */
  clearJump(): void;
}

export const useConversationUi = create<ConversationUiState>((set) => ({
  replyTo: {},
  editing: {},
  focusTick: 0,
  jump: null,

  startReply: (roomId, eventId) =>
    set((s) => ({
      replyTo: { ...s.replyTo, [roomId]: eventId },
      editing: { ...s.editing, [roomId]: undefined },
      focusTick: s.focusTick + 1,
    })),
  cancelReply: (roomId) => set((s) => ({ replyTo: { ...s.replyTo, [roomId]: undefined }, focusTick: s.focusTick + 1 })),
  startEdit: (roomId, eventId) =>
    set((s) => ({
      editing: { ...s.editing, [roomId]: eventId },
      replyTo: { ...s.replyTo, [roomId]: undefined },
      focusTick: s.focusTick + 1,
    })),
  cancelEdit: (roomId) => set((s) => ({ editing: { ...s.editing, [roomId]: undefined }, focusTick: s.focusTick + 1 })),
  clearComposerTargets: (roomId) =>
    set((s) => ({ replyTo: { ...s.replyTo, [roomId]: undefined }, editing: { ...s.editing, [roomId]: undefined } })),
  focusComposer: () => set((s) => ({ focusTick: s.focusTick + 1 })),
  jumpTo: (roomId, eventId) => set((s) => ({ jump: { roomId, eventId, nonce: (s.jump?.nonce ?? 0) + 1 } })),
  clearJump: () => set({ jump: null }),
}));

/** The reply target for a room (undefined when not replying). */
export function useReplyTargetId(roomId: string): string | undefined {
  return useConversationUi((s) => s.replyTo[roomId]);
}

/** The edit target for a room (undefined when not editing). */
export function useEditingId(roomId: string): string | undefined {
  return useConversationUi((s) => s.editing[roomId]);
}
