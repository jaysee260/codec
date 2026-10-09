/**
 * Provider selection (Phase 4). The only module in `src/lib/gif` that reads `import.meta.env` and localStorage.
 *
 *   provider = localStorage `matrix-poc.gifProvider` ('klipy' | 'mock', forces)   // QA flips per test, no restart
 *            -> key present ? 'klipy' : 'mock'
 *   key      = localStorage `matrix-poc.gifApiKey` (runtime: APK / DevTools, no rebuild) -> `VITE_GIF_API_KEY` -> ''
 *   base     = `VITE_GIF_API_BASE` (QA `page.route` target) -> https://api.klipy.com
 *
 * `getGifProvider()` memoises per (provider, key, base) and re-reads localStorage on every call, so
 * `localStorage.setItem(...)` followed by the next picker open is enough; `setGifApiKey()` / `setGifProviderOverride()`
 * are the typed setters. `searchGifs` / `trendingGifs` are the one-liners docs/PHASE4_ACCEPTANCE.md names.
 */
import { GIF_API_KEY_STORAGE_KEY, GIF_CUSTOMER_ID_STORAGE_KEY, GIF_PROVIDER_STORAGE_KEY, KLIPY_DEFAULT_BASE } from './config.ts';
import { createKlipyProvider } from './klipy.ts';
import { createMockProvider } from './mock.ts';
import type { GifPage, GifProvider, GifProviderName, GifQueryOptions } from './types.ts';

export { GIF_API_KEY_STORAGE_KEY, GIF_CUSTOMER_ID_STORAGE_KEY, GIF_PROVIDER_STORAGE_KEY };

// `import.meta.env` is undefined under Node type stripping; read defensively so scripts can import the barrel.
const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;

/** Build-time key from `VITE_GIF_API_KEY` ('' when unset). */
export const DEFAULT_GIF_API_KEY: string = (env.VITE_GIF_API_KEY ?? '').trim();
/** Build-time API base from `VITE_GIF_API_BASE`, else Klipy's. */
export const GIF_API_BASE: string = ((env.VITE_GIF_API_BASE ?? '').trim() || KLIPY_DEFAULT_BASE).replace(/\/+$/, '');

function storage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}
function read(key: string): string {
  try {
    return storage()?.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}
function write(key: string, value: string | null | undefined): void {
  try {
    if (value) storage()?.setItem(key, value);
    else storage()?.removeItem(key);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Effective Klipy key: runtime override -> VITE_GIF_API_KEY -> ''. */
export function getGifApiKey(): string {
  return read(GIF_API_KEY_STORAGE_KEY) || DEFAULT_GIF_API_KEY;
}

/** Persist (or clear, with '' / null) the runtime key override. Returns the effective key. */
export function setGifApiKey(key: string | null | undefined): string {
  const k = (key ?? '').trim();
  write(GIF_API_KEY_STORAGE_KEY, !k || k === DEFAULT_GIF_API_KEY ? null : k);
  memo = undefined;
  return getGifApiKey();
}

/** The forced provider from localStorage `matrix-poc.gifProvider`, or undefined. */
export function getGifProviderOverride(): GifProviderName | undefined {
  const v = read(GIF_PROVIDER_STORAGE_KEY);
  return v === 'klipy' || v === 'mock' ? v : undefined;
}

/** Force a provider (QA / DevTools); `null` clears the override. 'klipy' without a key -> every call rejects with an 'auth' error. */
export function setGifProvider(name: GifProviderName | null | undefined): void {
  write(GIF_PROVIDER_STORAGE_KEY, name === 'klipy' || name === 'mock' ? name : null);
  memo = undefined;
}
/** Alias of `setGifProvider`. */
export const setGifProviderOverride = setGifProvider;

/** Stable random `customer_id` (per browser profile, localStorage `matrix-poc.gifCustomerId`), sent with every Klipy request. '' without storage. */
export function getGifCustomerId(): string {
  const s = storage();
  if (!s) return '';
  try {
    let id = s.getItem(GIF_CUSTOMER_ID_STORAGE_KEY);
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      s.setItem(GIF_CUSTOMER_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

/** `matrix-poc.gifProvider` override, else `'klipy'` when a key is configured (runtime or build-time), else `'mock'`. */
export function gifProviderName(): GifProviderName {
  return getGifProviderOverride() ?? (getGifApiKey() ? 'klipy' : 'mock');
}

let memo: { key: string; provider: GifProvider } | undefined;

/** The provider to use right now (re-evaluated from localStorage on every call; instances memoised). */
export function getGifProvider(): GifProvider {
  const name = gifProviderName();
  const key = getGifApiKey();
  const memoKey = `${name}|${key}|${GIF_API_BASE}`;
  if (memo?.key === memoKey) return memo.provider;
  const provider =
    name === 'klipy'
      ? createKlipyProvider({ apiKey: key, baseUrl: GIF_API_BASE, customerId: getGifCustomerId() || undefined })
      : createMockProvider({ basePath: env.BASE_URL ?? '/' });
  memo = { key: memoKey, provider };
  return provider;
}

/** `getGifProvider().search(query, opts)`. */
export function searchGifs(query: string, opts?: GifQueryOptions): Promise<GifPage> {
  return getGifProvider().search(query, opts);
}

/** `getGifProvider().trending(opts)`. */
export function trendingGifs(opts?: GifQueryOptions): Promise<GifPage> {
  return getGifProvider().trending(opts);
}
