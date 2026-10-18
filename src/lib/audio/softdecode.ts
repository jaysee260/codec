/**
 * Software playback fallback for voice notes the browser cannot play natively (iOS < 18.4 plays neither
 * WebM nor Ogg). Browser-only (uses `<audio>`, Blob); the pure pieces live in ogg.ts / wav.ts.
 *
 *   canPlayNatively(mimetype): boolean                  `<audio>.canPlayType` ('' -> false); bare ogg/webm -> codecs="opus"
 *   decodeToWavBlob(blob, mimetype?): Promise<Blob>     WebM/Opus or Ogg/Opus -> 16-bit WAV blob ('audio/wav')
 *   decodeOpusBlob(blob, mimetype?): Promise<DecodedPcm> same, but the raw PCM (waveform / duration callers)
 *   SoftDecodeError (code: 'unsupported' | 'decode-failed')
 *
 * `decodeToWavBlob` sniffs the bytes (EBML magic / `OggS`) rather than trusting the mimetype; WebM is remuxed
 * to Ogg in TS first (ogg.ts), then decoded with `ogg-opus-decoder` (WASM, lazy `import()` so browsers that
 * play Ogg/WebM natively never download it). MP4/AAC and anything else rejects with 'unsupported': play those
 * natively. Playback flow (Dev B): `canPlayNatively(mime)` false, or `<audio>` error / `play()` format rejection
 *   -> `const wav = await decodeToWavBlob(blob)` -> `URL.createObjectURL(wav)` on the same `<audio>`.
 */
import { isOggBytes, isWebmBytes, remuxWebmOpusToOgg } from './ogg.ts';
import { containerMimeType } from './mime.ts';
import { encodeWav, WAV_MIMETYPE } from './wav.ts';

export type SoftDecodeErrorCode = 'unsupported' | 'decode-failed';

export class SoftDecodeError extends Error {
  override readonly name = 'SoftDecodeError';
  readonly code: SoftDecodeErrorCode;
  constructor(code: SoftDecodeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export interface DecodedPcm {
  channelData: Float32Array[];
  sampleRate: number;
  /** Frames per channel. */
  samples: number;
  /** Integer milliseconds. */
  durationMs: number;
}

const playableCache = new Map<string, boolean>();

/**
 * Whether `<audio>.canPlayType` says this type is playable ('' -> false, 'maybe'/'probably' -> true).
 * A mimetype with a `codecs` parameter is queried exactly as given. A bare `audio/ogg` / `audio/webm` is
 * queried as `audio/ogg; codecs="opus"` / `audio/webm; codecs="opus"` (a bare container only earns "maybe",
 * which says nothing about Opus). Other types are queried as given. Results are cached by the query string.
 * Unknown environments (no `<audio>`, no `canPlayType`) report true so native playback is still attempted first.
 */
export function canPlayNatively(mimetype: string | null | undefined): boolean {
  const raw = (mimetype ?? '').trim();
  if (!raw) return true;
  const container = containerMimeType(raw);
  const hasCodecs = /;\s*codecs\s*=/i.test(raw);
  let query = raw;
  if (!hasCodecs) {
    if (container === 'audio/ogg' || container === 'application/ogg') query = 'audio/ogg; codecs="opus"';
    else if (container === 'audio/webm' || container === 'video/webm') query = `${container}; codecs="opus"`;
    else query = container;
  }
  const cached = playableCache.get(query);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return true;
  let result = true;
  try {
    const el = document.createElement('audio');
    if (typeof el.canPlayType !== 'function') return true;
    result = el.canPlayType(query) !== '';
  } catch {
    result = true;
  }
  playableCache.set(query, result);
  return result;
}

/** True when `decodeToWavBlob` would accept this container (Ogg or WebM). Mimetype only; the bytes decide in the end. */
export function canSoftwareDecode(mimetype: string | null | undefined): boolean {
  const c = containerMimeType(mimetype);
  return c === 'audio/ogg' || c === 'application/ogg' || c === 'audio/webm' || c === 'video/webm' || c === 'audio/opus';
}

/** Decode Ogg/Opus bytes to PCM with ogg-opus-decoder (lazy WASM). */
export async function decodeOggOpusBytes(ogg: Uint8Array): Promise<DecodedPcm> {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const decoder = new OggOpusDecoder();
  try {
    await decoder.ready;
    const out = await decoder.decodeFile(ogg);
    const samples = out.samplesDecoded;
    // A completely failed decode yields 0 samples; a handful of samples with errors is a broken stream too.
    if (!samples || (out.errors.length > 0 && samples < out.sampleRate / 10)) {
      const first = out.errors[0];
      throw new SoftDecodeError('decode-failed', `Opus decode produced ${samples} samples${first ? ` (${first.message})` : ''}`);
    }
    return {
      channelData: out.channelData,
      sampleRate: out.sampleRate,
      samples,
      durationMs: Math.round((samples * 1000) / out.sampleRate),
    };
  } catch (e) {
    if (e instanceof SoftDecodeError) throw e;
    throw new SoftDecodeError('decode-failed', `Opus decode failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  } finally {
    try {
      decoder.free();
    } catch {
      /* already freed */
    }
  }
}

/** Blob (WebM/Opus or Ogg/Opus) -> PCM. Rejects with SoftDecodeError('unsupported') for other containers. */
export async function decodeOpusBlob(blob: Blob, mimetype?: string): Promise<DecodedPcm> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let ogg: Uint8Array;
  if (isOggBytes(bytes)) {
    ogg = bytes;
  } else if (isWebmBytes(bytes)) {
    try {
      ogg = remuxWebmOpusToOgg(bytes);
    } catch (e) {
      throw new SoftDecodeError('unsupported', `WebM is not Opus: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  } else {
    const declared = containerMimeType(mimetype) || containerMimeType(blob.type) || 'unknown';
    throw new SoftDecodeError('unsupported', `Cannot software-decode ${declared} (${bytes.length} bytes): only Ogg/Opus and WebM/Opus`);
  }
  return decodeOggOpusBytes(ogg);
}

/**
 * Blob (WebM/Opus or Ogg/Opus) -> 16-bit WAV blob (`audio/wav`) for `<audio src=blob:>`.
 * Rejects with SoftDecodeError: 'unsupported' (not Opus in Ogg/WebM, e.g. MP4/AAC) or 'decode-failed'.
 */
export async function decodeToWavBlob(blob: Blob, mimetype?: string): Promise<Blob> {
  const pcm = await decodeOpusBlob(blob, mimetype);
  return new Blob([encodeWav(pcm.channelData, pcm.sampleRate)], { type: WAV_MIMETYPE });
}
