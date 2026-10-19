/**
 * QA (voice format): the WebM/Opus -> Ogg/Opus remuxer, in Node, no browser page.
 * docs/archive/VOICE_FORMAT_PLAN.md decision 1 / AC-F1..F3 ("lossless remux, no re-encoding"). Runs in the
 * `mobile` project only (playwright.config.ts) so `--project=mobile` covers the whole voice feature.
 *
 * Input: real Chromium MediaRecorder recordings of the fake-mic tone (`e2e/fixtures/chromium-1s.webm`,
 * `chromium-3s.webm`, 60 ms Opus frames). Output is judged by `fixtures/ogg.ts`, an independent
 * RFC 3533 / RFC 7845 reader (own CRC, own lacing, own TOC sample count), never by the remuxer itself.
 *
 * What a correct remux must give (RFC 7845):
 *  - page 0: BOS, exactly one packet `OpusHead`, granule 0, the packet ends the page;
 *  - the next page(s): `OpusTags` starting on a fresh page, granule 0; audio starts on a fresh page;
 *  - every page: `OggS`, version 0, one serial, sequence 0..n with no gap, stored CRC == computed CRC;
 *  - only the last page has EOS; granules never go backwards;
 *  - the audio packets are byte-for-byte the WebM frames, in order (lossless);
 *  - each audio page's granule == pre-skip + samples of every packet completed so far (the last page
 *    may trim at most one frame); so the final granule ~= duration * 48000 + pre-skip.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { remuxWebmOpusToOgg } from '../src/lib/audio/ogg.ts';
import {
  opusPacketSamples,
  parseOggPages,
  readOpusHead,
  readWebmOpus,
  type OggParse,
} from './fixtures/ogg.ts';

const FIXTURES = [
  { file: 'e2e/fixtures/chromium-1s.webm', approxSeconds: 1 },
  { file: 'e2e/fixtures/chromium-3s.webm', approxSeconds: 3 },
];

const load = (file: string): Uint8Array => new Uint8Array(readFileSync(file));

/** Every RFC 7845 structural rule above; returns the parse for further checks. */
function expectWellFormedOpusOgg(out: Uint8Array, label: string): OggParse {
  expect(out.length, `${label}: output is not empty`).toBeGreaterThan(0);
  expect(String.fromCharCode(...out.subarray(0, 4)), `${label}: starts with OggS`).toBe('OggS');
  const ogg = parseOggPages(out);
  const { pages } = ogg;
  expect(ogg.trailing, `${label}: no bytes after the last page`).toBe(0);
  expect(pages.length, `${label}: head + tags + at least one audio page`).toBeGreaterThanOrEqual(3);

  const serial = pages[0].serial;
  pages.forEach((p, i) => {
    expect(p.version, `${label}: page ${i} version`).toBe(0);
    expect(p.crcStored, `${label}: page ${i} CRC (stored 0x${p.crcStored.toString(16)} vs computed 0x${p.crcComputed.toString(16)})`).toBe(p.crcComputed);
    expect(p.serial, `${label}: page ${i} serial`).toBe(serial);
    expect(p.sequence, `${label}: page ${i} sequence number`).toBe(i);
    expect(p.bos, `${label}: BOS only on page 0 (page ${i})`).toBe(i === 0);
    expect(p.eos, `${label}: EOS only on the last page (page ${i})`).toBe(i === pages.length - 1);
    expect(p.length, `${label}: page ${i} <= 65307 bytes`).toBeLessThanOrEqual(65_307);
    if (i > 0) {
      expect(p.continued, `${label}: page ${i} continued-flag matches the previous page`).toBe(pages[i - 1].endsMidPacket);
      if (p.granule !== -1n && pages[i - 1].granule !== -1n) {
        expect(p.granule >= pages[i - 1].granule, `${label}: granule never goes backwards (page ${i})`).toBe(true);
      }
    }
  });

  // Header pages.
  const head = pages[0];
  expect(head.completedPackets.length, `${label}: page 0 holds exactly one packet`).toBe(1);
  expect(head.endsMidPacket).toBe(false);
  expect(head.granule, `${label}: OpusHead page granule`).toBe(0n);
  readOpusHead(head.completedPackets[0]); // throws if it is not OpusHead

  expect(pages[1].continued, `${label}: OpusTags starts on a fresh page`).toBe(false);
  const tags = ogg.packets[1];
  expect(String.fromCharCode(...tags.subarray(0, 8)), `${label}: second packet is OpusTags`).toBe('OpusTags');
  const tv = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
  const vendorLen = tv.getUint32(8, true);
  expect(12 + vendorLen, `${label}: OpusTags vendor string fits`).toBeLessThanOrEqual(tags.length);
  tv.getUint32(8 + 4 + vendorLen, true); // comment count readable

  // The page that completes OpusTags must end exactly there, and carry granule 0.
  let tagsPageIdx = 1;
  while (pages[tagsPageIdx].completedPackets.length === 0) tagsPageIdx += 1;
  const tagsPage = pages[tagsPageIdx];
  expect(tagsPage.completedPackets.length, `${label}: OpusTags is alone on its last page`).toBe(1);
  expect(tagsPage.endsMidPacket).toBe(false);
  for (let i = 1; i <= tagsPageIdx; i += 1) {
    expect(pages[i].granule === 0n || pages[i].granule === -1n, `${label}: tags page ${i} granule`).toBe(true);
  }
  expect(pages[tagsPageIdx + 1].continued, `${label}: audio starts on a fresh page`).toBe(false);
  return ogg;
}

for (const fx of FIXTURES) {
  test(`remux ${fx.file}: well-formed Ogg/Opus, every CRC valid, lossless packets, granules exact`, () => {
    const input = load(fx.file);
    const pristine = input.slice();
    const webm = readWebmOpus(input);
    expect(webm.codecId).toBe('A_OPUS');
    expect(webm.frames.length).toBeGreaterThan(0);

    const out = remuxWebmOpusToOgg(input);
    expect(Buffer.from(input).equals(Buffer.from(pristine)), 'the input bytes are not mutated').toBe(true);

    const ogg = expectWellFormedOpusOgg(out, fx.file);
    const opusHead = readOpusHead(ogg.packets[0]);
    const srcHead = readOpusHead(webm.codecPrivate!);
    expect(opusHead.version, 'OpusHead version 1').toBe(1);
    expect(opusHead.channels, 'channels carried over from CodecPrivate').toBe(srcHead.channels);
    expect(opusHead.preSkip, 'pre-skip carried over from CodecPrivate').toBe(srcHead.preSkip);
    expect(opusHead.inputSampleRate).toBe(srcHead.inputSampleRate);
    expect(opusHead.mappingFamily).toBe(0);

    // Lossless: the audio packets are the WebM frames, byte for byte, in order.
    const audio = ogg.packets.slice(2);
    expect(audio.length, 'one Ogg packet per WebM frame').toBe(webm.frames.length);
    audio.forEach((p, i) => {
      expect(Buffer.from(p).equals(Buffer.from(webm.frames[i])), `audio packet ${i} == WebM frame ${i}`).toBe(true);
    });

    // Granules: pre-skip + cumulative samples of the packets completed on or before each page.
    const totalSamples = webm.frames.reduce((a, f) => a + opusPacketSamples(f), 0);
    let cumulative = 0;
    let packetIdx = 0;
    const audioPages = ogg.pages.filter((p) => p.completedPackets.length > 0).slice(2);
    // Header packets are on the first pages; walk audio packets page by page.
    for (const [i, page] of audioPages.entries()) {
      for (const _ of page.completedPackets) {
        cumulative += opusPacketSamples(audio[packetIdx]);
        packetIdx += 1;
      }
      const expected = BigInt(opusHead.preSkip + cumulative);
      if (i < audioPages.length - 1) {
        expect(page.granule, `audio page granule (page seq ${page.sequence})`).toBe(expected);
      }
    }
    expect(cumulative).toBe(totalSamples);
    const finalGranule = Number(ogg.pages[ogg.pages.length - 1].granule);
    expect(finalGranule, 'final granule <= pre-skip + all samples').toBeLessThanOrEqual(opusHead.preSkip + totalSamples);
    expect(finalGranule, 'final granule trims at most one 120 ms frame').toBeGreaterThanOrEqual(
      opusHead.preSkip + totalSamples - 5760,
    );
    const seconds = (finalGranule - opusHead.preSkip) / 48_000;
    expect(Math.abs(seconds - fx.approxSeconds), `decoded length ${seconds}s vs ~${fx.approxSeconds}s`).toBeLessThanOrEqual(0.25);
    test.info().annotations.push({
      type: 'remux',
      description: `${fx.file}: ${input.length} B webm -> ${out.length} B ogg, ${ogg.pages.length} pages, ${audio.length} packets, final granule ${finalGranule} (pre-skip ${opusHead.preSkip}, ${seconds.toFixed(3)} s)`,
    });
  });
}

test('remux of a WebM cut mid-cluster either throws or still yields a well-formed Ogg', () => {
  const input = load('e2e/fixtures/chromium-3s.webm');
  const cut = input.slice(0, Math.floor(input.length * 0.6));
  let out: Uint8Array | undefined;
  try {
    out = remuxWebmOpusToOgg(cut);
  } catch {
    return; // throwing is fine: encodeToOggOpus then sends the original
  }
  const ogg = expectWellFormedOpusOgg(out, 'truncated webm');
  const frames = readWebmOpus(cut).frames;
  expect(ogg.packets.length - 2, 'no more audio packets than complete frames in the input').toBeLessThanOrEqual(frames.length);
});

test('remux rejects input that is not WebM/Opus', () => {
  const random = new Uint8Array(4096);
  let seed = 1234567;
  for (let i = 0; i < random.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    random[i] = seed >>> 24;
  }
  const webm = load('e2e/fixtures/chromium-3s.webm');
  const cases: Record<string, Uint8Array> = {
    empty: new Uint8Array(0),
    'random bytes': random,
    'a WAV file': load('e2e/fixtures/test-voice.wav'),
    'a PNG': load('e2e/fixtures/test-image.png'),
    'an Ogg file (already remuxed)': remuxWebmOpusToOgg(webm),
    'EBML header only (no tracks, no frames)': webm.slice(0, 40),
    'EBML magic then garbage': (() => {
      const b = random.slice();
      b.set([0x1a, 0x45, 0xdf, 0xa3], 0);
      return b;
    })(),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    expect(() => remuxWebmOpusToOgg(bytes), `${name} must throw`).toThrow();
  }
});
