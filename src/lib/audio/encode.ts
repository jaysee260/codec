/**
 * Voice-note encoding surface exactly as listed in docs/PHASE2_TICKETS.md "Shared API" (what Dev B codes
 * against). Thin wrappers over recording.ts / analysis.ts / mime.ts.
 *
 * Format decision for the POC (coordinator + advisor; docs/ARCHITECTURE.md "Phase 2 deltas"): no transcoding.
 * The MediaRecorder blob is sent in its native container with the honest base mimetype:
 *   Android WebView / desktop Chromium   audio/webm;codecs=opus  -> audio/webm
 *   iOS WKWebView / Safari               audio/mp4 (AAC)         -> audio/mp4
 *   Firefox                              audio/ogg;codecs=opus   -> audio/ogg
 * `encodeToOggOpus` is therefore an identity today and the single seam for the P1 (remux WebM/Opus -> Ogg/Opus
 * with a pure-TS muxer, or opus-recorder live encoding). AC-V2-4 (Ogg on Chromium) is waived for the POC.
 */
import { pickRecordingMimeType } from './recording.ts';
import { decodeAudio, waveformFromSamples, WAVEFORM_SAMPLES } from './analysis.ts';
import { containerMimeType } from './mime.ts';

/** First supported of ogg;opus, webm;opus, webm, mp4, ...; `''` when MediaRecorder is missing or nothing matches. */
export function pickVoiceMimeType(): string {
  return pickRecordingMimeType() ?? '';
}

/** `'audio/webm;codecs=opus' -> 'audio/webm'`. */
export function baseMimetype(mime: string | null | undefined): string {
  return containerMimeType(mime);
}

export interface EncodedVoice {
  blob: Blob;
  /** Base mimetype of `blob` (no codec parameters), for `info.mimetype`. */
  mimetype: string;
}

/**
 * Ogg/Opus when possible, otherwise the input blob with its own base mimetype. Never rejects for format reasons.
 * POC: always returns the input (see the module header); `mimetype` falls back to `fallbackMimetype`, then
 * `audio/webm` when the blob carries no type.
 */
export async function encodeToOggOpus(blob: Blob, fallbackMimetype?: string): Promise<EncodedVoice> {
  const mimetype = baseMimetype(blob.type) || baseMimetype(fallbackMimetype) || 'audio/webm';
  return { blob, mimetype };
}

/** Web Audio `decodeAudioData`. Rejects when the platform cannot decode this container/codec. */
export async function decodeToPcm(blob: Blob): Promise<AudioBuffer> {
  const buffer = await decodeAudio(blob);
  if (!buffer) throw new Error(`Cannot decode audio (${blob.type || 'unknown type'}, ${blob.size} bytes)`);
  return buffer;
}

/**
 * `samples` ints 0..1024 from peak amplitude per bucket, normalised so the loudest bucket is 1024.
 * Accepts a decoded `AudioBuffer` or a mono `Float32Array` (-1..1).
 */
export function computeWaveform(src: AudioBuffer | Float32Array, samples = WAVEFORM_SAMPLES): number[] {
  return waveformFromSamples(src, samples, { normalize: true });
}
