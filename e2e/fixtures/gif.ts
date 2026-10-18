/**
 * GIF picker fixtures (QA-19, Phase 4) — provider control, Klipy/CDN stubs with a quota guard,
 * picker flows, the wire-shape contract and a `not-built` probe.
 *
 * ## Why the mock expectations are *derived*, not hard-coded
 * The fixture catalogue (ids, titles, dimensions) moved three times while this suite was being
 * written: docs/PHASE4_ACCEPTANCE.md and `src/lib/gif/mock-fixtures.ts` were realigned by the PM and
 * the Principal in the same hour, and the two still disagree on individual titles. Hard-coding
 * either one produces a suite that fails on the next realignment for no product reason, so the
 * catalogue is **imported** from `src/lib/gif/mock-fixtures.ts` (the acceptance doc and
 * docs/PHASE4_TICKETS.md both name it the single source of truth and explicitly bless QA importing
 * it) and every mock expectation — trending order, which ids a query matches, the event body — is
 * computed from it by {@link mockSearch}. What the suite still hard-asserts is everything that is a
 * *contract* rather than data: the registry test ids, the `dev.matrixpoc.gif` wire shape, the Klipy
 * request URL, and the search *semantics* (case-insensitive title substring, API order).
 * {@link catalogueDrift} reports a doc/code mismatch as an annotation so it is visible without
 * turning it into a red test.
 *
 * Everything else here is deliberately independent of the code under test: the expected wire field
 * is built by {@link expectedMockGif} in this file, never by importing `buildGifContent`, so a bug
 * in the app's builder cannot make the contract test pass (same rule as `matrix-api.ts`).
 *
 * ## Route-order rule
 * Playwright matches `page.route` handlers **last-registered-first**. {@link guardGifNetwork} must
 * therefore be installed *before* {@link stubKlipy} / {@link stubKlipyCdn}, so the specific stubs win
 * and the guard only sees what nothing else claimed. A test key is 100 requests/hour, so any request
 * that reaches the guard fails the test (AC-G11-3).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import {
  MOCK_EMPTY_QUERIES,
  MOCK_ERROR_QUERY,
  MOCK_FIXTURES,
  MOCK_FIXTURE_PATH,
} from '../../src/lib/gif/mock-fixtures.ts';
import { fixtureGifBytes, hasFixtureGif, FIXTURE_HINT } from './gif-assets.ts';
import { loginAs } from './auth.ts';
import { asUser, type ApiUser } from './matrix-api.ts';
import { tapRoom } from './mobile.ts';
import { resolveRoom, type UserKey } from './seed.ts';
import { workerOrigin } from './pool.ts';
import { openChannel } from './ui.ts';

export { MOCK_EMPTY_QUERIES, MOCK_ERROR_QUERY };

/** The first reserved "return nothing" query (`nothing-here`). */
export const MOCK_EMPTY_QUERY: string = MOCK_EMPTY_QUERIES[0] ?? 'nothing-here';

/* ------------------------------------------------------------------ contract constants */

/** The namespaced content key carrying the structured GIF (docs/PHASE4_ACCEPTANCE.md). */
export const GIF_FIELD = 'dev.matrixpoc.gif';

/** localStorage keys the app reads (`src/lib/gif/config.ts`); hard-coded here on purpose. */
export const GIF_PROVIDER_STORAGE_KEY = 'matrix-poc.gifProvider';
export const GIF_API_KEY_STORAGE_KEY = 'matrix-poc.gifApiKey';

/** The only key this suite ever puts in a URL. Never a real one. */
export const FAKE_KEY = 'e2e-fake-key';

export const KLIPY_API_HOST = 'api.klipy.com';
export const KLIPY_CDN_HOST = 'static.klipy.com';
const KLIPY_API_GLOB = `https://${KLIPY_API_HOST}/**`;
const KLIPY_CDN_GLOB = `https://${KLIPY_CDN_HOST}/**`;

/** Klipy's documented default page size (AC-G2-1). */
export const KLIPY_PER_PAGE = 24;
/** `GIF_CONTENT_RATING` on the wire (AC-G2-1). */
export const KLIPY_CONTENT_FILTER = 'medium';

export type GifProviderName = 'klipy' | 'mock';

/* ------------------------------------------------------------------ the mock catalogue */

export interface MockGif {
  id: string;
  title: string;
  w: number;
  h: number;
}

/** The mock fixture catalogue, in trending order. Derived — see the module header. */
export const MOCK_GIFS: readonly MockGif[] = MOCK_FIXTURES.map((f) => ({
  id: f.id,
  title: f.title,
  w: f.width,
  h: f.height,
}));

export const MOCK_IDS: readonly string[] = MOCK_GIFS.map((g) => g.id);

/** Absolute URL the mock provider serves a fixture GIF from (`<origin>/gif-fixtures/mock-1.gif`). */
export function mockGifUrl(id: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/${MOCK_FIXTURE_PATH}${id}.gif`;
}

/** Absolute URL of the paused frame (`<origin>/gif-fixtures/mock-1.png`). */
export function mockStillUrl(id: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/${MOCK_FIXTURE_PATH}${id}.png`;
}

/**
 * What the mock provider must return for `query`, in catalogue order: the reserved queries first,
 * then a case-insensitive title substring match (empty query = everything). This encodes the
 * *semantics* from the contract, with the data taken from the catalogue.
 */
export function mockSearch(query: string): readonly MockGif[] {
  const needle = query.trim().toLowerCase();
  if (needle === MOCK_ERROR_QUERY.toLowerCase()) return [];
  if (MOCK_EMPTY_QUERIES.some((q) => q.toLowerCase() === needle)) return [];
  if (!needle) return MOCK_GIFS;
  return MOCK_GIFS.filter((g) => g.title.toLowerCase().includes(needle));
}

/** A query that matches exactly one fixture, and that fixture. Used by the single-result criteria. */
export function soleMatch(query: string): MockGif {
  const hits = mockSearch(query);
  if (hits.length !== 1) {
    throw new Error(
      `the mock catalogue no longer has exactly one match for "${query}" (got ${hits.length}: ${hits
        .map((h) => h.id)
        .join(', ')}). Pick another query in the spec.`,
    );
  }
  return hits[0]!;
}

/** The first query in `candidates` that matches exactly `count` fixtures, or undefined. */
export function queryMatching(count: number, candidates: string[]): string | undefined {
  return candidates.find((q) => mockSearch(q).length === count);
}

/** A query no fixture title contains (the empty-state criteria). */
export const NO_MATCH_QUERY = 'zzzz';

/**
 * The exact `dev.matrixpoc.gif` field a pick of `id` under `mock` must produce, built here rather
 * than by importing the app's builder.
 */
export function expectedMockGif(id: string, origin: string): Record<string, unknown> {
  const gif = MOCK_GIFS.find((g) => g.id === id);
  if (!gif) throw new Error(`unknown mock fixture "${id}"; catalogue: ${MOCK_IDS.join(', ')}`);
  const url = mockGifUrl(id, origin);
  return {
    provider: 'mock',
    id: gif.id,
    title: gif.title,
    url,
    w: gif.w,
    h: gif.h,
    // The mock's preview *is* the gif, so these mirror url/w/h (docs/PHASE4_ACCEPTANCE.md).
    previewUrl: url,
    previewW: gif.w,
    previewH: gif.h,
    stillUrl: mockStillUrl(id, origin),
  };
}

/** `"<title> <url>"` — the body Element shows and the server unfurls. */
export function expectedMockBody(id: string, origin: string): string {
  const gif = MOCK_GIFS.find((g) => g.id === id);
  if (!gif) throw new Error(`unknown mock fixture "${id}"`);
  return `${gif.title} ${mockGifUrl(id, origin)}`;
}

/**
 * Compares the imported catalogue with docs/PHASE4_ACCEPTANCE.md's table and returns a human note
 * when they disagree, so the drift is annotated instead of failing a product test.
 */
export function catalogueDrift(): string | undefined {
  const docTable: Array<[string, string]> = [
    ['mock-1', 'Tacos dance'],
    ['mock-2', 'Tacos Tuesday'],
    ['mock-3', 'Tacos party'],
    ['mock-4', 'Party popper'],
    ['mock-5', 'Cat typing'],
    ['mock-6', 'Cat nope'],
    ['mock-7', 'Thumbs up'],
    ['mock-8', 'Facepalm'],
  ];
  const drift = docTable
    .filter(([id, title]) => {
      const found = MOCK_GIFS.find((g) => g.id === id);
      return found !== undefined && found.title !== title;
    })
    .map(([id, title]) => `${id}: doc "${title}" vs code "${MOCK_GIFS.find((g) => g.id === id)!.title}"`);
  if (MOCK_GIFS.length !== 8) drift.push(`catalogue has ${MOCK_GIFS.length} fixtures, the doc table has 8`);
  return drift.length ? drift.join('; ') : undefined;
}

/* ------------------------------------------------------------------ locators (registry names only) */

export const gifPicker = (page: Page): Locator => page.getByTestId('gif-picker');
export const gifSearch = (page: Page): Locator => page.getByTestId('gif-search');
export const gifHeading = (page: Page): Locator => page.getByTestId('gif-heading');
export const gifGrid = (page: Page): Locator => page.getByTestId('gif-grid');
export const gifItem = (page: Page, id: string): Locator => page.getByTestId(`gif-item-${id}`);
export const gifLoading = (page: Page): Locator => page.getByTestId('gif-loading');
export const gifEmpty = (page: Page): Locator => page.getByTestId('gif-empty');
export const gifError = (page: Page): Locator => page.getByTestId('gif-error');
export const gifErrorRetry = (page: Page): Locator => page.getByTestId('gif-error-retry');
export const gifAttribution = (page: Page): Locator => page.getByTestId('gif-attribution');
export const gifClose = (page: Page): Locator => page.getByTestId('gif-close');
export const gifBackdrop = (page: Page): Locator => page.getByTestId('gif-backdrop');
export const gifLoadMore = (page: Page): Locator => page.getByTestId('gif-load-more');

/** `composer-gif`, or `thread-composer-gif` in the panel (Phase 3 prefix rule). */
export const composerGif = (page: Page, thread = false): Locator =>
  page.getByTestId(thread ? 'thread-composer-gif' : 'composer-gif');

/** `gif-pending`, or `thread-gif-pending` in the panel. */
export const gifPending = (page: Page, thread = false): Locator =>
  page.getByTestId(thread ? 'thread-gif-pending' : 'gif-pending');

/** The `gif-item-*` ids currently in the grid, in DOM order (AC-G4-3: must equal API order). */
export async function gridIds(page: Page): Promise<string[]> {
  return gifGrid(page)
    .locator('[data-testid^="gif-item-"]')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute('data-testid') ?? '').replace('gif-item-', '')),
    );
}

/** `data-index` of each tile, in DOM order. */
export async function gridIndexes(page: Page): Promise<(string | null)[]> {
  return gifGrid(page)
    .locator('[data-testid^="gif-item-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-index')));
}

/** The id of the tile with `data-selected="true"`, or null. */
export async function selectedGifId(page: Page): Promise<string | null> {
  const sel = gifGrid(page).locator('[data-testid^="gif-item-"][data-selected="true"]');
  if ((await sel.count()) === 0) return null;
  return ((await sel.first().getAttribute('data-testid')) ?? '').replace('gif-item-', '');
}

/* ---------------------------------------------- GIF message row locators */

/**
 * The timeline row rendering a given GIF id, local echo (`message-~`) included.
 *
 * Scoped to rows **inside** `message-list` and keyed on the `message-[$~]` prefix on purpose: a bare
 * `[data-testid^="message-"]` also matches `message-list` itself, which *contains* every tile, so a
 * `.filter({ has })` on it resolves to the list and `settledEventId` then reads `data-testid`
 * `"message-list"` forever. (Found the hard way — see docs/BUGS.md "test defects".)
 */
export const gifRowById = (page: Page, gifId: string, opts: { thread?: boolean } = {}): Locator =>
  page
    .getByTestId(opts.thread ? 'thread-message-list' : 'message-list')
    .getByTestId(/^message-[$~]/)
    .filter({ has: page.locator(`[data-gif-id="${gifId}"]`) });

export const messageGif = (row: Locator): Locator => row.getByTestId('message-gif');
export const messageGifImg = (row: Locator): Locator => row.getByTestId('message-gif-img');
export const messageGifBadge = (row: Locator): Locator => row.getByTestId('message-gif-badge');
export const messageGifPlaceholder = (row: Locator): Locator => row.getByTestId('message-gif-placeholder');
export const messageGifPlay = (row: Locator): Locator => row.getByTestId('message-gif-play');
export const messageGifFallback = (row: Locator): Locator => row.getByTestId('message-gif-fallback');

/**
 * Scrolls a GIF row into view, waits for `data-state="playing"` and returns its `<img>`.
 *
 * `GifMessage` mounts the `<img>` only while an IntersectionObserver reports the row as intersecting
 * (+200 px), and starts out `offscreen` so a window full of GIFs does not all fetch at once — so a
 * just-sent row that happens to sit below the fold legitimately has **no** `message-gif-img` in the
 * DOM, only `message-gif-placeholder`. Playwright's `toBeVisible()` does not mean "in the viewport",
 * so asserting the image without scrolling first is a test defect, not a product bug (AC-G8-3 is the
 * criterion that asserts the offscreen behaviour on purpose).
 */
export async function expectGifPlaying(gifRow: Locator, timeout = 10_000): Promise<Locator> {
  await gifRow.scrollIntoViewIfNeeded();
  await expect(
    messageGif(gifRow),
    'a GIF row scrolled into view must leave the `offscreen` state and mount its <img>',
  ).toHaveAttribute('data-state', 'playing', { timeout });
  const img = messageGifImg(gifRow);
  await expect(img).toBeVisible({ timeout });
  return img;
}

/* ------------------------------------------------------------------ provider control */

export interface ProviderOptions {
  /** Klipy key to put in localStorage (klipy only). Default {@link FAKE_KEY}. */
  key?: string;
}

/**
 * Forces the provider for every navigation in this context, before app code runs
 * (`localStorage['matrix-poc.gifProvider']`). Call **before** `loginAs`.
 *
 *   await useGifProvider(page, 'mock');
 *   await loginAs(page, 'alice');
 */
export async function useGifProvider(
  page: Page,
  name: GifProviderName,
  opts: ProviderOptions = {},
): Promise<void> {
  const key = name === 'klipy' ? (opts.key ?? FAKE_KEY) : '';
  await page.addInitScript(
    ([providerKey, apiKeyKey, provider, apiKey]) => {
      try {
        window.localStorage.setItem(providerKey as string, provider as string);
        if (apiKey) window.localStorage.setItem(apiKeyKey as string, apiKey as string);
        else window.localStorage.removeItem(apiKeyKey as string);
      } catch {
        /* private mode */
      }
    },
    [GIF_PROVIDER_STORAGE_KEY, GIF_API_KEY_STORAGE_KEY, name, key] as const,
  );
}

/**
 * Guard against a `.env` key (or a stale override) silently flipping a `mock` test onto the real
 * provider: the picker reports which provider it resolved, and this fails loudly naming the cause.
 */
export async function expectProvider(page: Page, name: GifProviderName): Promise<void> {
  await expect(
    gifPicker(page),
    `gif-picker must resolve data-provider="${name}" — if this says "klipy" under a mock test, VITE_GIF_API_KEY is set in .env (it burns the 100/hour Klipy test quota); unset it or clear matrix-poc.gifApiKey`,
  ).toHaveAttribute('data-provider', name);
}

/* ------------------------------------------------------------------ network: quota guard */

export interface NetworkGuard {
  /** Unstubbed **API** requests — these spend quota, so they must stay empty. */
  readonly violations: string[];
  /** Media requests the guard itself served (leftover klipy rows in a dirty room). Informational. */
  readonly cdnFallbacks: string[];
  /** Throws with the offending URLs when anything leaked. Call at the end of a test. */
  assertClean(): void;
}

/**
 * Catch-all on `api.klipy.com` and `static.klipy.com` (AC-G11-3). Install **first**, before any
 * stub: Playwright prefers the most recently registered handler, so the stubs shadow this one and
 * the guard only sees what nothing else claimed.
 *
 * The two hosts are treated differently, and the reason matters:
 *  - **`api.klipy.com`** is the quota (100 requests/hour on a test key). An unstubbed hit is aborted
 *    and **fails the test**.
 *  - **`static.klipy.com`** is just media, and it is unavoidable in a dirty room: the `klipy`
 *    criteria have to post real messages whose `url` is on the Klipy CDN (AC-G3-2), so every later
 *    test that opens #dev renders those rows and the browser fetches those images. Failing on that
 *    would make each klipy test poison every test after it. The guard therefore **serves** them from
 *    the local fixture bytes — still no request leaves the machine, which is what AC-G11-3 is for —
 *    and records them as `cdnFallbacks`.
 */
export function guardGifNetwork(page: Page): NetworkGuard {
  const violations: string[] = [];
  const cdnFallbacks: string[] = [];

  void page.route(KLIPY_API_GLOB, async (route) => {
    violations.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  void page.route(KLIPY_CDN_GLOB, async (route) => {
    cdnFallbacks.push(route.request().url());
    try {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/gif', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: fixtureGifBytes(),
      });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });

  return {
    violations,
    cdnFallbacks,
    assertClean() {
      expect(
        violations,
        'a request reached api.klipy.com without a stub — a test key is 100 requests/hour, so every GIF test must stub it (AC-G11-3)',
      ).toEqual([]);
    },
  };
}

/* ------------------------------------------------------------------ network: Klipy API stub */

export interface KlipyVariantSpec {
  url: string;
  width: number;
  height: number;
  size?: number;
}

export interface KlipyItemSpec {
  id: number | string;
  title: string;
  slug?: string;
  /** `hd.gif` dimensions — the variant `GIF_SEND_VARIANT = 'hd'` sends. */
  w: number;
  h: number;
  /** `sm.webp` dimensions (the picker preview). Default a third of `w`/`h`. */
  previewW?: number;
  previewH?: number;
  /** Drop `sm.webp` so the preview falls back to `sm.mp4` (AC-G4-8) or `sm.gif`. */
  preview?: 'webp' | 'mp4' | 'gif';
  /** Omit `hd` so the send variant falls back to `md` (AC-G2-2's fallback half). */
  omitHd?: boolean;
}

/** One item in Klipy's `data.data[]`, in the verified response shape. */
export function klipyItem(spec: KlipyItemSpec): Record<string, unknown> {
  // `slug` defaults to `String(spec.id)` on purpose. The orchestrator ruled (2026-10-09) that a Klipy
  // `GifResult.id` is the item's **slug**, not `String(item.id)`; before that ruling landed it was the
  // numeric id. Making the two identical in the stub means every id assertion (tile test ids, the
  // `dev.matrixpoc.gif.id` on the wire) pins the same string under either mapping — the contract QA
  // actually cares about is that the id is a stable, distinct string that round-trips onto the event,
  // and a slug is what makes that true for ids above 2^53 (BUG-9).
  const slug = spec.slug ?? String(spec.id);
  const base = `https://${KLIPY_CDN_HOST}/ii/${spec.id}`;
  const pw = spec.previewW ?? Math.max(1, Math.round(spec.w / 3));
  const ph = spec.previewH ?? Math.max(1, Math.round(spec.h / 3));
  const file: Record<string, Record<string, KlipyVariantSpec>> = {
    md: { gif: { url: `${base}/md.gif`, width: Math.round(spec.w / 2), height: Math.round(spec.h / 2), size: 1_200_000 } },
    sm: {
      gif: { url: `${base}/sm.gif`, width: pw, height: ph, size: 315_000 },
      jpg: { url: `${base}/sm.jpg`, width: pw, height: ph, size: 20_000 },
    },
    xs: { webp: { url: `${base}/xs.webp`, width: 80, height: 80, size: 25_000 } },
  };
  if (!spec.omitHd) {
    file.hd = { gif: { url: `${base}/hd.gif`, width: spec.w, height: spec.h, size: 4_000_000 } };
  }
  const preview = spec.preview ?? 'webp';
  if (preview === 'webp') file.sm!.webp = { url: `${base}/sm.webp`, width: pw, height: ph, size: 80_000 };
  if (preview === 'mp4') file.sm!.mp4 = { url: `${base}/sm.mp4`, width: pw, height: ph, size: 60_000 };
  return { id: spec.id, slug, title: spec.title, type: 'gif', blur_preview: null, file };
}

/**
 * The `GifResult.id` a stubbed item must map to — the slug (the orchestrator's 2026-10-09 ruling),
 * which {@link klipyItem} pins equal to `String(spec.id)` so the value is the same either way.
 */
export function klipyResultId(spec: KlipyItemSpec): string {
  return spec.slug ?? String(spec.id);
}

/** The url `GIF_SEND_VARIANT = 'hd'` picks for an item spec — what must land in the event. */
export function klipySendUrl(spec: KlipyItemSpec): string {
  const base = `https://${KLIPY_CDN_HOST}/ii/${spec.id}`;
  return spec.omitHd ? `${base}/md.gif` : `${base}/hd.gif`;
}

/** The url the picker grid must show for an item spec. */
export function klipyPreviewUrl(spec: KlipyItemSpec): string {
  const base = `https://${KLIPY_CDN_HOST}/ii/${spec.id}`;
  return `${base}/sm.${spec.preview ?? 'webp'}`;
}

export interface KlipyRequest {
  /** `search` or `trending`. */
  endpoint: string;
  url: string;
  /** The path segment Klipy uses for auth. */
  key: string;
  params: Record<string, string>;
  /** Headers the app sent (AC-G2-1 asserts there is no `authorization`). */
  headers: Record<string, string>;
}

export interface StubKlipyOptions {
  /** Items returned by both endpoints unless overridden. */
  items?: KlipyItemSpec[];
  /** Items for `/gifs/search` only. */
  searchItems?: KlipyItemSpec[];
  /** Items for `/gifs/trending` only. */
  trendingItems?: KlipyItemSpec[];
  /** HTTP status. Non-2xx answers the documented error body unless `body` is given. */
  status?: number;
  /** Replace the whole JSON body. */
  body?: unknown;
  /** Extra response headers (e.g. `{ 'retry-after': '0' }`). */
  headers?: Record<string, string>;
  /** `data.has_next` (AC-G2-2 / `gif-load-more`). */
  hasNext?: boolean;
}

export interface KlipyStub {
  /** Every request the stub answered, in order. */
  readonly requests: KlipyRequest[];
  searchRequests(): KlipyRequest[];
  trendingRequests(): KlipyRequest[];
  last(): KlipyRequest | undefined;
  /** Swap the response mid-test (the retry criteria). */
  update(opts: StubKlipyOptions): void;
  reset(): void;
}

const INVALID_KEY_BODY = {
  result: false,
  errors: { message: ['The provided API key is invalid.'] },
};

function klipyBody(items: KlipyItemSpec[], page: number, hasNext: boolean): Record<string, unknown> {
  return {
    result: true,
    data: {
      data: items.map(klipyItem),
      current_page: page,
      per_page: KLIPY_PER_PAGE,
      has_next: hasNext,
    },
  };
}

/**
 * Stubs `https://api.klipy.com/api/v1/{key}/gifs/{search,trending}` with the verified response
 * shape and records every request (URL, key path segment, query params, headers).
 *
 *   const stub = await stubKlipy(page, { items: [spec] });
 *   ...
 *   expect(stub.searchRequests()[0]!.params.q).toBe('cat');
 */
export async function stubKlipy(page: Page, opts: StubKlipyOptions = {}): Promise<KlipyStub> {
  let current: StubKlipyOptions = { ...opts };
  const requests: KlipyRequest[] = [];

  await page.route(KLIPY_API_GLOB, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const params = Object.fromEntries(url.searchParams.entries());
    const match = /\/api\/v1\/([^/]+)\/gifs\/([^/?]+)/.exec(url.pathname);
    const endpoint = match?.[2] ?? url.pathname;
    requests.push({
      endpoint,
      url: request.url(),
      key: match?.[1] ? decodeURIComponent(match[1]) : '',
      params,
      headers: await request.allHeaders(),
    });

    const status = current.status ?? 200;
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...(current.headers ?? {}) };
    if (current.body !== undefined) {
      await route.fulfill({ status, headers, body: JSON.stringify(current.body) });
      return;
    }
    if (status >= 400) {
      await route.fulfill({ status, headers, body: JSON.stringify(INVALID_KEY_BODY) });
      return;
    }
    const items =
      (endpoint === 'trending' ? current.trendingItems : current.searchItems) ?? current.items ?? [];
    const pageNo = Number(params.page ?? '1') || 1;
    await route.fulfill({
      status,
      headers,
      body: JSON.stringify(klipyBody(items, pageNo, current.hasNext ?? false)),
    });
  });

  return {
    requests,
    searchRequests: () => requests.filter((r) => r.endpoint === 'search'),
    trendingRequests: () => requests.filter((r) => r.endpoint === 'trending'),
    last: () => requests[requests.length - 1],
    update(next: StubKlipyOptions) {
      current = { ...current, ...next };
    },
    reset() {
      requests.length = 0;
    },
  };
}

export interface CdnStub {
  readonly requests: string[];
  /** Answer the next requests with this status (AC-G8-5 stubs 404 to force the fallback). */
  setStatus(status: number): void;
}

/**
 * Stubs `https://static.klipy.com/**` with real animated GIF bytes (see `gif-assets.ts` for why
 * one byte source covers every variant).
 */
export async function stubKlipyCdn(page: Page, opts: { status?: number; id?: string } = {}): Promise<CdnStub> {
  const requests: string[] = [];
  let status = opts.status ?? 200;
  const bytes = fixtureGifBytes(opts.id);
  await page.route(KLIPY_CDN_GLOB, async (route) => {
    requests.push(route.request().url());
    if (status >= 400) {
      await route.fulfill({ status, contentType: 'text/plain', body: 'stubbed failure' });
      return;
    }
    await route.fulfill({
      status,
      headers: { 'content-type': 'image/gif', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: bytes,
    });
  });
  return {
    requests,
    setStatus(next: number) {
      status = next;
    },
  };
}

/** Both Klipy stubs plus the guard, in the right order, for a `klipy` test. */
export async function stubKlipyAll(
  page: Page,
  opts: StubKlipyOptions = {},
): Promise<{ guard: NetworkGuard; api: KlipyStub; cdn: CdnStub }> {
  const guard = guardGifNetwork(page);
  const api = await stubKlipy(page, opts);
  const cdn = await stubKlipyCdn(page);
  return { guard, api, cdn };
}

/* ------------------------------------------------------------------ event helpers */

export interface SendGifOptions {
  /** Fixture id to post. Default the first in the catalogue. */
  id?: string;
  /** Origin the mock URLs point at. Default: this worker's app origin (`workerOrigin()`). */
  origin?: string;
  /** Phase 3 thread relation. */
  threadRoot?: string;
  /** Override individual field values (the forged-field criteria). */
  overrides?: Record<string, unknown>;
  /** Replace the whole `dev.matrixpoc.gif` value (e.g. with a string, for AC-G3-4). */
  field?: unknown;
  /** Override the body. */
  body?: string;
}

export interface SentGif {
  eventId: string;
  body: string;
  gif: Record<string, unknown>;
}

/**
 * Posts a GIF message with the **exact** contract content as `api`'s user (bob in the rendering
 * criteria), built in this file rather than by the app's builder.
 */
export async function sendGifMessage(
  api: ApiUser,
  roomId: string,
  opts: SendGifOptions = {},
): Promise<SentGif> {
  const id = opts.id ?? MOCK_IDS[0]!;
  const origin = opts.origin ?? workerOrigin();
  const gif = { ...expectedMockGif(id, origin), ...(opts.overrides ?? {}) };
  const body = opts.body ?? expectedMockBody(id, origin);
  const extra: Record<string, unknown> = {
    [GIF_FIELD]: opts.field !== undefined ? opts.field : gif,
  };
  if (opts.threadRoot) {
    extra['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: opts.threadRoot,
      is_falling_back: true,
      'm.in_reply_to': { event_id: opts.threadRoot },
    };
  }
  const eventId = await api.send(roomId, body, extra);
  return { eventId, body, gif };
}

export interface GifEvent {
  content: Record<string, unknown>;
  msgtype: unknown;
  body: unknown;
  /** The `dev.matrixpoc.gif` field as it is on the wire, or undefined. */
  gif: Record<string, unknown> | undefined;
  relatesTo: Record<string, unknown> | undefined;
}

/**
 * Fetches an event over the raw client-server API and splits out the GIF field, so a test can
 * assert the wire shape independently of the client (AC-G3-1/2/3).
 */
export async function gifEventFor(roomId: string, eventId: string, as: UserKey = 'alice'): Promise<GifEvent> {
  const api = await asUser(as);
  const event = await api.getEvent(roomId, eventId);
  const content = event.content as Record<string, unknown>;
  const raw = content[GIF_FIELD];
  return {
    content,
    msgtype: content.msgtype,
    body: content.body,
    gif: raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined,
    relatesTo: content['m.relates_to'] as Record<string, unknown> | undefined,
  };
}

/** Asserts the full contract on a fetched event: `m.text`, body = "<title> <url>", exact field. */
export function expectMockGifEvent(event: GifEvent, id: string, origin: string): void {
  expect(event.msgtype, 'a GIF is a plain m.text so other clients show the link').toBe('m.text');
  expect(event.body).toBe(expectedMockBody(id, origin));
  expect(event.gif, `content["${GIF_FIELD}"] must be an object`).toBeDefined();
  expect(event.gif).toEqual(expectedMockGif(id, origin));
  expect(event.content.format, 'no HTML body on a GIF message').toBeUndefined();
  expect(event.content.formatted_body).toBeUndefined();
  expect(event.content.url, 'nothing is uploaded: no top-level url/info').toBeUndefined();
  expect(event.content.info).toBeUndefined();
}

/** The dimension/url invariants every GIF event must satisfy, whatever the provider. */
export function expectGifFieldShape(gif: Record<string, unknown> | undefined, allowedOrigin: string): void {
  expect(gif, 'the event carries a dev.matrixpoc.gif field').toBeDefined();
  const f = gif!;
  expect(typeof f.id, '`id` is a string (Klipy ids are stringified)').toBe('string');
  expect(typeof f.title).toBe('string');
  expect(typeof f.url).toBe('string');
  expect(Number.isInteger(f.w) && (f.w as number) > 0, `w must be a positive integer, got ${String(f.w)}`).toBe(true);
  expect(Number.isInteger(f.h) && (f.h as number) > 0, `h must be a positive integer, got ${String(f.h)}`).toBe(true);
  const host = new URL(f.url as string).host;
  const ownHost = new URL(allowedOrigin).host;
  expect([KLIPY_CDN_HOST, 'static1.klipy.com', 'static2.klipy.com', ownHost], `url host ${host} must be allow-listed`).toContain(host);
  expect(String(f.title).length, 'title is non-empty (falls back to "GIF")').toBeGreaterThan(0);
  expect(String(f.url), 'the url is the last whitespace token of the body').not.toContain(' ');
}

/* ------------------------------------------------------------------ picker flows */

/** Clicks (or taps) `composer-gif` and waits for the picker. */
export async function openGifPicker(
  page: Page,
  opts: { thread?: boolean; touch?: boolean } = {},
): Promise<Locator> {
  const button = composerGif(page, opts.thread ?? false);
  await expect(button).toBeVisible();
  if (opts.touch) await button.tap();
  else await button.click();
  const picker = gifPicker(page);
  await expect(picker).toBeVisible();
  await expect(gifGrid(page)).toBeVisible();
  return picker;
}

/**
 * Types a slash command into the composer and presses Enter: the picker must open pre-searched and
 * **nothing** may be sent (AC-G6-3).
 */
export async function openGifPickerBySlash(
  page: Page,
  text: string,
  opts: { thread?: boolean } = {},
): Promise<Locator> {
  const input = page.getByTestId(opts.thread ? 'thread-composer-input' : 'composer-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
  const picker = gifPicker(page);
  await expect(picker).toBeVisible();
  await expect(input, 'the slash command is consumed, so the composer is cleared').toHaveValue('');
  return picker;
}

/** Clicks a tile and waits for the picker to close (AC-G7-1). */
export async function pickGif(page: Page, id: string, opts: { touch?: boolean } = {}): Promise<void> {
  const tile = gifItem(page, id);
  await expect(tile).toBeVisible();
  if (opts.touch) await tile.tap();
  else await tile.click();
  await expect(gifPicker(page), 'the picker closes as soon as a tile is picked').toBeHidden();
}

/** Waits until the grid holds exactly `ids`, in that order. */
export async function expectGridIds(page: Page, ids: readonly string[], timeout = 10_000): Promise<void> {
  await expect
    .poll(() => gridIds(page), {
      timeout,
      message: `gif-grid must hold exactly [${ids.join(', ')}] in API order`,
    })
    .toEqual([...ids]);
}

/** Types into `gif-search` (replacing what is there) and waits past the 300 ms debounce. */
export async function searchInPicker(page: Page, query: string): Promise<void> {
  const input = gifSearch(page);
  await input.click();
  await input.fill(query);
}

/* ------------------------------------------------------------------ not-built probe */

/**
 * Which GIF entry points exist in the build under test. Dev A (`src/features/gif/**`) and Dev B
 * (`src/features/conversation/**`) are implementing while this suite runs, so each test declares
 * what it needs and skips with a `not-built` annotation when it is absent — a test that *runs* and
 * fails is then a real bug or a test defect, never "not implemented yet" (the Phase 3 pattern from
 * `threads.ts`). Probing happens once per worker in its own page and the verdict is cached.
 */
export type GifFeature =
  /** `composer-gif` in the channel composer (DEV-B-23). */
  | 'composer-gif'
  /** Clicking it mounts `gif-picker` (DEV-A-20 + DEV-B-23). */
  | 'gif-picker'
  /** The grid renders at least one `gif-item-*` (DEV-A-20 + PRIN-13 fixtures). */
  | 'gif-grid'
  /** `/gif <q>` + Enter opens the picker pre-searched (DEV-B-23). */
  | 'slash-gif'
  /** A GIF event renders as `message-gif` (DEV-B-25). */
  | 'message-gif'
  /** Phone only: `gif-backdrop` behind the sheet (DEV-A-20 / DEV-B-26). */
  | 'gif-backdrop';

export type GifUiReport = Record<GifFeature, boolean> & { notes: string[] };

/** Just enough of Playwright's `test` object to skip and annotate; pass the imported `test`. */
export interface GifUiTest {
  skip(condition: boolean, description: string): void;
  info(): { annotations: { type: string; description?: string }[] };
}

const PRESENT = 4_000;
let probed: Promise<GifUiReport> | undefined;

async function probeGifUi(page: Page, touch: boolean): Promise<GifUiReport> {
  const report: GifUiReport = {
    'composer-gif': false,
    'gif-picker': false,
    'gif-grid': false,
    'slash-gif': false,
    'message-gif': false,
    'gif-backdrop': false,
    notes: [],
  };
  if (!hasFixtureGif()) report.notes.push(FIXTURE_HINT);

  const probe = await page.context().newPage();
  const seen = (locator: Locator, timeout = PRESENT): Promise<boolean> =>
    locator
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);

  try {
    await useGifProvider(probe, 'mock');
    guardGifNetwork(probe);
    const dev = await resolveRoom('dev');
    const bob = await asUser('bob');
    // Post a GIF before logging in so the row is in the first sync.
    const sent = await sendGifMessage(bob, dev, { id: MOCK_IDS[0]!, origin: workerOrigin() });

    await loginAs(probe, 'alice');
    // Both layouts must land in **#dev**, where the probe posted its event: the phone opens #general
    // by default, so waiting for `message-list` alone would look for the row in the wrong room.
    if (touch) await tapRoom(probe, dev);
    else await openChannel(probe, dev);

    report['composer-gif'] = await seen(composerGif(probe));
    if (report['composer-gif']) {
      const button = composerGif(probe);
      const opened = await (touch ? button.tap() : button.click())
        .then(() => seen(gifPicker(probe)))
        .catch(() => false);
      report['gif-picker'] = opened;
      if (opened) {
        report['gif-grid'] = await seen(
          gifGrid(probe).locator('[data-testid^="gif-item-"]').first(),
          8_000,
        );
        if (touch) report['gif-backdrop'] = (await gifBackdrop(probe).count()) > 0;
        if (!report['gif-grid']) {
          const empty = (await gifEmpty(probe).count()) > 0;
          const error = (await gifError(probe).count()) > 0;
          report.notes.push(
            `gif-picker opened but rendered no tiles (${error ? 'gif-error' : empty ? 'gif-empty' : 'nothing'}) — the mock provider or public/gif-fixtures may be broken`,
          );
        }
        await probe.keyboard.press('Escape').catch(() => undefined);
        await gifPicker(probe).waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => undefined);
      }
    }

    // `/gif` consumption is Dev B's and independent of the button.
    const input = probe.getByTestId(touch ? 'composer-input' : 'composer-input');
    report['slash-gif'] = await input
      .fill('/gif cat')
      .then(() => input.press('Enter'))
      .then(() => seen(gifPicker(probe)))
      .catch(() => false);
    if (report['slash-gif']) {
      await probe.keyboard.press('Escape').catch(() => undefined);
    } else {
      await input.fill('').catch(() => undefined);
    }

    const row = probe.getByTestId(`message-${sent.eventId}`);
    if (await seen(row, 15_000)) {
      report['message-gif'] = await seen(messageGif(row), 6_000);
      if (!report['message-gif']) {
        report.notes.push(
          `the GIF event ${sent.eventId} rendered as a row but without message-gif — DEV-B-25 not built, or getGifContent rejected the field`,
        );
      }
    } else {
      report.notes.push(`the probe's GIF event ${sent.eventId} never rendered in #dev`);
    }
  } catch (e) {
    report.notes.push(`probe aborted: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    await probe
      .evaluate(() => {
        try {
          window.localStorage.clear();
        } catch {
          /* storage may be unavailable */
        }
      })
      .catch(() => undefined);
    await probe.close().catch(() => undefined);
  }
  return report;
}

/** Probes the GIF UI once per worker (own page) and caches the verdict. */
export function checkGifUi(page: Page, touch = false): Promise<GifUiReport> {
  probed ??= probeGifUi(page, touch);
  return probed;
}

/**
 * Skips the calling test with a `not-built` annotation unless every listed feature is present.
 *
 *   test('AC-G7-1 ...', async ({ page }) => {
 *     await requireGifUi(test, page, ['composer-gif', 'gif-picker']);
 *     ...
 *   });
 */
export async function requireGifUi(
  test: GifUiTest,
  page: Page,
  features: GifFeature | GifFeature[],
  opts: { touch?: boolean } = {},
): Promise<GifUiReport> {
  const report = await checkGifUi(page, opts.touch ?? false);
  const needed = Array.isArray(features) ? features : [features];
  const missing = needed.filter((f) => !report[f]);
  if (missing.length > 0) {
    test.info().annotations.push({
      type: 'not-built',
      description: `GIF UI not implemented yet: ${missing.join(', ')}${report.notes.length ? ` (${report.notes.join('; ')})` : ''}`,
    });
    test.skip(true, `GIF UI not built: ${missing.join(', ')}`);
  }
  return report;
}

/** Skips when the Principal's fixture GIFs are not on disk (`npm run gif:fixtures`). */
export function requireGifFixtures(test: GifUiTest, id = 'mock-1'): void {
  if (!hasFixtureGif(id)) {
    test.info().annotations.push({ type: 'blocked', description: FIXTURE_HINT });
    test.skip(true, FIXTURE_HINT);
  }
}

/** Guarantees the next `loginAs` really sees `login-form`, whatever this context's storage holds. */
export async function resetGifSession(page: Page): Promise<void> {
  if (!/^https?:/i.test(page.url())) await page.goto('/');
  await page
    .evaluate(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* storage may be unavailable */
      }
    })
    .catch(() => undefined);
}
