/**
 * Call UI model (Dev B, Phase 7): pure helpers the call components render with. Node-loadable (unit-tested in
 * `model.test.ts`), so nothing here imports React, the store or the SDK at runtime.
 */

/** `call-screen[data-state]` values (docs/PHASE7_ACCEPTANCE.md registry). */
export type ScreenState = 'calling' | 'connecting' | 'connected' | 'reconnecting' | 'no-answer' | 'busy' | 'ended';

/** The part of the store's `ActiveCall` snapshot the screen state depends on. */
export interface CallStateLike {
  state: string;
  endReason?: string | null;
  ringing?: boolean;
}

/**
 * Map the store's call state onto the screen states. The store says `connecting` / `ringing` / `connected` /
 * `reconnecting` / `ended` (+ `endReason`); the screen also needs "Calling..." for an outgoing ring that is still
 * setting up (`intent === 'ring'`), "No answer" and "Busy".
 */
export function screenStateOf(call: CallStateLike, intent: 'ring' | 'join' | null): ScreenState {
  switch (call.state) {
    case 'calling':
    case 'ringing':
      return 'calling';
    case 'connecting':
      return intent === 'ring' ? 'calling' : 'connecting';
    case 'connected':
      return call.ringing ? 'calling' : 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'no-answer':
      return 'no-answer';
    case 'busy':
      return 'busy';
    case 'ended':
      if (call.endReason === 'no-answer') return 'no-answer';
      if (call.endReason === 'busy') return 'busy';
      return 'ended';
    default:
      return 'connecting';
  }
}

/**
 * How long the screen stays up once the call is over, in ms. `null` = until the user closes it
 * ("No answer" offers Call back + Close). 0 = close right away (we hung up ourselves).
 */
export function closeDelayFor(screen: ScreenState, endReason: string | null | undefined): number | null {
  if (screen === 'no-answer') return null;
  if (screen === 'busy') return 3000;
  if (screen !== 'ended') return null;
  if (endReason === 'hangup') return 0;
  if (endReason === 'declined' || endReason === 'error') return 3000;
  return 2000;
}

/** `call-status` text. `peerName` is the other person in a DM (for "alice declined"). */
export function statusText(screen: ScreenState, opts: { endReason?: string | null; peerName?: string; errorMessage?: string | null } = {}): string {
  switch (screen) {
    case 'calling':
      return 'Calling...';
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting...';
    case 'no-answer':
      return 'No answer';
    case 'busy':
      return 'Busy';
    case 'ended':
      if (opts.endReason === 'declined') return opts.peerName ? `${opts.peerName} declined` : 'Declined';
      if (opts.endReason === 'answered-elsewhere') return 'Answered on another device';
      if (opts.endReason === 'error') return opts.errorMessage || 'Call failed';
      return 'Call ended';
  }
}

/** `mm:ss` (minutes keep counting past 59: "75:03"). */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** One device in the call, as the store reports it (extra fields ignored). */
export interface ParticipantLike {
  userId: string;
  isSelf?: boolean;
  speaking?: boolean;
  muted?: boolean;
  poor?: boolean;
  keyState?: string;
}

export interface Tile {
  userId: string;
  isSelf: boolean;
  speaking: boolean;
  muted: boolean;
  poor: boolean;
  keys: 'ok' | 'missing';
}

/**
 * One tile per user (the testid is per user, `call-participant-{userId}`), self first. A user on two devices is
 * speaking if either is, muted only if both are, and "missing keys" if any of their devices is. Our own tile never
 * reports missing keys (we hold our own key).
 */
export function tilesOf(participants: readonly ParticipantLike[], myUserId: string | null): Tile[] {
  const byUser = new Map<string, Tile>();
  for (const p of participants) {
    const self = !!p.isSelf || p.userId === myUserId;
    const prev = byUser.get(p.userId);
    const missing = !self && p.keyState === 'missing';
    if (!prev) {
      byUser.set(p.userId, {
        userId: p.userId,
        isSelf: self,
        speaking: !!p.speaking,
        muted: !!p.muted,
        poor: !!p.poor,
        keys: missing ? 'missing' : 'ok',
      });
    } else {
      prev.isSelf = prev.isSelf || self;
      prev.speaking = prev.speaking || !!p.speaking;
      prev.muted = prev.muted && !!p.muted;
      prev.poor = prev.poor || !!p.poor;
      if (missing && !prev.isSelf) prev.keys = 'missing';
      if (prev.isSelf) prev.keys = 'ok';
    }
  }
  return [...byUser.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}

/** The toast for a failed start / accept / join (store `lastError`). */
export function errorText(code: string, message?: string | null): string {
  switch (code) {
    case 'mic-denied':
      return "Codec can't use your microphone. Allow it in the browser's site settings and try again";
    case 'mic-missing':
      return 'No microphone found. Plug one in and try again';
    case 'mic-busy':
      return 'Another app is using your microphone. Close it and try again';
    case 'unencrypted':
      return 'Calls need an encrypted room';
    case 'busy':
      return "You're already in a call";
    case 'media-unsupported':
      return "This browser can't make encrypted calls";
    case 'no-focus':
    case 'token':
    case 'connect':
      return "Couldn't reach the call server. Try again in a moment";
    default:
      return message || "Couldn't start the call";
  }
}

/** Header button title for a disabled reason. */
export function disabledTitle(reason: string, message?: string): string {
  if (reason === 'unencrypted') return 'Calls need an encrypted room';
  if (reason === 'busy') return "You're already in a call";
  return message || "Calls aren't available here";
}
