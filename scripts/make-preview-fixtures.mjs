#!/usr/bin/env node
/**
 * Generate the link-preview fixture images (Phase 6): `public/preview-fixtures/hero.png` (1200x630, landscape,
 * what a news article's og:image looks like) and `thumb.png` (128x128, a small square favicon-style image).
 * Pure Node (no dependencies): a minimal truecolour PNG writer. Deterministic: re-running produces identical bytes.
 *
 *   npm run preview:fixtures      # (re)writes public/preview-fixtures/*.png and prints their sizes
 *
 * The HTML pages next to them (`article.html`, `square.html`, `title-only.html`, `empty.html`, `long.html`) are
 * hand-written and reference the images by root-relative path, so they work on any Vite port (Synapse rebases
 * og:image against the page URL). The test Synapse can fetch them because the committed homeserver.yaml
 * whitelists 127.0.0.1 for url previews (docs/ARCHITECTURE.md "Phase 6 deltas").
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'preview-fixtures');

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** `pixel(x, y) -> [r, g, b]`; 8-bit RGB, filter 0 on every row. */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Diagonal teal -> indigo gradient with a white rounded "card" in the middle (reads as a hero image at any size). */
function hero(x, y) {
  const W = 1200;
  const H = 630;
  const inCard = x > 300 && x < 900 && y > 215 && y < 415 && !((x < 324 || x > 876) && (y < 239 || y > 391));
  if (inCard) return [250, 250, 252];
  const t = (x / W + y / H) / 2;
  return [lerp(20, 76, t), lerp(150, 29, t), lerp(170, 149, t)];
}

/** Square: concentric amber rings on a dark background (a logo-like thumbnail). */
function thumb(x, y) {
  const d = Math.hypot(x - 63.5, y - 63.5);
  if (d < 18 || (d > 30 && d < 42)) return [245, 158, 11];
  return [24, 24, 32];
}

mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ['hero.png', encodePng(1200, 630, hero)],
  ['thumb.png', encodePng(128, 128, thumb)],
];
for (const [name, bytes] of files) {
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, bytes);
  console.log(`${path.relative(ROOT, file)}  ${statSync(file).size} bytes`);
}
