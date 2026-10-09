/**
 * GIF feature (Dev A, Phase 4). Dev B's composer mounts exactly one thing from here:
 *
 *   import { GifPicker } from '@/features/gif';
 *   <GifPicker variant={isPhone ? 'sheet' : 'popover'} initialQuery={q} onPick={send} onClose={close} />
 *
 * The mount owns placement (`popover` renders inline with no positioning of its own), the phone
 * `gif-backdrop`, click-outside, and returning focus to `composer-input`. The picker owns the
 * search box, the grid, the keyboard model and the `gif-*` states - see GifPicker.tsx.
 *
 * `useGifSearch` is exported for completeness (debounce + abort + a 20-query cache over
 * `src/lib/gif`); nothing outside this folder needs it today.
 */
export { GifPicker } from './components/GifPicker.tsx';
export type { GifPickerProps, GifPickerVariant } from './components/GifPicker.tsx';
export { useGifSearch, GIF_SEARCH_DEBOUNCE_MS, GIF_PAGE_SIZE } from './hooks/useGifSearch.ts';
export type { UseGifSearchOptions, GifSearchState } from './hooks/useGifSearch.ts';
