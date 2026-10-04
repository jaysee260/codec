/**
 * Generates the binary/text upload fixtures used by the upload criteria (AC-B8-2, AC-B8-3) and the
 * voice criteria (AC-V4-1).
 *
 *   node e2e/fixtures/make-test-assets.mjs      # npm run test:e2e:fixtures
 *
 * Writes (idempotent, byte-stable so re-running never dirties git):
 *   e2e/fixtures/test-image.png  120x80 RGB PNG, magenta/indigo checkerboard with a border
 *   e2e/fixtures/test-file.txt   small text file for the m.file path
 *   e2e/fixtures/test-voice.wav  1.5 s, 16 kHz mono PCM16 WAV, the file AC-V4-1 names
 *
 * Pure Node (zlib + CRC32), no dependencies, no network, no ffmpeg (there is none on this machine).
 * The WAV generator is the same algorithm as `ApiUser.sendVoice` (`e2e/fixtures/matrix-api.ts`) and
 * `scripts/send-voice-sample.mjs`, so the bytes match whichever path posts them.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const IMAGE_WIDTH = 120;
export const IMAGE_HEIGHT = 80;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @returns {Buffer} a deterministic RGB PNG of the given size. */
export function makePng(width = IMAGE_WIDTH, height = IMAGE_HEIGHT) {
  // One filter byte (0 = none) + RGB triplets per scanline.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const isBorder = x < 4 || y < 4 || x >= width - 4 || y >= height - 4;
      const isCheck = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
      const [r, g, b] = isBorder ? [242, 243, 245] : isCheck ? [217, 70, 239] : [88, 101, 242];
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEXT_CONTENT = [
  'matrix-poc e2e upload fixture',
  'Used by AC-B8-3: selecting a non-image file must render an m.file download link.',
  '',
].join('\n');

function writeIfChanged(file, buf) {
  if (existsSync(file) && readFileSync(file).equals(buf)) {
    console.log(`unchanged ${file}`);
    return;
  }
  writeFileSync(file, buf);
  console.log(`wrote     ${file} (${buf.length} bytes)`);
}

/** Length of `test-voice.wav` in ms (AC-V4-1: "1.5 s" -> `formatDuration` renders `0:02`). */
export const VOICE_DURATION_MS = 1500;
const VOICE_SAMPLE_RATE = 16_000;

/**
 * @returns {Buffer} 16-bit PCM mono WAV: a short melody with gaps so the computed waveform has
 * distinct bumps instead of a flat line. Mirrors `generateWav()` in `e2e/fixtures/matrix-api.ts`.
 */
export function makeWav(durationMs = VOICE_DURATION_MS, sampleRate = VOICE_SAMPLE_RATE) {
  const total = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const pcm = new Int16Array(total);
  const notes = [440, 0, 523.25, 587.33, 0, 659.25, 0, 783.99, 659.25, 0, 523.25, 440];
  const noteLen = total / notes.length;
  for (let i = 0; i < total; i += 1) {
    const n = Math.min(notes.length - 1, Math.floor(i / noteLen));
    const f = notes[n];
    if (!f) continue;
    const t = i / sampleRate;
    const pos = (i - n * noteLen) / noteLen;
    const env = Math.sin(Math.PI * pos) ** 0.6 * (0.35 + (0.45 * ((n * 7) % 5)) / 4);
    const s = Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * env * 32767)));
  }
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return buf;
}

writeIfChanged(join(HERE, 'test-image.png'), makePng());
writeIfChanged(join(HERE, 'test-file.txt'), Buffer.from(TEXT_CONTENT, 'utf8'));
writeIfChanged(join(HERE, 'test-voice.wav'), makeWav());
