/**
 * Voice-note encoding surface exactly as listed in docs/PHASE2_TICKETS.md "Shared API" (what Dev B codes
 * against). Thin wrappers over recording.ts / analysis.ts / mime.ts.
 *
 * Format decision (orchestrator; docs/VOICE_FORMAT_PLAN.md, docs/ARCHITECTURE.md "Phase 2 deltas"): no re-encoding,
 * but WebM/Opus is losslessly REMUXED to Ogg/Opus in pure TS (ogg.ts) before upload so every listener gets a
 * container with a software-decode fallback (softdecode.ts):
 *   Android WebView / desktop Chromium   audio/webm;codecs=opus  -> remux  -> audio/ogg
 *   Firefox / Safari >= 18.4 (Ogg/Opus)  audio/ogg;codecs=opus   -> as is  -> audio/ogg
 *   old iOS WKWebView / Safari           audio/mp4 (AAC)         -> as is  -> audio/mp4 (plays natively everywhere)
 * `encodeToOggOpus` is the single seam: if the remux throws for any reason the original blob and its own base
 * mimetype are returned (console.warn) - sending must never break.
 */
import { pickRecordingMimeType } from './recording.ts';
import { decodeAudio, waveformFromSamples, WAVEFORM_SAMPLES } from './analysis.ts';
import { containerMimeType } from './mime.ts';
import { isOggBytes, isWebmBytes, remuxWebmOpusToOgg } from './ogg.ts';

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
 *   - WebM/Opus bytes (EBML magic)  -> remuxed Ogg/Opus blob, `mimetype: 'audio/ogg'`
 *   - Ogg bytes                     -> unchanged, `mimetype: 'audio/ogg'`
 *   - anything else (MP4/AAC, ...)  -> unchanged, `mimetype` = blob type, then `fallbackMimetype`, then `audio/webm`
 *   - remux throws (not Opus, truncated header, ...) -> unchanged input + console.warn
 * The container is decided by sniffing the bytes, not by the declared type.
 */
export async function encodeToOggOpus(blob: Blob, fallbackMimetype?: string): Promise<EncodedVoice> {
  const mimetype = baseMimetype(blob.type) || baseMimetype(fallbackMimetype) || 'audio/webm';
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    console.warn('encodeToOggOpus: could not read the recording, sending it as is', e);
    return { blob, mimetype };
  }
  if (isOggBytes(bytes)) return { blob, mimetype: 'audio/ogg' };
  if (!isWebmBytes(bytes)) return { blob, mimetype };
  try {
    const ogg = remuxWebmOpusToOgg(bytes);
    return { blob: new Blob([ogg], { type: 'audio/ogg' }), mimetype: 'audio/ogg' };
  } catch (e) {
    console.warn(`encodeToOggOpus: WebM -> Ogg remux failed, sending ${mimetype} as is`, e);
    return { blob, mimetype };
  }
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
