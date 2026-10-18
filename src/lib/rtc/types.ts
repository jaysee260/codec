/**
 * Phase 7 (voice calls): shared types of the call layer. Pure, Node-loadable.
 */

/** Why a call could not start, was refused, or ended with an error. Stable codes the UI maps to text. */
export type CallErrorCode =
  | 'unencrypted' // the room has no m.room.encryption: calls are refused (PLAN: no silent fallback)
  | 'crypto-unavailable' // this session runs without the crypto engine, so media keys cannot be shared
  | 'not-allowed' // the room's power levels do not let this user send call state (ask an admin)
  | 'no-focus' // no LiveKit focus is configured (well-known / rtc/transports / override)
  | 'token' // the LiveKit auth service refused or failed
  | 'mic-denied' // getUserMedia: NotAllowedError
  | 'mic-missing' // getUserMedia: NotFoundError / no audio input
  | 'mic-busy' // getUserMedia: NotReadableError (another app holds the mic)
  | 'media-unsupported' // no WebRTC / no insertable streams (E2EE) in this browser
  | 'connect' // LiveKit connect failed (network, bad token)
  | 'busy' // another call is active and a second one was requested
  | 'bridged-dm' // the only other member is a bridge ghost (Signal): nobody could answer (PRIN-33)
  | 'membership' // the MatrixRTC membership manager gave up (delayed events, state events)
  | 'unknown';

export class CallError extends Error {
  readonly code: CallErrorCode;
  constructor(code: CallErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = 'CallError';
    this.code = code;
  }
}

/** A LiveKit focus as advertised in the well-known / `rtc/transports` (MSC4143 + MSC4195). */
export interface LivekitFocus {
  type: 'livekit';
  livekit_service_url: string;
  /** MatrixRTC `Transport` compatibility (the SDK's focus type is an open object). */
  [key: string]: unknown;
}

/** A device taking part in the MatrixRTC session (one Matrix user can have several). */
export interface CallParticipant {
  userId: string;
  deviceId: string;
  /** `${userId}:${deviceId}`: the LiveKit participant identity for legacy (state-event) memberships. */
  identity: string;
  /** This device (never speaking-highlighted by the remote path). */
  isSelf: boolean;
  /** The device's media is connected to the SFU (it may be a member without media while it connects). */
  connected: boolean;
  speaking: boolean;
  /** Microphone muted or not published yet. */
  muted: boolean;
  /** We hold a media key for this device, so its audio decrypts (false = "can't hear them" until keys arrive). */
  hasKey: boolean;
  /**
   * `ok`: a key arrived; `pending`: none yet, within the grace period; `missing`: none after CALL_KEYS_TIMEOUT_MS
   * (UI: "No call keys from X yet"). Keys travel over Olm to every device, verified or not (Advisor Wave 19).
   */
  keyState: 'ok' | 'pending' | 'missing';
}

export type CallStateName = 'connecting' | 'ringing' | 'connected' | 'reconnecting' | 'ended';

/** Why `state` became `ended`. */
export type CallEndReason =
  | 'hangup' // we left
  | 'remote-hangup' // everyone else left (DM)
  | 'declined' // the callee declined (DM ring)
  | 'no-answer' // nobody joined within the ring timeout (DM ring)
  | 'busy' // the callee is in another call
  | 'answered-elsewhere' // one of our other devices took the call
  | 'error';

export interface IncomingCall {
  roomId: string;
  /** The `org.matrix.msc4075.rtc.notification` event id (what a decline references). */
  notifyEventId: string;
  /** Caller's user id. */
  from: string;
  slotId: string;
  /** Ringing stops at this timestamp (ms since epoch): min(notification lifetime, 60 s). */
  expiresAt: number;
  receivedAt: number;
}

export type CallDirection = 'outgoing' | 'incoming';

export type CallOutcome = 'completed' | 'missed' | 'declined' | 'busy' | 'no-answer' | 'failed' | 'cancelled';

export interface CallHistoryEntry {
  id: string;
  roomId: string;
  direction: CallDirection;
  outcome: CallOutcome;
  /** The other user for DMs; the caller for incoming room calls; null for a room call we started. */
  peerUserId: string | null;
  startedAt: number;
  endedAt: number;
  /** Time spent `connected`, 0 when the call never connected. */
  durationMs: number;
}

/** What `canCall(roomId)` answers. `hint: 'codec-only'` = a bridged group: the call reaches Codec members only. */
export type CallAvailability = { ok: true; hint?: 'codec-only' } | { ok: false; reason: CallErrorCode; message: string };
