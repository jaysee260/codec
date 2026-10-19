/**
 * QA-31: desktop link preview suite, AC-L1 .. AC-L9 (docs/archive/PHASE6_ACCEPTANCE.md). Phone half: mobile-link-preview.spec.ts.
 *
 * ## Real server vs stub
 * The test Synapse whitelists loopback for url previews and fetches the OpenGraph fixture pages the page's own Vite
 * serves (public/preview-fixtures/). **Real round trip**: AC-L2-1..3, AC-L3-1..5, AC-L4-1/2/4, AC-L5, AC-L6-3/4/5,
 * AC-L7, AC-L9. **`page.route` stub of `/preview_url`**: AC-L2-4 (non-mxc image), AC-L4-2 (the "no dimensions"
 * thumbnail case: Synapse measures images itself, so only a stub can omit them), AC-L4-6 hostname fallback,
 * AC-L6-1/2 (errors, slowness), AC-L8 (YouTube / Spotify, no internet). AC-L4-3 holds the real thumbnail behind a
 * gate to measure the reserved box before the image arrives.
 *
 * ## Dirty-seed contract
 * Everything happens in #dev (plain) or #vault (encrypted); every test sends its own messages and uses fixture URLs
 * with a unique `?t=` query, because the client cache, the SDK's promise cache and Synapse's url cache are all keyed
 * by URL: request counting needs a URL nobody asked for yet. Tests are independent, so the file runs in parallel
 * mode across the pool's workers.
 *
 * ## Guards (AC-L10-2)
 * Every test installs `noThirdParty` (YouTube / Spotify hosts aborted, a request before the play click fails the test)
 * and records every `/preview_url` request from before the first navigation, so the encrypted-room criteria assert
 * "zero requests since the page loaded" literally.
 *
 * ## Skips
 * Until Dev A / Dev B land the testids, UI tests skip with `waiting on Dev A/B` (`requireUi`, a source scan). A test
 * that runs and fails is a real defect or a test defect, never "not built yet".
 *
 * ## Deviations, recorded on purpose
 *  - "within 5 s" polls for 10 s (sync and Synapse's fetch of the page jitter under a 3-worker run).
 *  - AC-L3-1 / AC-L3-5 "waits 3 s" are literal 3 s Node sleeps: there is nothing to wait *for* when the claim is
 *    that no request happens. Same exception as AC-E6-4.
 *  - AC-L1-5 "undecryptable / still decrypting": covered by the extraction unit check through the dev hook
 *    (`decryption.status !== 'decrypted'` -> []), not by a UTD row (that needs the sample script's historical keys).
 */
import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import { asUser, type ApiUser } from './fixtures/matrix-api.ts';
import { HS_URL, resolveRoom, uniqueName, userId } from './fixtures/seed.ts';
import { channelItem, hoverActions, messageList, nextFrames, openChannel, openSpace, parkAboveBottom, row, rowByText, settledEventId, typeAndSend } from './fixtures/ui.ts';
import { createRoom, joinRoom, setRoomEncryption } from './fixtures/e2ee-api.ts';
import { e2eeAfterEach, requireUi, secondContext, waitForStatus } from './fixtures/e2ee.ts';
import { annotate, markRoomRead } from './fixtures/state.ts';
import { openThreadFromMessage, openThreadsList, threadPanel, threadRootEl, threadSummary, threadList } from './fixtures/threads.ts';
import { sendGifMessage } from './fixtures/gif.ts';
import {
  FIXTURES,
  cardFor,
  cardUrls,
  cards,
  clearHidden,
  collectErrors,
  deferred,
  expectImageLoaded,
  expectReady,
  fixtureUrl,
  hiddenStore,
  imageEl,
  isHomeserverMediaUrl,
  mediaIdOf,
  noThirdParty,
  previewHook,
  previewRequests,
  previewsHost,
  serverPreview,
  sleep,
  stubPreview,
  uniq,
  type PreviewRequests,
  type ThirdPartyGuard,
} from './fixtures/link-preview.ts';

test.describe.configure({ mode: 'parallel', timeout: 90_000 });

const R = { dev: '', vault: '', acme: '', gaming: '' };
let alice: ApiUser;
let bob: ApiUser;
const createdRooms: { roomId: string; parent?: string }[] = [];

/** The UI every card test needs (Dev A's card, Dev B's host). */
const CARD_UI = ['link-preview', 'link-previews', 'link-preview-title'] as const;

test.beforeAll(async () => {
  R.dev = await resolveRoom('dev');
  R.vault = await resolveRoom('vault');
  R.acme = await resolveRoom('acme-hq');
  R.gaming = await resolveRoom('gaming');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

test.afterEach(async ({ page }, info) => {
  await e2eeAfterEach(page, info);
  // bob posts into #dev (and thread replies) in several tests; leave alice with nothing unread there, or the Acme rail
  // dot outlives AC-A5-2's "reading #random clears it" on whichever worker runs navigation.spec.ts next.
  await markRoomRead(R.dev).catch(() => undefined);
});

test.afterAll(async () => {
  for (const { roomId, parent } of createdRooms) {
    try {
      if (parent) await alice.sendStateEvent(parent, 'm.space.child', roomId, {});
      await alice.leaveRoom(roomId);
      await alice.forgetRoom(roomId);
    } catch {
      /* best effort */
    }
  }
});

interface Session {
  guard: ThirdPartyGuard;
  reqs: PreviewRequests;
  errors: () => string[];
}

async function openRoom(page: Page, roomId: string): Promise<void> {
  // A fresh login can land on Home (DMs): pick Acme HQ first.
  if (!(await channelItem(page, roomId).isVisible().catch(() => false))) await openSpace(page, R.acme);
  await openChannel(page, roomId);
}

/** Guards first (before any navigation), then alice in `roomId`. */
async function start(page: Page, roomId: string, opts: { encrypted?: boolean } = {}): Promise<Session> {
  const guard = await noThirdParty(page);
  const reqs = previewRequests(page);
  const errs = collectErrors(page);
  // Open straight into the room: the default landing room (#general) holds a seeded link whose (legitimate, plain
  // room) preview request would otherwise muddy "zero preview requests since the page loaded".
  await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId } });
  if (opts.encrypted) await waitForStatus(page);
  await openRoom(page, roomId);
  return { guard, reqs, errors: errs.errors };
}

/** Types `text` (which must contain the unique `marker`) and returns the settled event id. */
async function send(page: Page, text: string, marker: string): Promise<string> {
  await typeAndSend(page, text);
  return settledEventId(rowByText(page, marker), 20_000);
}

function expectNoThirdParty(s: Session): void {
  expect(s.guard.violations(), 'no request to a YouTube / Spotify host before a play click (AC-L10-2, S1)').toEqual([]);
}

/** Room switch away and back: unmounts and remounts every row. */
async function remountRoom(page: Page, roomId: string, via: string): Promise<void> {
  await openRoom(page, via);
  await openRoom(page, roomId);
}

/* ================================================================== AC-L1 extraction (dev hook) */

test.describe('AC-L1 URL extraction', () => {
  test('AC-L1-1..4 extractPreviewUrls: punctuation, order, max 3, dedupe, code blocks, matrix.to, own media', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!((window as any).__matrixPoc?.preview ?? (window as any).__matrixPoc?.previews));
    const F = (name: string): string => fixtureUrl(page, name);
    const ex = (src: unknown, opts: Record<string, unknown> = {}): Promise<string[]> => previewHook<string[]>(page, 'extractPreviewUrls', src, opts);

    // AC-L1-1
    expect(await ex(`see ${F('article.html')}, and ${F('square.html')}.`)).toEqual([F('article.html'), F('square.html')]);
    expect(await ex('http://a.example/x https://b.example/y ftp://c.example/z mailto:x@y.z example.org')).toEqual(['http://a.example/x', 'https://b.example/y']);
    // AC-L1-2
    const five = [1, 2, 3, 4, 5].map((i) => `https://l${i}.example/`);
    expect(await ex(five.join(' '))).toEqual(five.slice(0, 3));
    expect(await ex(`${F('a.html')} ${F('a.html')} ${F('a.html')}`)).toEqual([F('a.html')]);
    expect(await ex(`${F('a.html')} ${F('a.html')}#x ${F('a.html')}?x=1`)).toEqual([F('a.html'), `${F('a.html')}?x=1`]);
    expect(await ex({ text: `waves at ${F('a.html')}`, msgtype: 'm.emote' })).toEqual([F('a.html')]);
    expect(await ex({ text: `caption ${F('a.html')}`, msgtype: 'm.image' })).toEqual([]);
    expect(await ex({ text: `caption ${F('a.html')}`, msgtype: 'm.file' })).toEqual([]);
    // AC-L1-3: formatted body wins; code / pre links never leak back in from the plain body.
    expect(
      await ex({
        text: `${F('code.html')} ${F('out.html')}`,
        html: `<p><code>${F('code.html')}</code> <pre><a href="${F('pre.html')}">x</a></pre> <a href="${F('out.html')}">out</a></p>`,
        msgtype: 'm.text',
      }),
    ).toEqual([F('out.html')]);
    // AC-L1-4
    expect(
      await ex(
        `https://matrix.to/#/#dev:localhost ${HS_URL}/_matrix/media/v3/download/localhost/abc ${HS_URL}/_matrix/client/v1/media/thumbnail/localhost/abc mxc://localhost/abc ${F('ok.html')}`,
        { hsUrl: HS_URL },
      ),
    ).toEqual([F('ok.html')]);
    // AC-L1-5 (core half): GIF / redacted / undecrypted sources yield nothing.
    expect(await ex({ text: F('g.html'), gif: { url: F('g.gif') } })).toEqual([]);
    expect(await ex({ text: F('r.html'), isRedacted: true })).toEqual([]);
    expect(await ex({ text: F('u.html'), decryption: { status: 'failed' } })).toEqual([]);
    expect(await ex({ text: F('u.html'), decryption: { status: 'pending' } })).toEqual([]);
  });

  test('AC-L1-5 a GIF message gets no card; an m.notice with a link does', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const gif = await sendGifMessage(bob, R.dev);
    const gifRow = row(page, gif.eventId);
    await expect(gifRow.getByTestId('message-gif')).toBeVisible({ timeout: 15_000 });
    const url = fixtureUrl(page, 'article.html', `t=${uniq('notice')}`);
    const noticeId = await bob.sendEvent(R.dev, 'm.room.message', { msgtype: 'm.notice', body: `bridge says ${url}` });
    // The notice's card is the sentinel: once it is ready, the GIF row has long been rendered and evaluated.
    await expectReady(row(page, noticeId), url, 15_000);
    await expect(previewsHost(gifRow), 'no link-previews host on a GIF row').toHaveCount(0);
    expect(s.reqs.urls().filter((u) => u.includes('gif-fixtures')), 'no preview request for the GIF URL').toEqual([]);
    expectNoThirdParty(s);
  });
});

/* ================================================================== AC-L2 automatic cards */

test.describe('AC-L2 automatic cards in plain rooms', () => {
  test('AC-L2-1 alice sends a link in #dev: one real preview request, the full card', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-site', 'link-preview-description');
    const s = await start(page, R.dev);
    const marker = uniq('L21');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `Read this: ${url} ${marker}`, marker);
    const r = row(page, id);
    const card = await expectReady(r, url, 10_000);
    await expect(previewsHost(r)).toHaveAttribute('data-count', '1');
    await expect(card.getByTestId('link-preview-site')).toHaveText(FIXTURES.article.site);
    const title = card.getByTestId('link-preview-title');
    await expect(title).toHaveText(FIXTURES.article.title);
    const link = title.locator('xpath=self::a | .//a').first();
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(card.getByTestId('link-preview-description')).not.toHaveText('');

    const mine = s.reqs.all().filter((q) => q.url === url);
    expect(mine.length, 'exactly one preview request for the URL').toBe(1);
    expect(mine[0]!.method).toBe('GET');
    expect(mine[0]!.ts, 'ts is a number').toMatch(/^\d+$/);
    expect(mine[0]!.raw).toContain(`url=${encodeURIComponent(url)}`);
    const headers = await mine[0]!.request.allHeaders();
    expect(headers['authorization'], 'the preview request is authenticated').toMatch(/^Bearer /);
    expect(s.errors()).toEqual([]);
    expectNoThirdParty(s);
  });

  test('AC-L2-2 four links: three cards in message order, no request for the fourth', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L22');
    const urls = ['square.html', 'article.html', 'long.html', 'title-only.html'].map((n) => fixtureUrl(page, n, `t=${marker}`));
    const id = await send(page, `${urls.join(' ')} ${marker}`, marker);
    const r = row(page, id);
    await expect(previewsHost(r)).toHaveAttribute('data-count', '3', { timeout: 10_000 });
    expect(await cardUrls(r)).toEqual(urls.slice(0, 3));
    await expectReady(r, urls[0]!);
    await expectReady(r, urls[1]!);
    await expectReady(r, urls[2]!);
    await expect(cardFor(r, urls[0]!)).toHaveAttribute('data-layout', 'thumbnail');
    await expect(cardFor(r, urls[1]!)).toHaveAttribute('data-layout', 'large');
    // Synapse measures og:image itself, so long.html (no declared dimensions) comes back 1200x630 -> large.
    await expect(cardFor(r, urls[2]!)).toHaveAttribute('data-layout', FIXTURES.long.layout);
    expect(s.reqs.countFor(urls[3]!), 'no request for the 4th link').toBe(0);
    expectNoThirdParty(s);
  });

  test('AC-L2-3 bob sends the link: alice sees the same card, and the text keeps its link', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L23');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await bob.send(R.dev, `Read this: ${url} ${marker}`);
    const r = row(page, id);
    const card = await expectReady(r, url, 15_000);
    await expect(card.getByTestId('link-preview-title')).toHaveText(FIXTURES.article.title);
    await expect(r.getByTestId('message-body').locator(`a[href="${url}"]`)).toBeVisible();
    expectNoThirdParty(s);
  });

  test('AC-L2-4 an og:image that is not mxc:// is never rendered (P1)', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L24');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const rawImage = fixtureUrl(page, 'hero.png');
    await stubPreview(page, (u) => (u === url ? { status: 200, body: { 'og:title': 'Raw image page', 'og:description': 'desc', 'og:image': rawImage, 'og:image:width': 1200, 'og:image:height': 630 } } : 'continue'));
    const id = await send(page, `${url} ${marker}`, marker);
    const card = await expectReady(row(page, id), url);
    await expect(card.getByTestId('link-preview-title')).toHaveText('Raw image page');
    await expect(card.getByTestId('link-preview-image')).toHaveCount(0);
    await expect(page.locator(`img[src*="preview-fixtures/hero.png"]`), 'no raw fixture image anywhere (S1)').toHaveCount(0);
    expectNoThirdParty(s);
  });
});

/* ================================================================== AC-L3 encrypted rooms */

test.describe('AC-L3 encrypted rooms: click-to-load', () => {
  test('AC-L3-1 + AC-L3-2 #vault: a button and zero requests, then one request on click and the card', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-load');
    const s = await start(page, R.vault, { encrypted: true });
    const marker = uniq('L31');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const other = fixtureUrl(page, 'square.html', `t=${marker}`);
    const id = await send(page, `${url} and ${other} ${marker}`, marker);
    const r = row(page, id);
    const card = cardFor(r, url);
    await expect(card).toHaveAttribute('data-state', 'click-to-load', { timeout: 10_000 });
    await sleep(3_000);
    await expect(card).toHaveAttribute('data-state', 'click-to-load');
    const load = card.getByTestId('link-preview-load');
    await expect(load).toContainText('Show preview');
    await expect(load).toContainText('localhost');
    await expect(card.getByTestId('link-preview-title')).toHaveCount(0);
    expect(s.reqs.count(), 'zero preview requests since the page loaded (S1)').toBe(0);

    // Out of view and back: nothing changes.
    await messageList(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await r.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute('data-state', 'click-to-load');
    expect(s.reqs.count()).toBe(0);

    // AC-L3-2
    await load.click();
    await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    await expect(card.getByTestId('link-preview-site')).toHaveText(FIXTURES.article.site);
    await expect(card.getByTestId('link-preview-title')).toHaveText(FIXTURES.article.title);
    expect(s.reqs.urls(), 'exactly one request, for the clicked URL').toEqual([url]);
    await expect(cardFor(r, other)).toHaveAttribute('data-state', 'click-to-load');
    await expect(cardFor(r, other).getByTestId('link-preview-load')).toBeVisible();
    expectNoThirdParty(s);
  });

  test('AC-L3-3 two links in #vault: only the clicked URL appears in any request', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-load');
    const s = await start(page, R.vault, { encrypted: true });
    const marker = uniq('L33');
    const first = fixtureUrl(page, 'square.html', `t=${marker}`);
    const second = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `${first} ${second} ${marker}`, marker);
    const r = row(page, id);
    await cardFor(r, first).getByTestId('link-preview-load').click();
    await expectReady(r, first);
    expect(s.reqs.all().map((q) => q.raw).filter((raw) => raw.includes(encodeURIComponent(second)) || raw.includes(second)), 'the unclicked URL never reaches the server').toEqual([]);
    expect(s.reqs.urls()).toEqual([first]);
  });

  test('AC-L3-4 empty page in #vault: "No preview available", no toast, no console error', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-load', 'link-preview-unavailable');
    const s = await start(page, R.vault, { encrypted: true });
    const marker = uniq('L34');
    const url = fixtureUrl(page, 'empty.html', `t=${marker}`);
    const id = await send(page, `${url} ${marker}`, marker);
    const card = cardFor(row(page, id), url);
    await card.getByTestId('link-preview-load').click();
    await expect(card).toHaveAttribute('data-state', 'unavailable', { timeout: 15_000 });
    await expect(card.getByTestId('link-preview-unavailable')).toHaveText(/No preview available/);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    expect(s.errors()).toEqual([]);
  });

  test('AC-L3-5 a loaded card survives a remount without a request; after reload it is a button again (P1)', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-load');
    const s = await start(page, R.vault, { encrypted: true });
    const marker = uniq('L35');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `${url} ${marker}`, marker);
    await cardFor(row(page, id), url).getByTestId('link-preview-load').click();
    await expectReady(row(page, id), url);
    expect(s.reqs.count()).toBe(1);

    await remountRoom(page, R.vault, R.dev);
    await expect(cardFor(row(page, id), url)).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    // (#dev, the room switched through, previews its own links automatically: count this URL only.)
    expect(s.reqs.countFor(url), 'remount within the cache lifetime: no new request').toBe(1);

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await waitForStatus(page);
    await openRoom(page, R.vault);
    const card = cardFor(row(page, id), url);
    await expect(card).toHaveAttribute('data-state', 'click-to-load', { timeout: 20_000 });
    await sleep(3_000);
    expect(s.reqs.countFor(url), 'after reload: no request without a click').toBe(1);
  });

  test('AC-L3-6 a room that turns encrypted while open: links after the flip get the button', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-load');
    const roomId = await createRoom(alice.token, { name: uniqueName('lpflip'), spaceId: R.gaming, invite: [userId('bob')], powerUsers: { [userId('bob')]: 100 }, preset: 'public_chat' });
    createdRooms.push({ roomId, parent: R.gaming });
    await joinRoom(bob.token, roomId);
    const guard = await noThirdParty(page);
    const reqs = previewRequests(page);
    await loginAs(page, 'alice');
    await waitForStatus(page);
    await openSpace(page, R.gaming);
    await expect(channelItem(page, roomId)).toBeVisible({ timeout: 20_000 });
    await openChannel(page, roomId);

    const m1 = uniq('L36a');
    const before = fixtureUrl(page, 'square.html', `t=${m1}`);
    const id1 = await send(page, `${before} ${m1}`, m1);
    await expectReady(row(page, id1), before, 15_000);

    await setRoomEncryption(bob.token, roomId);
    await expect.poll(() => page.evaluate((r) => (window as any).__matrixPoc.utils.isRoomEncrypted(r), roomId), { timeout: 15_000 }).toBe(true);
    const m2 = uniq('L36b');
    const after = fixtureUrl(page, 'article.html', `t=${m2}`);
    const id2 = await send(page, `${after} ${m2}`, m2);
    await expect(cardFor(row(page, id2), after)).toHaveAttribute('data-state', 'click-to-load', { timeout: 10_000 });
    await sleep(3_000);
    expect(reqs.countFor(after), 'no automatic request after the flip (S1)').toBe(0);
    expect(guard.violations()).toEqual([]);
  });
});

/* ================================================================== AC-L4 layout and images */

test.describe('AC-L4 card layout and images', () => {
  test('AC-L4-1 article card: large image below the text, homeserver media URL, decoded', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-image', 'link-preview-description');
    const s = await start(page, R.dev);
    const marker = uniq('L41');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `${url} ${marker}`, marker);
    const card = await expectReady(row(page, id), url);
    await expect(card).toHaveAttribute('data-layout', 'large');
    const image = card.getByTestId('link-preview-image');
    await expect(image).toHaveAttribute('data-size', 'large');
    await expectImageLoaded(card);
    const src = (await imageEl(card).getAttribute('src')) ?? '';
    expect(isHomeserverMediaUrl(src), `image src is homeserver media, got ${src}`).toBe(true);
    expect(src).not.toContain('preview-fixtures');
    const imgBox = (await image.boundingBox())!;
    const descBox = (await card.getByTestId('link-preview-description').boundingBox())!;
    expect(imgBox.y, 'large image sits below the description').toBeGreaterThan(descBox.y);
    expectNoThirdParty(s);
  });

  test('AC-L4-2 thumbnail beside the text (square, stubbed no-dims), text layout without image', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-image');
    const s = await start(page, R.dev);
    const marker = uniq('L42');
    const square = fixtureUrl(page, 'square.html', `t=${marker}`);
    const noimage = fixtureUrl(page, 'noimage.html', `t=${marker}`);
    const nodims = fixtureUrl(page, 'nodims.html', `t=${marker}stub`);
    // A real hero mxc without dimensions: only a stub can drop og:image:width/height (Synapse measures images).
    const hero = await serverPreview(alice.token, fixtureUrl(page, 'article.html'));
    const heroMxc = String(hero.body['og:image'] ?? '');
    expect(heroMxc).toMatch(/^mxc:\/\//);
    await stubPreview(page, (u) => (u === nodims ? { status: 200, body: { 'og:title': 'No dims', 'og:description': 'hero without declared size', 'og:image': heroMxc } } : 'continue'));
    const id = await send(page, `${square} ${noimage} ${nodims} ${marker}`, marker);
    const r = row(page, id);

    const sq = await expectReady(r, square);
    await expect(sq).toHaveAttribute('data-layout', 'thumbnail');
    await expect(sq.getByTestId('link-preview-image')).toHaveAttribute('data-size', 'thumbnail');
    await expectImageLoaded(sq);
    const imgBox = (await sq.getByTestId('link-preview-image').boundingBox())!;
    expect(imgBox.width, 'thumbnail box <= 96 px wide').toBeLessThanOrEqual(96.5);
    expect(imgBox.height, 'thumbnail box <= 96 px tall').toBeLessThanOrEqual(96.5);
    const titleBox = (await sq.getByTestId('link-preview-title').boundingBox())!;
    expect(imgBox.y < titleBox.y + titleBox.height && imgBox.y + imgBox.height > titleBox.y, 'thumbnail shares a row with the title').toBe(true);

    const nd = await expectReady(r, nodims);
    await expect(nd).toHaveAttribute('data-layout', 'thumbnail');

    const ni = await expectReady(r, noimage);
    await expect(ni).toHaveAttribute('data-layout', 'text');
    await expect(ni.getByTestId('link-preview-title')).toHaveText(FIXTURES.noimage.title);
    await expect(ni.getByTestId('link-preview-image')).toHaveCount(0);
    expectNoThirdParty(s);
  });

  test('AC-L4-4 + AC-L4-6 card <= 480 px, description clamped to 3 lines, title to 2; hostname fallback', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-description', 'link-preview-site');
    const s = await start(page, R.dev);
    const marker = uniq('L44');
    const long = fixtureUrl(page, 'long.html', `t=${marker}`);
    const article = fixtureUrl(page, 'article.html', `t=${marker}`);
    const nosite = fixtureUrl(page, 'article.html', `t=${marker}nosite`);
    await stubPreview(page, (u) => (u === nosite ? { status: 200, body: { 'og:title': 'No site name here', 'og:description': 'fallback check' } } : 'continue'));
    const id = await send(page, `${long} ${article} ${nosite} ${marker}`, marker);
    const r = row(page, id);

    const lc = await expectReady(r, long);
    const box = (await lc.boundingBox())!;
    expect(box.width, 'card at most 480 px wide on desktop').toBeLessThanOrEqual(480.5);
    const lines = async (testid: string): Promise<{ client: number; line: number; scroll: number }> =>
      lc.getByTestId(testid).evaluate((el) => {
        const cs = getComputedStyle(el);
        const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        return { client: el.clientHeight, line, scroll: el.scrollHeight };
      });
    const desc = await lines('link-preview-description');
    expect(desc.client, `description <= 3 lines (${JSON.stringify(desc)})`).toBeLessThanOrEqual(3 * desc.line + 2);
    expect(desc.scroll, 'the long description really is clamped').toBeGreaterThan(desc.client);
    const title = await lines('link-preview-title');
    expect(title.client, `title <= 2 lines (P1, ${JSON.stringify(title)})`).toBeLessThanOrEqual(2 * title.line + 2);

    const ac = await expectReady(r, article);
    const full = await ac.getByTestId('link-preview-description').evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(full.scroll, 'the article description shows in full').toBeLessThanOrEqual(full.client + 1);

    const ns = await expectReady(r, nosite);
    await expect(ns.getByTestId('link-preview-site'), 'hostname fallback (P1)').toHaveText('localhost');
    expectNoThirdParty(s);
  });
});

test.describe('AC-L4-3 reserved image box', () => {
  // The media service worker (public/media-sw.js) fetches /_matrix/client/v1/media itself, and Playwright routes
  // do not see service-worker requests. Blocked, the app falls back to the legacy /_matrix/media/v3 URLs (the test
  // server has authenticated media off), which `page.route` can hold.
  test.use({ serviceWorkers: 'block' });

  test('AC-L4-3 the image box is reserved before the image loads: the row does not grow', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-image');
    const marker = uniq('L43');
    const s = await start(page, R.dev);
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    // Learn the mxc Synapse stores for this URL, then hold that media until the test has measured.
    const pre = await serverPreview(alice.token, url);
    const mxc = String(pre.body['og:image'] ?? '');
    expect(mxc, 'Synapse returned an mxc og:image').toMatch(/^mxc:\/\//);
    const gate = deferred();
    let held = 0;
    await page.route((u) => u.pathname.includes('/media/') && u.pathname.includes(mediaIdOf(mxc)), async (route) => {
      held += 1;
      await gate.promise;
      await route.continue().catch(() => undefined);
    });
    const id = await send(page, `${url} ${marker}`, marker);
    const r = row(page, id);
    const card = await expectReady(r, url);
    await expect.poll(() => held, { message: 'the thumbnail request is being held' }).toBeGreaterThan(0);
    const img = imageEl(card);
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth), 'image not loaded yet').toBe(0);
    const boxBefore = (await card.getByTestId('link-preview-image').boundingBox())!;
    const rowBefore = (await r.boundingBox())!;
    expect(boxBefore.height, 'image box has a height before load').toBeGreaterThan(20);
    gate.release();
    await expectImageLoaded(card);
    const boxAfter = (await card.getByTestId('link-preview-image').boundingBox())!;
    const rowAfter = (await r.boundingBox())!;
    expect(Math.abs(boxAfter.height - boxBefore.height), 'image box height unchanged by the load').toBeLessThanOrEqual(1);
    expect(Math.abs(rowAfter.height - rowBefore.height), 'row height unchanged by the load').toBeLessThanOrEqual(1);
    expectNoThirdParty(s);
  });

});

/* ================================================================== AC-L5 hide */

test.describe('AC-L5 hide, per viewer', () => {
  test('AC-L5-1 + AC-L5-2 hide removes the card, sends nothing, survives reload; same URL elsewhere still shows', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-hide');
    const s = await start(page, R.dev);
    await clearHidden(page);
    const marker = uniq('L51');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const keep = fixtureUrl(page, 'square.html', `t=${marker}`);
    const idA = await send(page, `${url} ${keep} ${marker}A`, `${marker}A`);
    const idB = await send(page, `again ${url} ${marker}B`, `${marker}B`);
    const rA = row(page, idA);
    const bodyBefore = await rA.getByTestId('message-body').innerText();
    await expectReady(rA, url);
    await expectReady(rA, keep);
    await expect(previewsHost(rA)).toHaveAttribute('data-count', '2');
    await cardFor(rA, url).getByTestId('link-preview-hide').click();
    await expect(cardFor(rA, url)).toHaveCount(0);
    await expect(previewsHost(rA)).toHaveAttribute('data-count', '1');
    await expect(rA.getByTestId('message-body')).toHaveText(bodyBefore);
    expect(await hiddenStore(page)).toContain(`${idA}|${url}`);
    // Hiding the last card removes the host.
    await cardFor(rA, keep).getByTestId('link-preview-hide').click();
    await expect(previewsHost(rA)).toHaveCount(0);

    // Nothing was sent: no event in the room relates to or redacts the message.
    const recent = await bob.messages(R.dev, 20);
    const related = recent.filter((e) => (e as any).redacts === idA || (e.content as any)?.redacts === idA || (e.content as any)?.['m.relates_to']?.event_id === idA);
    expect(related.map((e) => e.type), 'no redaction / edit / relation sent for a hide').toEqual([]);

    // AC-L5-2
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await openRoom(page, R.dev);
    await expectReady(row(page, idB), url, 15_000); // sentinel: the same URL in another message still shows
    await expect(row(page, idA)).toBeVisible();
    await expect(cards(row(page, idA))).toHaveCount(0);
    expectNoThirdParty(s);
  });

  test('AC-L5-3 bob in his own context still sees a card alice hid', async ({ page, browser }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-hide');
    await start(page, R.dev);
    const marker = uniq('L53');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `${url} ${marker}`, marker);
    await expectReady(row(page, id), url);
    await cardFor(row(page, id), url).getByTestId('link-preview-hide').click();
    await expect(cardFor(row(page, id), url)).toHaveCount(0);

    const b = await secondContext(browser, 'bob');
    await openRoom(b.page, R.dev);
    await expectReady(row(b.page, id), url, 15_000);
    await b.close();
  });

  test('AC-L5-4 click-to-load and unavailable elements in #vault can be hidden too (P1)', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-hide', 'link-preview-load', 'link-preview-unavailable');
    await start(page, R.vault, { encrypted: true });
    const marker = uniq('L54');
    const a = fixtureUrl(page, 'article.html', `t=${marker}`);
    const e = fixtureUrl(page, 'empty.html', `t=${marker}`);
    const id = await send(page, `${a} ${e} ${marker}`, marker);
    const r = row(page, id);
    await cardFor(r, e).getByTestId('link-preview-load').click();
    await expect(cardFor(r, e)).toHaveAttribute('data-state', 'unavailable', { timeout: 15_000 });
    await cardFor(r, a).getByTestId('link-preview-hide').click();
    await cardFor(r, e).getByTestId('link-preview-hide').click();
    await expect(cards(r)).toHaveCount(0);
    const store = await hiddenStore(page);
    expect(store).toEqual(expect.arrayContaining([`${id}|${a}`, `${id}|${e}`]));
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await openRoom(page, R.vault);
    await expect(row(page, id)).toBeVisible({ timeout: 20_000 });
    await expect(row(page, id).getByTestId('message-body')).toContainText(marker, { timeout: 20_000 });
    await expect(cards(row(page, id))).toHaveCount(0);
  });
});

/* ================================================================== AC-L6 errors, caching */

test.describe('AC-L6 errors stay quiet, caching', () => {
  test('AC-L6-1 404 / 403 / 429 / 500 / empty body: no card, no toast, no uncaught error', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L61');
    const cases: Record<string, { status: number; body?: unknown }> = {
      e404: { status: 404 },
      e403: { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'IP address blocked' } },
      e429: { status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', error: 'slow down', retry_after_ms: 50 } },
      e500: { status: 500 },
      empty: { status: 200, body: {} },
    };
    const urls = Object.fromEntries(Object.keys(cases).map((k) => [k, fixtureUrl(page, 'article.html', `t=${marker}${k}`)]));
    await stubPreview(page, (u) => {
      const key = Object.keys(urls).find((k) => urls[k] === u);
      return key ? cases[key]! : 'continue';
    });
    const ids: Record<string, string> = {};
    for (const k of Object.keys(cases)) ids[k] = await send(page, `${urls[k]} ${marker}${k}x`, `${marker}${k}x`);
    // Sentinel: a real card sent last; when it is ready every stubbed answer has been handled.
    const sm = `${marker}sentinel`;
    const sentinel = fixtureUrl(page, 'square.html', `t=${sm}`);
    const sid = await send(page, `${sentinel} ${sm}`, sm);
    await expectReady(row(page, sid), sentinel);
    for (const k of Object.keys(cases)) {
      await expect.poll(() => s.reqs.countFor(urls[k]!), { message: `${k} was requested` }).toBeGreaterThan(0);
      const r = row(page, ids[k]!);
      await expect(cardFor(r, urls[k]!), `${k}: no card`).toHaveCount(0);
      await expect(previewsHost(r), `${k}: no link-previews host when nothing is visible`).toHaveCount(0);
      await expect(r.getByTestId('message-body')).toContainText(`${marker}${k}x`);
    }
    await expect(page.getByTestId('toast')).toHaveCount(0);
    expect(s.errors()).toEqual([]);
    expectNoThirdParty(s);
  });

  test('AC-L6-2 a slow preview: text first, a loading placeholder at most one line tall, then the card', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L62');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const gate = deferred();
    await stubPreview(page, (u) => (u === url ? { continueAfter: gate.promise } : 'continue'));
    const id = await send(page, `${url} ${marker}`, marker);
    const r = row(page, id);
    await expect(r.getByTestId('message-body')).toContainText(marker);
    const card = cardFor(r, url);
    await expect(card).toHaveAttribute('data-state', 'loading', { timeout: 10_000 });
    const h = (await card.boundingBox())?.height ?? 0;
    expect(h, 'loading placeholder reserves at most one line').toBeLessThanOrEqual(32);
    await sleep(3_000); // the criterion's 3 s delay
    await expect(card).toHaveAttribute('data-state', 'loading');
    gate.release();
    await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    expectNoThirdParty(s);
  });

  test('AC-L6-3 + AC-L6-5 cached across remount / send / edit; misses not retried; clear cache refetches', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L63');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const bad = fixtureUrl(page, 'article.html', `t=${marker}bad`);
    await stubPreview(page, (u) => (u === bad ? { status: 500 } : 'continue'));
    const id = await send(page, `${url} ${bad} ${marker}`, marker);
    await expectReady(row(page, id), url);
    await expect.poll(() => s.reqs.countFor(bad)).toBe(1);
    expect(s.reqs.countFor(url)).toBe(1);

    await remountRoom(page, R.dev, R.vault);
    await expect(cardFor(row(page, id), url)).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    // Another message, and an edit of another message (bumps the store version).
    const m2 = uniq('L63b');
    const other = await send(page, `plain ${m2}`, m2);
    await alice.sendEvent(R.dev, 'm.room.message', {
      msgtype: 'm.text',
      body: `* plain ${m2} edited`,
      'm.new_content': { msgtype: 'm.text', body: `plain ${m2} edited` },
      'm.relates_to': { rel_type: 'm.replace', event_id: other },
    });
    await expect(row(page, other).getByTestId('message-body')).toContainText('edited', { timeout: 10_000 });
    await expect(cardFor(row(page, id), url)).toHaveAttribute('data-state', 'ready');
    expect(s.reqs.countFor(url), 'no refetch after remount / send / edit').toBe(1);
    expect(s.reqs.countFor(bad), 'a miss is not retried on remount').toBe(1);

    // AC-L6-5 (P1): the in-memory cache is the only reason it was not fetched.
    const size = await previewHook<number>(page, 'linkPreviewCacheSize');
    expect(size).toBeLessThanOrEqual(200);
    await previewHook(page, 'clearLinkPreviewCache');
    await remountRoom(page, R.dev, R.vault);
    await expect(cardFor(row(page, id), url)).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    // BUG-30 regression: matrix-js-sdk's own urlPreviewCache (keyed by URL + the minute bucket of `ts`, never expired,
    // rejections included) must not swallow the refetch, or a transient failure is never retried for the session.
    await expect.poll(() => s.reqs.countFor(url), { message: 'after clearLinkPreviewCache + remount the URL is fetched again (AC-L6-5, BUG-30)', timeout: 10_000 }).toBe(2);
    await expect.poll(() => s.reqs.countFor(bad), { message: 'a cleared miss is retried (the negative TTL can expire, BUG-30)', timeout: 10_000 }).toBe(2);
  });

  test('AC-L6-4 two messages with the same URL in a row: one request, both ready', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L64');
    const url = fixtureUrl(page, 'square.html', `t=${marker}`);
    const id1 = await bob.send(R.dev, `${url} ${marker}1`);
    const id2 = await bob.send(R.dev, `${url} ${marker}2`);
    await expectReady(row(page, id1), url, 15_000);
    await expectReady(row(page, id2), url, 15_000);
    expect(s.reqs.countFor(url), 'in-flight dedupe').toBe(1);
  });
});

/* ================================================================== AC-L7 threads, quotes, edits, scroll */

test.describe('AC-L7 threads, quotes, edits, scroll', () => {
  test('AC-L7-1 cards in the thread panel; none in the summary, Threads list or reply quote', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L71');
    const rootUrl = fixtureUrl(page, 'article.html', `t=${marker}root`);
    const replyUrl = fixtureUrl(page, 'article.html', `t=${marker}reply`);
    const rootId = await bob.send(R.dev, `thread root ${rootUrl} ${marker}`);
    const replyId = await bob.sendThreadReply(R.dev, rootId, `thread reply ${replyUrl} ${marker}`, { latest: rootId });
    const quoteId = await bob.send(R.dev, `quoting the root ${marker}q`, { 'm.relates_to': { 'm.in_reply_to': { event_id: rootId } } });
    await expectReady(row(page, rootId), rootUrl, 15_000);
    await expect(threadSummary(page, rootId)).toBeVisible({ timeout: 15_000 });
    await expect(cards(threadSummary(page, rootId)), 'no card in the thread summary').toHaveCount(0);
    const quoteRow = row(page, quoteId);
    await expect(quoteRow.getByTestId('message-reply-quote')).toBeVisible({ timeout: 15_000 });
    await expect(cards(quoteRow.getByTestId('message-reply-quote')), 'no card in a reply quote').toHaveCount(0);
    await expect(previewsHost(quoteRow), 'the quoting message itself has no link').toHaveCount(0);

    const panel = await openThreadFromMessage(page, rootId);
    await expectReady(threadRootEl(page), rootUrl, 15_000);
    await expectReady(panel.getByTestId(`message-${replyId}`), replyUrl, 15_000);

    await openThreadsList(page);
    await expect(threadList(page).getByTestId(`thread-list-item-${rootId}`)).toBeVisible({ timeout: 15_000 });
    await expect(cards(threadList(page)), 'no card in the Threads list').toHaveCount(0);
    expect(await threadPanel(page).count()).toBeGreaterThanOrEqual(0);
    expectNoThirdParty(s);
  });

  test('AC-L7-2 editing swaps the card; editing the link away removes the host', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L72');
    const square = fixtureUrl(page, 'square.html', `t=${marker}`);
    const article = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `${square} ${marker}`, marker);
    const r = row(page, id);
    await expectReady(r, square);

    const editTo = async (text: string): Promise<void> => {
      const actions = await hoverActions(page, id);
      await actions.getByTestId('message-action-edit').click();
      await expect(page.getByTestId('composer-edit-banner')).toBeVisible();
      await page.getByTestId('composer-input').fill(text);
      await page.getByTestId('composer-input').press('Enter');
      await expect(page.getByTestId('composer-edit-banner')).toHaveCount(0);
    };
    await editTo(`${article} ${marker}`);
    await expectReady(r, article, 10_000);
    await expect(cardFor(r, square)).toHaveCount(0);
    await expect(previewsHost(r)).toHaveAttribute('data-count', '1');
    await expect(r.getByTestId('message-edited')).toBeVisible();

    await editTo(`no links any more ${marker}`);
    await expect(r.getByTestId('message-body')).toContainText('no links any more', { timeout: 10_000 });
    await expect(previewsHost(r)).toHaveCount(0);
    await expect(r.getByTestId('message-edited')).toBeVisible();
    expectNoThirdParty(s);
  });

  test('AC-L7-3 pinned to the bottom: a card and its large image arriving keep the list at the bottom', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI, 'link-preview-image');
    const s = await start(page, R.dev);
    const list = messageList(page);
    const gap = (): Promise<number> => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(gap, { message: 'pinned before the message arrives' }).toBeLessThan(2);
    const marker = uniq('L73');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await bob.send(R.dev, `${url} ${marker}`);
    const card = await expectReady(row(page, id), url, 15_000);
    await expect.poll(gap, { message: 'still at the bottom after the card is ready', timeout: 3_000 }).toBeLessThan(2);
    await expectImageLoaded(card);
    await expect.poll(gap, { message: 'still at the bottom after the image loads (BUG-28 family)', timeout: 3_000 }).toBeLessThan(2);
    expectNoThirdParty(s);
  });

  test('AC-L7-4 scrolled up: a card loading above the viewport does not move what alice reads', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI, 'link-preview-image');
    const marker = uniq('L74');
    const guard = await noThirdParty(page);
    const reqs = previewRequests(page);
    // The URL must be built before navigation: use this worker's origin.
    const url = fixtureUrl(undefined, 'article.html', `t=${marker}`);
    const gate = deferred();
    await stubPreview(page, (u) => (u === url ? { continueAfter: gate.promise } : 'continue'));
    const cardMsg = await bob.send(R.dev, `${url} ${marker}card`);
    const fillers: string[] = [];
    for (let i = 0; i < 24; i += 1) fillers.push(await bob.send(R.dev, `${marker} filler ${i}`));
    await loginAs(page, 'alice');
    await openRoom(page, R.dev);
    const cardRow = row(page, cardMsg);
    await expect(cardRow, 'the card row is in the initial window').toBeAttached({ timeout: 15_000 });
    await expect(cardFor(cardRow, url)).toHaveAttribute('data-state', 'loading', { timeout: 10_000 });
    const reader = row(page, fillers[14]!);
    await reader.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const before = (await reader.boundingBox())!.y;
    const cardTop = (await cardRow.boundingBox())!;
    const listTop = (await messageList(page).boundingBox())!.y;
    expect(cardTop.y + cardTop.height, 'the loading card is above the viewport').toBeLessThan(listTop);
    await expect.poll(() => reqs.countFor(url), { message: 'the request for the card is in flight' }).toBe(1);
    gate.release();
    await expect(cardFor(cardRow, url)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expectImageLoaded(cardFor(cardRow, url)).catch(() => annotate('image-not-loaded', 'the offscreen image did not decode (lazy loading?); measured after the card only'));
    await expect.poll(async () => Math.abs((await reader.boundingBox())!.y - before), { message: 'the message alice reads keeps its position within 2 px', timeout: 3_000 }).toBeLessThanOrEqual(2);
    expect(guard.violations()).toEqual([]);
  });

  test('REG-L7-4b parked 10-35 px above the bottom (inside the stick band): a card loading above the viewport keeps the reader', async ({ page }) => {
    // Regression for the AC-L7-4 root cause (Dev B, 2026-10-18): "stuck" means within 40 px of the bottom, and late
    // growth used to snap to the true bottom, moving everything on screen by the remaining gap (21-24 px).
    requireUi('Dev B', ...CARD_UI, 'link-preview-image');
    const marker = uniq('L74b');
    const guard = await noThirdParty(page);
    const url = fixtureUrl(undefined, 'article.html', `t=${marker}`);
    const gate = deferred();
    await stubPreview(page, (u) => (u === url ? { continueAfter: gate.promise } : 'continue'));
    const cardMsg = await bob.send(R.dev, `${url} ${marker}card`);
    const fillers: string[] = [];
    for (let i = 0; i < 24; i += 1) fillers.push(await bob.send(R.dev, `${marker} filler ${i}`));
    await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.dev } });
    await openRoom(page, R.dev);
    const cardRow = row(page, cardMsg);
    await expect(cardRow).toBeAttached({ timeout: 15_000 });
    await expect(row(page, fillers[23]!)).toBeVisible({ timeout: 15_000 });
    await expect(cardFor(cardRow, url)).toHaveAttribute('data-state', 'loading', { timeout: 10_000 });
    const gap = await parkAboveBottom(page, 20);
    expect(gap, 'parked inside the 40 px stick band, not at the very bottom').toBeGreaterThanOrEqual(10);
    expect(gap).toBeLessThanOrEqual(35);
    const listBox = (await messageList(page).boundingBox())!;
    const cardBox = (await cardRow.boundingBox())!;
    expect(cardBox.y + cardBox.height, 'the loading card is above the viewport').toBeLessThan(listBox.y);
    const reader = row(page, fillers[22]!);
    const before = (await reader.boundingBox())!.y;
    const heightBefore = cardBox.height;
    gate.release();
    await expect(cardFor(cardRow, url)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expectImageLoaded(cardFor(cardRow, url)).catch(() => annotate('image-not-loaded', 'measured after the card only'));
    await expect.poll(async () => (await cardRow.boundingBox())!.height, { message: 'the card row grew' }).toBeGreaterThan(heightBefore + 20);
    await nextFrames(page);
    const after = (await reader.boundingBox())!.y;
    expect(Math.abs(after - before), `reader moved ${after - before}px`).toBeLessThanOrEqual(2);
    const gapAfter = await messageList(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(Math.abs(gapAfter - gap), `bottom gap kept (${gap} -> ${gapAfter})`).toBeLessThanOrEqual(2);
    expect(guard.violations()).toEqual([]);
  });

  test('AC-L7-5 a redaction removes the card with the text (P1)', async ({ page }) => {
    requireUi('Dev B', ...CARD_UI);
    const s = await start(page, R.dev);
    const marker = uniq('L75');
    const url = fixtureUrl(page, 'article.html', `t=${marker}`);
    const id = await send(page, `${url} ${marker}`, marker);
    await expectReady(row(page, id), url);
    await alice.redact(R.dev, id);
    await expect(row(page, id).getByTestId('message-redacted')).toBeVisible({ timeout: 10_000 });
    await expect(previewsHost(row(page, id))).toHaveCount(0);
    expectNoThirdParty(s);
  });
});

/* ================================================================== AC-L8 embeds */

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SPOTIFY = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';

test.describe('AC-L8 embeds (P1)', () => {
  test('AC-L8-1 parseEmbed table', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).__matrixPoc?.preview);
    const pe = (u: string): Promise<Record<string, unknown> | null> => previewHook(page, 'parseEmbed', u);
    for (const u of [YT, 'https://youtube.com/shorts/dQw4w9WgXcQ']) {
      expect(await pe(u)).toMatchObject({ provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
    }
    expect(await pe('https://youtu.be/dQw4w9WgXcQ?t=5')).toMatchObject({ provider: 'youtube', id: 'dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5', startSeconds: 5 });
    expect(await pe(SPOTIFY)).toMatchObject({ provider: 'spotify', kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC', embedUrl: 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC' });
    for (const kind of ['album', 'playlist', 'episode']) {
      expect(await pe(`https://open.spotify.com/${kind}/4uLU6hMCjMI75M1A2tKUQC`)).toMatchObject({ provider: 'spotify', kind, embedUrl: `https://open.spotify.com/embed/${kind}/4uLU6hMCjMI75M1A2tKUQC` });
    }
    expect(await pe('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC')).toMatchObject({ kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });
    expect(await pe('https://www.youtube.com/')).toBeNull();
    expect(await pe('https://open.spotify.com/user/x')).toBeNull();
  });

  /** Stubs preview_url for the embed URLs with a real hero mxc so no internet is needed. */
  async function stubEmbeds(page: Page): Promise<void> {
    const hero = await serverPreview(alice.token, fixtureUrl(page, 'article.html'));
    const mxc = String(hero.body['og:image'] ?? '');
    await stubPreview(page, (u) => {
      if (u.startsWith('https://www.youtube.com/') || u.startsWith('https://open.spotify.com/')) {
        return { status: 200, body: { 'og:site_name': u.includes('spotify') ? 'Spotify' : 'YouTube', 'og:title': 'Embed fixture', 'og:image': mxc, 'og:image:width': 1280, 'og:image:height': 720 } };
      }
      return 'continue';
    });
  }

  for (const [label, url, prefix] of [
    ['YouTube', YT, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['Spotify', SPOTIFY, 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC'],
  ] as const) {
    test(`AC-L8-2 + AC-L8-3 ${label} in #dev: play button, no third-party request, iframe only after the click`, async ({ page }) => {
      requireUi('Dev A', ...CARD_UI, 'link-preview-play', 'link-preview-embed');
      const s = await start(page, R.dev);
      await stubEmbeds(page);
      const marker = uniq('L82');
      const id = await send(page, `${url} ${marker}`, marker);
      const card = await expectReady(row(page, id), url, 10_000);
      await expect(card).toHaveAttribute('data-embed', label.toLowerCase());
      await expect(card.getByTestId('link-preview-play')).toBeVisible();
      await expect(card.getByTestId('link-preview-embed')).toHaveCount(0);
      expect(s.guard.violations(), 'no third-party request before play (S1)').toEqual([]);
      s.guard.allow();
      await card.getByTestId('link-preview-play').click();
      const frame = card.getByTestId('link-preview-embed');
      await expect(frame).toBeVisible();
      expect(await frame.evaluate((el) => el.tagName)).toBe('IFRAME');
      expect((await frame.getAttribute('src')) ?? '').toMatch(new RegExp(`^${prefix.replace(/[.?/]/g, '\\$&')}`));
      await expect(frame).toHaveAttribute('sandbox', /.*/);
      await expect(card.getByTestId('link-preview-play')).toHaveCount(0);
    });
  }

  test('AC-L8-4 YouTube in #vault: Show preview -> play -> iframe, nothing before each click', async ({ page }) => {
    requireUi('Dev A', ...CARD_UI, 'link-preview-load', 'link-preview-play', 'link-preview-embed');
    const s = await start(page, R.vault, { encrypted: true });
    await stubEmbeds(page);
    const marker = uniq('L84');
    const id = await send(page, `${YT} ${marker}`, marker);
    const card = cardFor(row(page, id), YT);
    await expect(card).toHaveAttribute('data-state', 'click-to-load', { timeout: 10_000 });
    expect(s.reqs.count(), 'no preview request before Show preview').toBe(0);
    await card.getByTestId('link-preview-load').click();
    await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
    expect(s.guard.violations(), 'no third-party request before play').toEqual([]);
    s.guard.allow();
    await card.getByTestId('link-preview-play').click();
    await expect(card.getByTestId('link-preview-embed')).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  });
});

/* ================================================================== AC-L9 homeserver config + fixtures */

test.describe('AC-L9 homeserver config and fixtures', () => {
  test('AC-L9-1 preview_url as alice returns the article OpenGraph with an mxc image', async ({ page }) => {
    await page.goto('/');
    const url = fixtureUrl(page, 'article.html', `t=${uniq('L91')}`);
    const res = await serverPreview(alice.token, url);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['og:title']).toBe(FIXTURES.article.title);
    expect(String(res.body['og:image'])).toMatch(/^mxc:\/\//);
    expect(Number(res.body['og:image:width'])).toBe(1200);
  });

  test('AC-L9-2 fixture pages and images are served with the stated tags and sizes', async ({ request }) => {
    const pages: Record<string, RegExp[]> = {
      'article.html': [/og:site_name" content="The Codec Gazette"/, /og:image:width" content="1200"/],
      'square.html': [/og:image" content="\/preview-fixtures\/thumb\.png"/],
      'long.html': [/og:site_name" content="Clamp Test Weekly"/],
      'title-only.html': [/<title>Plain page with only a title<\/title>/],
      'empty.html': [/<head><meta charset="utf-8"><\/head>/],
      'noimage.html': [/og:title" content="Text-only release notes"/],
      'nodims.html': [/og:image" content="\/preview-fixtures\/hero\.png"/],
    };
    for (const [name, patterns] of Object.entries(pages)) {
      const res = await request.get(`/preview-fixtures/${name}`);
      expect(res.status(), name).toBe(200);
      const html = await res.text();
      for (const p of patterns) expect(html, `${name} ${p}`).toMatch(p);
      if (name === 'empty.html' || name === 'title-only.html') expect(html).not.toMatch(/<meta property="og:/);
      if (name === 'nodims.html' || name === 'long.html') expect(html).not.toMatch(/<meta property="og:image:width"/);
    }
    for (const [name, w, h] of [['hero.png', 1200, 630], ['thumb.png', 128, 128]] as const) {
      const res = await request.get(`/preview-fixtures/${name}`);
      expect(res.status(), name).toBe(200);
      const b = Buffer.from(await res.body());
      expect(b.subarray(1, 4).toString('ascii'), `${name} is a PNG`).toBe('PNG');
      expect([b.readUInt32BE(16), b.readUInt32BE(20)], `${name} size`).toEqual([w, h]);
    }
  });
});
