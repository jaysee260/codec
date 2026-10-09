/**
 * GIF picker backend (Phase 4): provider-neutral search/trending + the wire shape of a sent GIF.
 *
 *   import { getGifProvider, gifProviderName, searchGifs, trendingGifs, type GifResult } from '@/lib/gif';
 *   const page = await searchGifs('tacos', { limit: 24 });   // page.results: GifResult[] (API order), page.nextPage / hasNext
 *   await sendGif(roomId, page.results[0], { threadRoot });  // src/lib/matrix/actions.ts
 *   getDisplayBody(event).gif / getGifContent(event)         // src/lib/matrix/utils.ts -> GifMessage | null
 *
 * Docs: docs/ARCHITECTURE.md "GIFs (Phase 4)"; contract: docs/PHASE4_ACCEPTANCE.md.
 */
export type { GifResult, GifPage, GifProvider, GifProviderName, GifQueryOptions, GifRating, GifPreviewMimetype, GifMessage } from './types.ts';
export { GifProviderError } from './types.ts';
export {
  GIF_CONTENT_RATING,
  GIF_SEND_VARIANT,
  GIF_IMAGE_HOSTS,
  GIF_MAX_DIMENSION,
  KLIPY_DEFAULT_BASE,
  GIF_PROVIDER_STORAGE_KEY,
  GIF_API_KEY_STORAGE_KEY,
  GIF_CUSTOMER_ID_STORAGE_KEY,
} from './config.ts';
export {
  getGifProvider,
  gifProviderName,
  searchGifs,
  trendingGifs,
  getGifApiKey,
  setGifApiKey,
  getGifProviderOverride,
  setGifProvider,
  setGifProviderOverride,
  getGifCustomerId,
  GIF_API_BASE,
  DEFAULT_GIF_API_KEY,
} from './provider.ts';
export { createKlipyProvider, mapKlipyItem, klipyRequestUrl, parseRetryAfter, RATING_TO_CONTENT_FILTER } from './klipy.ts';
export type { KlipyProviderOptions, KlipyContentFilter, KlipyItem } from './klipy.ts';
export { createMockProvider, mockGifResults } from './mock.ts';
export type { MockProviderOptions } from './mock.ts';
export { MOCK_FIXTURES, MOCK_FIXTURE_PATH, MOCK_EMPTY_QUERIES, MOCK_ERROR_QUERY } from './mock-fixtures.ts';
export type { MockFixture } from './mock-fixtures.ts';
export { buildGifContent, parseGifContent, isAllowedGifUrl, GIF_CONTENT_KEY } from './message.ts';
export type { GifMessageContent, GifUrlOptions } from './message.ts';
