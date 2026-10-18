/**
 * Call UI state that is not call state (Dev B, Phase 7): whether the call screen is open or minimised to the
 * in-call bar, how the current call was started (an outgoing ring shows "Calling..." while it sets up), when it
 * became `connected` (the timer), and whether the finished call's screen was dismissed. The store keeps the last
 * snapshot in `ended` until the next call, so "dismissed" is per call (`callKey`).
 *
 * Synced from `useCallStore` by one module-level subscription: a new call (new `roomId|startedAt`) resets
 * everything and opens the screen.
 */
import { create } from 'zustand';
import { ringPolicy, useCallStore, type ActiveCall } from '@/store/call.ts';

export type CallIntent = 'ring' | 'join';

interface CallUiState {
  /** The call the fields below belong to (`roomId|startedAt`), null when there is no call. */
  callKey: string | null;
  screenOpen: boolean;
  intent: CallIntent | null;
  /** When the call first reached `connected` (timer base), ms since epoch. */
  connectedSince: number | null;
  /** The finished call's screen was closed (auto or by the user). */
  dismissed: boolean;
  openScreen(): void;
  minimiseScreen(): void;
  dismiss(): void;
}

export const useCallUi = create<CallUiState>((set) => ({
  callKey: null,
  screenOpen: true,
  intent: null,
  connectedSince: null,
  dismissed: false,
  openScreen: () => set({ screenOpen: true }),
  minimiseScreen: () => set({ screenOpen: false }),
  dismiss: () => set({ dismissed: true }),
}));

export function callKeyOf(call: Pick<ActiveCall, 'roomId' | 'startedAt'> | null): string | null {
  return call ? `${call.roomId}|${call.startedAt}` : null;
}

/** Intent for the next call the store creates (set right before `startCall` / `acceptCall` / `joinCall`). */
let pendingIntent: CallIntent | null = null;

function sync(call: ActiveCall | null): void {
  const ui = useCallUi.getState();
  const key = callKeyOf(call);
  if (key !== ui.callKey) {
    useCallUi.setState({
      callKey: key,
      screenOpen: true,
      intent: key ? pendingIntent : null,
      connectedSince: call && call.state === 'connected' && !call.ringing ? Date.now() : null,
      dismissed: false,
    });
    if (key) pendingIntent = null;
    return;
  }
  if (call && call.state === 'connected' && !call.ringing && ui.connectedSince === null) {
    useCallUi.setState({ connectedSince: Date.now() });
  }
}

sync(useCallStore.getState().activeCall);
useCallStore.subscribe((s) => sync(s.activeCall));

// ---------------------------------------------------------------------------
// Actions shared by the header button, the card, the timeline "Call back" and the screen
// ---------------------------------------------------------------------------

/** `ringPolicy(roomId)` from the store: DMs and rooms with <= 5 other Codec members ring, bigger rooms drop in. */
export function ringModeFor(roomId: string): 'ring' | 'drop-in' {
  try {
    return ringPolicy(roomId);
  } catch {
    return 'ring';
  }
}

/**
 * Start a call from the UI (header button, Call back). Failures land in the store's `lastError`, which `CallHost`
 * turns into a toast, so the rejection is swallowed here.
 */
export async function startCallFromUi(roomId: string): Promise<void> {
  const mode = ringModeFor(roomId);
  pendingIntent = mode === 'ring' ? 'ring' : 'join';
  try {
    // The store rings or drops in per the same `ringPolicy`.
    await useCallStore.getState().startCall(roomId);
  } catch {
    /* lastError -> toast (CallHost) */
  } finally {
    pendingIntent = null;
  }
}

export async function acceptFromUi(roomId: string): Promise<void> {
  pendingIntent = 'join';
  try {
    await useCallStore.getState().acceptCall(roomId);
  } catch {
    /* lastError -> toast */
  } finally {
    pendingIntent = null;
  }
}

/** Speaker / earpiece (`call-speaker`, phone): the store's `speaker` + `setSpeaker` (native shim). */
export function useSpeakerMode(): ['earpiece' | 'speaker', (mode: 'earpiece' | 'speaker') => void] {
  const mode = useCallStore((s) => s.speaker);
  return [mode, (next) => void useCallStore.getState().setSpeaker(next).catch(() => undefined)];
}
