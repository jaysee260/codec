#!/usr/bin/env node
/**
 * Verify the Phase 4 GIF core without a browser (Principal; `npm run verify:gif`):
 *
 *   1. mock provider: trending order, search contract (tacos / TACO / party / cat / nothing-here / __error__), page 2;
 *   2. fixtures on disk: 8 x GIF89a with >= 2 image descriptors, <= 3 KB, matching dimensions, PNG stills;
 *   3. the wire shape: `buildGifContent` -> `parseGifContent` round trip, host allow list rejects forged fields;
 *   4. Klipy mapping against the documented response shape (no network);
 *   5. live: alice posts ONE mock GIF to #dev:localhost through the same builder the client uses, fetches it back
 *      and asserts msgtype / body / `dev.matrixpoc.gif` (w, h, previewW/H, stillUrl) / no top-level url or info;
 *   6. with VITE_GIF_API_KEY (or GIF_API_KEY) set: one real Klipy search (`hello`, 8 per page) and the first three
 *      results; skipped cleanly when unset.
 *
 * Environment: HS_URL (http://localhost:8008), PASSWORD (password123), APP_ORIGIN (http://localhost:5173),
 * VITE_GIF_API_KEY / GIF_API_KEY (optional), VITE_GIF_API_BASE (optional).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEvent, loadGifLib, login, logout, resolveRoom, sendContent } from './lib/gif-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'public', 'gif-fixtures');
const ORIGIN = (process.env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
const KEY = (process.env.VITE_GIF_API_KEY ?? process.env.GIF_API_KEY ?? '').trim();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const ids = (page) => page.results.map((g) => g.id).join(',');

const lib = await loadGifLib();

// ------------------------------------------------------------------ 1. mock provider
const mock = lib.createMockProvider({ baseUrl: ORIGIN });
const trending = await mock.trending({ page: 1, limit: 24 });
console.log('mock trending:');
for (const g of trending.results) console.log(`  ${g.id.padEnd(7)} ${g.title.padEnd(14)} ${g.fullW}x${g.fullH}  ${g.fullUrl}`);
check('mock trending = mock-1..8 in order, hasNext false', ids(trending) === lib.MOCK_FIXTURES.map((f) => f.id).join(',') && trending.hasNext === false && trending.nextPage === null);
check('mock results have own-origin urls + png stills', trending.results.every((g) => g.fullUrl === `${ORIGIN}/gif-fixtures/${g.id}.gif` && g.stillUrl === `${ORIGIN}/gif-fixtures/${g.id}.png` && g.provider === 'mock'));
const search = async (q) => mock.search(q, { page: 1, limit: 24 });
console.log(`mock search "tacos": ${ids(await search('tacos'))}`);
check("search 'tacos' -> mock-1,mock-2,mock-3 (BUG-8)", ids(await search('tacos')) === 'mock-1,mock-2,mock-3');
check("search 'TACO' -> mock-1,mock-2,mock-3", ids(await search('TACO')) === 'mock-1,mock-2,mock-3');
check("search 'dance' -> mock-1", ids(await search('dance')) === 'mock-1');
check("search 'party' -> mock-3,mock-4", ids(await search('party')) === 'mock-3,mock-4');
check("search 'cat' -> mock-5,mock-6", ids(await search('cat')) === 'mock-5,mock-6');
check("search 'nothing-here' / '__empty__' -> []", ids(await search('nothing-here')) === '' && ids(await search('__empty__')) === '');
check("search '' -> all 8", (await search('')).results.length === 8);
check('page 2 -> []', (await mock.trending({ page: 2 })).results.length === 0);
const err = await search('__error__').then(() => null, (e) => e);
check("search '__error__' rejects with GifProviderError('network', 'mock: simulated failure')", err?.name === 'GifProviderError' && err.kind === 'network' && err.message === 'mock: simulated failure');
const t0 = performance.now();
await search('party');
check('mock resolves within 50 ms', performance.now() - t0 < 50, `${(performance.now() - t0).toFixed(1)} ms`);

// ------------------------------------------------------------------ 2. fixtures on disk
function imageDescriptors(buf) {
  // Walk the block structure (not a naive 0x2C scan): header + LSD + GCT, then extensions / images until the trailer.
  const gctSize = buf[10] & 0x80 ? 3 * (1 << ((buf[10] & 7) + 1)) : 0;
  let p = 13 + gctSize;
  let frames = 0;
  const skipSubBlocks = () => {
    while (buf[p] !== 0) p += buf[p] + 1;
    p++;
  };
  while (p < buf.length) {
    const t = buf[p++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      p++;
      skipSubBlocks();
    } else if (t === 0x2c) {
      p += 9;
      const packed = buf[p - 1];
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
      p++; // LZW min code size
      skipSubBlocks();
      frames++;
    } else return -1;
  }
  return frames;
}
let fixturesOk = true;
const files = readdirSync(FIXTURE_DIR);
for (const f of lib.MOCK_FIXTURES) {
  const gifPath = path.join(FIXTURE_DIR, `${f.id}.gif`);
  const pngPath = path.join(FIXTURE_DIR, `${f.id}.png`);
  const gif = readFileSync(gifPath);
  const png = readFileSync(pngPath);
  const w = gif.readUInt16LE(6);
  const h = gif.readUInt16LE(8);
  const frames = imageDescriptors(gif);
  const pngW = png.readUInt32BE(16);
  const pngH = png.readUInt32BE(20);
  const ok = gif.subarray(0, 6).toString('latin1') === 'GIF89a' && w === f.width && h === f.height && frames >= 2 && statSync(gifPath).size <= 3 * 1024 && png.subarray(1, 4).toString('latin1') === 'PNG' && pngW === f.width && pngH === f.height;
  if (!ok) console.log(`  ${f.id}: GIF89a=${gif.subarray(0, 6).toString('latin1')} ${w}x${h} frames=${frames} ${gif.length} B; png ${pngW}x${pngH}`);
  fixturesOk &&= ok;
}
check('8 fixtures: GIF89a, >= 2 image descriptors, catalogue dimensions, <= 3 KB, PNG still of the same size', fixturesOk);
check('no stray files in public/gif-fixtures', files.length === lib.MOCK_FIXTURES.length * 2, files.join(' '));

// ------------------------------------------------------------------ 3. wire shape
const picked = trending.results[0];
const content = lib.buildGifContent(picked);
const field = content['dev.matrixpoc.gif'];
check('buildGifContent: m.text, body "<title> <url>", no format', content.msgtype === 'm.text' && content.body === `Tacos dance ${picked.fullUrl}` && !('format' in content) && !('url' in content) && !('info' in content));
check('buildGifContent: field = { provider, id, title, url, w, h, previewUrl, previewW, previewH, stillUrl }', JSON.stringify(Object.keys(field)) === JSON.stringify(['provider', 'id', 'title', 'url', 'w', 'h', 'previewUrl', 'previewW', 'previewH', 'stillUrl']) && field.w === 240 && field.h === 180 && field.previewW === 240 && field.previewH === 180 && field.stillUrl.endsWith('/mock-1.png'));
const parsed = lib.parseGifContent(content, { origin: ORIGIN });
check('parseGifContent round-trips (origin given)', parsed && parsed.id === 'mock-1' && parsed.url === picked.fullUrl && parsed.w === 240 && parsed.h === 180 && parsed.stillUrl === picked.stillUrl);
const forged = (patch) => lib.parseGifContent({ msgtype: 'm.text', body: 'x', 'dev.matrixpoc.gif': { ...field, ...patch } }, { origin: ORIGIN });
check('rejects evil host / w=0 / string field / http klipy / other-origin fixtures', forged({ url: 'https://evil.example/x.gif' }) === null && forged({ w: 0 }) === null && lib.parseGifContent({ 'dev.matrixpoc.gif': 'x' }) === null && forged({ url: 'http://static.klipy.com/x.gif' }) === null && forged({ url: 'http://evil.example/gif-fixtures/mock-1.gif' }) === null);
check('accepts https static.klipy.com / static1 / static2', forged({ url: 'https://static.klipy.com/ii/a/b/c.gif' }) !== null && forged({ url: 'https://static2.klipy.com/x.gif' }) !== null);
check('bad stillUrl is dropped, not fatal', forged({ stillUrl: 'https://evil.example/x.jpg' })?.stillUrl === undefined);

// ------------------------------------------------------------------ 4. Klipy mapping (documented example shape)
const item = {
  id: 8041071659142944,
  slug: 'hello-hi-662',
  title: 'Hello',
  type: 'gif',
  file: {
    hd: { gif: { url: 'https://static.klipy.com/ii/x/hd.gif', width: 498, height: 498, size: 4001918 } },
    md: { gif: { url: 'https://static.klipy.com/ii/x/md.gif', width: 498, height: 498, size: 3721260 } },
    sm: {
      gif: { url: 'https://static.klipy.com/ii/x/sm.gif', width: 220, height: 220, size: 314884 },
      webp: { url: 'https://static.klipy.com/ii/x/sm.webp', width: 220, height: 220, size: 80118 },
      jpg: { url: 'https://static.klipy.com/ii/x/sm.jpg', width: 220, height: 220, size: 8560 },
      mp4: { url: 'https://static.klipy.com/ii/x/sm.mp4', width: 320, height: 320, size: 49565 },
    },
  },
};
const mapped = lib.mapKlipyItem(item);
check('mapKlipyItem: id = slug (BUG-9), hd.gif url + dims, sm.webp preview, sm.jpg still', mapped.id === 'hello-hi-662' && lib.mapKlipyItem({ ...item, slug: undefined }).id === '8041071659142944' && mapped.fullUrl.endsWith('/hd.gif') && mapped.fullW === 498 && mapped.previewUrl.endsWith('/sm.webp') && mapped.previewMimetype === 'image/webp' && mapped.previewW === 220 && mapped.stillUrl.endsWith('/sm.jpg') && mapped.fullSize === 4001918);
const url = lib.klipyRequestUrl({ apiKey: 'e2e-fake-key' }, 'search', 'tacos', { page: 1, limit: 24 });
check('klipy search url = /api/v1/{key}/gifs/search?q=tacos&page=1&per_page=24&content_filter=medium', url === 'https://api.klipy.com/api/v1/e2e-fake-key/gifs/search?q=tacos&page=1&per_page=24&content_filter=medium');
check('klipy trending url (+ customer_id when given)', lib.klipyRequestUrl({ apiKey: 'k' }, 'trending', undefined, {}) === 'https://api.klipy.com/api/v1/k/gifs/trending?page=1&per_page=24&content_filter=medium' && lib.klipyRequestUrl({ apiKey: 'k', customerId: 'u-1' }, 'trending', undefined, {}).endsWith('&customer_id=u-1'));
const stubbed = lib.createKlipyProvider({
  apiKey: 'e2e-fake-key',
  fetch: async () => new Response(JSON.stringify({ result: true, data: { data: [item], current_page: 1, per_page: 24, has_next: false } }), { status: 200 }),
});
const sp = await stubbed.search('hello');
check('stubbed klipy page: 1 result, hasNext false, nextPage null', sp.results.length === 1 && sp.hasNext === false && sp.nextPage === null);
const badKey = lib.createKlipyProvider({ apiKey: 'bad', fetch: async () => new Response(JSON.stringify({ result: false, errors: { message: ['The provided API key is invalid.'] } }), { status: 404 }) });
const authErr = await badKey.trending().then(() => null, (e) => e);
check("invalid key (404 + errors.message) -> GifProviderError kind 'auth'", authErr?.kind === 'auth' && authErr.status === 404);
let calls = 0;
const limited = lib.createKlipyProvider({ apiKey: 'k', fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '0' } }); } });
const rlErr = await limited.trending().then(() => null, (e) => e);
check("429 twice -> one retry, then GifProviderError kind 'rate-limit' status 429", calls === 2 && rlErr?.kind === 'rate-limit' && rlErr.status === 429);

// ------------------------------------------------------------------ 5. live round trip (alice -> #dev)
const alice = await login('alice', 'verify-gif');
try {
  const roomId = await resolveRoom(alice, '#dev:localhost');
  const eventId = await sendContent(alice, roomId, content);
  const ev = await fetchEvent(alice, roomId, eventId);
  console.log(`sent ${eventId} to ${roomId} (#dev)`);
  const c = ev.content;
  const f = c['dev.matrixpoc.gif'];
  check('event: m.room.message / m.text', ev.type === 'm.room.message' && c.msgtype === 'm.text');
  check('event: body contains the url and no top-level url/info/format', c.body === `Tacos dance ${picked.fullUrl}` && c.url === undefined && c.info === undefined && c.format === undefined);
  check('event: field provider mock, id mock-1, w 240, h 180, previewW/H 240/180, stillUrl png', f?.provider === 'mock' && f.id === 'mock-1' && f.w === 240 && f.h === 180 && f.previewW === 240 && f.previewH === 180 && f.stillUrl === picked.stillUrl);
  const back = lib.parseGifContent(c, { origin: ORIGIN });
  check('event parses back through parseGifContent', back?.id === 'mock-1' && back.url === picked.fullUrl);
} finally {
  await logout(alice);
}

// ------------------------------------------------------------------ 6. real Klipy (optional)
if (KEY) {
  const klipy = lib.createKlipyProvider({ apiKey: KEY, baseUrl: process.env.VITE_GIF_API_BASE });
  try {
    const page = await klipy.search('hello', { limit: 8 });
    console.log(`klipy search "hello": ${page.results.length} results, hasNext=${page.hasNext}`);
    for (const g of page.results.slice(0, 3)) console.log(`  ${g.id} ${JSON.stringify(g.title)} ${g.fullW}x${g.fullH} ${g.fullUrl} (preview ${g.previewMimetype} ${g.previewW}x${g.previewH})`);
    check('real Klipy search returns results on static*.klipy.com', page.results.length > 0 && page.results.every((g) => /^https:\/\/static\d?\.klipy\.com\//.test(g.fullUrl)));
  } catch (e) {
    check('real Klipy search', false, `${e.name}: ${e.message}`);
  }
} else {
  console.log('SKIP  real Klipy search (set VITE_GIF_API_KEY to run it)');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
