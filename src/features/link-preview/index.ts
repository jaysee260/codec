/**
 * Link preview UI (Dev A, Phase 6). Dev B's message rows mount one card per previewable URL inside their own
 * `link-previews` host:
 *
 *   import { LinkPreviewCard } from '@/features/link-preview';
 *   {urls.map((url) => (
 *     <LinkPreviewCard key={url} eventId={eventId} url={url} auto={shouldAutoPreview(roomId, event)} ts={event.getTs()} />
 *   ))}
 *
 * The card owns its state (`useLinkPreview` / `useHiddenPreview` from `@/lib/preview`): click-to-load in
 * encrypted rooms, loading, ready, unavailable; it returns null when hidden or (plain room) empty.
 * `EmbedPlayer` is the YouTube / Spotify click-to-play used by the card; exported for completeness.
 */
export { LinkPreviewCard, hostnameOf, LARGE_MAX_W, LARGE_MAX_H, THUMB_SIZE } from './components/LinkPreviewCard.tsx';
export type { LinkPreviewCardProps } from './components/LinkPreviewCard.tsx';
export { EmbedPlayer, EmbedFrame, embedSrc, spotifyHeight } from './components/EmbedPlayer.tsx';
export type { EmbedPlayerProps } from './components/EmbedPlayer.tsx';
