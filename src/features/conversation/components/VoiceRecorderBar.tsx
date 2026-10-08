/**
 * Recording bar (DEV-B-12). Replaces the composer input while a voice note is being recorded,
 * encoded or uploaded.
 *
 *   composer-recording   data-state="recording|encoding|sending|error"
 *   recording-timer      elapsed m:ss (floored; caps at 2:00)
 *   recording-level      data-level 0..100, width-animated meter
 *   recording-cancel     discard (releases the mic)
 *   recording-send       stop + send; in `error` state it retries the same blob
 *   recording-error      inline failure text
 *
 * The red dot pulses only while `recording`; `encoding`/`sending` swap the timer for a status word so the
 * demo shows progress, and the send button turns into a spinner that cannot be tapped twice.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Loader, Mic, RotateCcw, Trash } from 'lucide-react';
import { plainTid, type Tid } from '../tid.ts';
import type { VoiceRecorder } from '../hooks/useVoiceRecorder.ts';
import styles from './VoiceRecorderBar.module.css';

const STATUS_TEXT: Record<string, string> = {
  encoding: 'Processing...',
  sending: 'Sending...',
  error: 'Not sent',
};

/** Bars in the live meter (DEV-B-17 polish): a scrolling history of the input level. */
const METER_BARS = 26;
const METER_TICK_MS = 80;

/**
 * Scrolling level history. It samples the current level on its own timer rather than reacting to
 * prop changes, so the bars keep moving while the level happens to hold steady.
 */
function LevelBars({ level, live }: { level: number; live: boolean }) {
  const [history, setHistory] = useState<number[]>(() => new Array<number>(METER_BARS).fill(0));
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setHistory((h) => [...h.slice(1), levelRef.current]), METER_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  return (
    <>
      {history.map((value, i) => (
        <span key={i} className={styles.meterBar} style={{ height: `${Math.max(8, Math.min(100, value))}%` }} />
      ))}
    </>
  );
}

export function VoiceRecorderBar({ recorder, tid = plainTid }: { recorder: VoiceRecorder; tid?: Tid }) {
  const { state, elapsedLabel, level, error } = recorder;
  const busy = state === 'encoding' || state === 'sending';
  const status = STATUS_TEXT[state];

  return (
    <div className={styles.bar} data-testid={tid('composer-recording')} data-state={state} role="group" aria-label="Recording a voice message">
      <button
        type="button"
        className={styles.cancel}
        data-testid="recording-cancel"
        title="Discard recording"
        aria-label="Discard recording"
        onClick={recorder.cancel}
      >
        <Trash size={18} aria-hidden="true" />
      </button>

      <span className={`${styles.dot} ${state === 'recording' ? styles.dotLive : ''}`} aria-hidden="true" />

      <span className={styles.timer} data-testid="recording-timer" aria-live="off">
        {elapsedLabel}
      </span>

      <div
        className={styles.level}
        data-testid="recording-level"
        data-level={level}
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={level}
      >
        {status ? <span className={styles.levelHint}>{status}</span> : <LevelBars level={level} live={state === 'recording'} />}
      </div>

      <button
        type="button"
        className={styles.send}
        data-testid="recording-send"
        title={state === 'error' ? 'Retry sending' : 'Send voice message'}
        aria-label={state === 'error' ? 'Retry sending' : 'Send voice message'}
        disabled={busy}
        onClick={recorder.send}
      >
        {busy ? (
          <Loader size={20} className={styles.spin} aria-hidden="true" />
        ) : state === 'error' ? (
          <RotateCcw size={20} aria-hidden="true" />
        ) : (
          <Check size={20} aria-hidden="true" />
        )}
      </button>

      {error && (
        <div className={styles.error} data-testid="recording-error" role="alert">
          <Mic size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Permission / unsupported notice shown above the input instead of inside the bar: AC-V5-1 requires
 * `composer-input` to keep working after a denial, so the bar is never opened for it. Same testid
 * (`recording-error`) and never rendered at the same time as the bar.
 */
export function VoiceErrorBanner({ message }: { message: string }) {
  return (
    <div className={styles.banner} data-testid="recording-error" role="alert">
      <Mic size={14} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
