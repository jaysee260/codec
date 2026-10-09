/**
 * Wire shape of a sent GIF (Phase 4) and its validator. Pure module (no SDK, no env, no DOM) so
 * `scripts/verify-gif.mjs` / `scripts/send-gif-sample.mjs` import it and post exactly what the client posts.
 *
 * Decision (orchestrator, 2026-10-09, after the Advisor's finding; docs/PHASE4_PLAN.md): Klipy's integration terms
 * forbid re-hosting / proxying its media, so GIF bytes are **never** uploaded to the media repo. A GIF is an
 * `m.text` message whose body is "<title> <url>" (Element shows the link and, with URL previews on, unfurls it)
 * plus a structured `dev.matrixpoc.gif` field that this client renders inline (docs/PHASE4_ACCEPTANCE.md):
 *
 *   { "msgtype": "m.text", "body": "Tacos dance https://static.klipy.com/ii/.../hd.gif",
 *     "dev.matrixpoc.gif": { "provider": "klipy", "id": "8041071659142944", "title": "Tacos dance",
 *                            "url": "https://static.klipy.com/ii/.../hd.gif", "w": 498, "h": 498,
 *                            "previewUrl": "https://static.klipy.com/ii/.../sm.webp", "previewW": 220, "previewH": 220,
 *                            "stillUrl": "https://static.klipy.com/ii/.../sm.jpg" } }
 *
 * `parseGifContent` only accepts https URLs on `GIF_IMAGE_HOSTS` (static.klipy.com, static1/2) or same-origin
 * `/gif-fixtures/<id>.gif|.png` (the mock), integer dimensions 1..2000. Anything else -> null and the row renders
 * as the plain text it is (forged fields cannot load arbitrary images).
 */
import { GIF_IMAGE_HOSTS, GIF_MAX_DIMENSION } from './config.ts';
import type { GifMessage, GifProviderName, GifResult } from './types.ts';

/** Custom content key carrying the structured GIF (namespaced per spec custom-field rules). */
export const GIF_CONTENT_KEY = 'dev.matrixpoc.gif' as const;

const PROVIDERS: readonly GifProviderName[] = ['klipy', 'mock'];

export interface GifMessageContent {
  msgtype: 'm.text';
  body: string;
  [GIF_CONTENT_KEY]: GifMessage;
}

/** `m.text` content for a picked GIF, exactly the acceptance shape. The caller adds the thread relation. */
export function buildGifContent(gif: GifResult): GifMessageContent {
  const title = gif.title.trim() || 'GIF';
  const field: GifMessage = {
    provider: gif.provider,
    id: String(gif.id),
    title,
    url: gif.fullUrl,
    w: gif.fullW,
    h: gif.fullH,
    previewUrl: gif.previewUrl,
    previewW: gif.previewW,
    previewH: gif.previewH,
  };
  if (gif.stillUrl) field.stillUrl = gif.stillUrl;
  return { msgtype: 'm.text', body: `${title} ${gif.fullUrl}`, [GIF_CONTENT_KEY]: field };
}

export interface GifUrlOptions {
  /** App origin for the same-origin mock rule; defaults to `location.origin` (undefined in Node -> mock URLs rejected). */
  origin?: string;
}

function appOrigin(opts?: GifUrlOptions): string | undefined {
  if (opts?.origin) return opts.origin;
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin;
}

/** True for an absolute URL this client is willing to render: https on a Klipy media host, or same-origin fixtures. */
export function isAllowedGifUrl(url: unknown, opts?: GifUrlOptions): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:' && GIF_IMAGE_HOSTS.includes(u.hostname)) return true;
  const origin = appOrigin(opts);
  if (origin && u.origin === origin && (u.protocol === 'http:' || u.protocol === 'https:')) {
    return /\/gif-fixtures\/[A-Za-z0-9._-]+\.(?:gif|png)$/.test(u.pathname);
  }
  return false;
}

const dim = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= GIF_MAX_DIMENSION ? v : undefined;

/**
 * Validate the `dev.matrixpoc.gif` field of a message content. Returns null when absent or invalid (not an object,
 * bad host, missing/zero/oversized `w`/`h`). Preview / still fields are dropped (not fatal) when they do not validate.
 */
export function parseGifContent(content: unknown, opts?: GifUrlOptions): GifMessage | null {
  if (!content || typeof content !== 'object') return null;
  const raw = (content as Record<string, unknown>)[GIF_CONTENT_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const w = dim(f.w);
  const h = dim(f.h);
  if (!isAllowedGifUrl(f.url, opts) || w === undefined || h === undefined) return null;
  const provider = PROVIDERS.includes(f.provider as GifProviderName) ? (f.provider as GifProviderName) : 'klipy';
  const id = typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id) : '';
  const title = typeof f.title === 'string' && f.title.trim() ? f.title.trim().slice(0, 200) : 'GIF';
  const out: GifMessage = { provider, id, title, url: f.url, w, h };
  const pw = dim(f.previewW);
  const ph = dim(f.previewH);
  if (isAllowedGifUrl(f.previewUrl, opts) && pw !== undefined && ph !== undefined) {
    out.previewUrl = f.previewUrl;
    out.previewW = pw;
    out.previewH = ph;
  }
  if (isAllowedGifUrl(f.stillUrl, opts)) out.stillUrl = f.stillUrl;
  return out;
}
