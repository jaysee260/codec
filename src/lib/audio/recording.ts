/**
 * Microphone recording with MediaRecorder (Phase 2, PRIN-5).
 *
 * Format decision (coordinator + advisor, recorded in docs/ARCHITECTURE.md "Phase 2 deltas"): record in
 * whatever the platform offers and send that, with the real container type in `info.mimetype`:
 *   Android WebView / desktop Chromium  audio/webm;codecs=opus   -> info.mimetype audio/webm
 *   iOS WKWebView / Safari              audio/mp4 (AAC)          -> info.mimetype audio/mp4
 *   Firefox                             audio/ogg;codecs=opus    -> info.mimetype audio/ogg
 * No transcoding in the POC (`encodeToOggOpus` in index.ts is the P1 seam). Duration comes from recorder
 * timing or `decodeAudioData` (analysis.ts) - never from `<audio>.duration`, which is Infinity for WebM blobs.
 */

/**
 * Order matters: first supported wins. Ogg/Opus first because it is the Matrix-native container (only Firefox
 * records it); Chromium / Android WebView land on `audio/webm;codecs=opus`, Safari / iOS on `audio/mp4`.
 */
export const RECORDING_MIME_CANDIDATES: readonly string[] = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg',
];

/** True when getUserMedia + MediaRecorder exist (secure context required: https, http://localhost, the app). */
export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

/** First MediaRecorder mimetype this platform supports, or null (no MediaRecorder / nothing supported). */
export function pickRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return RECORDING_MIME_CANDIDATES[0] ?? null;
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* some WebViews throw on unknown types */
    }
  }
  return null;
}

export interface RecordingResult {
  blob: Blob;
  /** Container type without codec parameters (`audio/webm`), from the recorder's actual mimeType. */
  mimetype: string;
  /** Wall-clock duration between start() and stop(), in ms. Prefer `analyzeAudio()` when accuracy matters. */
  durationMs: number;
}

export interface RecordingHandle {
  /** Full MediaRecorder mimetype actually in use (may include codecs). */
  readonly mimeType: string;
  /** The live mic stream (for a level meter: `createLevelMeter(stream)`). Stopped on stop()/cancel(). */
  readonly stream: MediaStream;
  readonly startedAt: number;
  /** Stop recording, release the microphone, resolve with the blob. */
  stop(): Promise<RecordingResult>;
  /** Discard everything and release the microphone. */
  cancel(): void;
}

export interface StartRecordingOptions {
  /** MediaRecorder timeslice in ms (chunks arrive while recording). Default 250. */
  timesliceMs?: number;
  /** Auto-stop after this many ms (AC-V1-6 caps at 120 s). Default: none. */
  maxDurationMs?: number;
  /** Called when `maxDurationMs` auto-stops the recording (the promise from stop() is not involved). */
  onAutoStop?(result: RecordingResult): void;
  /** Extra getUserMedia audio constraints. */
  audio?: MediaTrackConstraints;
}

/**
 * Ask for the microphone and start recording. Rejects with the getUserMedia error (`NotAllowedError`,
 * `NotFoundError`, ...) or an Error when MediaRecorder is unavailable; callers map those to UI text.
 */
export async function startRecording(opts: StartRecordingOptions = {}): Promise<RecordingHandle> {
  if (!isRecordingSupported()) throw new Error('Recording is not supported in this browser (needs MediaRecorder and a secure context)');
  const mimeType = pickRecordingMimeType();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(opts.audio ?? {}) },
  });

  let recorder: MediaRecorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }

  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let stopped = false;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;

  const stopPromise = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
  });
  recorder.addEventListener('dataavailable', (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  const releaseMic = (): void => {
    stream.getTracks().forEach((t) => t.stop());
  };

  const finish = async (): Promise<RecordingResult> => {
    if (!stopped) {
      stopped = true;
      if (autoTimer) clearTimeout(autoTimer);
      if (recorder.state !== 'inactive') {
        try {
          recorder.requestData();
        } catch {
          /* fine */
        }
        recorder.stop();
      }
    }
    await stopPromise;
    releaseMic();
    const durationMs = Date.now() - startedAt;
    const actual = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm';
    const blob = new Blob(chunks, { type: actual });
    return { blob, mimetype: actual.split(';')[0]!.trim().toLowerCase(), durationMs };
  };

  recorder.start(opts.timesliceMs ?? 250);

  if (opts.maxDurationMs && opts.maxDurationMs > 0) {
    autoTimer = setTimeout(() => {
      if (stopped) return;
      void finish().then((r) => opts.onAutoStop?.(r));
    }, opts.maxDurationMs);
  }

  return {
    mimeType: recorder.mimeType || mimeType || '',
    stream,
    startedAt,
    stop: finish,
    cancel: () => {
      if (stopped) return;
      stopped = true;
      if (autoTimer) clearTimeout(autoTimer);
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* already stopped */
      }
      chunks.length = 0;
      releaseMic();
    },
  };
}

export interface LevelMeter {
  /** Current input level 0..100 (RMS of the last analyser frame, perceptually scaled). */
  read(): number;
  close(): void;
}

/**
 * Live input level for the recording bar (`recording-level` data-level). Uses an AnalyserNode on the mic
 * stream; `read()` is cheap enough to call from requestAnimationFrame. Returns a constant-0 meter when
 * Web Audio is unavailable.
 */
export function createLevelMeter(stream: MediaStream): LevelMeter {
  const AudioCtx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
    | typeof AudioContext
    | undefined;
  if (!AudioCtx) return { read: () => 0, close: () => undefined };
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  return {
    read() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length); // 0..1
      // Speech RMS rarely exceeds ~0.3; sqrt makes quiet input visible.
      return Math.round(Math.min(1, Math.sqrt(rms * 3)) * 100);
    },
    close() {
      try {
        source.disconnect();
      } catch {
        /* fine */
      }
      void ctx.close().catch(() => undefined);
    },
  };
}
