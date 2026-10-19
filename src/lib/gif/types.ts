/**
 * GIF picker types (Phase 4). Provider-neutral: the picker (Dev A) and the composer/timeline (Dev B) only ever
 * see `GifResult` / `GifPage` / `GifMessage`; `klipy.ts` and `mock.ts` map their own shapes onto these.
 *
 * Pure module: no React, no Matrix SDK, no `import.meta.env` (Node scripts import it with type stripping).
 */

export type GifPreviewMimetype = 'image/webp' | 'video/mp4' | 'image/gif';

/** One search / trending hit. All URLs are absolute (https for Klipy; same-origin http(s) for the mock). */
export interface GifResult {
  /** Provider-scoped stable id: `'mock-3'`; Klipy `slug` (`'hello-hi-662'`; numeric ids can exceed 2^53, BUG-9). Safe in testids. */
  id: string;
  title: string;
  /** Small animated preview for the picker grid (`<img>` for webp/gif, `<video muted loop autoplay playsinline>` for mp4). */
  previewUrl: string;
  previewMimetype: GifPreviewMimetype;
  previewW: number;
  previewH: number;
  /** The GIF that gets sent (always `image/gif`): Klipy `GIF_SEND_VARIANT` (hd -> md -> sm), the mock's file. */
  fullUrl: string;
  fullW: number;
  fullH: number;
  /** Bytes of `fullUrl` when the provider reports it. */
  fullSize?: number;
  /** Paused frame (Klipy `sm.jpg`, mock `<id>.png`) for reduced-motion rendering; omitted when unknown. */
  stillUrl?: string;
  mimetype: 'image/gif';
  provider: GifProviderName;
}

export type GifProviderName = 'klipy' | 'mock';

export interface GifPage {
  /** In the provider's order; never filtered or re-sorted by the client (Klipy integration terms). */
  results: GifResult[];
  /** Pass back as `opts.page` to fetch the next page; `null` when this was the last page (Klipy: a page number). */
  nextPage: string | number | null;
  /** `nextPage !== null` (the name docs/archive/PHASE4_ACCEPTANCE.md uses). */
  hasNext: boolean;
}

/** Brief's content rating; mapped onto Klipy's `content_filter` (g -> high, pg -> medium, pg-13 -> low, r -> off). */
export type GifRating = 'g' | 'pg' | 'pg-13' | 'r';

export interface GifQueryOptions {
  /** 1-based page number (`GifPage.nextPage`; numeric strings are accepted). */
  page?: string | number | null;
  /** Results per page. Klipy clamps to 8..50 (default 24); the mock ignores it (one page). */
  limit?: number;
  rating?: GifRating;
  /** Cancel an in-flight request (debounced typing in the picker). */
  signal?: AbortSignal;
}

export interface GifProvider {
  readonly name: GifProviderName;
  search(query: string, opts?: GifQueryOptions): Promise<GifPage>;
  trending(opts?: GifQueryOptions): Promise<GifPage>;
}

/**
 * The `dev.matrixpoc.gif` field of a sent GIF message, exactly as on the wire (docs/archive/PHASE4_ACCEPTANCE.md
 * "GIF message event"). The timeline renders `<img src={url}>` straight from the provider's host (never the media
 * repo) and `stillUrl` under reduced motion.
 */
export interface GifMessage {
  provider: GifProviderName;
  id: string;
  title: string;
  /** Absolute URL of the full `image/gif`, on an allowed host. */
  url: string;
  w: number;
  h: number;
  /** Picker preview (`sm.webp` / `sm.mp4` / `sm.gif`; the gif itself for the mock). */
  previewUrl?: string;
  previewW?: number;
  previewH?: number;
  /** Paused frame (`sm.jpg`; `<id>.png` for the mock). */
  stillUrl?: string;
}

/** Thrown by providers. `kind` is what the picker branches on; `message` is readable as-is. */
export class GifProviderError extends Error {
  readonly kind: 'auth' | 'rate-limit' | 'network' | 'bad-response' | 'aborted';
  /** HTTP status when the service answered. */
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(kind: GifProviderError['kind'], message: string, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'GifProviderError';
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}
