/**
 * QA (voice format): every voice note plays for every listener — docs/archive/VOICE_FORMAT_PLAN.md AC-F4..F11.
 * `mobile` project only (`devices['Pixel 7']`, fake microphone; playwright.config.ts).
 *
 *  - **native** (plain Chromium): an Ogg note and an old WebM note play through `<audio>` with
 *    `data-playback="native"`, and the `ogg-opus-decoder` chunk is never requested (AC-F4, AC-F8);
 *  - **old iPhone** (`fixtures/old-iphone.ts`: `canPlayType` says `''` for Ogg/WebM, `<audio>` and
 *    `decodeAudioData` refuse them): the same notes play through the software decoder with
 *    `data-playback="fallback"` — play, position advancing, seek to half, pause/resume, end (AC-F5..F7);
 *    a variant where `canPlayType` *lies* (`'maybe'`) checks the `<audio>`-error recovery path;
 *  - an undecodable `audio/ogg` note under the simulation ends in `voice-error` + download link (AC-F11);
 *  - the send path's fallbacks through the dev hooks: a forced remux failure sends the original WebM
 *    (AC-F9), and Ogg/MP4 recordings pass `encodeToOggOpus` unchanged (AC-F10).
 *
 * Notes are posted through the raw API (`fixtures/matrix-api.ts`) as bob, or alice for "her own" note.
 * The Ogg bytes are the real Chromium fixture remuxed in Node; the WebM bytes are the fixture itself
 * (exactly what Codec sent before the remux existed). Everything goes to `#dev`.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { remuxWebmOpusToOgg } from '../src/lib/audio/ogg.ts';
import { loginAs } from './fixtures/auth.ts';
import { asUser, type ApiUser, type SentVoice } from './fixtures/matrix-api.ts';
import { resolveRoom, userId } from './fixtures/seed.ts';
import { messageList, row, settledEventId } from './fixtures/ui.ts';
import { tapRoom } from './fixtures/mobile.ts';
import { oldIphoneLog, simulateOldIphone, watchDecoderRequests } from './fixtures/old-iphone.ts';

const ALICE = userId('alice');
const WEBM_3S = new Uint8Array(readFileSync('e2e/fixtures/chromium-3s.webm'));
const OGG_3S = remuxWebmOpusToOgg(WEBM_3S);
/** chromium-3s.webm holds 50 x 60 ms Opus frames = 3000 ms (e2e/ogg-remux.spec.ts). */
const DURATION_MS = 3000;

const R = { acme: '', dev: '' };
let alice: ApiUser;
let bob: ApiUser;

test.beforeAll(async () => {
  R.acme = await resolveRoom('acme-hq');
  R.dev = await resolveRoom('dev');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

/* ------------------------------------------------------------------ helpers */

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function openDev(page: Page): Promise<void> {
  await loginAs(page, 'alice', { selection: { spaceId: R.acme, roomId: R.dev } });
  const header = page.getByTestId('channel-header-name');
  if (!((await header.textContent()) ?? '').includes('dev')) await tapRoom(page, R.dev, 'channel');
  await expect(header).toContainText('dev');
  await expect(messageList(page)).toBeVisible();
}

const postOgg = (who: ApiUser = bob): Promise<SentVoice> =>
  who.sendVoice(R.dev, { bytes: OGG_3S, mimetype: 'audio/ogg', durationMs: DURATION_MS });
const postOldWebm = (): Promise<SentVoice> =>
  bob.sendVoice(R.dev, { bytes: WEBM_3S, mimetype: 'audio/webm', durationMs: DURATION_MS });

function bubbleOf(page: Page, eventId: string): { r: Locator; bubble: Locator } {
  const r = row(page, eventId);
  return { r, bubble: r.getByTestId('voice-message') };
}

const position = async (bubble: Locator): Promise<number> => Number(await bubble.getAttribute('data-position-ms'));

/** Sets `voice-progress` the way a drag ends (AC-V3-5's technique). */
async function seek(bubble: Locator, ms: number): Promise<void> {
  await bubble.getByTestId('voice-progress').evaluate((el, value) => {
    const range = el as HTMLInputElement;
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, ms);
}

/**
 * The whole playback contract for one note: idle with the total, tap -> (loading) -> playing within
 * `playWithinMs`, the expected `data-playback`, elapsed time shown, position advancing across two
 * polls, seek to half lands within 300 ms and keeps playing, pause holds, resume continues, the end
 * returns to idle at 0 with the total shown again (AC-F5/F6/F7, AC-V3-2..5).
 */
async function expectFullPlayback(
  page: Page,
  eventId: string,
  expected: { playback: 'native' | 'fallback'; mimetype: string; playWithinMs?: number },
): Promise<{ playMs: number }> {
  const { r, bubble } = bubbleOf(page, eventId);
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  await expect(bubble).toHaveAttribute('data-state', 'idle');
  await expect(bubble).toHaveAttribute('data-mimetype', expected.mimetype);
  await expect(bubble.getByTestId('voice-duration')).toHaveText(mmss(DURATION_MS));

  const tappedAt = Date.now();
  await r.getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', /^(loading|playing)$/, { timeout: 2_000 });
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: expected.playWithinMs ?? 5_000 });
  const playMs = Date.now() - tappedAt;
  await expect(bubble).toHaveAttribute('data-playback', expected.playback);
  await expect(r.getByTestId('voice-error')).toHaveCount(0);

  // Position advances across two polls; the duration label shows elapsed, not the total.
  const p0 = await position(bubble);
  await expect.poll(() => position(bubble), { timeout: 4_000, intervals: [100, 200, 300] }).toBeGreaterThan(p0);
  const p1 = await position(bubble);
  await expect.poll(() => position(bubble), { timeout: 4_000, intervals: [100, 200, 300] }).toBeGreaterThan(p1);
  await expect(bubble.getByTestId('voice-duration')).not.toHaveText(mmss(DURATION_MS));
  expect(Number(await bubble.getByTestId('voice-progress').getAttribute('aria-valuenow'))).toBeGreaterThan(0);

  // AC-F7: seek to half while playing; it lands there and keeps playing.
  await r.getByTestId('voice-pause').tap();
  await expect(bubble).toHaveAttribute('data-state', 'paused');
  const half = Math.round(DURATION_MS / 2);
  await seek(bubble, half);
  await expect
    .poll(() => position(bubble), { timeout: 5_000, message: 'seek to half did not land' })
    .toBeGreaterThan(half - 300);
  expect(await position(bubble), 'seek to half within 300 ms').toBeLessThan(half + 300);
  // Paused: the position holds.
  const held = await position(bubble);
  await page.waitForTimeout(400); // the only fixed wait: proving *absence* of movement needs elapsed time
  expect(await position(bubble), 'position must not move while paused').toBe(held);

  // Resume from the seek point, keep going, and end at idle.
  await r.getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  expect(await position(bubble), 'resume continues from the seek point').toBeGreaterThanOrEqual(half - 300);
  await expect.poll(() => position(bubble), { timeout: 4_000 }).toBeGreaterThan(half + 100);
  await expect(bubble).toHaveAttribute('data-playback', expected.playback);
  await expect(bubble).toHaveAttribute('data-state', 'idle', { timeout: DURATION_MS + 10_000 });
  await expect(bubble).toHaveAttribute('data-position-ms', '0');
  await expect(bubble.getByTestId('voice-duration')).toHaveText(mmss(DURATION_MS));
  return { playMs };
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/* ================================================================== native (plain Chromium) */

test.describe('native playback (plain Chromium)', () => {
  test('AC-F4/AC-F8 — alice\'s own Ogg note and an old WebM note play natively; the decoder chunk is never requested', async ({
    page,
  }) => {
    const decoder = watchDecoderRequests(page);
    const errors = collectPageErrors(page);
    const ogg = await postOgg(alice);
    const webm = await postOldWebm();
    await openDev(page);

    await expectFullPlayback(page, ogg.eventId, { playback: 'native', mimetype: 'audio/ogg' });
    await expectFullPlayback(page, webm.eventId, { playback: 'native', mimetype: 'audio/webm' });

    expect(decoder, 'ogg-opus-decoder must not be loaded by a browser that plays Ogg/WebM').toEqual([]);
    expect(errors).toEqual([]);
  });

  test('AC-F4 — one note at a time still holds for Ogg notes', async ({ page }) => {
    const a = await postOgg();
    const b = await postOgg();
    await openDev(page);
    const first = bubbleOf(page, a.eventId);
    const second = bubbleOf(page, b.eventId);
    await expect(second.bubble).toBeVisible({ timeout: 20_000 });
    await first.r.getByTestId('voice-play').tap();
    await expect(first.bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
    await second.r.getByTestId('voice-play').tap();
    await expect(second.bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
    await expect(first.bubble).toHaveAttribute('data-state', 'paused', { timeout: 5_000 });
  });
});

/* ================================================================== old iPhone simulation */

test.describe('old iPhone (no Ogg/WebM support)', () => {
  test.beforeEach(async ({ page }) => {
    await simulateOldIphone(page);
  });

  test('simulation self-check — canPlayType is empty and <audio> refuses Ogg/WebM, WAV still plays', async ({ page }) => {
    await openDev(page);
    const result = await page.evaluate(async (oggBytes) => {
      const a = document.createElement('audio');
      const probe = {
        ogg: a.canPlayType('audio/ogg; codecs=opus'),
        webm: a.canPlayType('audio/webm'),
        wav: a.canPlayType('audio/wav'),
        mp4: a.canPlayType('audio/mp4'),
      };
      const url = URL.createObjectURL(new Blob([new Uint8Array(oggBytes)], { type: 'audio/ogg' }));
      a.src = url;
      const outcome = await new Promise<string>((resolve) => {
        a.onerror = () => resolve(`error ${a.error?.code}`);
        a.oncanplay = () => resolve('canplay');
        setTimeout(() => resolve('timeout'), 5_000);
      });
      const playErr = await a.play().then(() => 'resolved', (e: DOMException) => e.name);
      let decode = 'resolved';
      try {
        await new AudioContext().decodeAudioData(new Uint8Array(oggBytes).buffer);
      } catch (e) {
        decode = (e as DOMException).name;
      }
      return { probe, outcome, playErr, srcKept: a.src === url, decode };
    }, [...OGG_3S]);
    expect(result.probe).toEqual({ ogg: '', webm: '', wav: 'maybe', mp4: 'maybe' });
    expect(result.outcome, 'MEDIA_ERR_SRC_NOT_SUPPORTED').toBe('error 4');
    expect(result.playErr).toBe('NotSupportedError');
    expect(result.srcKept, 'the app sees the src it set').toBe(true);
    expect(result.decode).toBe('EncodingError');
  });

  test('AC-F5/AC-F7 — a new Ogg note plays through the fallback: playing <= 5 s, position, seek to half, pause/resume, end', async ({
    page,
  }) => {
    const decoder = watchDecoderRequests(page);
    const errors = collectPageErrors(page);
    const sent = await postOgg();
    await openDev(page);
    const { playMs } = await expectFullPlayback(page, sent.eventId, { playback: 'fallback', mimetype: 'audio/ogg' });
    expect(decoder.length, 'the decoder chunk is lazy-loaded for the fallback').toBeGreaterThan(0);
    const log = await oldIphoneLog(page);
    expect(log.blobTypes, 'a WAV was produced and played').toContain('audio/wav');
    expect(errors).toEqual([]);
    test.info().annotations.push({ type: 'AC-F5 timing', description: `tap -> playing ${playMs} ms; decoder: ${decoder.join(', ')}` });
  });

  test('AC-F6/AC-F7 — an old WebM note (as Codec sent them before) plays through the fallback', async ({ page }) => {
    const decoder = watchDecoderRequests(page);
    const errors = collectPageErrors(page);
    const sent = await postOldWebm();
    await openDev(page);
    const { playMs } = await expectFullPlayback(page, sent.eventId, { playback: 'fallback', mimetype: 'audio/webm' });
    expect(decoder.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    test.info().annotations.push({ type: 'AC-F6 timing', description: `tap -> playing ${playMs} ms` });
  });

  test('AC-F11 — random bytes sent as audio/ogg end in voice-error with a download link, no uncaught error', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    const garbage = new Uint8Array(8192);
    let seed = 42;
    for (let i = 0; i < garbage.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      garbage[i] = seed >>> 24;
    }
    const sent = await bob.sendVoice(R.dev, { bytes: garbage, mimetype: 'audio/ogg', durationMs: 2000 });
    await openDev(page);
    const { r, bubble } = bubbleOf(page, sent.eventId);
    await expect(bubble).toBeVisible({ timeout: 20_000 });
    await r.getByTestId('voice-play').tap();
    await expect(r.getByTestId('voice-error')).toBeVisible({ timeout: 15_000 });
    await expect(r.getByTestId('voice-error')).toContainText(/can.?t play/i);
    await expect(r.getByTestId('voice-error').locator('a')).toHaveAttribute('href', /.+/);
    await expect(bubble).toHaveAttribute('data-state', 'error');
    expect(errors, 'no uncaught exception on an undecodable note').toEqual([]);
  });

  test('AC-F11 — a truncated Ogg (header pages only) ends in voice-error too', async ({ page }) => {
    const errors = collectPageErrors(page);
    // OpusHead + OpusTags pages and nothing else: a container that parses but holds no audio.
    let off = 0;
    for (let page = 0; page < 2; page += 1) {
      const nseg = OGG_3S[off + 26];
      let body = 0;
      for (let i = 0; i < nseg; i += 1) body += OGG_3S[off + 27 + i];
      off += 27 + nseg + body;
    }
    const headersOnly = OGG_3S.slice(0, off);
    const sent = await bob.sendVoice(R.dev, { bytes: headersOnly, mimetype: 'audio/ogg', durationMs: 2000 });
    await openDev(page);
    const { r, bubble } = bubbleOf(page, sent.eventId);
    await expect(bubble).toBeVisible({ timeout: 20_000 });
    await r.getByTestId('voice-play').tap();
    await expect(r.getByTestId('voice-error')).toBeVisible({ timeout: 15_000 });
    await expect(bubble).toHaveAttribute('data-state', 'error');
    expect(errors).toEqual([]);
  });
});

test.describe('old iPhone whose canPlayType lies ("maybe")', () => {
  test.beforeEach(async ({ page }) => {
    await simulateOldIphone(page, { canPlayTypeLies: true });
  });

  test('AC-F5 (format-error path) — <audio> refuses the Ogg note, the bubble recovers through the fallback', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    const sent = await postOgg();
    await openDev(page);
    await expectFullPlayback(page, sent.eventId, { playback: 'fallback', mimetype: 'audio/ogg' });
    const log = await oldIphoneLog(page);
    expect(log.refused.length, 'the native attempt really was made and refused').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test.describe('native play() that never starts', () => {
  test.beforeEach(async ({ page }) => {
    // canPlayType says yes, but play() on an Ogg/WebM blob never settles and never plays (a stalled
    // WKWebView). Dev B: the bubble switches to the fallback once after ~4 s without `playing`.
    await page.addInitScript(() => {
      const types = new Map<string, string>();
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (obj: Blob | MediaSource): string => {
        const url = create(obj);
        if (obj instanceof Blob) types.set(url, obj.type);
        return url;
      };
      const play = HTMLMediaElement.prototype.play;
      (window as unknown as { __qaStalled: number }).__qaStalled = 0;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): Promise<void> {
        const src = this.src; // not currentSrc: it lags behind a new src until the load algorithm runs
        if (src.startsWith('blob:') && /ogg|webm/i.test(types.get(src) ?? '')) {
          (window as unknown as { __qaStalled: number }).__qaStalled += 1;
          return new Promise<void>(() => undefined);
        }
        return play.call(this);
      };
    });
  });

  test('stalled native play() switches to the fallback after ~4 s and plays', async ({ page }) => {
    const errors = collectPageErrors(page);
    const sent = await postOgg();
    await openDev(page);
    const { r, bubble } = bubbleOf(page, sent.eventId);
    await expect(bubble).toBeVisible({ timeout: 20_000 });
    const tappedAt = Date.now();
    await r.getByTestId('voice-play').tap();
    await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 12_000 });
    const elapsed = Date.now() - tappedAt;
    await expect(bubble).toHaveAttribute('data-playback', 'fallback');
    expect(await page.evaluate(() => (window as unknown as { __qaStalled: number }).__qaStalled)).toBeGreaterThan(0);
    expect(elapsed, 'the switch waits for the stall timeout (~4 s), not less').toBeGreaterThanOrEqual(3_000);
    await expect.poll(() => position(bubble), { timeout: 5_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    test.info().annotations.push({ type: 'stall fallback', description: `tap -> playing ${elapsed} ms` });
  });
});

/* ================================================================== send-path fallbacks (dev hooks) */

test('AC-F9 — a forced remux failure still sends: audio/webm, Voice message.webm, EBML bytes, and it plays', async ({
  page,
}) => {
  await openDev(page);
  await page.waitForFunction(() => !!(window as unknown as { __matrixPoc?: { voice?: unknown } }).__matrixPoc?.voice);
  await page.evaluate(() => {
    (window as unknown as { __matrixPoc: { voice: { forceRemuxFailure: boolean } } }).__matrixPoc.voice.forceRemuxFailure = true;
  });

  const mic = page.getByTestId('composer-mic');
  const bar = page.getByTestId('composer-recording');
  await mic.tap();
  await expect(bar).toHaveAttribute('data-state', 'recording', { timeout: 5_000 });
  await expect(page.getByTestId('recording-timer')).toHaveText('0:03', { timeout: 9_000 });
  await page.getByTestId('recording-send').tap();
  await expect(bar).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('recording-error')).toHaveCount(0);

  const newRow = messageList(page)
    .locator(`[data-testid^="message-"][data-sender="${ALICE}"]`)
    .filter({ has: page.getByTestId('voice-message') })
    .last();
  await expect(newRow).toBeVisible({ timeout: 20_000 });
  const eventId = await settledEventId(newRow);
  const c = (await alice.getEvent(R.dev, eventId)).content as Record<string, any>;
  expect(c.info.mimetype).toBe('audio/webm');
  expect(c['org.matrix.msc1767.file'].mimetype).toBe('audio/webm');
  expect(c['org.matrix.msc1767.file'].name).toBe('Voice message.webm');
  const media = await alice.getMedia(c.url);
  expect(media.magicHex.startsWith('1A 45 DF A3'), `magic ${media.magicHex}`).toBe(true);
  expect(media.bytes.length).toBe(c.info.size);

  const bubble = row(page, eventId).getByTestId('voice-message');
  await row(page, eventId).getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  await expect.poll(() => position(bubble), { timeout: 5_000 }).toBeGreaterThan(0);

  await page.evaluate(() => {
    (window as unknown as { __matrixPoc: { voice: { forceRemuxFailure: boolean } } }).__matrixPoc.voice.forceRemuxFailure = false;
  });
});

test('AC-F10 — encodeToOggOpus passes Ogg and MP4 recordings through unchanged and remuxes real WebM', async ({ page }) => {
  await openDev(page);
  await page.waitForFunction(() => !!(window as unknown as { __matrixPoc?: { voice?: unknown } }).__matrixPoc?.voice);
  const out = await page.evaluate(async (webmBytes) => {
    type Enc = (b: Blob, m?: string) => Promise<{ blob: Blob; mimetype: string }>;
    const enc = (window as unknown as { __matrixPoc: { voice: { encodeToOggOpus: Enc } } }).__matrixPoc.voice.encodeToOggOpus;
    const res: Record<string, { same: boolean; mimetype: string; magic?: string }> = {};
    for (const type of ['audio/ogg', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2']) {
      const input = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type });
      const r = await enc(input);
      res[type] = { same: r.blob === input, mimetype: r.mimetype };
    }
    const webm = new Blob([new Uint8Array(webmBytes)], { type: 'audio/webm;codecs=opus' });
    const r = await enc(webm);
    const head = new Uint8Array(await r.blob.slice(0, 4).arrayBuffer());
    res['audio/webm;codecs=opus'] = { same: r.blob === webm, mimetype: r.mimetype, magic: String.fromCharCode(...head) };
    return res;
  }, [...WEBM_3S]);
  expect(out['audio/ogg']).toEqual({ same: true, mimetype: 'audio/ogg' });
  expect(out['audio/ogg;codecs=opus']).toEqual({ same: true, mimetype: 'audio/ogg' });
  expect(out['audio/mp4']).toEqual({ same: true, mimetype: 'audio/mp4' });
  expect(out['audio/mp4;codecs=mp4a.40.2']).toEqual({ same: true, mimetype: 'audio/mp4' });
  expect(out['audio/webm;codecs=opus']).toEqual({ same: false, mimetype: 'audio/ogg', magic: 'OggS' });
});
