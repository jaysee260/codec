/**
 * Decode-once audio analysis (Phase 2, PRIN-5): duration + waveform for the voice message event.
 *
 *  analyzeAudio(blob)        -> { durationMs, waveform, decoded }   one decode, use this from the recorder flow
 *  computeWaveform(blob)     -> number[]  (about 100 ints 0..1024, peak amplitude per bucket; flat zeros on failure)
 *  getAudioDuration(blob)    -> ms (0 when undecodable)
 *
 * Decoding uses `OfflineAudioContext.decodeAudioData` (not subject to iOS's user-gesture/suspended rule),
 * falling back to a throwaway `AudioContext`. `<audio>.duration` is never used: MediaRecorder WebM blobs have
 * no duration header and report Infinity.
 */

/** Target number of waveform samples (contract: about 100, accepted 30..120). */
export const WAVEFORM_SAMPLES = 100;
/** Waveform sample range is 0..1024 inclusive (MSC1767 / Element). */
export const WAVEFORM_MAX = 1024;
/** Accepted waveform lengths when reading other clients' events. */
export const WAVEFORM_MIN_SAMPLES = 30;
export const WAVEFORM_MAX_SAMPLES = 120;

type AudioContextCtor = typeof AudioContext;

function offlineContextCtor(): (new (channels: number, length: number, sampleRate: number) => OfflineAudioContext) | undefined {
  const w = window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
}

function audioContextCtor(): AudioContextCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

function decodeWith(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  // Promise form first; Safari < 14.1 only had the callback form.
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const maybe = ctx.decodeAudioData(bytes, resolve, reject);
      if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
        (maybe as Promise<AudioBuffer>).then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

/** Decode a blob to PCM. Resolves null when the platform cannot decode this container/codec. */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
  if (typeof window === 'undefined' || blob.size === 0) return null;
  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    return null;
  }
  const Offline = offlineContextCtor();
  if (Offline) {
    try {
      // Length/sampleRate are irrelevant for decoding; 48 kHz matches Opus.
      return await decodeWith(new Offline(1, 1, 48000), bytes.slice(0));
    } catch {
      /* fall through to a live context */
    }
  }
  const Live = audioContextCtor();
  if (!Live) return null;
  const ctx = new Live();
  try {
    return await decodeWith(ctx, bytes.slice(0));
  } catch {
    return null;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

export interface WaveformOptions {
  /** Scale so the loudest bucket is exactly 1024 (docs/archive/PHASE2_TICKETS.md). Default true. Silence stays all-zero. */
  normalize?: boolean;
}

/**
 * Peak amplitude per bucket, as integers 0..1024. Accepts a decoded `AudioBuffer` (all channels are
 * combined with max-abs) or a mono `Float32Array` of samples in -1..1.
 */
export function waveformFromSamples(
  src: AudioBuffer | Float32Array,
  samples = WAVEFORM_SAMPLES,
  opts: WaveformOptions = {},
): number[] {
  const n = Math.max(1, Math.round(samples));
  const channels: Float32Array[] = [];
  if (src instanceof Float32Array) channels.push(src);
  else for (let c = 0; c < src.numberOfChannels; c++) channels.push(src.getChannelData(c));
  const length = channels[0]?.length ?? 0;
  if (length === 0) return new Array<number>(n).fill(0);
  const peaks: number[] = new Array<number>(n);
  let loudest = 0;
  for (let b = 0; b < n; b++) {
    const start = Math.floor((b * length) / n);
    const end = Math.max(start + 1, Math.floor(((b + 1) * length) / n));
    let peak = 0;
    for (const data of channels) {
      for (let i = start; i < end && i < length; i++) {
        const v = Math.abs(data[i]!);
        if (v > peak) peak = v;
      }
    }
    peaks[b] = peak;
    if (peak > loudest) loudest = peak;
  }
  const scale = (opts.normalize ?? true) && loudest > 0 ? 1 / loudest : 1;
  return peaks.map((p) => Math.round(Math.min(1, p * scale) * WAVEFORM_MAX));
}

/** @deprecated Use `waveformFromSamples(buffer, samples, opts)`. */
export const waveformFromBuffer = waveformFromSamples;

/** Clamp to ints 0..1024, drop non-numbers, and resample to 100 when longer than 120 (other clients). */
export function sanitizeWaveform(input: unknown, target = WAVEFORM_SAMPLES): number[] {
  if (!Array.isArray(input)) return [];
  const nums = input
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(WAVEFORM_MAX, Math.max(0, Math.round(v))) : 0));
  if (nums.length <= WAVEFORM_MAX_SAMPLES) return nums;
  // Peak-resample down to `target` buckets.
  const out: number[] = new Array<number>(target).fill(0);
  for (let i = 0; i < nums.length; i++) {
    const b = Math.min(target - 1, Math.floor((i * target) / nums.length));
    if (nums[i]! > out[b]!) out[b] = nums[i]!;
  }
  return out;
}

export interface AudioAnalysis {
  /** Integer milliseconds from the decoded PCM (0 when undecodable; callers fall back to recorder timing). */
  durationMs: number;
  /** `samples` ints 0..1024 (flat zeros when undecodable). */
  waveform: number[];
  /** False when the platform could not decode the blob. */
  decoded: boolean;
  sampleRate?: number;
  channels?: number;
}

/** One decode -> duration + waveform (normalised, loudest bucket = 1024). Never throws. */
export async function analyzeAudio(blob: Blob, samples = WAVEFORM_SAMPLES, opts: WaveformOptions = {}): Promise<AudioAnalysis> {
  const buffer = await decodeAudio(blob);
  if (!buffer) return { durationMs: 0, waveform: new Array<number>(samples).fill(0), decoded: false };
  return {
    durationMs: Math.round(buffer.duration * 1000),
    waveform: waveformFromSamples(buffer, samples, opts),
    decoded: true,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
}

/**
 * Blob -> about 100 ints in 0..1024 (peak per bucket, normalised). Flat zeros when the blob cannot be decoded.
 * (The brief's `computeWaveform(blob)`; the sync `computeWaveform(AudioBuffer | Float32Array)` from the
 * tickets' Shared API lives in encode.ts.)
 */
export async function computeWaveformFromBlob(blob: Blob, samples = WAVEFORM_SAMPLES): Promise<number[]> {
  return (await analyzeAudio(blob, samples)).waveform;
}

/** Duration in ms from the decoded audio; 0 when undecodable (use the recorder's wall-clock timing then). */
export async function getAudioDuration(blob: Blob): Promise<number> {
  const buffer = await decodeAudio(blob);
  return buffer ? Math.round(buffer.duration * 1000) : 0;
}
