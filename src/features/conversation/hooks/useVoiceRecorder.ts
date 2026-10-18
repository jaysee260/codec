/**
 * Voice-note recording state machine (DEV-B-12 + DEV-B-13).
 *
 * Wraps the Principal's primitives (`src/lib/audio`), never MediaRecorder directly:
 *
 *   startRecording({ maxDurationMs, onAutoStop })  getUserMedia + MediaRecorder, releases the mic on both paths
 *   createLevelMeter(stream)                       RMS 0..100 for `recording-level`
 *   handle.stop() -> { blob, mimetype, durationMs } wall-clock duration
 *   analyzeAudio(blob) -> { durationMs, waveform, decoded }   one decode for both numbers
 *   encodeToOggOpus(blob, mime) -> { blob, mimetype }   lossless WebM/Opus -> Ogg/Opus remux (audio/ogg); Ogg,
 *                                                  MP4/AAC and anything it cannot remux come back unchanged
 *   sendVoiceMessage(roomId, blob, meta)           upload + the MSC1767/MSC3245 event
 *
 * States (docs/PHASE2_ACCEPTANCE.md test-id registry):
 *   idle        nothing happening; the composer shows `composer-mic`
 *   requesting  waiting for getUserMedia (the permission prompt on a device)
 *   recording   `composer-recording` with the timer and the live level
 *   encoding    stopped, decoding for duration + waveform
 *   sending     uploading + sending the event
 *   error       the upload/send failed; `recording-send` retries the *same* blob, `recording-cancel` discards
 *   denied      getUserMedia was refused. Deliberately NOT a bar state: AC-V5-1 requires `composer-input`
 *               to keep working, so the composer renders `recording-error` as a banner above the input and
 *               stamps `composer-mic[data-state="denied"]`.
 *
 * Lifecycle rules (docs/ARCHITECTURE.md "Release the mic"): every exit path stops the handle and closes the
 * level meter - cancel, send, unmount and room change (the Composer is keyed by room, so a room switch
 * unmounts this hook: AC-V1-5). A `cancel()` that lands while getUserMedia is still pending cancels the
 * handle as soon as it resolves (`generation`), so a late grant cannot leave the mic open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyzeAudio,
  createLevelMeter,
  encodeToOggOpus,
  isRecordingSupported,
  startRecording,
  type LevelMeter,
  type RecordingHandle,
  type RecordingResult,
} from '@/lib/audio/index.ts';
import { sendVoiceMessage } from '@/lib/matrix/actions.ts';
import { showToast } from '@/store/toast.ts';

/** AC-V1-6: recording auto-stops (and sends) at two minutes. */
export const MAX_DURATION_MS = 120_000;
/** AC-V1-4: anything shorter is refused with a toast instead of being sent. */
export const MIN_DURATION_MS = 1_000;
/** Waveform samples in the event (contract: about 100, accepted 30..120). */
export const WAVEFORM_SAMPLES = 100;

/**
 * Dev-only test switch (AC-F9), exposed as `window.__matrixPoc.voice.forceRemuxFailure` by src/app/devtools.ts.
 * When true in a dev build, the send path behaves as if the WebM -> Ogg remux threw, so the ORIGINAL recording
 * is uploaded with its own mimetype. Ignored in production builds.
 */
export const voiceSendDebug = { forceRemuxFailure: false };

const LEVEL_INTERVAL_MS = 66; // ~15 fps; AC-V1-2 compares two samples 500 ms apart
const TIMER_INTERVAL_MS = 100;

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'encoding' | 'sending' | 'error' | 'denied';

/** What the bar needs to render, plus the three verbs the composer calls. */
export interface VoiceRecorder {
  state: RecorderState;
  /** True while `composer-recording` should replace the input (recording / encoding / sending / error). */
  barOpen: boolean;
  /** Elapsed ms, floored to the rendered second by `elapsedLabel`. Capped at MAX_DURATION_MS. */
  elapsedMs: number;
  /** `m:ss` of the elapsed time, floored (AC-V1-2 wants 0:00 for the whole first second). */
  elapsedLabel: string;
  /** Live input level 0..100 (`recording-level` data-level). */
  level: number;
  /** Inline message for `recording-error` (empty when there is nothing to show). */
  error: string;
  /** False in an insecure context (phone browser over a LAN IP): the mic button is disabled with a hint. */
  supported: boolean;
  /** Tap `composer-mic`. */
  start(): void;
  /** Tap `recording-send`: stop, analyse, upload, send. In `error` state it retries the same blob. */
  send(): void;
  /** Tap `recording-cancel`: discard everything and release the mic. */
  cancel(): void;
}

/** Floored `m:ss` (the bubble's `formatDuration` rounds; a running timer must not show 0:01 at 500 ms). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** Human text for a getUserMedia rejection (AC-V5-1 wants the fix, not the DOMException name). */
function micErrorText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access denied. Allow the microphone for this app in your browser or system settings, then tap the mic again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect one and tap the mic again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy. Close whatever else is using it and tap the mic again.';
    default:
      return `Could not start recording: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The analysed, upload-ready take kept across a retry (AC-V5-2). */
interface PreparedTake {
  /** The ENCODED blob (`encodeToOggOpus` output): what is uploaded, on the first try and on every retry. */
  blob: Blob;
  /** `encodeToOggOpus`'s mimetype for `blob` (audio/ogg after a remux), not the recorder's. */
  mimetype: string;
  /** From the original recording's decode (else the recorder's wall clock). */
  durationMs: number;
  waveform: number[];
}

const raf = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

export interface VoiceRecorderOptions {
  onFinish?(): void;
  /** Phase 3: send the voice note into this thread instead of the main timeline (DEV-B-22). */
  threadRoot?: string;
}

export function useVoiceRecorder(roomId: string, opts: VoiceRecorderOptions = {}): VoiceRecorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');

  const handleRef = useRef<RecordingHandle | null>(null);
  const meterRef = useRef<LevelMeter | null>(null);
  const takeRef = useRef<PreparedTake | null>(null);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  /** Bumped by cancel/unmount so an in-flight start or send knows it was superseded. */
  const genRef = useRef(0);
  const onFinishRef = useRef(opts.onFinish);
  onFinishRef.current = opts.onFinish;
  // Read through a ref so `deliver` does not need the thread root in its dependency list.
  const threadRootRef = useRef(opts.threadRoot);
  threadRootRef.current = opts.threadRoot;
  const supported = useRef(isRecordingSupported()).current;

  const clearTimers = useCallback((): void => {
    for (const t of timersRef.current) clearInterval(t);
    timersRef.current = [];
  }, []);

  /** Release the microphone and every timer. Never throws; safe to call twice. */
  const teardown = useCallback(
    (discard: boolean): void => {
      clearTimers();
      const meter = meterRef.current;
      meterRef.current = null;
      try {
        meter?.close();
      } catch {
        /* already closed */
      }
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle && discard) {
        try {
          handle.cancel();
        } catch {
          /* already stopped */
        }
      }
      setLevel(0);
    },
    [clearTimers],
  );

  // Unmount / room change: discard, release the mic, invalidate anything in flight.
  useEffect(() => {
    return () => {
      genRef.current++;
      takeRef.current = null;
      teardown(true);
    };
  }, [roomId, opts.threadRoot, teardown]);

  const reset = useCallback(
    (next: RecorderState, message = ''): void => {
      takeRef.current = null;
      teardown(true);
      setElapsedMs(0);
      setState(next);
      setError(message);
    },
    [teardown],
  );

  /**
   * Analyse + upload + send. `pre` is set when the take was already stopped (auto-stop) or when we are
   * retrying after a failed upload.
   */
  const deliver = useCallback(
    async (gen: number, stopped?: RecordingResult, retry?: PreparedTake): Promise<void> => {
      let take = retry;
      if (!take) {
        if (!stopped) return;
        if (stopped.durationMs < MIN_DURATION_MS || stopped.blob.size === 0) {
          showToast('That voice note is too short - hold the mic for at least a second.', 'error');
          if (genRef.current === gen) reset('idle');
          onFinishRef.current?.();
          return;
        }
        setState('encoding');
        await raf(); // one paint in `encoding` before the decode blocks (AC-V2-1)
        // Duration + waveform come from the ORIGINAL recording (the remux changes no samples, and the
        // original is what this platform is known to decode); only the upload uses the encoded blob.
        const analysis = await analyzeAudio(stopped.blob, WAVEFORM_SAMPLES);
        let encoded: { blob: Blob; mimetype: string };
        try {
          if (import.meta.env.DEV && voiceSendDebug.forceRemuxFailure) throw new Error('forced remux failure (AC-F9)');
          encoded = await encodeToOggOpus(stopped.blob, stopped.mimetype);
        } catch {
          // The seam already falls back on remux failure; this is belt and braces so sending never breaks.
          encoded = { blob: stopped.blob, mimetype: stopped.mimetype };
        }
        if (genRef.current !== gen) return;
        // Kept in `takeRef`: a retry after a failed upload re-sends this exact encoded blob (no re-encode).
        take = {
          blob: encoded.blob,
          mimetype: encoded.mimetype,
          // The decoded duration is exact; the recorder's wall clock includes the stop round-trip.
          durationMs: analysis.decoded && analysis.durationMs > 0 ? analysis.durationMs : stopped.durationMs,
          waveform: analysis.waveform,
        };
        takeRef.current = take;
      }

      setState('sending');
      setError('');
      try {
        await sendVoiceMessage(roomId, take.blob, {
          durationMs: take.durationMs,
          waveform: take.waveform,
          mimetype: take.mimetype,
          threadRoot: threadRootRef.current,
        });
        if (genRef.current !== gen) return;
        reset('idle');
        onFinishRef.current?.();
      } catch (e) {
        if (genRef.current !== gen) return;
        // Keep the blob: `recording-send` retries it, `recording-cancel` throws it away (AC-V5-2).
        clearTimers();
        setState('error');
        setError(`Upload failed: ${e instanceof Error ? e.message : String(e)}. Tap send to try again.`);
      }
    },
    [roomId, reset, clearTimers],
  );

  const start = useCallback((): void => {
    if (!supported) {
      setError('Recording needs a secure context (the app, https, or http://localhost).');
      return;
    }
    if (state !== 'idle' && state !== 'denied') return;
    const gen = ++genRef.current;
    takeRef.current = null;
    setError('');
    setElapsedMs(0);
    setLevel(0);
    setState('requesting');

    void (async () => {
      let handle: RecordingHandle;
      try {
        handle = await startRecording({
          maxDurationMs: MAX_DURATION_MS,
          onAutoStop: (result) => {
            if (genRef.current !== gen) return;
            handleRef.current = null; // already stopped and released by the handle
            clearTimers();
            void deliver(gen, result);
          },
        });
      } catch (e) {
        if (genRef.current !== gen) return;
        // Every start failure lands on `denied`: the registry allows only idle|requesting|denied on
        // `composer-mic`, and the text in `recording-error` says which one it was.
        setState('denied');
        setError(micErrorText(e));
        return;
      }
      // Cancelled (or the room changed) while the prompt was up: release the mic immediately.
      if (genRef.current !== gen) {
        try {
          handle.cancel();
        } catch {
          /* already stopped */
        }
        return;
      }

      handleRef.current = handle;
      let meter: LevelMeter | null = null;
      try {
        meter = createLevelMeter(handle.stream);
      } catch {
        meter = null; // no Web Audio: the bar just shows a flat level
      }
      meterRef.current = meter;
      setState('recording');

      const startedAt = handle.startedAt;
      timersRef.current.push(
        setInterval(() => setElapsedMs(Math.min(MAX_DURATION_MS, Date.now() - startedAt)), TIMER_INTERVAL_MS),
      );
      if (meter) {
        const read = meter;
        timersRef.current.push(setInterval(() => setLevel(read.read()), LEVEL_INTERVAL_MS));
      }
    })();
  }, [supported, state, clearTimers, deliver]);

  const send = useCallback((): void => {
    const gen = genRef.current;
    if (state === 'error') {
      const take = takeRef.current;
      if (take) void deliver(gen, undefined, take);
      return;
    }
    if (state !== 'recording') return;
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;
    clearTimers();
    setState('encoding');
    void (async () => {
      let stopped: RecordingResult;
      try {
        stopped = await handle.stop();
      } catch (e) {
        if (genRef.current !== gen) return;
        reset('idle', '');
        showToast(`Recording failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
        return;
      } finally {
        try {
          meterRef.current?.close();
        } catch {
          /* already closed */
        }
        meterRef.current = null;
        setLevel(0);
      }
      if (genRef.current !== gen) return;
      await deliver(gen, stopped);
    })();
  }, [state, clearTimers, deliver, reset]);

  const cancel = useCallback((): void => {
    genRef.current++;
    reset('idle');
    onFinishRef.current?.();
  }, [reset]);

  const barOpen = state === 'recording' || state === 'encoding' || state === 'sending' || state === 'error';

  return {
    state,
    barOpen,
    elapsedMs,
    elapsedLabel: formatElapsed(elapsedMs),
    level,
    error,
    supported,
    start,
    send,
    cancel,
  };
}
