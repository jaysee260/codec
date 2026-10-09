#!/usr/bin/env node
/**
 * Generate the mock GIF provider's fixtures (Phase 4): 8 small, real, animated GIF89a files under
 * `public/gif-fixtures/mock-<n>.gif` (2-3 frames, <= 3 KB each) plus a `mock-<n>.png` still of the first frame.
 * Pure Node (no dependencies): a minimal GIF89a writer with an LZW encoder, an indexed-colour PNG writer, a few
 * shape primitives and a 3x5 digit font so every fixture shows its own number (handy in screenshots).
 * Deterministic: re-running produces identical bytes (AC-G1-3).
 *
 *   npm run gif:fixtures          # (re)writes public/gif-fixtures/*.gif + *.png and prints a size table
 *
 * The catalogue (ids, titles, dimensions, frame counts) lives in `src/lib/gif/mock-fixtures.ts` and is the
 * contract QA and Dev A code against (docs/ARCHITECTURE.md "Mock GIF fixtures"); this script only renders it.
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'gif-fixtures');
const MAX_BYTES = 3 * 1024;

// Imported from the TypeScript catalogue (Node 24 strips types natively; the module is plain TS).
const { MOCK_FIXTURES } = await import('../src/lib/gif/mock-fixtures.ts');

// ---------------------------------------------------------------------------
// GIF89a writer (global colour table, NETSCAPE loop, one GCE + image per frame)
// ---------------------------------------------------------------------------

/** LZW-encode an index stream (omggif's proven encoder, transcribed). Returns the packed sub-blocks. */
function lzwEncode(indices, minCodeSize) {
  const out = [];
  let cur = 0;
  let curShift = 0;
  const blocks = [];
  const flushByte = () => {
    out.push(cur & 0xff);
    cur >>= 8;
    curShift -= 8;
    if (out.length === 255) {
      blocks.push(255, ...out);
      out.length = 0;
    }
  };
  const emit = (code, size) => {
    cur |= code << curShift;
    curShift += size;
    while (curShift >= 8) flushByte();
  };

  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;
  let table = new Map();

  emit(clearCode, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found === undefined) {
      emit(prefix, codeSize);
      if (nextCode === 4096) {
        emit(clearCode, codeSize);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
        table = new Map();
      } else {
        if (nextCode >= 1 << codeSize) codeSize++;
        table.set(key, nextCode++);
      }
      prefix = k;
    } else {
      prefix = found;
    }
  }
  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (curShift > 0) flushByte();
  if (out.length) blocks.push(out.length, ...out);
  blocks.push(0);
  return blocks;
}

const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];

/** @param {{width:number,height:number,palette:number[][],frames:Uint8Array[],delayCs:number}} g */
function encodeGif(g) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  let colorBits = 1;
  while (1 << colorBits < g.palette.length) colorBits++;
  colorBits = Math.max(colorBits, 1);
  const tableSize = 1 << colorBits;
  push(...Buffer.from('GIF89a'));
  push(...u16(g.width), ...u16(g.height), 0x80 | ((colorBits - 1) << 4) | (colorBits - 1), 0, 0);
  for (let i = 0; i < tableSize; i++) {
    const [r, gg, b] = g.palette[i] ?? [0, 0, 0];
    push(r, gg, b);
  }
  // NETSCAPE2.0 loop forever
  push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, ...u16(0), 0x00);
  const minCodeSize = Math.max(2, colorBits);
  for (const frame of g.frames) {
    push(0x21, 0xf9, 0x04, 0x00, ...u16(g.delayCs), 0x00, 0x00); // GCE: no disposal, no transparency
    push(0x2c, ...u16(0), ...u16(0), ...u16(g.width), ...u16(g.height), 0x00);
    push(minCodeSize, ...lzwEncode(frame, minCodeSize));
  }
  push(0x3b);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// PNG writer (indexed colour, one PLTE, filter 0 rows)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, palette, indices) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const plte = Buffer.from(palette.flat());
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Tiny rasteriser
// ---------------------------------------------------------------------------

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h).fill(bg);
  }
  rect(x, y, w, h, c) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px[yy * this.w + xx] = c;
  }
  circle(cx, cy, r, c) {
    const r2 = r * r;
    for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(this.h - 1, Math.ceil(cy + r)); yy++) {
      for (let xx = Math.max(0, Math.floor(cx - r)); xx <= Math.min(this.w - 1, Math.ceil(cx + r)); xx++) {
        const dx = xx - cx;
        const dy = yy - cy;
        if (dx * dx + dy * dy <= r2) this.px[yy * this.w + xx] = c;
      }
    }
  }
  /** 3x5 digit font, scaled. */
  text(str, x, y, scale, c) {
    const FONT = {
      0: ['111', '101', '101', '101', '111'],
      1: ['010', '110', '010', '010', '111'],
      2: ['111', '001', '111', '100', '111'],
      3: ['111', '001', '111', '001', '111'],
      4: ['101', '101', '111', '001', '001'],
      5: ['111', '100', '111', '001', '111'],
      6: ['111', '100', '111', '101', '111'],
      7: ['111', '001', '001', '001', '001'],
      8: ['111', '101', '111', '101', '111'],
      9: ['111', '101', '111', '001', '111'],
    };
    let cx = x;
    for (const ch of str) {
      const glyph = FONT[ch];
      if (glyph) {
        glyph.forEach((row, ry) => {
          [...row].forEach((bit, rx) => {
            if (bit === '1') this.rect(cx + rx * scale, y + ry * scale, scale, scale, c);
          });
        });
      }
      cx += 4 * scale;
    }
  }
}

// Palette shared by all fixtures (8 colours -> 3-bit indices, min code size 3).
const PALETTE = [
  [24, 25, 28], // 0 near-black
  [245, 245, 240], // 1 off-white
  [88, 101, 242], // 2 blurple
  [87, 242, 135], // 3 green
  [254, 231, 92], // 4 yellow
  [237, 66, 69], // 5 red
  [235, 69, 158], // 6 pink
  [0, 168, 252], // 7 blue
];

/** Draw frame `i` of `n` for fixture `n`(1-based). Each pattern is distinct and obviously animated. */
function drawFrame(fx, i, n) {
  const { width: w, height: h } = fx;
  const t = i / n; // 0 .. 1
  const bg = (fx.index % 2 === 0 ? 0 : 1);
  const fg = bg === 0 ? 1 : 0;
  const cv = new Canvas(w, h, bg);
  const accent = 2 + ((fx.index + i) % 6);
  switch (fx.index % 6) {
    case 1: // bouncing ball
      cv.circle(w * (0.2 + 0.6 * t), h * 0.55 - Math.abs(Math.sin(Math.PI * t)) * h * 0.3, Math.min(w, h) * 0.12, accent);
      break;
    case 2: // growing bars (equaliser)
      for (let b = 0; b < 3; b++) {
        const bh = h * (0.2 + 0.6 * Math.abs(Math.sin((b + 1) * 1.3 + t * Math.PI * 2)));
        cv.rect(w * (0.15 + b * 0.25), h - bh, w * 0.18, bh, accent);
      }
      break;
    case 3: // sliding stripes
      for (let s = -2; s < 8; s++) {
        cv.rect(((s + t) * w) / 4, 0, w / 8, h, s % 2 ? accent : bg);
      }
      break;
    case 4: // pulsing ring
      cv.circle(w / 2, h / 2, Math.min(w, h) * (0.2 + 0.25 * t), accent);
      cv.circle(w / 2, h / 2, Math.min(w, h) * (0.1 + 0.2 * t), bg);
      break;
    case 5: // spinning square (orbit)
      cv.rect(w / 2 + Math.cos(t * Math.PI * 2) * w * 0.3 - w * 0.08, h / 2 + Math.sin(t * Math.PI * 2) * h * 0.3 - h * 0.08, w * 0.16, h * 0.16, accent);
      break;
    default: // rising rocket / blinking
      cv.rect(w * 0.42, h * (0.8 - 0.6 * t), w * 0.16, h * 0.25, accent);
      cv.circle(w * 0.5, h * (0.8 - 0.6 * t), w * 0.08, 4 + (i % 2) * 1);
      break;
  }
  const scale = Math.max(2, Math.floor(Math.min(w, h) / 14));
  cv.text(String(fx.index), 2 * scale, 2 * scale, scale, fg);
  return cv.px;
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
let bad = 0;
const rows = [];
for (const fx of MOCK_FIXTURES) {
  const frames = [];
  for (let i = 0; i < fx.frames; i++) frames.push(drawFrame(fx, i, fx.frames));
  const buf = encodeGif({ width: fx.width, height: fx.height, palette: PALETTE, frames, delayCs: fx.delayCs ?? 30 });
  const file = path.join(OUT_DIR, `${fx.id}.gif`);
  writeFileSync(file, buf);
  const png = encodePng(fx.width, fx.height, PALETTE, frames[0]);
  writeFileSync(path.join(OUT_DIR, `${fx.id}.png`), png);
  const size = statSync(file).size;
  if (size > MAX_BYTES) {
    console.warn(`  ${fx.id}.gif is ${size} B (> ${MAX_BYTES})`);
    bad++;
  }
  if (buf.subarray(0, 6).toString('latin1') !== 'GIF89a') bad++;
  rows.push({ id: fx.id, title: fx.title, dims: `${fx.width}x${fx.height}`, frames: fx.frames, gifBytes: size, pngBytes: png.length });
}
console.table(rows);
console.log(`${rows.length} fixtures -> ${path.relative(ROOT, OUT_DIR)}${bad ? `  (${bad} problem(s))` : ''}`);
if (bad) process.exit(1);
