/**
 * The incoming card's view of the Principal's ringtone helper (`src/lib/audio/ringtone.ts`). The store plays and
 * stops the ringtone (and vibrates on phones) itself; the card only needs `canPlay()` for the "Click anywhere to
 * hear the ringtone" note. Loaded through a glob so the card builds (and simply shows no note) without it.
 */
import { useEffect, useState } from 'react';

export interface RingtoneLike {
  canPlay(): boolean;
  lastPlayedAt?: number | null;
}

const modules = import.meta.glob<{ ringtone?: RingtoneLike }>('../../lib/audio/ringtone.ts');
const load = Object.values(modules)[0];
let cached: RingtoneLike | null = null;
let loading: Promise<RingtoneLike | null> | null = null;

export function loadRingtone(): Promise<RingtoneLike | null> {
  if (cached) return Promise.resolve(cached);
  if (!load) return Promise.resolve(null);
  loading ??= load()
    .then((m) => (cached = m.ringtone ?? null))
    .catch(() => null);
  return loading;
}

/** True while the ringtone exists but the browser will not let it play yet (no click / key press on the page). */
export function useRingtoneMuted(active: boolean): boolean {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let ringtone: RingtoneLike | null = null;
    const check = (): void => {
      if (alive && ringtone) setMuted(!ringtone.canPlay());
    };
    void loadRingtone().then((r) => {
      ringtone = r;
      check();
    });
    // The helper flips `canPlay` on the first gesture; re-read just after it (the helper's listener may run later).
    const onGesture = (): void => {
      setTimeout(check, 0);
      setTimeout(check, 250);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    const timer = setInterval(check, 1000);
    return () => {
      alive = false;
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      clearInterval(timer);
    };
  }, [active]);
  return active && muted;
}
