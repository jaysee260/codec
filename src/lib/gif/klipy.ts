/**
 * Klipy GIF provider (Phase 4). Facts verified against docs.klipy.com (`llms-full.txt`, 2026-10-09) and live curl,
 * independently by the Advisor agent; recorded in docs/CORE_API.md "Klipy facts relied on".
 *
 *   GET https://api.klipy.com/api/v1/{app_key}/gifs/search?q=&page=&per_page=&content_filter=[&locale=&customer_id=]
 *   GET https://api.klipy.com/api/v1/{app_key}/gifs/trending?page=&per_page=&content_filter=[&locale=&customer_id=]
 *
 * - The app key is a **path segment**; no header, no query param, no `Authorization`. An invalid key answers
 *   HTTP 404 `{ result: false, errors: { message: ["The provided API key is invalid."] } }` -> `GifProviderError('auth')`.
 * - `page` is 1-based; `per_page` 8..50 (default 24); `content_filter` off | low | medium | high (`GIF_CONTENT_RATING`).
 * - Response `{ result: true, data: { data: Item[], current_page, per_page, has_next } }`,
 *   Item `{ id: number, slug, title, type: 'gif', blur_preview, file: { hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height, size } } } }`.
 * - CORS: `access-control-allow-origin: *` on api.klipy.com and on the static*.klipy.com media hosts.
 * - Test keys: 100 requests/hour (the picker debounces and aborts). 429 shape is undocumented: retried once
 *   honouring `Retry-After` (seconds or HTTP date), else 1 s; a second 429 rejects with `status: 429`.
 * - Mapping: `id` = `slug` (numeric `id` can exceed 2^53, BUG-9; `String(id)` only when there is no slug); `fullUrl` =
 *   `GIF_SEND_VARIANT` gif (hd -> md -> sm); `previewUrl` = sm.webp, else sm.mp4, else sm.gif (xs.* as a last resort);
 *   `stillUrl` = sm.jpg; results in Klipy's order, never filtered or re-sorted. `customer_id` is sent when given.
 *
 * Pure module: `createKlipyProvider({ apiKey })`; env/localStorage live in `provider.ts`.
 */
import { GIF_CONTENT_RATING, GIF_SEND_VARIANT, KLIPY_DEFAULT_BASE } from './config.ts';
import { GifProviderError } from './types.ts';
import type { GifPage, GifPreviewMimetype, GifProvider, GifQueryOptions, GifRating, GifResult } from './types.ts';

export { KLIPY_DEFAULT_BASE };

/** Klipy's content safety filter values. */
export type KlipyContentFilter = 'off' | 'low' | 'medium' | 'high';

/** Brief's `rating` -> Klipy `content_filter`. */
export const RATING_TO_CONTENT_FILTER: Record<GifRating, KlipyContentFilter> = {
  g: 'high',
  pg: 'medium',
  'pg-13': 'low',
  r: 'off',
};

export interface KlipyProviderOptions {
  apiKey: string;
  /** API origin (QA stubs point this at a `page.route` target). Default `https://api.klipy.com`. */
  baseUrl?: string;
  /** Stable per-user id for Klipy's "recent" ranking; `getGifProvider()` passes `getGifCustomerId()`. */
  customerId?: string;
  /** ISO 3166-1 alpha-2 country code (`us`, `de`); not sent unless given. */
  locale?: string;
  /** Default content filter when `opts.rating` is not given. Default `GIF_CONTENT_RATING` (`medium`). */
  contentFilter?: KlipyContentFilter;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

interface KlipyVariant {
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}
type KlipyFormats = Partial<Record<'gif' | 'webp' | 'jpg' | 'mp4' | 'webm', KlipyVariant>>;
export interface KlipyItem {
  id?: number | string;
  slug?: string;
  title?: string;
  type?: string;
  file?: Partial<Record<'hd' | 'md' | 'sm' | 'xs', KlipyFormats>>;
}
interface KlipyResponse {
  result?: boolean;
  data?: { data?: KlipyItem[]; current_page?: number; per_page?: number; has_next?: boolean };
  errors?: { message?: string[] | string };
}

const PER_PAGE_MIN = 8;
const PER_PAGE_MAX = 50;
const PER_PAGE_DEFAULT = 24;
const RETRY_FALLBACK_MS = 1000;
const RETRY_MAX_MS = 15_000;
const SEND_ORDER: Array<'hd' | 'md' | 'sm'> = [GIF_SEND_VARIANT, ...(['hd', 'md', 'sm'] as const).filter((v) => v !== GIF_SEND_VARIANT)];

type OkVariant = Required<Pick<KlipyVariant, 'url' | 'width' | 'height'>> & KlipyVariant;
const okVariant = (v?: KlipyVariant): v is OkVariant =>
  !!v && typeof v.url === 'string' && typeof v.width === 'number' && typeof v.height === 'number' && v.width > 0 && v.height > 0;

/** Map one Klipy item to a `GifResult`, or null when it has no usable GIF variant. */
export function mapKlipyItem(item: KlipyItem): GifResult | null {
  const f = item.file ?? {};
  const full = SEND_ORDER.map((size) => f[size]?.gif).find(okVariant);
  if (!full) return null;
  const previewCandidates: Array<[KlipyVariant | undefined, GifPreviewMimetype]> = [
    [f.sm?.webp, 'image/webp'],
    [f.sm?.mp4, 'video/mp4'],
    [f.sm?.gif, 'image/gif'],
    [f.xs?.webp, 'image/webp'],
    [f.xs?.mp4, 'video/mp4'],
    [f.xs?.gif, 'image/gif'],
  ];
  const preview = previewCandidates.find(([v]) => okVariant(v)) as [OkVariant, GifPreviewMimetype] | undefined;
  // BUG-9: Klipy ids are numbers that can exceed 2^53 and collapse in JSON.parse; the slug is the stable, unique id.
  const id = (typeof item.slug === 'string' && item.slug.trim()) || (item.id === undefined || item.id === null ? '' : String(item.id));
  if (!id) return null;
  const still = f.sm?.jpg;
  return {
    id,
    title: (item.title ?? item.slug ?? 'GIF').trim() || 'GIF',
    previewUrl: preview ? preview[0].url : full.url,
    previewMimetype: preview ? preview[1] : 'image/gif',
    previewW: preview ? preview[0].width : full.width,
    previewH: preview ? preview[0].height : full.height,
    fullUrl: full.url,
    fullW: full.width,
    fullH: full.height,
    fullSize: typeof full.size === 'number' ? full.size : undefined,
    stillUrl: still && typeof still.url === 'string' ? still.url : undefined,
    mimetype: 'image/gif',
    provider: 'klipy',
  };
}

/** `Retry-After` header -> ms (seconds or HTTP date), bounded; `undefined` when absent/unparseable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(RETRY_MAX_MS, Math.max(0, secs * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(RETRY_MAX_MS, Math.max(0, at - now));
  return undefined;
}

function errorMessage(json: KlipyResponse | undefined): string | undefined {
  const m = json?.errors?.message;
  if (Array.isArray(m)) return m.filter((x) => typeof x === 'string').join('; ') || undefined;
  return typeof m === 'string' ? m : undefined;
}

/** Build the request URL (exported for tests / docs). */
export function klipyRequestUrl(options: KlipyProviderOptions, endpoint: 'search' | 'trending', query: string | undefined, opts: GifQueryOptions = {}): string {
  const base = (options.baseUrl ?? KLIPY_DEFAULT_BASE).replace(/\/+$/, '');
  const url = new URL(`${base}/api/v1/${encodeURIComponent(options.apiKey.trim())}/gifs/${endpoint}`);
  if (endpoint === 'search') url.searchParams.set('q', query ?? '');
  const page = Number(opts.page ?? 1);
  url.searchParams.set('page', String(Number.isInteger(page) && page >= 1 ? page : 1));
  const limit = Math.round(opts.limit ?? PER_PAGE_DEFAULT);
  url.searchParams.set('per_page', String(Math.min(PER_PAGE_MAX, Math.max(PER_PAGE_MIN, Number.isFinite(limit) ? limit : PER_PAGE_DEFAULT))));
  const filter = opts.rating ? RATING_TO_CONTENT_FILTER[opts.rating] : (options.contentFilter ?? GIF_CONTENT_RATING);
  url.searchParams.set('content_filter', filter);
  if (options.locale) url.searchParams.set('locale', options.locale);
  if (options.customerId) url.searchParams.set('customer_id', options.customerId);
  return url.toString();
}

export function createKlipyProvider(options: KlipyProviderOptions): GifProvider {
  const apiKey = options.apiKey.trim();
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new GifProviderError('aborted', 'Request aborted'));
        },
        { once: true },
      );
    });

  const request = async (endpoint: 'search' | 'trending', query: string | undefined, opts: GifQueryOptions): Promise<GifPage> => {
    if (!apiKey) throw new GifProviderError('auth', 'No Klipy API key configured (VITE_GIF_API_KEY or localStorage matrix-poc.gifApiKey)');
    const url = klipyRequestUrl({ ...options, apiKey }, endpoint, query, opts);
    let retried = false;
    for (;;) {
      if (opts.signal?.aborted) throw new GifProviderError('aborted', 'Request aborted');
      let res: Response;
      try {
        res = await doFetch(url, { signal: opts.signal });
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw new GifProviderError('aborted', 'Request aborted');
        throw new GifProviderError('network', `Could not reach the GIF service (${(e as Error)?.message ?? e})`);
      }
      if (res.status === 429 && !retried) {
        retried = true;
        await sleep(parseRetryAfter(res.headers.get('retry-after')) ?? RETRY_FALLBACK_MS, opts.signal);
        continue;
      }
      const text = await res.text();
      let json: KlipyResponse | undefined;
      try {
        json = text ? (JSON.parse(text) as KlipyResponse) : undefined;
      } catch {
        json = undefined;
      }
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? RETRY_FALLBACK_MS;
        throw new GifProviderError('rate-limit', 'GIF search is rate limited; try again in a moment', { status: 429, retryAfterMs });
      }
      const apiError = json && json.result === false ? errorMessage(json) : undefined;
      if (apiError && /api key/i.test(apiError)) {
        throw new GifProviderError('auth', `Klipy rejected the API key: ${apiError}`, { status: res.status });
      }
      if (!res.ok || !json || json.result !== true || !json.data || !Array.isArray(json.data.data)) {
        const detail = apiError ?? (text ? text.slice(0, 120) : res.statusText);
        const kind = res.status === 401 || res.status === 403 ? 'auth' : res.ok ? 'bad-response' : 'network';
        throw new GifProviderError(kind, `GIF service error ${res.status}: ${detail}`, { status: res.status });
      }
      const results = json.data.data.map(mapKlipyItem).filter((g): g is GifResult => g !== null);
      const current = typeof json.data.current_page === 'number' ? json.data.current_page : Number(opts.page ?? 1) || 1;
      const hasNext = json.data.has_next === true;
      return { results, nextPage: hasNext ? current + 1 : null, hasNext };
    }
  };

  return {
    name: 'klipy',
    search: (query, opts = {}) => request('search', query, opts),
    trending: (opts = {}) => request('trending', undefined, opts),
  };
}
