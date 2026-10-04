/**
 * Voice-note audio primitives (Phase 2, PRIN-5). Dev B composes these into the recording bar and the
 * playback bubble; nothing here touches React or the Matrix client. Sending/parsing the Matrix event is
 * `sendVoiceMessage` (src/lib/matrix/actions.ts) and `getVoiceMessage` (src/lib/matrix/utils.ts).
 *
 * Shared API (docs/PHASE2_TICKETS.md) - encode.ts:
 *   pickVoiceMimeType(): string                       '' when MediaRecorder is missing
 *   encodeToOggOpus(blob): Promise<{ blob, mimetype }> identity in the POC (no transcoding), P1 seam
 *   decodeToPcm(blob): Promise<AudioBuffer>           rejects when undecodable
 *   computeWaveform(src, samples = 100): number[]     AudioBuffer | Float32Array -> ints 0..1024, loudest = 1024
 *   baseMimetype(mime): string                        'audio/webm;codecs=opus' -> 'audio/webm'
 *
 * Extras (Principal):
 *   startRecording(opts) / createLevelMeter(stream)   getUserMedia + MediaRecorder lifecycle, mic release, level 0..100
 *   analyzeAudio(blob): { durationMs, waveform, decoded }   one decode for both numbers (never throws)
 *   computeWaveformFromBlob(blob), getAudioDuration(blob)   the brief's blob-based helpers
 *   sanitizeWaveform(unknown)                         clamp/resample other clients' waveforms
 *
 * Typical flow (Dev B, DEV-B-13):
 *   const rec = await startRecording({ maxDurationMs: 120_000 });     // NotAllowedError -> recording-error
 *   const meter = createLevelMeter(rec.stream);                        // recording-level = meter.read()
 *   const { blob, durationMs: timed } = await rec.stop(); meter.close();
 *   const { durationMs, waveform, decoded } = await analyzeAudio(blob);
 *   const { blob: out, mimetype } = await encodeToOggOpus(blob);
 *   await sendVoiceMessage(roomId, out, { durationMs: decoded ? durationMs : timed, waveform, mimetype });
 */
export {
  RECORDING_MIME_CANDIDATES,
  isRecordingSupported,
  pickRecordingMimeType,
  startRecording,
  createLevelMeter,
  type RecordingHandle,
  type RecordingResult,
  type StartRecordingOptions,
  type LevelMeter,
} from './recording.ts';
export {
  WAVEFORM_SAMPLES,
  WAVEFORM_MAX,
  WAVEFORM_MIN_SAMPLES,
  WAVEFORM_MAX_SAMPLES,
  decodeAudio,
  waveformFromSamples,
  waveformFromBuffer,
  sanitizeWaveform,
  analyzeAudio,
  computeWaveformFromBlob,
  getAudioDuration,
  type AudioAnalysis,
  type WaveformOptions,
} from './analysis.ts';
export { pickVoiceMimeType, encodeToOggOpus, decodeToPcm, computeWaveform, baseMimetype, type EncodedVoice } from './encode.ts';
export { containerMimeType, extensionFor, voiceFileName, isAudioMimeType } from './mime.ts';
