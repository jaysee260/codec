/**
 * Phase 7 (PRIN-30): the incoming-call ringtone, synthesised with WebAudio (no asset to ship, loops for free).
 *
 *   ringtone.canPlay()        true once the page has seen a pointer / key gesture (browser autoplay gate)
 *   ringtone.play()           starts the loop; before a gesture it resolves without playing (never throws) and the
 *                             first pointer / key gesture after it starts the loop unless `stop()` came first (BUG-33)
 *   ringtone.stop()           silence; idempotent
 *   ringtone.lastPlayedAt     ms timestamp of the last successful `play()`, null until then (AC-R3-8)
 *   ringtone.vibrate(on)      `navigator.vibrate` pattern on phones (no-op where unsupported); off stops it
 *
 * The store starts it with the first `incoming` ring and stops it when the list empties; Dev B's card only reads
 * `canPlay()` for the "Click anywhere to hear the ringtone" note. Pattern: two 0.4 s tones (A5 + C#6-ish beat),
 * a 1.2 s pause, looped: short, recognisably a ring, not a tune.
 */

let gestureSeen = false;
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let gain: GainNode | null = null;
let lastPlayedAt: number | null = null;
/** `play()` was asked for before any gesture: the first gesture starts it (BUG-33). */
let pendingPlay = false;

const VIBRATE_PATTERN = [400, 200, 400, 1200];

function noteGesture(): void {
  gestureSeen = true;
  if (pendingPlay) {
    pendingPlay = false;
    void ringtone.play();
  }
}

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(type, noteGesture, { capture: true, passive: true });
  }
}

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

function burst(at: number): void {
  if (!ctx || !gain) return;
  for (const [offset, freq] of [
    [0, 880],
    [0.5, 988],
  ] as const) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, at + offset);
    env.gain.linearRampToValueAtTime(0.6, at + offset + 0.02);
    env.gain.setValueAtTime(0.6, at + offset + 0.35);
    env.gain.linearRampToValueAtTime(0, at + offset + 0.4);
    osc.connect(env).connect(gain);
    osc.start(at + offset);
    osc.stop(at + offset + 0.42);
  }
}

export const ringtone = {
  canPlay(): boolean {
    return gestureSeen;
  },
  get lastPlayedAt(): number | null {
    return lastPlayedAt;
  },
  async play(): Promise<void> {
    if (timer) return;
    if (!gestureSeen) {
      pendingPlay = true; // resolves without playing; the first pointer / key gesture retries (BUG-33)
      return;
    }
    pendingPlay = false;
    const audio = getContext();
    if (!audio) return;
    try {
      if (audio.state === 'suspended') await audio.resume();
      if (audio.state !== 'running') return;
    } catch {
      return;
    }
    gain = audio.createGain();
    gain.gain.value = 0.5;
    gain.connect(audio.destination);
    lastPlayedAt = Date.now();
    burst(audio.currentTime + 0.05);
    timer = setInterval(() => {
      if (ctx) burst(ctx.currentTime + 0.05);
    }, 2200);
  },
  stop(): void {
    pendingPlay = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (gain) {
      try {
        gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    gain = null;
    ringtone.vibrate(false);
  },
  /** Repeating vibration while ringing (phones); `false` cancels. Never throws. */
  vibrate(on: boolean): void {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }) : undefined;
    if (!nav?.vibrate) return;
    try {
      if (on) {
        nav.vibrate(VIBRATE_PATTERN);
        if (!vibrateTimer) vibrateTimer = setInterval(() => nav.vibrate!(VIBRATE_PATTERN), VIBRATE_PATTERN.reduce((a, b) => a + b, 0));
      } else {
        if (vibrateTimer) clearInterval(vibrateTimer);
        vibrateTimer = null;
        nav.vibrate(0);
      }
    } catch {
      /* ignore */
    }
  },
  /** Test hook: pretend a gesture happened (Playwright clicks do this for real). */
  _markGesture(): void {
    gestureSeen = true;
  },
};

let vibrateTimer: ReturnType<typeof setInterval> | null = null;

export type Ringtone = typeof ringtone;
