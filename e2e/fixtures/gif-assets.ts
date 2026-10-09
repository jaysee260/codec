/**
 * Byte sources for the GIF suites (QA-19, Phase 4).
 *
 * The `klipy` code path is tested against `page.route` stubs, so the stubbed CDN has to answer with
 * *real* image bytes: a browser that gets JSON back from an `<img src>` fires `error`, which would
 * make every "the GIF renders" assertion fail for the wrong reason. Rather than embed a second
 * encoder here, the stub re-serves the Principal's own mock fixtures
 * (`public/gif-fixtures/<id>.gif`, `npm run gif:fixtures`) — they are animated GIF89a, < 5 KB, and
 * they are already on disk for the `mock` provider.
 *
 * Content-Type vs extension: the stub answers a `.../sm.webp` URL with GIF bytes and
 * `image/gif`. That is deliberate — Chrome sniffs image bytes and renders them regardless of the
 * URL's extension, so one byte source covers every variant Klipy would hand us. The tests that care
 * about *which* variant was chosen assert on the URL in the event, never on the bytes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where `scripts/make-gif-fixtures.mjs` writes the mock fixtures (Principal-owned). */
export const FIXTURE_DIR = resolve(HERE, '../../public/gif-fixtures');

export const FIXTURE_HINT =
  'public/gif-fixtures is missing or stale — run `npm run gif:fixtures` (PRIN-13) before the GIF suites';

const cache = new Map<string, Buffer>();

function readFixture(file: string): Buffer {
  const cached = cache.get(file);
  if (cached) return cached;
  const path = resolve(FIXTURE_DIR, file);
  if (!existsSync(path)) throw new Error(`${path} not found. ${FIXTURE_HINT}`);
  const bytes = readFileSync(path);
  cache.set(file, bytes);
  return bytes;
}

/** Animated GIF89a bytes for a fixture id (`mock-1`), straight off disk. */
export function fixtureGifBytes(id = 'mock-1'): Buffer {
  return readFixture(`${id}.gif`);
}

/** First-frame PNG for a fixture id, or `undefined` when the generator has not written the stills yet. */
export function fixtureStillBytes(id = 'mock-1'): Buffer | undefined {
  try {
    return readFixture(`${id}.png`);
  } catch {
    return undefined;
  }
}

/** True when `<id>.gif` exists on disk (the suites report a clear skip instead of a locator miss). */
export function hasFixtureGif(id = 'mock-1'): boolean {
  return existsSync(resolve(FIXTURE_DIR, `${id}.gif`));
}

/** `GIF89a` / `GIF87a` magic plus at least `frames` image descriptors (AC-G1-3). */
export function describeGif(bytes: Uint8Array): {
  magic: string;
  width: number;
  height: number;
  imageDescriptors: number;
  animated: boolean;
} {
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 6));
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  // Image descriptors start with 0x2C. Counting raw occurrences would also hit payload bytes, so walk
  // the block structure properly: after the header/LSD/GCT, GIF is a flat list of blocks.
  let i = 13 + (bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 0x07) + 1)) : 0);
  let descriptors = 0;
  const skipSubBlocks = (): void => {
    for (;;) {
      const len = bytes[i]!;
      i += 1;
      if (!len || i >= bytes.length) return;
      i += len;
    }
  };
  while (i < bytes.length) {
    const marker = bytes[i]!;
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      i += 2; // extension introducer + label
      skipSubBlocks();
      continue;
    }
    if (marker === 0x2c) {
      descriptors += 1;
      const packed = bytes[i + 9]!;
      i += 10;
      if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1)); // local colour table
      i += 1; // LZW minimum code size
      skipSubBlocks();
      continue;
    }
    i += 1; // unknown byte: resync
  }
  return { magic, width, height, imageDescriptors: descriptors, animated: descriptors >= 2 };
}

/** 1x1 transparent PNG — the still-frame stand-in when the generator has not written `<id>.png`. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAX+XsSAAAAABJRU5ErkJggg==',
  'base64',
);
