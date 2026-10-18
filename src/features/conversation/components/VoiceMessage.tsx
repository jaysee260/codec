/**
 * Voice-note playback bubble (DEV-B-14 / DEV-B-17).
 *
 * Rendered by `MessageBody` for every event where `getVoiceMessage(event)` is non-null (a real voice
 * note or any other playable `m.audio`). One plain `<audio>` element per bubble - no Web Audio, no
 * library.
 *
 *   voice-message   data-state="idle|loading|playing|paused|error", data-duration-ms,
 *                   data-position-ms, data-mimetype
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
 * Only one note plays at a time (AC-V3-6): a tiny module-level registry pauses the previous one.
 *
 * Phase 5 (DEV-B-28, AC-E3-4): an encrypted note (`voice.file`, `voice.url === ''`) is fetched the same way,
 * on the first tap, through `fetchDecryptedBlob` (download + SHA-256 check + AES-CTR decrypt), and plays from
 * that blob; `data-encrypted="true"`. A hash or key failure is `voice-error`, whose download button decrypts
 * through `downloadMedia` with the file source (never a link to the ciphertext).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { formatDuration, type VoiceMessageInfo } from '@/lib/matrix/utils.ts';
import { downloadMedia, fetchMedia } from '@/lib/matrix/media.ts';
import { fetchDecryptedBlob } from '@/lib/matrix/attachments.ts';
import styles from './VoiceMessage.module.css';

/** Bars drawn when the sender gave no waveform (flat placeholder, AC-V4-3). */
const FLAT_BARS = 40;
/** Position refresh while playing; `timeupdate` alone only fires about 4x/s. */
const TICK_MS = 100;
const WAVEFORM_MAX = 1024;

type PlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

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

  /** Object URL of the downloaded media; created on the first play, revoked on unmount. */
  const objectUrlRef = useRef<string | null>(null);
  const disposedRef = useRef(false);

  // Stop playing and release the object URL when the row unmounts (room switch, pagination).
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      releasePlayback(id);
      const el = audioRef.current;
      if (el && !el.paused) el.pause();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [id]);

  /** Download once; the object URL is what makes the note seekable. Throws on a bad download. */
  const ensureSource = useCallback(async (): Promise<string> => {
    if (objectUrlRef.current) return objectUrlRef.current;
    if (voice.file) {
      const plain = await fetchDecryptedBlob(voice.file, voice.mimetype);
      if (disposedRef.current) throw new Error('unmounted');
      const url = URL.createObjectURL(plain);
      objectUrlRef.current = url;
      return url;
    }
    const res = await fetchMedia(voice.url);
    if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
    const blob = await res.blob();
    // Keep the event's mimetype: Synapse serves the right one, but a proxy might not.
    const typed = blob.type ? blob : new Blob([blob], { type: voice.mimetype });
    const url = URL.createObjectURL(typed);
    objectUrlRef.current = url;
    return url;
  }, [voice.url, voice.file, voice.mimetype]);

  const toggle = (): void => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      pause();
      return;
    }
    claimPlayback(id, pause);
    setState('loading');
    void (async () => {
      try {
        const src = await ensureSource();
        // Another bubble may have claimed playback while this one was downloading: AC-V3-6 means the
        // superseded one must stay silent instead of starting when its fetch finally resolves.
        if (disposedRef.current) return;
        if (activePlayer?.id !== id) {
          setState('idle');
          return;
        }
        if (el.src !== src) {
          el.src = src;
          if (positionMs > 0) el.currentTime = positionMs / 1000;
        }
        // A rejected play() (unsupported container in WKWebView, autoplay rules) must not become an
        // unhandled rejection.
        await el.play();
      } catch {
        if (disposedRef.current) return;
        releasePlayback(id);
        setState('error');
      }
    })();
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
      data-voice={voice.isVoice ? 'true' : 'false'}
      data-encrypted={voice.file ? 'true' : undefined}
    >
      <audio
        ref={audioRef}
        // No src until the first tap when the event carries a duration (nothing to look up, and a
        // broken download must only surface after the tap). Without a duration we need metadata, so
        // the plain http URL is loaded up front and swapped for the object URL on play.
        // An encrypted note has no fetchable URL at all: nothing loads before the tap.
        src={voice.durationMs > 0 || voice.file ? undefined : voice.url}
        preload={voice.durationMs > 0 || voice.file ? 'none' : 'metadata'}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setMetaDurationMs(Math.round(d * 1000));
        }}
        onPlaying={() => setState('playing')}
        onPause={() => setState((s) => (s === 'playing' || s === 'loading' ? 'paused' : s))}
        onTimeUpdate={(e) => setPositionMs(Math.round(e.currentTarget.currentTime * 1000))}
        onEnded={() => {
          releasePlayback(id);
          setState('idle');
          setPositionMs(0);
          const el = audioRef.current;
          if (el) el.currentTime = 0;
        }}
        onError={() => {
          releasePlayback(id);
          setState('error');
        }}
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
          {voice.file ? (
            <button
              type="button"
              className={`${styles.download} ${styles.downloadButton}`}
              onClick={(e) => downloadMedia(e, voice.file!, voice.name, voice.mimetype)}
            >
              <Download size={13} aria-hidden="true" />
              Download
            </button>
          ) : (
            <a className={styles.download} href={voice.url} download={voice.name} onClick={(e) => downloadMedia(e, voice.url, voice.name)} target="_blank" rel="noopener noreferrer">
              <Download size={13} aria-hidden="true" />
              Download
            </a>
          )}
        </div>
      )}
    </div>
  );
}
