/**
 * Link preview types (Phase 6). Pure module: no React, no Matrix SDK, no `import.meta.env`, so Node scripts and
 * e2e helpers can import it with type stripping (like `src/lib/gif/types.ts`).
 *
 * Contract: docs/PHASE6_ACCEPTANCE.md (PM); API: docs/ARCHITECTURE.md "Phase 6 deltas (link previews)".
 */

/** The og:image of a preview. `mxc` is always an `mxc://` URI (the homeserver re-hosts the image): render it with `mxcToHttp`. */
export interface LinkPreviewImage {
  mxc: string;
  width?: number;
  height?: number;
  mimetype?: string;
  /** `matrix:image:size`, bytes, when the server reports it. */
  size?: number;
}

/**
 * A normalised `/preview_url` answer. At least one of `title`, `description`, `image` is present
 * (`getLinkPreview` returns `null` instead of an empty preview). Strings are trimmed and never empty.
 */
export interface LinkPreview {
  /** The URL that was previewed (hash stripped), i.e. the card's link target. */
  url: string;
  /** `og:site_name`. */
  siteName?: string;
  /** `og:title` (Synapse synthesises one from `<title>` when a page has no OpenGraph tags). */
  title?: string;
  /** `og:description`. */
  description?: string;
  image?: LinkPreviewImage;
}

export type EmbedProvider = 'youtube' | 'spotify';

/**
 * A click-to-play embed parsed client-side from the URL alone (no network). The card shows a play button and
 * creates the `<iframe src={embedUrl}>` only after the click (docs brief, decision 5).
 */
export interface LinkEmbed {
  provider: EmbedProvider;
  /** `'video'` for YouTube; the Spotify resource kind otherwise. */
  kind: 'video' | 'track' | 'album' | 'playlist' | 'episode';
  /** Provider id (YouTube video id, Spotify base62 id). Safe in testids. */
  id: string;
  /** `https://www.youtube-nocookie.com/embed/<id>[?start=N]` or `https://open.spotify.com/embed/<kind>/<id>`. */
  embedUrl: string;
  /** Canonical page URL to link the title to. */
  canonicalUrl: string;
  /** YouTube `t=` / `start=` offset in seconds, when the link carried one. */
  startSeconds?: number;
}

/**
 * The subset of `DisplayBody` (src/lib/matrix/utils.ts) that `extractPreviewUrls` reads. Pass a `DisplayBody`
 * straight in, or a plain string for a text-only body.
 */
export interface PreviewSource {
  text: string;
  /** `org.matrix.custom.html` body; links inside `<pre>` / `<code>` are skipped. */
  html?: string;
  msgtype?: string;
  isRedacted?: boolean;
  /** Present on a GIF message: GIFs already render inline, so no preview. */
  gif?: unknown;
  /** Phase 5 decryption placeholder: anything but `'decrypted'` yields no links. */
  decryption?: { status: string } | undefined;
}

export interface ExtractOptions {
  /** Maximum distinct links (message order). Default 3. */
  max?: number;
  /**
   * Homeserver base URL (no trailing slash): links to its media endpoints (`/_matrix/media/...`,
   * `/_matrix/client/v1/media/...`) are skipped. The SDK-bound wrapper passes `getHsUrl()`.
   */
  hsUrl?: string;
}

export interface LinkPreviewOptions {
  /** Cancel waiting for the answer (the request itself still completes and fills the cache). */
  signal?: AbortSignal;
  /** Timestamp for the server's `ts` parameter (the SDK buckets it to the minute). Default `Date.now()`. */
  ts?: number;
}

/** `useLinkPreview` state. `'empty'` covers "no preview", "blocked" and "failed" alike: errors stay quiet. */
export type LinkPreviewStatus = 'idle' | 'loading' | 'ready' | 'empty';
