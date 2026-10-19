/**
 * Catalogue of the mock provider's fixtures (Phase 4) = the contract in docs/archive/PHASE4_ACCEPTANCE.md "Mock provider
 * fixture contract". Single source of truth for ids, titles and dimensions: `scripts/make-gif-fixtures.mjs`
 * renders exactly these into `public/gif-fixtures/<id>.gif` (animated GIF89a, 2-3 frames, <= 3 KB) and
 * `<id>.png` (first frame still); `mock.ts` serves them. QA and Dev A code against this table.
 *
 * Titles are chosen for the demo queries (BUG-8 ruling): `tacos` / `taco` -> [mock-1, mock-2, mock-3], `party` -> [mock-3, mock-4],
 * `cat` -> [mock-5, mock-6], `thumbs` -> [mock-7], `facepalm` -> [mock-8], `nope` -> [mock-6], `dance` -> [mock-1].
 *
 * Pure data; importable from Node scripts (no env, no DOM).
 */

export interface MockFixture {
  /** 1-based; the digit drawn on the frames. */
  index: number;
  /** `mock-<index>`; also the file name. */
  id: string;
  title: string;
  width: number;
  height: number;
  /** Frame count (2..3). */
  frames: number;
  /** Frame delay in hundredths of a second. */
  delayCs: number;
}

export const MOCK_FIXTURES: readonly MockFixture[] = [
  { index: 1, id: 'mock-1', title: 'Tacos dance', width: 240, height: 180, frames: 2, delayCs: 30 },
  { index: 2, id: 'mock-2', title: 'Tacos Tuesday', width: 200, height: 200, frames: 2, delayCs: 35 },
  { index: 3, id: 'mock-3', title: 'Tacos party', width: 240, height: 180, frames: 2, delayCs: 30 },
  { index: 4, id: 'mock-4', title: 'Party popper', width: 160, height: 160, frames: 3, delayCs: 20 },
  { index: 5, id: 'mock-5', title: 'Cat typing', width: 240, height: 180, frames: 2, delayCs: 35 },
  { index: 6, id: 'mock-6', title: 'Cat nope', width: 200, height: 150, frames: 3, delayCs: 30 },
  { index: 7, id: 'mock-7', title: 'Thumbs up', width: 240, height: 180, frames: 2, delayCs: 40 },
  { index: 8, id: 'mock-8', title: 'Facepalm', width: 240, height: 180, frames: 2, delayCs: 45 },
];

/** URL path (under the app origin / Vite base) where the fixtures are served from. */
export const MOCK_FIXTURE_PATH = 'gif-fixtures/';

/** Search queries that make the mock return no results (QA: empty state). */
export const MOCK_EMPTY_QUERIES: readonly string[] = ['nothing-here', '__empty__'];
/** Search query that makes the mock reject with `GifProviderError('network', 'mock: simulated failure')` (QA: error state). */
export const MOCK_ERROR_QUERY = '__error__';
