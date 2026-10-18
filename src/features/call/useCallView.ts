/**
 * What the call screen and the in-call bar render, derived once from the store + `useCallUi`.
 */
import { useEffect, useState } from 'react';
import { useActiveCall, type ActiveCall } from '@/store/call.ts';
import { screenStateOf, type ScreenState } from './model.ts';
import { callKeyOf, useCallUi } from './useCallUi.ts';

export interface CallView {
  call: ActiveCall | null;
  screen: ScreenState | null;
  /** `call-screen` is shown. */
  screenVisible: boolean;
  /** `in-call-bar` is shown (a live call whose screen is minimised). */
  barVisible: boolean;
  connectedSince: number | null;
}

export function useCallView(): CallView {
  const call = useActiveCall();
  const ui = useCallUi();
  const current = !!call && ui.callKey === callKeyOf(call);
  const screen = call ? screenStateOf(call, current ? ui.intent : null) : null;
  const over = call?.state === 'ended';
  const screenVisible = !!call && (!current || (ui.screenOpen && !ui.dismissed));
  const barVisible = !!call && !over && current && !ui.screenOpen;
  return { call, screen, screenVisible, barVisible, connectedSince: current ? ui.connectedSince : null };
}

/** Re-render every `ms` while `active` (the call timer). */
export function useTick(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}
