/**
 * PCM -> WAV (RIFF, 16-bit little-endian, interleaved). Pure TypeScript, no DOM.
 *
 *   encodeWav(channelData: Float32Array[], sampleRate): Uint8Array<ArrayBuffer>   -1..1 floats -> int16 WAV bytes
 *   WAV_MIMETYPE                                                                  'audio/wav'
 *
 * Used by the software playback fallback (softdecode.ts): decoded Opus PCM is wrapped as WAV so it can play
 * through the same `<audio src=blob:>` path as a native note (every browser plays PCM WAV, duration is exact).
 */

export const WAV_MIMETYPE = 'audio/wav';

/** 16-bit PCM WAV from float channel data (channels must be the same length; extra samples are truncated). */
export function encodeWav(channelData: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const channels = Math.max(1, channelData.length);
  const frames = channelData.length === 0 ? 0 : Math.min(...channelData.map((c) => c.length));
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataLen = frames * blockAlign;
  const out = new Uint8Array(new ArrayBuffer(44 + dataLen));
  const v = new DataView(out.buffer);
  ascii(out, 0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  ascii(out, 8, 'WAVE');
  ascii(out, 12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  ascii(out, 36, 'data');
  v.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = channelData[c]?.[i] ?? 0;
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      v.setInt16(p, clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), true);
      p += 2;
    }
  }
  return out;
}

function ascii(out: Uint8Array, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i) & 0xff;
}
