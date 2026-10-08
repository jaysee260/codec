/**
 * One shared clock for the relative timestamps on thread summary rows ("just now" -> "1 min ago").
 *
 * A row that re-renders itself on its own `setInterval` would mean one timer per thread root on
 * screen; this is a single module-level interval that only runs while at least one component is
 * subscribed, and it is stopped when the last one unmounts.
 */
import { useEffect, useState } from 'react';

const TICK_MS = 30_000;

const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: (now: number) => void): () => void {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const listener of listeners) listener(now);
    }, TICK_MS);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Epoch ms, refreshed every 30 s. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}
