/**
 * Link previews (Phase 6): which links in a message get a card, fetching + caching previews through the
 * homeserver, click-to-play embeds, and the per-viewer hide store.
 *
 *   import { getPreviewUrls, shouldAutoPreview, useLinkPreview, useHiddenPreview, parseEmbed, previewImageLayout } from '@/lib/preview';
 *   const urls = getPreviewUrls(event);                         // string[] (<= 3, message order; [] for GIF/redacted/undecrypted/media)
 *   const auto = shouldAutoPreview(roomId, event);              // false in encrypted rooms: render a "Show preview" button instead
 *   const { status, preview } = useLinkPreview(url, { enabled: auto || clicked });
 *   const embed = parseEmbed(url);                              // YouTube / Spotify -> iframe src, created only after the play click
 *   mxcToHttp(preview.image.mxc, w, h)                          // og:image is an mxc URI; never render a raw URL
 *
 * Pure (Node-loadable, no React/SDK): types, extract, embed, normalize, cache, hidden. SDK-bound: fetch, policy.
 * React: hooks. Docs: docs/ARCHITECTURE.md "Phase 6 deltas (link previews)".
 */
export type {
  LinkPreview,
  LinkPreviewImage,
  LinkEmbed,
  EmbedProvider,
  PreviewSource,
  ExtractOptions,
  LinkPreviewOptions,
  LinkPreviewStatus,
} from './types.ts';
export { extractPreviewUrls, normalizePreviewUrl, PREVIEW_MAX_LINKS } from './extract.ts';
export { parseEmbed, isEmbedUrl, YOUTUBE_EMBED_ORIGIN, SPOTIFY_EMBED_ORIGIN } from './embed.ts';
export { normalizePreview, previewImageLayout, isMxcUrl } from './normalize.ts';
export type { RawUrlPreview } from './normalize.ts';
export { LruCache } from './cache.ts';
export type { LruOptions } from './cache.ts';
export {
  getLinkPreview,
  peekLinkPreview,
  isLinkPreviewPending,
  primeLinkPreview,
  clearLinkPreviewCache,
  linkPreviewCacheSize,
  previewCacheKey,
  PREVIEW_CACHE_MAX,
  PREVIEW_CACHE_TTL_MS,
  PREVIEW_NEGATIVE_TTL_MS,
} from './fetch.ts';
export { shouldAutoPreview, getPreviewUrls } from './policy.ts';
export {
  isPreviewHidden,
  hidePreview,
  unhidePreview,
  clearHiddenPreviews,
  subscribeHiddenPreviews,
  hiddenPreviewsVersion,
  hiddenPreviewKey,
  HIDDEN_PREVIEWS_STORAGE_KEY,
  HIDDEN_PREVIEWS_MAX,
} from './hidden.ts';
export { useLinkPreview, useHiddenPreview } from './hooks.ts';
export type { UseLinkPreviewOptions, UseLinkPreviewResult, UseHiddenPreviewResult } from './hooks.ts';
