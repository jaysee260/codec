/**
 * Voice-note playback bubble (DEV-B-14 / DEV-B-17).
 *
 * Rendered by `MessageBody` for every event where `getVoiceMessage(event)` is non-null (a real voice
 * note or any other playable `m.audio`). One plain `<audio>` element per bubble plays everything;
 * notes the browser can't play natively go through a software-decode fallback (below).
 *
 *   voice-message   data-state="idle|loading|playing|paused|error", data-duration-ms,
 *                   data-position-ms, data-mimetype (the event's), data-playback="native|fallback"
 *                   (which source the `<audio>` is playing; absent until the first play)
 *   voice-play / voice-pause   the same button; the testid follows the state
 *   voice-progress  <input type="range">, aria-valuenow = position in ms (explicit attributes:
 *                   a native range does not expose them to getAttribute on its own)
 *   voice-duration  total when idle, elapsed while playing or paused
 *   voice-waveform  one bar per waveform sample (data-samples); bars left of the playhead are accent
 *   voice-error     "Can't play this voice message" + a download link
 *
 * Duration rules (docs/ARCHITECTURE.md "Mobile / voice gotchas"): the event's `durationMs` is the
 * truth. `<audio>.duration` is `Infinity` for MediaRecorder WebM blobs, so it is only consulted when
 * the event carries no duration at all (other clients' plain audio files) and only when finite.
 *
 * Why the media is fetched instead of handed straight to `<audio src>`: **Synapse's media download
 * ignores `Range`** (no `Accept-Ranges`; a ranged request comes back 200 with the whole body), so
 * Chromium loads the response as an unseekable stream - `audio.seekable` is `[0, 0]` and every
 * `currentTime` assignment snaps back to 0, which kills the scrubber (AC-V3-5). Measured with
 * `__dev__/blobseek.mjs`: the identical bytes behind a `blob:` URL report `seekable [0, duration]`
 * and seek normally. So the first tap on `voice-play` fetches the file once (small: ~12 KB/s of
 * Opus), keeps an object URL for the life of the bubble, and plays that. Nothing is fetched before
 * that tap, which is also what AC-V5-4 needs: a broken download must surface as `voice-error` *after*
 * the user taps play, not at mount.
 *
 * Fallback for listeners who can't play the note's container (WebM/Ogg on iOS < 18.4,
 * docs/VOICE_FORMAT_PLAN.md): when `canPlayNatively(container)` is false (container = the downloaded
 * blob's type, else the event's mimetype), the downloaded bytes go through `decodeToWavBlob`
 * (lazy-loaded Opus decoder -> 16-bit WAV) and the WAV's object URL is played through the same
 * `<audio>`, so seeking, the scrubber, duration and one-at-a-time all behave the same. If native
 * playback is attempted but fails with a *format* error (`<audio>` error MEDIA_ERR_DECODE /
 * MEDIA_ERR_SRC_NOT_SUPPORTED, or `play()` rejecting with NotSupportedError), the bubble switches to
 * the other path once, keeping the position. Each path is tried at most once per bubble (so a wrong
 * `canPlayType` answer that sent us to the fallback still gets one native try if decoding fails);
 * only when both have failed does `voice-error` appear. Network failures go straight to
 * `voice-error`. The download link always serves the original file, never the WAV.
 * Details: the path is chosen with `canPlayNatively('audio/ogg; codecs="opus"')`-style queries (bare
 * types answer inconsistently); when the server's type and the event's disagree, the first 4 bytes
 * (EBML = WebM, `OggS` = Ogg) decide. A native `play()` that produces no `playing` within 4 s
 * (WKWebView can stall silently) also switches to the fallback once. The first tap plays a 10 ms
 * silent data: WAV synchronously to keep iOS's user activation across the download/decode awaits;
 * its events never touch the state. NotAllowedError is never a format error (back to tappable).
 *
 * Only one note plays at a time (AC-V3-6): a tiny module-level registry pauses the previous one.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { formatDuration, type VoiceMessageInfo } from '@/lib/matrix/utils.ts';
import { downloadMedia, fetchMedia } from '@/lib/matrix/media.ts';
import { canPlayNatively, containerMimeType, decodeToWavBlob, isAudioMimeType } from '@/lib/audio/index.ts';
import styles from './VoiceMessage.module.css';

/** Bars drawn when the sender gave no waveform (flat placeholder, AC-V4-3). */
const FLAT_BARS = 40;
/** Position refresh while playing; `timeupdate` alone only fires about 4x/s. */
const TICK_MS = 100;
const WAVEFORM_MAX = 1024;

type PlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
/** Which source feeds the `<audio>`: the downloaded file itself, or its software-decoded WAV. */
type PlaybackPath = 'native' | 'fallback';

/** `MediaError` codes that mean "this browser can't play these bytes" (vs. network / aborted). */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

function isFormatMediaError(err: MediaError | null): boolean {
  return err?.code === MEDIA_ERR_DECODE || err?.code === MEDIA_ERR_SRC_NOT_SUPPORTED;
}

/** Thrown by the play attempt when the bytes are unplayable on the current path (switch paths). */
class FormatError extends Error {}

/**
 * 10 ms of silence (8 kHz mono 16-bit WAV). Played synchronously inside the tap so iOS treats the
 * element as user-activated; the real `play()` comes after the download/decode awaits, by which
 * time the tap's activation may be gone (NotAllowedError).
 */
const UNLOCK_SRC =
  'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** True while `el` is playing the unlock clip: its media events must not touch the bubble's state. */
function isUnlockEvent(el: HTMLAudioElement): boolean {
  return (el.currentSrc || el.src) === UNLOCK_SRC;
}

/** WKWebView sometimes neither errors nor plays an unsupported container: give native this long. */
const NATIVE_WATCHDOG_MS = 4000;

/** Container from the first bytes: EBML magic = WebM, `OggS` = Ogg, else '' (unknown). */
async function sniffContainer(blob: Blob): Promise<string> {
  try {
    const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (b.length < 4) return '';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  } catch {
    /* unreadable: fall through */
  }
  return '';
}

/**
 * The mimetype the bytes really are: the blob's (server's) type and the event's normally agree; when
 * they don't, the first four bytes decide for Ogg/WebM, else the event's mimetype wins. Keeps the
 * event's codecs parameter when its container is the one chosen.
 */
async function resolveMimetype(blob: Blob, eventMime: string): Promise<string> {
  const blobContainer = isAudioMimeType(blob.type) ? containerMimeType(blob.type) : '';
  const eventContainer = containerMimeType(eventMime);
  let container = blobContainer || eventContainer;
  if (blobContainer && eventContainer && blobContainer !== eventContainer) {
    container = (await sniffContainer(blob)) || eventContainer;
  }
  if (container === eventContainer && eventMime) return eventMime;
  if (container === blobContainer && blob.type) return blob.type;
  return container;
}

/**
 * The string handed to `canPlayNatively` (canPlayType): Ogg/WebM carry `codecs="opus"`, because bare
 * types give inconsistent answers (Safari says "maybe" to bare audio/ogg and then can't play Opus).
 * An explicit codecs parameter from the event is kept as is.
 */
function playabilityQuery(mime: string): string {
  const container = containerMimeType(mime);
  if (/;\s*codecs\s*=/i.test(mime)) return mime;
  if (container === 'audio/ogg' || container === 'audio/webm') return `${container}; codecs="opus"`;
  return container;
}

/** The bubble currently playing, so starting another one pauses it (AC-V3-6). */
let activePlayer: { id: string; pause(): void } | null = null;

function claimPlayback(id: string, pause: () => void): void {
  if (activePlayer && activePlayer.id !== id) activePlayer.pause();
  activePlayer = { id, pause };
}

function releasePlayback(id: string): void {
  if (activePlayer?.id === id) activePlayer = null;
}

export function VoiceMessage({ voice }: { voice: VoiceMessageInfo }) {
  const id = useId();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<PlayState>('idle');
  const [positionMs, setPositionMs] = useState(0);
  /** Duration read from `<audio>` metadata; only used when the event has none. */
  const [metaDurationMs, setMetaDurationMs] = useState(0);

  const durationMs = voice.durationMs > 0 ? voice.durationMs : metaDurationMs;
  /** A range's max must be finite and > 0 even before we know the length. */
  const scaleMs = durationMs > 0 ? durationMs : 1;
  const playing = state === 'playing';

  const pause = useCallback((): void => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    setState((s) => (s === 'error' ? s : 'paused'));
    setPositionMs(Math.round(el.currentTime * 1000));
    releasePlayback(id);
  }, [id]);

  // Position ticker while playing (`timeupdate` is too coarse for AC-V3-2's two polls).
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const el = audioRef.current;
      if (el) setPositionMs(Math.round(el.currentTime * 1000));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing]);

  /** The downloaded original (retyped when needed). One download per bubble, kept for its life. */
  const downloadRef = useRef<Promise<Blob> | null>(null);
  /** Object URL of the original file (native path); created lazily, revoked on unmount. */
  const nativeUrlRef = useRef<string | null>(null);
  /** In-flight / finished WAV decode (fallback path); cleared on failure so a retry can decode again. */
  const fallbackRef = useRef<Promise<string> | null>(null);
  /** Object URL of the decoded WAV; revoked on unmount. */
  const fallbackUrlRef = useRef<string | null>(null);
  /** The path the next play uses (null until the first tap decides it). */
  const pathRef = useRef<PlaybackPath | null>(null);
  /** Paths that have been attempted, so each one is tried at most once before `voice-error`. */
  const triedRef = useRef<Set<PlaybackPath>>(new Set());
  /** Bumped by every play attempt; a continuation from an older attempt bails out. */
  const attemptRef = useRef(0);
  /** Latest position for async continuations (state closures go stale). */
  const positionRef = useRef(0);
  useEffect(() => {
    positionRef.current = positionMs;
  }, [positionMs]);
  /** Pending native-playback watchdog (cleared by `playing`, pause, a newer attempt, unmount). */
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearWatchdog = (): void => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  };
  /** Mirrors `pathRef` for `data-playback`; null until the first source is set on `<audio>`. */
  const [playbackPath, setPlaybackPath] = useState<PlaybackPath | null>(null);
  const disposedRef = useRef(false);

  // Stop playing and release every object URL when the row unmounts (room switch, pagination).
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      attemptRef.current += 1;
      if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
      releasePlayback(id);
      const el = audioRef.current;
      if (el && !el.paused) el.pause();
      for (const ref of [nativeUrlRef, fallbackUrlRef]) {
        if (ref.current) {
          URL.revokeObjectURL(ref.current);
          ref.current = null;
        }
      }
    };
  }, [id]);

  /** Download once (concurrent taps share the request). Rejects on a bad download. */
  const download = useCallback((): Promise<Blob> => {
    if (!downloadRef.current) {
      const p = (async () => {
        const res = await fetchMedia(voice.url);
        if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
        const blob = await res.blob();
        // Keep the event's mimetype when the response has no audio type: Synapse serves the right
        // one, but a proxy might send none or application/octet-stream.
        // When the response type and the event disagree, the first bytes decide (resolveMimetype);
        // the blob is retyped so `<audio>` and the decoder both see the real container.
        const mime = await resolveMimetype(blob, voice.mimetype);
        return mime && mime !== blob.type ? new Blob([blob], { type: mime }) : blob;
      })();
      downloadRef.current = p;
      // A failed download may be retried by the next tap.
      p.catch(() => {
        if (downloadRef.current === p) downloadRef.current = null;
      });
    }
    return downloadRef.current;
  }, [voice.url, voice.mimetype]);

  /** Object URL for `path`; the native one is what makes the note seekable (Synapse ignores Range). */
  const sourceFor = useCallback(
    async (path: PlaybackPath, blob: Blob): Promise<string> => {
      if (path === 'native') {
        if (!nativeUrlRef.current && !disposedRef.current) nativeUrlRef.current = URL.createObjectURL(blob);
        if (!nativeUrlRef.current) throw new Error('disposed');
        return nativeUrlRef.current;
      }
      if (!fallbackRef.current) {
        const p = (async () => {
          let wav: Blob;
          try {
            wav = await decodeToWavBlob(blob, blob.type || voice.mimetype);
          } catch (e) {
            throw new FormatError(e instanceof Error ? e.message : 'Undecodable audio');
          }
          // Never create a URL after unmount: nothing would revoke it.
          if (disposedRef.current) throw new Error('disposed');
          if (!fallbackUrlRef.current) fallbackUrlRef.current = URL.createObjectURL(wav);
          return fallbackUrlRef.current;
        })();
        fallbackRef.current = p;
        p.catch(() => {
          if (fallbackRef.current === p) fallbackRef.current = null;
        });
      }
      return fallbackRef.current;
    },
    [voice.mimetype],
  );

  /**
   * One play attempt on `pathRef`'s path (deciding it on the first tap). On a format failure it
   * switches to the other path once and tries again; anything else, or both paths failing, ends in
   * `voice-error`. `fromMs` is where to resume (the position when the previous path failed).
   */
  const startPlayback = useCallback(
    async (fromMs: number): Promise<void> => {
      const el = audioRef.current;
      if (!el) return;
      const attempt = ++attemptRef.current;
      /** Disposed, superseded by a newer attempt, or another bubble claimed playback (AC-V3-6). */
      const stale = (): boolean => {
        if (disposedRef.current || attempt !== attemptRef.current) return true;
        if (activePlayer?.id !== id) {
          setState('idle');
          return true;
        }
        return false;
      };
      let path: PlaybackPath | null = pathRef.current;
      try {
        const blob = await download();
        if (stale()) return;
        if (!path) {
          path = canPlayNatively(playabilityQuery(blob.type)) ? 'native' : 'fallback';
          pathRef.current = path;
        }
        triedRef.current.add(path);
        const src = await sourceFor(path, blob);
        if (stale()) return;
        if (el.src !== src) {
          el.src = src;
          setPlaybackPath(path);
          if (fromMs > 0) el.currentTime = fromMs / 1000;
        }
        // A rejected play() (unsupported container in WKWebView, autoplay rules) must not become an
        // unhandled rejection.
        clearWatchdog();
        if (path === 'native' && !triedRef.current.has('fallback')) {
          // play() may neither resolve nor reject on WKWebView; `playing` clears this.
          watchdogRef.current = setTimeout(() => {
            watchdogRef.current = null;
            if (disposedRef.current || attempt !== attemptRef.current || activePlayer?.id !== id) return;
            if (pathRef.current !== 'native' || triedRef.current.has('fallback')) return;
            pathRef.current = 'fallback';
            void startPlayback(Math.max(fromMs, positionRef.current));
          }, NATIVE_WATCHDOG_MS);
        }
        try {
          await el.play();
        } catch (e) {
          if (e instanceof DOMException && e.name === 'NotSupportedError') throw new FormatError(e.message);
          throw e;
        }
      } catch (e) {
        if (disposedRef.current || attempt !== attemptRef.current) return;
        clearWatchdog();
        // An AbortError means a newer src/pause interrupted this play(); not a failure.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Autoplay policy, never a format problem: back to tappable, the next tap is a fresh gesture.
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          releasePlayback(id);
          setState(positionRef.current > 0 ? 'paused' : 'idle');
          return;
        }
        if (e instanceof FormatError && path) {
          const other: PlaybackPath = path === 'native' ? 'fallback' : 'native';
          if (!triedRef.current.has(other)) {
            pathRef.current = other;
            await startPlayback(Math.max(fromMs, positionRef.current));
            return;
          }
        }
        releasePlayback(id);
        setState('error');
      }
    },
    [download, sourceFor, id, voice.mimetype],
  );

  const toggle = (): void => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      pause();
      return;
    }
    claimPlayback(id, pause);
    setState('loading');
    // First tap only (no real source on the element yet): play a silent clip synchronously so the
    // element keeps its user activation for the play() after the awaits (iOS). Its media events are
    // filtered out by `isUnlockEvent`; the real src replaces it (which aborts it) before play.
    const src = el.currentSrc || el.src;
    if (src !== nativeUrlRef.current && src !== fallbackUrlRef.current) {
      try {
        el.src = UNLOCK_SRC;
        void el.play().catch(() => {});
      } catch {
        /* best effort */
      }
    }
    void startPlayback(positionMs);
  };

  /**
   * `<audio>` error. A format error on the source of the current path (at load or mid-playback)
   * switches to the other path once, resuming where it stopped. Errors from a source we already
   * abandoned (a `play()` rejection got there first) are ignored, as is a format error on the pre-tap
   * metadata load of the plain http URL (no-duration notes): the tap picks the right path. Everything
   * else (network errors, both paths failed) is `voice-error`.
   */
  const onAudioError = (el: HTMLAudioElement): void => {
    if (disposedRef.current || isUnlockEvent(el)) return;
    const formatError = isFormatMediaError(el.error);
    const src = el.currentSrc || el.src;
    const srcPath: PlaybackPath | null =
      src && src === nativeUrlRef.current ? 'native' : src && src === fallbackUrlRef.current ? 'fallback' : null;
    if (srcPath === null && formatError) return;
    if (srcPath !== null && srcPath !== pathRef.current) return;
    if (formatError && srcPath !== null) {
      const other: PlaybackPath = srcPath === 'native' ? 'fallback' : 'native';
      if (!triedRef.current.has(other)) {
        const resumeMs = Math.max(positionRef.current, Math.round((el.currentTime || 0) * 1000));
        pathRef.current = other;
        if (activePlayer?.id === id) {
          setState('loading');
          void startPlayback(resumeMs);
        } else {
          // Not the active note (a late error after a pause): the next tap uses the other path.
          setPositionMs(resumeMs);
        }
        return;
      }
    }
    attemptRef.current += 1;
    clearWatchdog();
    releasePlayback(id);
    setState('error');
  };

  const seekTo = useCallback(
    (ms: number): void => {
      const el = audioRef.current;
      const clamped = Math.max(0, Math.min(scaleMs, ms));
      setPositionMs(clamped);
      if (el) {
        try {
          el.currentTime = clamped / 1000;
        } catch {
          /* not seekable yet */
        }
      }
    },
    [scaleMs],
  );

  /*
   * React's controlled-input value tracker swallows an `input` event that follows a direct
   * `el.value = x` assignment, which is exactly how a test scrubs the range (AC-V3-5). A native
   * listener next to `onChange` makes both paths work; `seekTo` is idempotent.
   */
  const progressRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = progressRef.current;
    if (!el) return;
    const onInput = (): void => seekTo(Number(el.value));
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [seekTo]);

  const samples = voice.waveform.length > 0 ? voice.waveform : null;
  const barCount = samples ? samples.length : FLAT_BARS;
  const progressRatio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const playedBars = Math.round(progressRatio * barCount);
  // Idle shows the total; playing / paused show how far in we are (AC-V3-1 / AC-V3-2 / AC-V3-4).
  const durationLabel = state === 'playing' || state === 'paused' ? formatDuration(positionMs) : formatDuration(durationMs);

  return (
    <div
      className={styles.bubble}
      data-testid="voice-message"
      data-state={state}
      data-duration-ms={durationMs}
      data-position-ms={positionMs}
      data-mimetype={voice.mimetype}
      data-playback={playbackPath ?? undefined}
      data-voice={voice.isVoice ? 'true' : 'false'}
    >
      <audio
        ref={audioRef}
        // No src until the first tap when the event carries a duration (nothing to look up, and a
        // broken download must only surface after the tap). Without a duration we need metadata, so
        // the plain http URL is loaded up front and swapped for the object URL on play.
        src={voice.durationMs > 0 ? undefined : voice.url}
        preload={voice.durationMs > 0 ? 'none' : 'metadata'}
        onLoadedMetadata={(e) => {
          if (isUnlockEvent(e.currentTarget)) return;
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setMetaDurationMs(Math.round(d * 1000));
        }}
        onPlaying={(e) => {
          if (isUnlockEvent(e.currentTarget)) return;
          clearWatchdog();
          setState('playing');
        }}
        onPause={(e) => {
          if (isUnlockEvent(e.currentTarget)) return;
          setState((s) => (s === 'playing' || s === 'loading' ? 'paused' : s));
        }}
        onTimeUpdate={(e) => {
          if (isUnlockEvent(e.currentTarget)) return;
          setPositionMs(Math.round(e.currentTarget.currentTime * 1000));
        }}
        onEnded={(e) => {
          if (isUnlockEvent(e.currentTarget)) return;
          releasePlayback(id);
          setState('idle');
          setPositionMs(0);
          const el = audioRef.current;
          if (el) el.currentTime = 0;
        }}
        onError={(e) => onAudioError(e.currentTarget)}
      />

      <button
        type="button"
        className={styles.play}
        data-testid={playing ? 'voice-pause' : 'voice-play'}
        title={playing ? 'Pause' : 'Play voice message'}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={toggle}
      >
        {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
      </button>

      <div className={styles.track}>
        <div className={styles.waveform} data-testid="voice-waveform" data-samples={barCount} aria-hidden="true">
          {Array.from({ length: barCount }, (_, i) => {
            const value = samples ? samples[i]! : 0;
            // 12 % floor so silence and missing waveforms still read as a bar chart.
            const height = samples ? 12 + (Math.min(WAVEFORM_MAX, value) / WAVEFORM_MAX) * 88 : 22;
            return (
              <span
                key={i}
                className={`${styles.bar} ${i < playedBars ? styles.barPlayed : ''}`}
                style={{ height: `${height}%` }}
              />
            );
          })}
        </div>
        <input
          ref={progressRef}
          type="range"
          className={styles.progress}
          data-testid="voice-progress"
          min={0}
          max={scaleMs}
          step={10}
          value={Math.min(positionMs, scaleMs)}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={scaleMs}
          aria-valuenow={positionMs}
          aria-valuetext={formatDuration(positionMs)}
          onChange={(e) => seekTo(Number(e.target.value))}
        />
      </div>

      <span className={styles.duration} data-testid="voice-duration">
        {durationLabel}
      </span>

      {state === 'error' && (
        <div className={styles.error} data-testid="voice-error" role="alert">
          <span>Can&apos;t play this voice message.</span>
          <a className={styles.download} href={voice.url} download={voice.name} onClick={(e) => downloadMedia(e, voice.url, voice.name)} target="_blank" rel="noopener noreferrer">
            <Download size={13} aria-hidden="true" />
            Download
          </a>
        </div>
      )}
    </div>
  );
}
