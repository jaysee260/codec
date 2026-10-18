/**
 * Fetching previews through the homeserver (Phase 6, brief decision 6). Wraps `client.getUrlPreview(url, ts)`
 * (matrix-js-sdk picks the authenticated `/_matrix/client/v1/media/preview_url` on v1.11 servers, else the v3 one).
 *
 * - One in-memory LRU per app (200 URLs; hits live 1 h, misses 5 min) so scrolling back never refetches.
 * - In-flight dedupe: ten rows with the same link share one request.
 * - Errors stay quiet: a failed / empty / blocked preview resolves to `null` (never throws, except `AbortError`
 *   when the caller's `signal` fires first; the request still completes and fills the cache).
 *
 * The SDK keeps its own per-minute promise cache, including rejected promises; this layer's negative TTL is what
 * makes a transient failure retryable at all.
 */
import { getClientOrNull } from '../matrix/client.ts';
import { LruCache } from './cache.ts';
import { normalizePreview } from './normalize.ts';
import type { LinkPreview, LinkPreviewOptions } from './types.ts';

export const PREVIEW_CACHE_MAX = 200;
export const PREVIEW_CACHE_TTL_MS = 60 * 60 * 1000;
export const PREVIEW_NEGATIVE_TTL_MS = 5 * 60 * 1000;

const cache = new LruCache<LinkPreview>({ max: PREVIEW_CACHE_MAX, ttlMs: PREVIEW_CACHE_TTL_MS, negativeTtlMs: PREVIEW_NEGATIVE_TTL_MS });
const inflight = new Map<string, Promise<LinkPreview | null>>();
/** Bumped by `clearLinkPreviewCache()`: a request started before the clear must not write into the new cache. */
let epoch = 0;

/** Hash-stripped cache key; `null` for strings that are not http(s) URLs. */
export function previewCacheKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Synchronous cache lookup for first render: `undefined` = unknown (call `getLinkPreview`), `null` = known
 * no-preview, else the preview.
 */
export function peekLinkPreview(url: string): LinkPreview | null | undefined {
  const key = previewCacheKey(url);
  return key ? cache.get(key) : null;
}

/** True while a request for this URL is in flight. */
export function isLinkPreviewPending(url: string): boolean {
  const key = previewCacheKey(url);
  return !!key && inflight.has(key);
}

function abortError(): Error {
  return typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/**
 * The preview for `url`, or `null` when the server has none / refuses / fails. Callers decide *whether* to ask
 * (`shouldAutoPreview(roomId)`); this function only answers. Rejects only with `AbortError` (signal fired).
 */
export function getLinkPreview(url: string, opts: LinkPreviewOptions = {}): Promise<LinkPreview | null> {
  const key = previewCacheKey(url);
  if (!key) return Promise.resolve(null);
  if (opts.signal?.aborted) return Promise.reject(abortError());
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  let p = inflight.get(key);
  if (!p) {
    p = request(key, opts.ts ?? Date.now()).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
  }
  if (!opts.signal) return p;
  const signal = opts.signal;
  return new Promise<LinkPreview | null>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p!.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function request(key: string, ts: number): Promise<LinkPreview | null> {
  const startedIn = epoch;
  const client = getClientOrNull();
  if (!client) return null; // not logged in: nothing to ask; not cached, so a later call retries
  let preview: LinkPreview | null;
  try {
    const raw = await client.getUrlPreview(key, ts);
    preview = normalizePreview(key, raw as Record<string, unknown>);
  } catch {
    preview = null;
  }
  if (startedIn === epoch) cache.set(key, preview);
  return preview;
}

/** Pre-seed or override the cache (tests, devtools). `null` records a miss. */
export function primeLinkPreview(url: string, preview: LinkPreview | null): void {
  const key = previewCacheKey(url);
  if (key) cache.set(key, preview);
}

/**
 * Drop everything cached and forget in-flight requests (logout / token rejected, devtools): a request already on
 * the wire still resolves for its caller but no longer writes into the cache, so the next user starts empty.
 */
export function clearLinkPreviewCache(): void {
  epoch++;
  cache.clear();
  inflight.clear();
}

/** Cached entry count (devtools / tests). */
export function linkPreviewCacheSize(): number {
  return cache.size;
}
