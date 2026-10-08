/**
 * Conversation UI state shared between the message list and the composer (Dev B only).
 *
 * Kept in a tiny zustand store instead of React context because the composer and the rows that
 * trigger reply/edit/jump live in different subtrees and must not re-render each other.
 *
 * Phase 3: all state is keyed by **source key** (`sourceKey(source)` from the timeline store: the
 * room id for a channel, the thread root id for a thread panel) instead of plain room id, so the
 * channel composer and the thread composer never share a reply/edit target, a draft focus request or
 * a jump. `sourceKey({ roomId })` is the room id, so every Phase 1/2 call site behaves exactly as
 * before. Focus requests carry their key: a `startEdit` in the panel must not pull the caret into the
 * channel composer (AC-T6-9) and vice versa.
 */
import { create } from 'zustand';

export interface JumpRequest {
  /** Source key of the list that should scroll (room id, or thread root id). */
  key: string;
  eventId: string;
  /** Bumped on every request so repeat jumps to the same event still fire. */
  nonce: number;
}

export interface FocusRequest {
  /** Source key of the composer that should take focus. */
  key: string;
  /** Bumped on every request so repeat focus calls still fire. */
  nonce: number;
}

export interface ConversationUiState {
  /** Event id the composer is replying to, per source key. */
  replyTo: Record<string, string | undefined>;
  /** Event id the composer is editing, per source key. */
  editing: Record<string, string | undefined>;
  /** Latest "take the caret" request; only the composer whose key matches reacts. */
  focus: FocusRequest | null;
  /** Latest "scroll the list to this event" request. */
  jump: JumpRequest | null;
  startReply(key: string, eventId: string): void;
  cancelReply(key: string): void;
  startEdit(key: string, eventId: string): void;
  cancelEdit(key: string): void;
  /** Clear reply + edit state for a source (after a successful send, or on room/thread change). */
  clearComposerTargets(key: string): void;
  focusComposer(key: string): void;
  jumpTo(key: string, eventId: string): void;
  /** Called by the list once it has taken the request, so re-mounting a room does not re-jump. */
  clearJump(): void;
}

export const useConversationUi = create<ConversationUiState>((set) => ({
  replyTo: {},
  editing: {},
  focus: null,
  jump: null,

  startReply: (key, eventId) =>
    set((s) => ({
      replyTo: { ...s.replyTo, [key]: eventId },
      editing: { ...s.editing, [key]: undefined },
      focus: { key, nonce: (s.focus?.nonce ?? 0) + 1 },
    })),
  cancelReply: (key) =>
    set((s) => ({ replyTo: { ...s.replyTo, [key]: undefined }, focus: { key, nonce: (s.focus?.nonce ?? 0) + 1 } })),
  startEdit: (key, eventId) =>
    set((s) => ({
      editing: { ...s.editing, [key]: eventId },
      replyTo: { ...s.replyTo, [key]: undefined },
      focus: { key, nonce: (s.focus?.nonce ?? 0) + 1 },
    })),
  cancelEdit: (key) =>
    set((s) => ({ editing: { ...s.editing, [key]: undefined }, focus: { key, nonce: (s.focus?.nonce ?? 0) + 1 } })),
  clearComposerTargets: (key) =>
    set((s) => ({ replyTo: { ...s.replyTo, [key]: undefined }, editing: { ...s.editing, [key]: undefined } })),
  focusComposer: (key) => set((s) => ({ focus: { key, nonce: (s.focus?.nonce ?? 0) + 1 } })),
  jumpTo: (key, eventId) => set((s) => ({ jump: { key, eventId, nonce: (s.jump?.nonce ?? 0) + 1 } })),
  clearJump: () => set({ jump: null }),
}));

/** The reply target for a source (undefined when not replying). */
export function useReplyTargetId(key: string): string | undefined {
  return useConversationUi((s) => s.replyTo[key]);
}

/** The edit target for a source (undefined when not editing). */
export function useEditingId(key: string): string | undefined {
  return useConversationUi((s) => s.editing[key]);
}

/** Nonce of the newest focus request addressed to this source, or 0 when there is none. */
export function useFocusTick(key: string): number {
  return useConversationUi((s) => (s.focus && s.focus.key === key ? s.focus.nonce : 0));
}
