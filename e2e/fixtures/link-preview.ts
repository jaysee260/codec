/**
 * QA-30: link preview helpers (Phase 6, docs/PHASE6_ACCEPTANCE.md AC-L1..L10).
 *
 * - `fixtureUrl(page, name)`: `http://localhost:<the page's own Vite port>/preview-fixtures/<name>`. The test Synapse
 *   whitelists 127.0.0.1/::1 for url previews (homeserver/homeserver.yaml), and each pool worker has its own Vite, so
 *   the port must be the page's own (a worker's Synapse can reach every Vite, but only its own one is guaranteed up).
 * - `previewRequests(page)`: every request whose URL contains `/preview_url`, recorded from `page.on('request')`
 *   (install BEFORE `goto` for the "zero requests since the page loaded" criteria).
 * - `stubPreview(page, handler)`: `page.route(/preview_url/)` for the error / slow / non-mxc / embed cases; the
 *   handler decides per requested URL (`'continue'` passes the request to the real Synapse).
 * - `noThirdParty(page)`: AC-L10-2 guard; any request to youtube / ytimg / googlevideo / spotify is aborted and
 *   recorded as a violation unless `allow()` was called first (the play click).
 * - `clearHidden(page)`: wipes the per-viewer hidden store and the in-memory preview cache through the dev hook.
 */
import { expect, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { workerOrigin } from './pool.ts';
import { HS_URL } from './seed.ts';

/** `localStorage` key of the hidden-preview store (src/lib/preview/hidden.ts). */
export const HIDDEN_PREVIEWS_STORAGE_KEY = 'matrix-poc.hiddenPreviews';

/** The fixture pages the Principal ships in public/preview-fixtures/. */
export type FixturePage = 'article.html' | 'square.html' | 'long.html' | 'title-only.html' | 'empty.html' | 'noimage.html' | 'nodims.html';

/** What the real Synapse answers for each fixture page (asserted literally; mirrors the acceptance table). */
export const FIXTURES = {
  article: { site: 'The Codec Gazette', title: 'Link previews land in Phase 6', layout: 'large' },
  square: { site: 'Ringo', title: 'Ringo - the tiny tool with the round logo', layout: 'thumbnail' },
  // Synapse measures the downloaded og:image itself, so pages without declared dimensions still come back with
  // og:image:width 1200 -> `large`. "No dimensions -> thumbnail" can only be produced by a preview_url stub.
  long: { site: 'Clamp Test Weekly', titleStart: 'Very long title and description fixture', layout: 'large' },
  noimage: { site: 'Codec Fixtures', title: 'Text-only release notes', layout: 'text' },
  titleOnly: { title: 'Plain page with only a title' },
} as const;

/** Origin of the page's own Vite (falls back to this worker's base URL before the first navigation). */
export function fixtureOrigin(page?: Page): string {
  let port = '';
  try {
    if (page && /^https?:/.test(page.url())) port = new URL(page.url()).port;
  } catch {
    /* about:blank */
  }
  if (!port) port = new URL(workerOrigin()).port || '5173';
  return `http://localhost:${port}`;
}

/**
 * Absolute fixture URL. `query` makes the URL unique per test (`?t=<id>`): Synapse and the client both cache per URL,
 * so request counting needs a URL nobody asked for yet. The URL is in the normalised form `extractPreviewUrls`
 * returns (WHATWG `URL.toString()`), so it can be compared with `data-url` verbatim.
 */
export function fixtureUrl(page: Page | undefined, name: FixturePage | string, query?: string): string {
  const u = new URL(`${fixtureOrigin(page)}/preview-fixtures/${name}`);
  if (query) u.search = query.startsWith('?') ? query : `?${query}`;
  return u.toString();
}

/** A short unique token for `fixtureUrl(..., query)` and message bodies. */
export function uniq(label = 'lp'): string {
  return `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------------------------------------------ request listener */

export interface PreviewRequest {
  /** The full request URL. */
  raw: string;
  /** The `url` query parameter (the previewed page). */
  url: string;
  ts: string | null;
  method: string;
  request: Request;
}

export interface PreviewRequests {
  all(): PreviewRequest[];
  /** Requested page URLs, in order. */
  urls(): string[];
  count(): number;
  /** How many requests asked for `pageUrl` (exact match on the `url` parameter). */
  countFor(pageUrl: string): number;
  /** Stop recording. */
  dispose(): void;
}

function parsePreviewRequest(r: Request): PreviewRequest {
  let url = '';
  let ts: string | null = null;
  try {
    const u = new URL(r.url());
    url = u.searchParams.get('url') ?? '';
    ts = u.searchParams.get('ts');
  } catch {
    /* keep '' */
  }
  return { raw: r.url(), url, ts, method: r.method(), request: r };
}

export const isPreviewRequestUrl = (u: string): boolean => u.includes('/preview_url');

/** Records every `/preview_url` request this page (and its frames) makes from now on. */
export function previewRequests(page: Page): PreviewRequests {
  const seen: PreviewRequest[] = [];
  const onRequest = (r: Request): void => {
    if (isPreviewRequestUrl(r.url())) seen.push(parsePreviewRequest(r));
  };
  page.on('request', onRequest);
  return {
    all: () => [...seen],
    urls: () => seen.map((s) => s.url),
    count: () => seen.length,
    countFor: (pageUrl) => seen.filter((s) => s.url === pageUrl).length,
    dispose: () => page.off('request', onRequest),
  };
}

/* ------------------------------------------------------------------ stubs */

export type StubAnswer =
  | 'continue'
  | 'abort'
  | { status: number; body?: unknown; delayMs?: number; gate?: Promise<void> }
  | { continueAfter: Promise<void> | number };

/** `og:*` body with an mxc image, for embed and layout stubs. */
export function ogBody(fields: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Routes `/preview_url` through `handler(pageUrl)`. Register AFTER the catch-alls you want it to override
 * (Playwright tries routes in reverse registration order). Returns the list of page URLs the stub answered.
 */
export async function stubPreview(page: Page, handler: (pageUrl: string, route: Route) => StubAnswer | Promise<StubAnswer>): Promise<{ answered: string[] }> {
  const answered: string[] = [];
  await page.route(/\/preview_url/, async (route) => {
    const pageUrl = parsePreviewRequest(route.request()).url;
    const answer = await handler(pageUrl, route);
    answered.push(pageUrl);
    if (answer === 'continue') return route.continue();
    if (answer === 'abort') return route.abort('failed');
    if ('continueAfter' in answer) {
      if (typeof answer.continueAfter === 'number') await sleep(answer.continueAfter);
      else await answer.continueAfter;
      return route.continue().catch(() => undefined);
    }
    if (answer.delayMs) await sleep(answer.delayMs);
    if (answer.gate) await answer.gate;
    const body = answer.body === undefined ? (answer.status >= 400 ? { errcode: 'M_UNKNOWN', error: 'stubbed' } : {}) : answer.body;
    return route
      .fulfill({ status: answer.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
      .catch(() => undefined);
  });
  return { answered };
}

/** Node-side sleep (not `page.waitForTimeout`): only used to delay a stubbed response. */
export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** A promise plus its resolver, for holding a routed response until the test has measured something. */
export function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/* ------------------------------------------------------------------ guards */

export interface ThirdPartyGuard {
  /** Requests to a third-party embed host made before `allow()`. Must stay empty. */
  violations(): string[];
  /** Every third-party request seen (before and after `allow()`). */
  all(): string[];
  /** The play click happened: later requests are expected (still aborted, never leave the machine). */
  allow(): void;
}

const THIRD_PARTY_RE = /^https?:\/\/([^/]*\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|googlevideo\.com|spotify\.com|spotifycdn\.com|scdn\.co)(:\d+)?\//i;

/** AC-L10-2: aborts every request to YouTube / Spotify hosts and records it. Install before `goto`. */
export async function noThirdParty(page: Page): Promise<ThirdPartyGuard> {
  const seen: string[] = [];
  const violations: string[] = [];
  let allowed = false;
  const record = (u: string): void => {
    seen.push(u);
    if (!allowed) violations.push(u);
  };
  await page.context().route(THIRD_PARTY_RE, (route) => {
    record(route.request().url());
    return route.abort('blockedbyclient');
  });
  return {
    violations: () => [...violations],
    all: () => [...seen],
    allow: () => {
      allowed = true;
    },
  };
}

/** Uncaught page errors plus console errors that are not the browser's generic "Failed to load resource" line. */
export function collectErrors(page: Page): { errors(): string[] } {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Chrome logs every 4xx/5xx fetch as "Failed to load resource" (no URL); stubbed error statuses cause those.
    if (/Failed to load resource/i.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return { errors: () => [...errors] };
}

/* ------------------------------------------------------------------ dev hook */

/** Calls `window.__matrixPoc.preview.<name>(...args)` (the `previews` alias is accepted too). */
export async function previewHook<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([n, a]) => {
      const w = (window as any).__matrixPoc;
      const mod = w?.preview ?? w?.previews;
      if (!mod) throw new Error('window.__matrixPoc.preview is missing (dev hook, src/app/devtools.ts)');
      const fn = mod[n as string] ?? (n === 'clearLinkPreviewCache' ? mod.clearPreviewCache : undefined);
      if (typeof fn !== 'function') throw new Error(`__matrixPoc.preview.${n} is not a function`);
      return fn(...(a as unknown[]));
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** Forget hidden previews and the in-memory preview cache (dev hook). */
export async function clearHidden(page: Page): Promise<void> {
  await previewHook(page, 'clearHiddenPreviews');
  await previewHook(page, 'clearLinkPreviewCache');
}

/** Name used by docs/PHASE6_ACCEPTANCE.md / the PM. */
export const resetPreviews = clearHidden;

export async function hiddenStore(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
    } catch {
      return [];
    }
  }, HIDDEN_PREVIEWS_STORAGE_KEY);
}

/* ------------------------------------------------------------------ locators */

/** The `link-previews` host of a row (or any scope). */
export const previewsHost = (scope: Locator): Locator => scope.getByTestId('link-previews');
/** Every `link-preview` in a row, in DOM order. */
export const cards = (scope: Locator): Locator => scope.getByTestId('link-preview');
/** The `link-preview` for one URL inside a row. */
export const cardFor = (scope: Locator, url: string): Locator => scope.locator(`[data-testid="link-preview"][data-url="${cssEscape(url)}"]`);

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** `data-url` of every card in the scope, in DOM order. */
export async function cardUrls(scope: Locator): Promise<string[]> {
  return cards(scope).evaluateAll((els) => els.map((el) => el.getAttribute('data-url') ?? ''));
}

/** Waits for a card to be `ready` and returns it. */
export async function expectReady(scope: Locator, url: string, timeout = 10_000): Promise<Locator> {
  const card = cardFor(scope, url);
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout });
  return card;
}

/** Waits until the card's `<img>` has decoded (`naturalWidth > 0`). */
export async function expectImageLoaded(card: Locator, timeout = 10_000): Promise<void> {
  const img = card.getByTestId('link-preview-image');
  await expect
    .poll(() => img.evaluate((el) => (el instanceof HTMLImageElement ? el.complete && el.naturalWidth : (el.querySelector('img')?.naturalWidth ?? 0))), {
      timeout,
      message: 'link-preview-image decodes (naturalWidth > 0)',
    })
    .toBeGreaterThan(0);
}

/** The `<img>` element of a `link-preview-image` (the testid may sit on the img or on its box). */
export function imageEl(card: Locator): Locator {
  const tagged = card.getByTestId('link-preview-image');
  return tagged.locator('xpath=self::img | .//img').first();
}

/* ------------------------------------------------------------------ server side */

/** `GET /_matrix/client/v1/media/preview_url` as `token` (AC-L9-1; also learns the mxc Synapse stored). */
export async function serverPreview(token: string, pageUrl: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${HS_URL}/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(pageUrl)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** The media id of an `mxc://server/id` URI. */
export function mediaIdOf(mxc: string): string {
  return mxc.replace(/^mxc:\/\/[^/]+\//, '');
}

/** True when `src` is a homeserver media URL (never the fixture origin). */
export function isHomeserverMediaUrl(src: string): boolean {
  try {
    const u = new URL(src, HS_URL);
    return u.origin === new URL(HS_URL).origin && /\/_matrix\/(media\/v3|client\/v1\/media)\/(thumbnail|download)\//.test(u.pathname);
  } catch {
    return false;
  }
}
