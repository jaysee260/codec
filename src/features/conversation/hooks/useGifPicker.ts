/**
 * Which composer (if any) currently owns the GIF picker (Dev B, Phase 4).
 *
 * The picker is a **singleton overlay**: its test ids (`gif-picker`, `gif-search`, `gif-grid`, ...) are
 * never prefixed (docs/PHASE4_ACCEPTANCE.md "Prefix rule"), so at most one may be in the DOM at a time
 * even though two composers are mounted while the thread panel is open. That is enforced here rather
 * than inside the composer: the store holds a single `{ key, initialQuery }`, and each `Composer`
 * renders `GifPickerMount` only while `open.key === sourceKey(source)`. Opening it from the thread
 * panel therefore closes the channel's instance for free (AC-G6-6), and a room switch closes it
 * because the composer's source-change effect calls `close()` (AC-G6-7).
 *
 * `nonce` is bumped on every `openFor` so re-opening with the same key and query still remounts the
 * picker (a fresh trending request, selection reset to index 0).
 *
 * Kept separate from `useConversationUi` because that store is keyed per source for *persistent*
 * state (reply/edit targets); this one is deliberately global and single-valued.
 */
import { create } from 'zustand';

export interface GifPickerTarget {
  /** `sourceKey(source)` of the composer that opened it: the room id, or the thread root id. */
  key: string;
  /** Pre-filled search query ('' = open on trending). */
  initialQuery: string;
  /** Bumped on every open so the picker remounts even for an identical key + query. */
  nonce: number;
}

export interface GifPickerState {
  open: GifPickerTarget | null;
  /** Open (or re-open) the picker for one composer. `query` is trimmed by the caller. */
  openFor(key: string, initialQuery?: string): void;
  /** Close it, whoever owns it. Safe to call when nothing is open. */
  close(): void;
}

export const useGifPickerStore = create<GifPickerState>((set, get) => ({
  open: null,
  openFor: (key, initialQuery = '') =>
    set((s) => ({ open: { key, initialQuery, nonce: (s.open?.nonce ?? 0) + 1 } })),
  close: () => {
    if (get().open) set({ open: null });
  },
}));

/** The picker target for this composer, or null when it is closed or owned by the other composer. */
export function useGifPickerFor(key: string): GifPickerTarget | null {
  return useGifPickerStore((s) => (s.open && s.open.key === key ? s.open : null));
}
