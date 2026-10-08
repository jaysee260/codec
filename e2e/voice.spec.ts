/**
 * QA-9 — voice notes (AC-V1 .. AC-V6 recording/playback halves), `mobile` project only.
 *
 * Runs on `devices['Pixel 7']` with Chromium's fake microphone (`--use-fake-device-for-media-stream`,
 * `--use-fake-ui-for-media-stream`, `permissions: ['microphone']` — see playwright.config.ts and
 * docs/advisor/fake-mic-probe.mjs). The fake device emits a looping tone, so `MediaRecorder` produces
 * real Opus bytes, `decodeAudioData` decodes them and the level meter genuinely moves.
 *
 * Everything the app *claims* to have sent is re-read through the raw client-server API
 * (`fixtures/matrix-api.ts`, no matrix-js-sdk) and the uploaded bytes are downloaded back and checked
 * by their container magic, so a bug in the app's SDK wiring cannot make a test pass.
 *
 * ## Not automatable here (reported as "not run here", checked by the stakeholder on the device)
 *  - **AC-V5-3** the Android runtime permission prompt (Allow / Deny, persistence across restarts).
 *  - **AC-V1-6** (P2) the 120 s auto-stop: two minutes of wall clock per run.
 *  - **AC-V3-7** bar colouring is a visual criterion; the mobile smoke writes the screenshot.
 *
 * ## Waived
 *  - **AC-V2-4** "`info.mimetype` is `audio/ogg` on Chromium". docs/ARCHITECTURE.md "Phase 2 deltas"
 *    records the orchestrator decision: the POC sends the native `MediaRecorder` container with no
 *    transcoding, so Chromium produces `audio/webm`. This spec asserts the mimetype is one of the
 *    three allowed containers *and* that the bytes really are that container (AC-V2-3), which is the
 *    part that protects interop.
 *
 * ## Freshness
 * Nothing here needs a fresh seed: alice's notes are located by the settled event id of the row this
 * run created, bob's by the event id `sendVoice` returns, and no test asserts a message count.
 * Recordings go to `#dev` (the quietest seeded channel); AC-V4-1 uses `#general` because the
 * criterion names it.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs } from './fixtures/auth.ts';
import {
  asUser,
  CONTAINER_FOR_MIMETYPE,
  type ApiUser,
  type MatrixEventJson,
} from './fixtures/matrix-api.ts';
import { resolveRoom, userId, type RoomKey, type UserKey } from './fixtures/seed.ts';
import { messageList, row, settledEventId } from './fixtures/ui.ts';
import { computed, denyMicrophone, expectTapTarget, openNavDrawer, tapRoom } from './fixtures/mobile.ts';

const ALICE = userId('alice');
const BOB = userId('bob');

/** `info.mimetype` values the contract allows (docs/PHASE2_ACCEPTANCE.md AC-V2-2). */
const ALLOWED_MIMETYPES = ['audio/ogg', 'audio/webm', 'audio/mp4'];

const R: Record<'acme' | 'general' | 'dev' | 'random', string> = {
  acme: '',
  general: '',
  dev: '',
  random: '',
};

let alice: ApiUser;
let bob: ApiUser;

test.beforeAll(async () => {
  R.acme = await resolveRoom('acme-hq');
  R.general = await resolveRoom('general');
  R.dev = await resolveRoom('dev');
  R.random = await resolveRoom('random');
  alice = await asUser('alice');
  bob = await asUser('bob');
});

/* ------------------------------------------------------------------ helpers */

/** `m:ss`, the same rule as `formatDuration` in src/lib/matrix/utils.ts. */
function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A non-flat waveform of `n` ints in 0..1024 (bob's notes; the shape is asserted, not the values). */
function makeWaveform(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(((Math.sin(i / 3) + 1) / 2) * 900 + 60));
}

const mic = (page: Page): Locator => page.getByTestId('composer-mic');
const bar = (page: Page): Locator => page.getByTestId('composer-recording');
const timer = (page: Page): Locator => page.getByTestId('recording-timer');
const level = (page: Page): Locator => page.getByTestId('recording-level');
const input = (page: Page): Locator => page.getByTestId('composer-input');

/** Logs in and lands straight in `roomKey` (no drawer needed; `nav.selection` is pre-seeded). */
async function openRoom(page: Page, roomKey: RoomKey, user: UserKey = 'alice'): Promise<string> {
  const roomId = await resolveRoom(roomKey);
  await loginAs(page, user, { selection: { spaceId: R.acme, roomId } });

  // The pre-seeded `nav.selection` can lose a race on a slow initial sync: the room store validates
  // the stored selection against the rooms it knows, and if this room has not arrived in the first
  // `/sync` batch yet it falls back to the space's first channel (#general). Phase 3 makes that
  // window wider — `threadSupport: true` asks Synapse for per-thread unread counts, and #general now
  // carries hundreds of thread replies — so the selection is *verified* and redone through the UI
  // rather than trusted. Seen once in the Wave 8 final `mobile` run on AC-V1-1 (header read
  // "general"); AC-V1-2, which calls this same helper, passed in the same run.
  const header = page.getByTestId('channel-header-name');
  if (!((await header.textContent()) ?? '').includes(roomKey)) {
    await tapRoom(page, roomId, 'channel');
  }
  await expect(header).toContainText(roomKey);
  await expect(messageList(page)).toBeVisible();
  return roomId;
}

/**
 * Taps `composer-mic` and waits until the bar reports `recording`.
 * @returns the wall clock at which recording actually started (for the AC-V2-2 duration window).
 */
async function startRecording(page: Page): Promise<number> {
  await expectTapTarget(mic(page), 'composer-mic');
  await mic(page).tap();
  await expect(bar(page)).toBeVisible({ timeout: 5_000 });
  await expect(bar(page)).toHaveAttribute('data-state', 'recording', { timeout: 5_000 });
  return Date.now();
}

/** Waits until `recording-timer` shows exactly `seconds` (auto-wait, no sleeps). */
async function holdUntil(page: Page, seconds: number): Promise<void> {
  await expect(timer(page)).toHaveText(mmss(seconds * 1000), { timeout: (seconds + 6) * 1000 });
}

/** Rows from `sender` that contain a `voice-message`. */
function voiceRowsFrom(page: Page, sender: string): Locator {
  return messageList(page)
    .locator(`[data-testid^="message-"][data-sender="${sender}"]`)
    .filter({ has: page.getByTestId('voice-message') });
}

/** Event ids of every `m.audio` from `sender` in the room's recent window. */
async function audioIdsOf(roomId: string, sender: string): Promise<string[]> {
  const events = await alice.messages(roomId, 60);
  return events
    .filter(
      (e: MatrixEventJson) =>
        e.type === 'm.room.message' &&
        e.sender === sender &&
        (e.content as { msgtype?: string }).msgtype === 'm.audio',
    )
    .map((e: MatrixEventJson) => e.event_id);
}

/**
 * "No voice note was sent" without a sleep: bob posts a marker and the UI is waited on until the
 * marker row renders — that round trip takes longer than a voice note's encode+upload would have —
 * then alice's set of `m.audio` events is compared against the snapshot taken before.
 *
 * Deliberately *not* "the room tail is unchanged": the suite also redacts events (AC-V4-4), and an
 * `m.room.redaction` is in `/messages` but not in `lastMessage()`, which made that check flap.
 */
async function expectNoVoiceSent(page: Page, roomId: string, before: string[]): Promise<void> {
  const marker = `qa-no-send-${Date.now().toString(36)}`;
  const markerId = await bob.send(roomId, marker);
  await expect(messageList(page).getByText(marker)).toBeVisible({ timeout: 20_000 });

  const after = await audioIdsOf(roomId, ALICE);
  const added = after.filter((id) => !before.includes(id));
  expect(added, `alice must not have sent a voice note (marker ${markerId})`).toEqual([]);
  await expect(bar(page)).toHaveCount(0);
}

/* ================================================================== AC-V1 recording UI */

test('AC-V1-1 — composer-mic is visible on an empty composer, replaced by composer-send once it has text, >= 44 px', async ({
  page,
}) => {
  await openRoom(page, 'dev');

  await expect(mic(page)).toBeVisible();
  await expect(mic(page)).toBeEnabled();
  await expect(mic(page)).toHaveAttribute('data-state', 'idle');
  await expectTapTarget(mic(page), 'composer-mic');

  await input(page).fill('typing makes the mic go away');
  await expect(mic(page)).toBeHidden();
  await expect(page.getByTestId('composer-send')).toBeVisible();

  await input(page).fill('');
  await expect(mic(page)).toBeVisible();
  await expect(page.getByTestId('composer-send')).toBeHidden();
});

test('AC-V1-2 — tapping composer-mic starts recording: bar, hidden input, timer advancing, live level', async ({
  page,
}) => {
  await openRoom(page, 'dev');
  await startRecording(page);

  await expect(input(page)).toBeHidden();
  await expect(page.getByTestId('recording-cancel')).toBeVisible();
  await expect(page.getByTestId('recording-send')).toBeVisible();

  await expect(timer(page)).toHaveText('0:01', { timeout: 4_000 });
  await expect(timer(page)).toHaveText('0:02', { timeout: 4_000 });

  // `recording-level`'s data-level must move while the fake device plays its tone.
  await expect(level(page)).toBeVisible();
  const first = await level(page).getAttribute('data-level');
  expect(Number(first), 'data-level is a number 0..100').toBeGreaterThanOrEqual(0);
  expect(Number(first)).toBeLessThanOrEqual(100);
  await expect
    .poll(() => level(page).getAttribute('data-level'), {
      timeout: 6_000,
      intervals: [100, 200, 300, 500],
      message: `data-level never moved from ${first} (fake microphone tone not reaching the analyser?)`,
    })
    .not.toBe(first);

  await page.getByTestId('recording-cancel').tap();
});

test('AC-V1-3 — recording-cancel discards: bar gone, composer-input back and focused, nothing sent', async ({
  page,
}) => {
  const roomId = await openRoom(page, 'dev');
  const before = await audioIdsOf(roomId, ALICE);

  await startRecording(page);
  await holdUntil(page, 1);
  await page.getByTestId('recording-cancel').tap();

  await expect(bar(page)).toHaveCount(0);
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expectNoVoiceSent(page, roomId, before);
});

test('AC-V1-4 — a recording shorter than 1 s is refused with a toast and nothing is sent', async ({
  page,
}) => {
  const roomId = await openRoom(page, 'dev');
  const before = await audioIdsOf(roomId, ALICE);

  await startRecording(page);
  // No hold at all: send immediately, so the clip is well under a second.
  await page.getByTestId('recording-send').tap();

  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('toast')).toContainText(/short/i);
  await expectNoVoiceSent(page, roomId, before);
});

test('AC-V1-5 — switching room while recording discards the recording', async ({ page }) => {
  const roomId = await openRoom(page, 'dev');
  const before = await audioIdsOf(roomId, ALICE);

  await startRecording(page);
  await holdUntil(page, 1);

  // Phone navigation: the drawer, then #random.
  await openNavDrawer(page);
  await page.getByTestId(`channel-item-${R.random}`).tap();
  await expect(page.getByTestId('channel-header-name')).toContainText('random');

  await expect(bar(page)).toHaveCount(0);
  const after = await audioIdsOf(roomId, ALICE);
  expect(
    after.filter((id) => !before.includes(id)),
    'the abandoned recording must not reach #dev',
  ).toEqual([]);
});

/* ================================================================== AC-V2 sent event */

test('AC-V2-1/2/3 — recording-send produces a contract-shaped m.audio whose bytes match its mimetype', async ({
  page,
}) => {
  const roomId = await openRoom(page, 'dev');
  const existing = await alice.messages(roomId, 40);
  const existingAudio = existing
    .filter((e: MatrixEventJson) => (e.content as { msgtype?: string }).msgtype === 'm.audio')
    .map((e: MatrixEventJson) => e.event_id);

  const startedAt = await startRecording(page);
  await holdUntil(page, 3);
  await page.getByTestId('recording-send').tap();
  const heldMs = Date.now() - startedAt;

  // AC-V2-1: the bar passes through encoding/sending and disappears; the row arrives; the input is back.
  await expect(bar(page)).toHaveCount(0, { timeout: 20_000 });
  const newRow = voiceRowsFrom(page, ALICE).last();
  await expect(newRow).toBeVisible({ timeout: 20_000 });
  await expect(input(page)).toBeVisible();
  const eventId = await settledEventId(newRow);
  expect(existingAudio, 'the row must be a new event').not.toContain(eventId);

  // AC-V2-2: the content, field by field, straight from the homeserver.
  const event = await alice.getEvent(roomId, eventId);
  const c = event.content as Record<string, any>;
  expect(c.msgtype).toBe('m.audio');
  expect(c.body).toBe('Voice message');
  expect(String(c.url)).toMatch(/^mxc:\/\//);
  expect(ALLOWED_MIMETYPES, `info.mimetype ${c.info?.mimetype}`).toContain(c.info?.mimetype);
  expect(String(c.info.mimetype), 'no codec parameters in info.mimetype').not.toMatch(/;/);
  expect(c.info.size).toBeGreaterThan(0);
  expect(Number.isInteger(c.info.duration), `info.duration ${c.info?.duration} is an integer`).toBe(
    true,
  );
  expect(
    Math.abs(c.info.duration - heldMs),
    `info.duration ${c.info.duration} ms vs held ${heldMs} ms`,
  ).toBeLessThanOrEqual(700);
  expect(c['org.matrix.msc1767.audio'].duration).toBe(c.info.duration);
  const waveform = c['org.matrix.msc1767.audio'].waveform as number[];
  expect(Array.isArray(waveform)).toBe(true);
  expect(waveform.length, 'waveform length 30..120').toBeGreaterThanOrEqual(30);
  expect(waveform.length, 'waveform length 30..120').toBeLessThanOrEqual(120);
  expect(
    waveform.every((v) => Number.isInteger(v) && v >= 0 && v <= 1024),
    'waveform ints 0..1024',
  ).toBe(true);
  expect(
    waveform.some((v) => v > 0),
    'waveform must not be silent (the fake mic emits a tone)',
  ).toBe(true);
  expect(c['org.matrix.msc3245.voice']).toEqual({});
  expect(c['org.matrix.msc1767.file'].url).toBe(c.url);
  expect(c['org.matrix.msc1767.file'].mimetype).toBe(c.info.mimetype);
  expect(c['org.matrix.msc1767.text']).toBe('Voice message');

  // AC-V2-3: the uploaded bytes really are the container the event claims.
  const media = await alice.getMedia(c.url as string);
  expect(media.status).toBe(200);
  expect(media.bytes.length, 'downloaded length = info.size').toBe(c.info.size);
  expect(media.container, `magic ${media.magicHex} does not match ${c.info.mimetype}`).toBe(
    CONTAINER_FOR_MIMETYPE[c.info.mimetype as string],
  );
  expect(media.contentType).toContain(String(c.info.mimetype));

  // AC-V2-4 is waived for the POC (see the spec header); record what Chromium actually produced.
  test.info().annotations.push({
    type: 'AC-V2-4 (waived)',
    description: `Chromium recorded ${c.info.mimetype}; bytes are ${media.container} (${media.magicHex}). docs/ARCHITECTURE.md: no transcoding in the POC.`,
  });
});

/* ================================================================== AC-V3 playback bubble */

test('AC-V3-1 — an idle bubble shows play, waveform bars, m:ss duration and a scrubber at 0', async ({
  page,
}) => {
  const durationMs = 3120;
  const sent = await bob.sendVoice(R.dev, { durationMs, waveform: makeWaveform(60) });
  await openRoom(page, 'dev');

  const r = row(page, sent.eventId);
  const bubble = r.getByTestId('voice-message');
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  await expect(bubble).toHaveAttribute('data-state', 'idle');
  await expect(bubble).toHaveAttribute('data-duration-ms', String(durationMs));
  await expect(r.getByTestId('voice-play')).toBeVisible();

  const waveform = bubble.getByTestId('voice-waveform');
  await expect(waveform).toHaveAttribute('data-samples', '60');
  expect(await waveform.locator('> *').count(), 'one bar per waveform sample').toBe(60);

  await expect(bubble.getByTestId('voice-duration')).toHaveText(mmss(durationMs));

  const progress = bubble.getByTestId('voice-progress');
  await expect(progress).toHaveAttribute('aria-valuemax', String(durationMs));
  await expect(progress).toHaveAttribute('aria-valuenow', '0');

  // Phone sizing: 44 px play button, bubble no wider than its row.
  await expectTapTarget(r.getByTestId('voice-play'), 'voice-play');
  const rowBox = (await r.boundingBox())!;
  const bubbleBox = (await bubble.boundingBox())!;
  expect(Math.round(bubbleBox.width), 'bubble <= row width').toBeLessThanOrEqual(
    Math.round(rowBox.width) + 1,
  );
});

test('AC-V3-2/3/4 — play advances, pause holds, resume continues, end returns to idle', async ({
  page,
}) => {
  const durationMs = 3120;
  const sent = await bob.sendVoice(R.dev, { durationMs });
  await openRoom(page, 'dev');

  const r = row(page, sent.eventId);
  const bubble = r.getByTestId('voice-message');
  await expect(bubble).toBeVisible({ timeout: 20_000 });

  // AC-V3-2
  await r.getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  await expect(r.getByTestId('voice-pause')).toBeVisible();
  await expect(r.getByTestId('voice-play')).toHaveCount(0);
  const firstPos = Number(await bubble.getAttribute('data-position-ms'));
  await expect
    .poll(async () => Number(await bubble.getAttribute('data-position-ms')), {
      timeout: 6_000,
      intervals: [100, 200, 300],
      message: 'data-position-ms did not advance while playing',
    })
    .toBeGreaterThan(firstPos);
  expect(
    Number(await bubble.getByTestId('voice-progress').getAttribute('aria-valuenow')),
    'aria-valuenow follows the position',
  ).toBeGreaterThan(0);
  await expect(bubble.getByTestId('voice-duration')).not.toHaveText(mmss(durationMs));

  // AC-V3-3
  await r.getByTestId('voice-pause').tap();
  await expect(bubble).toHaveAttribute('data-state', 'paused', { timeout: 5_000 });
  const paused = Number(await bubble.getAttribute('data-position-ms'));
  expect(
    Number(await bubble.getAttribute('data-position-ms')),
    'the position must not move while paused',
  ).toBe(paused);
  await r.getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  expect(
    Number(await bubble.getAttribute('data-position-ms')),
    `resume must continue from >= ${paused}`,
  ).toBeGreaterThanOrEqual(paused - 100);

  // AC-V3-4
  await expect(bubble).toHaveAttribute('data-state', 'idle', { timeout: durationMs + 15_000 });
  await expect(bubble).toHaveAttribute('data-position-ms', '0');
  await expect(bubble.getByTestId('voice-duration')).toHaveText(mmss(durationMs));
});

test('AC-V3-5 — setting voice-progress to half the duration seeks there', async ({ page }) => {
  const durationMs = 4000;
  const sent = await bob.sendVoice(R.dev, { durationMs });
  await openRoom(page, 'dev');

  const bubble = row(page, sent.eventId).getByTestId('voice-message');
  await expect(bubble).toBeVisible({ timeout: 20_000 });

  const target = Math.round(durationMs / 2);
  await bubble.getByTestId('voice-progress').evaluate((el, value) => {
    const range = el as HTMLInputElement;
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, target);

  await expect
    .poll(async () => Number(await bubble.getAttribute('data-position-ms')), { timeout: 5_000 })
    .toBeGreaterThan(target - 300);
  expect(Number(await bubble.getAttribute('data-position-ms'))).toBeLessThan(target + 300);
});

test('AC-V3-6 (P1) — playing a second note pauses the first', async ({ page }) => {
  const a = await bob.sendVoice(R.dev, { durationMs: 4000 });
  const b = await bob.sendVoice(R.dev, { durationMs: 4000 });
  await openRoom(page, 'dev');

  const first = row(page, a.eventId).getByTestId('voice-message');
  const second = row(page, b.eventId).getByTestId('voice-message');
  await expect(second).toBeVisible({ timeout: 20_000 });

  await row(page, a.eventId).getByTestId('voice-play').tap();
  await expect(first).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  await row(page, b.eventId).getByTestId('voice-play').tap();
  await expect(second).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  await expect(first).toHaveAttribute('data-state', 'paused', { timeout: 5_000 });
});

/* ================================================================== AC-V4 received notes */

test('AC-V4-1/2 — a note bob posts via the API renders live with 50 bars and 0:02, and plays', async ({
  page,
}) => {
  await openRoom(page, 'general');
  // AC-V4-1 names e2e/fixtures/test-voice.wav (1.5 s, audio/wav, hand-made 50-sample waveform).
  const sent = await bob.sendVoice(R.general, {
    file: 'e2e/fixtures/test-voice.wav',
    durationMs: 1500,
    mimetype: 'audio/wav',
    waveform: makeWaveform(50),
  });

  // No reload: the row must arrive over /sync.
  const r = row(page, sent.eventId);
  await expect(r).toBeVisible({ timeout: 20_000 });
  await expect(r).toHaveAttribute('data-sender', BOB);
  const bubble = r.getByTestId('voice-message');
  await expect(bubble).toBeVisible();
  await expect(bubble.getByTestId('voice-duration')).toHaveText('0:02');
  await expect(bubble.getByTestId('voice-waveform')).toHaveAttribute('data-samples', '50');
  expect(await bubble.getByTestId('voice-waveform').locator('> *').count()).toBe(50);

  // AC-V4-2: AC-V3-2 then AC-V3-4 for someone else's note.
  await r.getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });
  await expect
    .poll(async () => Number(await bubble.getAttribute('data-position-ms')), { timeout: 6_000 })
    .toBeGreaterThan(0);
  await expect(bubble).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await expect(bubble).toHaveAttribute('data-position-ms', '0');
});

test('AC-V4-3 (P1) — a plain m.audio without msc3245/waveform still renders flat bars, plays, and previews as [audio]', async ({
  page,
}) => {
  const sent = await bob.sendVoice(R.dev, { durationMs: 2000, voice: false, msc1767: false });
  await openRoom(page, 'dev');

  const r = row(page, sent.eventId);
  const bubble = r.getByTestId('voice-message');
  await expect(bubble).toBeVisible({ timeout: 20_000 });

  // "flat bars when []": every bar the same height, and at least a few of them. The *number* of
  // placeholder bars is Dev B's choice — the registry only pins `data-samples` to the bar count.
  const waveform = bubble.getByTestId('voice-waveform');
  const heights = await waveform.locator('> *').evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10),
  );
  expect(heights.length, 'a waveform-less note still draws bars').toBeGreaterThan(0);
  expect(new Set(heights).size, `bars must be flat, got heights ${[...new Set(heights)].join(', ')}`).toBe(1);
  expect(
    Number(await waveform.getAttribute('data-samples')),
    'data-samples equals the bar count',
  ).toBe(heights.length);

  await r.getByTestId('voice-play').tap();
  await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 5_000 });

  // previewText: `[audio] <body>` for a non-voice audio file.
  const reply = await bob.send(R.dev, `qa-audio-preview-${Date.now().toString(36)}`, {
    'm.relates_to': { 'm.in_reply_to': { event_id: sent.eventId } },
  });
  await expect(row(page, reply).getByTestId('message-reply-quote')).toContainText('[audio]', {
    timeout: 20_000,
  });
});

test('AC-V4-4 — a redacted voice message shows message-redacted, no bubble, no console error', async ({
  page,
}) => {
  const errors: string[] = [];
  const notFound: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // "Failed to load resource: ... 404" carries no URL in the console message, so it is judged
    // through `page.on('response')` below instead (the same trick as scripts/verify-phone-shell.mjs).
    if (m.type() === 'error' && !/Failed to load resource|msc4143|rtc\/transports/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() === 404) notFound.push(res.url());
  });

  const sent = await bob.sendVoice(R.dev, { durationMs: 2000 });
  await openRoom(page, 'dev');
  const r = row(page, sent.eventId);
  await expect(r.getByTestId('voice-message')).toBeVisible({ timeout: 20_000 });

  await bob.redact(R.dev, sent.eventId, 'qa AC-V4-4');
  await expect(r.getByTestId('message-redacted')).toBeVisible({ timeout: 20_000 });
  await expect(r.getByTestId('voice-message')).toHaveCount(0);
  expect(errors, 'no page/console errors while redacting a voice note').toEqual([]);
  // The SDK probes /org.matrix.msc4143/rtc/transports once per startClient and it 404s by design
  // (docs/ARCHITECTURE.md). Anything else 404ing — a media fetch for the redacted note — is a bug.
  expect(
    notFound.filter((u) => !/msc4143|rtc\/transports/.test(u)),
    'no unexpected 404 while redacting a voice note',
  ).toEqual([]);
});

/* ================================================================== AC-V5 errors */

test('AC-V5-1 — a denied microphone shows recording-error, marks composer-mic denied, keeps the input usable', async ({
  page,
}) => {
  await denyMicrophone(page); // addInitScript, before the first navigation
  await openRoom(page, 'dev');

  await mic(page).tap();
  const error = page.getByTestId('recording-error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(error).toContainText(/microphone/i);
  await expect(error).toContainText(/denied|permission|allow|settings/i);
  await expect(mic(page)).toHaveAttribute('data-state', 'denied', { timeout: 5_000 });

  // The composer still works.
  await input(page).fill('still typing after a denied mic');
  await expect(input(page)).toHaveValue('still typing after a denied mic');
  await input(page).fill('');
});

test('AC-V5-2 — a failing upload shows recording-error, recording-send retries, recording-cancel discards', async ({
  page,
}) => {
  const roomId = await openRoom(page, 'dev');
  const before = await audioIdsOf(roomId, ALICE);

  let uploads = 0;
  await page.route('**/_matrix/media/v3/upload*', async (route) => {
    uploads += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'QA injected upload failure' }),
    });
  });

  await startRecording(page);
  await holdUntil(page, 2);
  await page.getByTestId('recording-send').tap();

  await expect(bar(page)).toHaveAttribute('data-state', 'error', { timeout: 20_000 });
  await expect(page.getByTestId('recording-error')).toContainText(/upload/i);
  expect(uploads, 'the upload was attempted').toBeGreaterThan(0);

  // Retry hits the route again (still 500), then cancel discards and nothing was sent.
  await page.getByTestId('recording-send').tap();
  await expect
    .poll(() => uploads, { timeout: 15_000, message: 'recording-send did not retry the upload' })
    .toBeGreaterThan(1);
  await expect(bar(page)).toHaveAttribute('data-state', 'error', { timeout: 20_000 });

  await page.getByTestId('recording-cancel').tap();
  await expect(bar(page)).toHaveCount(0);
  // The route is deliberately left installed for the rest of the test (it dies with the page): if the
  // cancel left a retry in flight, un-routing here would let it reach the real media repo and the
  // note would land *after* the criterion said it was discarded. Keeping the 500 means
  // `expectNoVoiceSent` judges the product, not the timing of this teardown.
  await expectNoVoiceSent(page, roomId, before);
});

test('AC-V5-4 — a voice note whose media 404s shows voice-error with a download link, no uncaught error', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // A well-formed mxc the media repo has never stored: the download really 404s.
  const sent = await bob.sendVoice(R.dev, { durationMs: 2000, url: 'bogus' });
  const probe = await alice.getMedia(sent.mxc);
  expect(probe.status, 'the bogus mxc must not resolve').toBeGreaterThanOrEqual(400);

  await openRoom(page, 'dev');
  const r = row(page, sent.eventId);
  const bubble = r.getByTestId('voice-message');
  await expect(bubble).toBeVisible({ timeout: 20_000 });

  await r.getByTestId('voice-play').tap();
  await expect(r.getByTestId('voice-error')).toBeVisible({ timeout: 15_000 });
  await expect(r.getByTestId('voice-error')).toContainText(/can.?t play/i);
  await expect(r.getByTestId('voice-error').locator('a')).toHaveAttribute('href', /.+/);
  await expect(bubble).toHaveAttribute('data-state', 'error');
  expect(errors, 'no uncaught exception on a 404 voice note').toEqual([]);
});

/* ================================================================== AC-V6 (composer half) */

test('AC-V6-1 — phone composer: bottom-anchored, safe-area padding, 16 px input, 44 px buttons', async ({
  page,
}) => {
  await openRoom(page, 'dev');

  const shellBox = (await page.getByTestId('app-shell').boundingBox())!;
  const composerBox = (await page.getByTestId('composer').boundingBox())!;
  expect(
    Math.abs(shellBox.y + shellBox.height - (composerBox.y + composerBox.height)),
    'composer bottom edge == app-shell bottom edge',
  ).toBeLessThanOrEqual(1);

  const safeBottom = await page.evaluate(
    () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0,
  );
  const paddingBottom = parseFloat(await computed(page.getByTestId('composer'), 'padding-bottom'));
  expect(
    paddingBottom,
    `composer padding-bottom >= --safe-bottom (${safeBottom}px)`,
  ).toBeGreaterThanOrEqual(safeBottom);

  expect(
    parseFloat(await computed(input(page), 'font-size')),
    'composer-input font-size >= 16px',
  ).toBeGreaterThanOrEqual(16);

  await expectTapTarget(page.getByTestId('composer-attach'), 'composer-attach');
  await expectTapTarget(mic(page), 'composer-mic');
  await input(page).fill('x');
  await expectTapTarget(page.getByTestId('composer-send'), 'composer-send');
  await input(page).fill('');
});

/* ================================================================== AC-V2-5 cross-client */

test.describe('cross-client (AC-V2-5, P1)', () => {
  // Desktop *context* options only — `devices['Desktop Chrome']` carries `defaultBrowserType`,
  // which Playwright refuses inside a describe.
  test.use({ viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('AC-V2-5 — a note alice sent renders and plays for bob on desktop', async ({ page }) => {
    // Alice's newest *voice* note in #dev, but only when it is still inside the initial sync window
    // bob will get. Phase 3 made that caveat necessary: #dev now absorbs the Principal's thread
    // tooling (`npm run thread:sample`, the 40-reply pagination fixtures), so a note from earlier in
    // the session can be hundreds of events back — bob's first render then has no row for it at all
    // and the criterion fails for a seed-window reason, not a product one (QA-17 gate triage).
    // A note must also carry `org.matrix.msc3245.voice`: a plain `m.audio` renders as `message-file`
    // by design (AC-V4-3), and this suite posts those too.
    const WINDOW = 25;
    const recent = await alice.messages(R.dev, WINDOW);
    let target = recent.find(
      (e: MatrixEventJson) =>
        e.sender === ALICE &&
        (e.content as { msgtype?: string }).msgtype === 'm.audio' &&
        !!(e.content as { url?: string }).url &&
        !!(e.content as Record<string, unknown>)['org.matrix.msc3245.voice'],
    );
    if (!target) {
      const sent = await alice.sendVoice(R.dev, { durationMs: 2500 });
      target = await alice.getEvent(R.dev, sent.eventId);
    }

    await loginAs(page, 'bob', { selection: { spaceId: R.acme, roomId: R.dev } });
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'desktop');

    // AC-V1-1's desktop half: the criterion says "any room (phone or desktop)".
    await expect(mic(page)).toBeVisible();
    await input(page).fill('desktop text hides the mic');
    await expect(mic(page)).toBeHidden();
    await expect(page.getByTestId('composer-send')).toBeVisible();
    await input(page).fill('');
    await expect(mic(page)).toBeVisible();

    const r = row(page, target.event_id);
    await r.scrollIntoViewIfNeeded().catch(() => undefined);
    const bubble = r.getByTestId('voice-message');
    await expect(bubble).toBeVisible({ timeout: 20_000 });
    await expect(bubble.getByTestId('voice-waveform')).toBeVisible();

    // AC-V3-2 for the other client.
    await r.getByTestId('voice-play').click();
    await expect(bubble).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    await expect
      .poll(async () => Number(await bubble.getAttribute('data-position-ms')), { timeout: 8_000 })
      .toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'cross-client',
      description: `bob (desktop) played alice's ${(target.content as { info?: { mimetype?: string } }).info?.mimetype} note ${target.event_id}`,
    });
  });
});

test.afterAll(() => {
  test.info().annotations.push({
    type: 'not run here',
    description:
      'AC-V5-3 (Android permission prompt), AC-V1-6 (120 s auto-stop) and AC-V3-7 (bar colours, see e2e/demo-mobile/) are manual/device criteria. AC-V2-4 is waived (docs/ARCHITECTURE.md Phase 2 deltas).',
  });
});
