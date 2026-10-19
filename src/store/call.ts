/**
 * Call store (Phase 7, voice calls): what the call UI renders and the actions behind its buttons. One active call
 * at a time (`activeCall`, mirrored from `CallSession.snapshot()`), the incoming rings (`incoming`), the rooms with a
 * live call (`liveSessions`, for the "Join voice (2)" chip and the sidebar indicator) and the local call history
 * (`history`, "Call ended, 12 min" / "Missed call"). Nothing here talks to LiveKit or the SDK directly except the
 * subscriptions in `bindCalls`; `src/lib/rtc/` does the work.
 *
 * Session wiring: `bindCalls(client)` after `bindSecurity`, `unbindCalls()` + `resetCalls()` on logout (session.ts).
 *
 * Selectors for Dev A / Dev B (all hooks re-exported from `@/store`):
 *   useActiveCall()                 ActiveCall | null              the in-call bar / full call screen
 *   useIncomingCall()               IncomingCall | null            the ringing card (first ring; `useIncomingCalls()` for all)
 *   useRoomCallSummary(roomId)      { live, userIds, deviceCount, joined, ringing }   chip / sidebar badge / header button state
 *   useCallAvailability(roomId)     CallAvailability               whether the Call button is enabled, and why not
 *   useCallHistory(roomId?)         CallHistoryEntry[]             timeline rows ("Call ended", "Missed call" + Call back)
 * Actions: startCall(roomId, { ring }), joinCall(roomId), acceptCall(roomId), declineCall(roomId), dismissIncoming(roomId),
 *          leaveCall(), toggleMute(), setMuted(b), setSpeaker('earpiece' | 'speaker'), setAudioOutput(id), resumeAudio(), clearError().
 *
 * Wave 2: `startCall` rings or drops in per `ringPolicy` (DMs and rooms with <= 5 other Codec members ring, bridge ghosts
 * never count), `canCall` knows bridged rooms (`bridged-dm` / hint `codec-only`), the store sends the Codec chat lines
 * (`dev.matrixpoc.call`: `missed` when our ring times out, `ended` when we are the last one out), plays the ringtone
 * (+ vibration on phones) while `incoming` is non-empty, and runs the Android foreground service for the call's lifetime.
 */
import { create } from 'zustand';
import { useCallback, useSyncExternalStore } from 'react';
import { RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { MatrixRTCSessionEvent, MatrixRTCSessionManagerEvents, type MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc/index.js';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { ringtone } from '@/lib/audio/ringtone.ts';
import { isNativeApp, onCallServiceHangup, setSpeakerphone, startCallService, stopCallService } from '@/lib/native.ts';
import { buildCallLineContent, CALL_LINE_TYPE, endLineFor, setCallTimelineResolver } from '@/lib/rtc/lines.ts';
import { bridgeGhostOnly, hasBridgeGhost, ringPolicy as ringPolicyOf, ringTargets, type RingPolicy } from '@/lib/rtc/policy.ts';
import { useRoomStore } from './rooms.ts';
import { appendHistory, HISTORY_STORAGE_KEY, makeHistoryEntry, missedOutcome, outcomeOf, parseStoredHistory } from '@/lib/rtc/history.ts';
import { canSendCallState, ensureCallPowerLevels } from '@/lib/rtc/permissions.ts';
import { sendDecline, watchIncomingCalls, type RingStopReason, type RingWatcher } from '@/lib/rtc/ringing.ts';
import { CallSession, MEMBERSHIP_EVENT_TYPE, type CallSessionSnapshot } from '@/lib/rtc/session.ts';
import { mediaEncryptionSupported } from '@/lib/rtc/e2ee-worker.ts';
import { CallError, type CallAvailability, type CallErrorCode, type CallHistoryEntry, type IncomingCall } from '@/lib/rtc/types.ts';

export type ActiveCall = CallSessionSnapshot;

export interface LiveSession {
  roomId: string;
  /** Users with a device in the call (deduplicated). */
  userIds: string[];
  deviceCount: number;
}

export interface RoomCallSummary {
  /** Someone is in a call in this room right now. */
  live: boolean;
  userIds: string[];
  deviceCount: number;
  /** This device is in the room's call. */
  joined: boolean;
  /** This room is ringing on this device. */
  ringing: boolean;
}

export interface CallState {
  activeCall: ActiveCall | null;
  incoming: IncomingCall[];
  history: CallHistoryEntry[];
  liveSessions: Record<string, LiveSession>;
  /** The last failure (start, accept, mute): the UI shows it and calls `clearError()`. */
  lastError: { code: CallErrorCode; message: string } | null;
  /** Phone audio route (Android shim; informational on the web). Reset to `earpiece` for every call. */
  speaker: 'earpiece' | 'speaker';
  /** Ring the room (DM Call button, WhatsApp-style room ring) or join a running call quietly (`joinCall`). */
  startCall(roomId: string, opts?: { ring?: boolean }): Promise<void>;
  joinCall(roomId: string): Promise<void>;
  acceptCall(roomId: string): Promise<void>;
  declineCall(roomId: string): Promise<void>;
  /** Stop ringing on this device without telling the caller (it becomes a missed call when the ring ends). */
  dismissIncoming(roomId: string): void;
  leaveCall(): Promise<void>;
  toggleMute(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** Loudspeaker / earpiece (`call-speaker`); calls the native shim, no-op on the web. */
  setSpeaker(mode: 'earpiece' | 'speaker'): Promise<void>;
  setAudioOutput(deviceId: string | null): Promise<void>;
  resumeAudio(): Promise<void>;
  clearError(): void;
}

const EMPTY_SUMMARY: RoomCallSummary = { live: false, userIds: [], deviceCount: 0, joined: false, ringing: false };

let session: CallSession | null = null;
/** The direction of the active call for the history entry (`startCall` = outgoing, `acceptCall` = incoming). */
let direction: 'outgoing' | 'incoming' = 'outgoing';
let incomingFrom: string | null = null;

function loadHistory(): CallHistoryEntry[] {
  try {
    return parseStoredHistory(localStorage.getItem(HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

function saveHistory(history: CallHistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* ignore */
  }
}

function toError(e: unknown): { code: CallErrorCode; message: string } {
  if (e instanceof CallError) return { code: e.code, message: e.message };
  return { code: 'unknown', message: (e as Error)?.message ?? String(e) };
}

/** The other member of a two-party room (a declined / unanswered DM call never has a connected peer to name). */
function dmPeer(roomId: string): string | null {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room || room.getJoinedMemberCount() !== 2) return null;
  const me = client.getUserId();
  return room.getJoinedMembers().map((m) => m.userId).find((u) => u !== me) ?? null;
}

/** 'ring' for DMs and small rooms, 'drop-in' above `CALL_RING_MAX_MEMBERS` other Codec members (AC-R3-2). */
export function ringPolicy(roomId: string): RingPolicy {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return 'ring';
  return ringPolicyOf(room, client.getUserId() ?? '', { isDm: !!useRoomStore.getState().roomsById[roomId]?.isDm });
}

/** Why a call cannot be started in `roomId` right now (pure over the SDK room; no network). */
export function canCall(roomId: string): CallAvailability {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return { ok: false, reason: 'unknown', message: 'Unknown room' };
  if (room.getMyMembership() !== 'join') return { ok: false, reason: 'not-allowed', message: 'Join the room to call' };
  if (!room.hasEncryptionStateEvent()) return { ok: false, reason: 'unencrypted', message: 'Calls need an encrypted room' };
  const me = client.getUserId() ?? '';
  if (bridgeGhostOnly(room, me)) return { ok: false, reason: 'bridged-dm', message: 'Calls do not reach Signal contacts' };
  if (!client.getCrypto()) return { ok: false, reason: 'crypto-unavailable', message: 'Encryption is not available in this session' };
  if (!mediaEncryptionSupported()) return { ok: false, reason: 'media-unsupported', message: 'This browser cannot encrypt call audio' };
  const userId = client.getUserId() ?? '';
  const admin = room.currentState.maySendStateEvent('m.room.power_levels', userId);
  if (!canSendCallState(room, userId) && !admin) return { ok: false, reason: 'not-allowed', message: "You can't start calls in this room (ask an admin)" };
  const active = useCallStore.getState().activeCall;
  if (active && active.state !== 'ended' && active.roomId !== roomId) return { ok: false, reason: 'busy', message: 'You are already in a call' };
  return hasBridgeGhost(room, me) ? { ok: true, hint: 'codec-only' } : { ok: true };
}

/** Best effort: the `dev.matrixpoc.call` line (encrypted like a message); a failure is logged, never shown. */
function sendCallLine(roomId: string, content: Record<string, unknown>): void {
  const client = getClientOrNull();
  if (!client) return;
  client.sendEvent(roomId, CALL_LINE_TYPE as never, content as never).catch((e: unknown) => console.warn('[call] could not send call line', e));
}

/** The lines this device owes when its call ends: `missed` (our ring timed out), `ended` (we were the last one out). */
function sendEndLines(snapshot: CallSessionSnapshot): void {
  if (!snapshot.callId) return;
  const kind = endLineFor(snapshot);
  if (kind === 'missed') {
    sendCallLine(snapshot.roomId, buildCallLineContent({ kind: 'missed', callId: snapshot.callId, participants: snapshot.rang }));
  } else if (kind === 'ended') {
    sendCallLine(snapshot.roomId, buildCallLineContent({ kind: 'ended', callId: snapshot.callId, durationMs: Date.now() - (snapshot.connectedAt ?? Date.now()), participants: snapshot.everParticipants }));
  }
}

/** Test override of the 60 s ring (STATUS request #24): ring `lifetime`, no-answer timer, incoming expiry cap. */
let ringTimeoutOverride: number | null = null;

export function setRingTimeoutMs(ms: number | null): void {
  ringTimeoutOverride = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

export function ringTimeoutMs(): number | undefined {
  return ringTimeoutOverride ?? undefined;
}

function roomNameOf(roomId: string): string {
  return useRoomStore.getState().roomsById[roomId]?.name ?? getClientOrNull()?.getRoom(roomId)?.name ?? '';
}

export const useCallStore = create<CallState>((set, get) => {
  function recordHistory(snapshot: CallSessionSnapshot, peerUserIds: string[]): void {
    const reason = snapshot.endReason ?? 'hangup';
    const outcome = outcomeOf(reason, snapshot.connectedAt !== null && snapshot.state !== 'ringing' && peerUserIds.length > 0);
    const entry = makeHistoryEntry({
      roomId: snapshot.roomId,
      direction,
      outcome,
      peerUserId: direction === 'incoming' ? incomingFrom : (peerUserIds[0] ?? dmPeer(snapshot.roomId)),
      startedAt: snapshot.startedAt,
      connectedAt: snapshot.connectedAt,
      endedAt: Date.now(),
    });
    const history = appendHistory(get().history, entry);
    saveHistory(history);
    set({ history });
  }

  async function begin(roomId: string, opts: { ring: boolean; dir: 'outgoing' | 'incoming'; from?: string; callId?: string }): Promise<void> {
    const client = getClientOrNull();
    const room = client?.getRoom(roomId);
    if (!client || !room) throw new CallError('unknown', 'Unknown room');
    const current = get().activeCall;
    if (session && current && current.state !== 'ended') {
      if (current.roomId === roomId) return;
      throw new CallError('busy', 'You are already in a call');
    }
    direction = opts.dir;
    incomingFrom = opts.from ?? null;
    let peers: string[] = [];
    const me = client.getUserId() ?? '';
    const next = new CallSession({
      client,
      room,
      ring: opts.ring,
      ringTargets: ringTargets(room, me),
      callId: opts.callId,
      ringTimeoutMs: ringTimeoutMs(),
      onChange: (snapshot) => {
        if (session !== next) return;
        if (snapshot.state !== 'ended') peers = next.peerUserIds().length ? next.peerUserIds() : peers;
        set({ activeCall: snapshot });
        if (snapshot.state === 'ended') {
          session = null;
          void stopCallService();
          sendEndLines(snapshot);
          recordHistory(snapshot, peers);
          if (snapshot.error) set({ lastError: snapshot.error });
        }
      },
    });
    session = next;
    set({ activeCall: next.snapshot(), lastError: null, speaker: 'earpiece' });
    // Android: the foreground service (mic type) must be running before the mic is held and the screen may lock;
    // only started while the app is visible (`startCallService` checks), i.e. from the Accept / Join / Call tap.
    await startCallService(roomNameOf(roomId));
    try {
      await next.start();
    } catch (e) {
      // A start that never got going (refused room, no mic, no focus, no token, SFU unreachable) is an error, not
      // an ended call: `lastError` carries it, `activeCall` goes back to null (history was recorded by onChange if
      // the session had gone far enough to ring anyone).
      if (session === next) session = null;
      void stopCallService();
      // One failed start is one error (BUG-37): when the session already reported it through onChange (and the UI may
      // already have shown and cleared it), don't raise a second one.
      set(next.snapshot().error ? { activeCall: null } : { activeCall: null, lastError: toError(e) });
      throw e;
    }
  }

  return {
    activeCall: null,
    incoming: [],
    history: loadHistory(),
    liveSessions: {},
    lastError: null,
    speaker: 'earpiece',

    async startCall(roomId, opts = {}) {
      await begin(roomId, { ring: opts.ring ?? ringPolicy(roomId) === 'ring', dir: 'outgoing' });
    },
    async joinCall(roomId) {
      await begin(roomId, { ring: false, dir: 'outgoing' });
    },
    async acceptCall(roomId) {
      const call = get().incoming.find((c) => c.roomId === roomId);
      ringWatcher?.stop(roomId, 'accepted');
      await begin(roomId, { ring: false, dir: 'incoming', from: call?.from, callId: call?.notifyEventId });
    },
    async declineCall(roomId) {
      const call = get().incoming.find((c) => c.roomId === roomId);
      if (!call) return;
      ringWatcher?.stop(roomId, 'declined');
      const client = getClientOrNull();
      if (client) await sendDecline(client, call).catch((e) => set({ lastError: toError(e) }));
    },
    dismissIncoming(roomId) {
      set({ incoming: get().incoming.filter((c) => c.roomId !== roomId) });
    },
    async leaveCall() {
      await session?.leave('hangup');
    },
    async toggleMute() {
      await get().setMuted(!(get().activeCall?.muted ?? false));
    },
    async setMuted(muted) {
      try {
        await session?.setMuted(muted);
      } catch (e) {
        set({ lastError: toError(e) });
      }
    },
    async setSpeaker(mode) {
      set({ speaker: mode });
      try {
        await setSpeakerphone(mode === 'speaker');
      } catch (e) {
        set({ lastError: toError(e) });
      }
    },
    async setAudioOutput(deviceId) {
      try {
        await session?.setAudioOutput(deviceId);
      } catch (e) {
        set({ lastError: toError(e) });
      }
    },
    async resumeAudio() {
      await session?.resumeAudio();
    },
    clearError() {
      set({ lastError: null });
    },
  };
});

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

let ringWatcher: RingWatcher | null = null;
let bound: { client: MatrixClient; dispose: () => void } | null = null;

/** Ringtone (+ vibration on phones) follows `incoming`: starts with the first ring, stops when none is left. */
function syncRingtone(count: number): void {
  if (count > 0) {
    void ringtone.play();
    if (isNativeApp() || (typeof navigator !== 'undefined' && 'vibrate' in navigator && /Android|iPhone/i.test(navigator.userAgent))) ringtone.vibrate(true);
  } else {
    ringtone.stop();
  }
}

function summarise(roomId: string, rtc: MatrixRTCSession): LiveSession | null {
  const memberships = rtc.memberships.filter((m) => !m.isExpired());
  if (memberships.length === 0) return null;
  return { roomId, userIds: [...new Set(memberships.map((m) => m.userId))], deviceCount: memberships.length };
}

function updateLiveSession(roomId: string, rtc: MatrixRTCSession): void {
  const next = summarise(roomId, rtc);
  const { liveSessions } = useCallStore.getState();
  const prev = liveSessions[roomId];
  if (!next && !prev) return;
  if (next && prev && prev.deviceCount === next.deviceCount && prev.userIds.join() === next.userIds.join()) return;
  const copy = { ...liveSessions };
  if (next) copy[roomId] = next;
  else delete copy[roomId];
  useCallStore.setState({ liveSessions: copy });
}

export function bindCalls(client: MatrixClient): void {
  unbindCalls();
  setCallTimelineResolver((roomId) => client.getRoom(roomId)?.getLiveTimeline().getEvents());
  const unsubRingtone = useCallStore.subscribe((s, prev) => {
    if (s.incoming.length !== prev.incoming.length) syncRingtone(s.incoming.length);
  });
  const unsubHangup = onCallServiceHangup(() => void useCallStore.getState().leaveCall());
  const tracked = new Map<string, { rtc: MatrixRTCSession; onChange: () => void }>();
  const track = (room: Room): void => {
    if (tracked.has(room.roomId)) return;
    const rtc = client.matrixRTC.getRoomSession(room);
    const onChange = (): void => updateLiveSession(room.roomId, rtc);
    rtc.on(MatrixRTCSessionEvent.MembershipsChanged, onChange);
    tracked.set(room.roomId, { rtc, onChange });
    onChange();
  };
  const onStarted = (roomId: string): void => {
    const room = client.getRoom(roomId);
    if (room) track(room);
  };
  const onEnded = (roomId: string, rtc: MatrixRTCSession): void => {
    updateLiveSession(roomId, rtc);
  };
  // The manager only tracks rooms with members; membership state events for rooms it has not seen yet come here.
  const onRoomState = (event: MatrixEvent): void => {
    if (event.getType() !== MEMBERSHIP_EVENT_TYPE) return;
    const room = client.getRoom(event.getRoomId());
    if (room) track(room);
  };
  client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
  client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
  client.on(RoomStateEvent.Events, onRoomState);
  for (const room of client.getRooms()) {
    if (client.matrixRTC.getActiveRoomSession(room)) track(room);
  }

  ringWatcher = watchIncomingCalls(client, {
    onRing(call) {
      const { activeCall, incoming } = useCallStore.getState();
      if (activeCall && activeCall.state !== 'ended' && activeCall.roomId !== call.roomId) {
        // Busy: tell the caller, log it as missed here, never ring over a live call.
        ringWatcher?.stop(call.roomId, 'busy');
        void sendDecline(client, call, 'busy').catch(() => undefined);
        return;
      }
      if (incoming.some((c) => c.roomId === call.roomId)) return;
      useCallStore.setState({ incoming: [...incoming, call] });
    },
    onStop(roomId, reason: RingStopReason) {
      const { incoming, history } = useCallStore.getState();
      const call = incoming.find((c) => c.roomId === roomId);
      const outcome = missedOutcome(reason);
      const next: Partial<CallState> = { incoming: incoming.filter((c) => c.roomId !== roomId) };
      if (outcome && call) {
        const entry = makeHistoryEntry({ roomId, direction: 'incoming', outcome, peerUserId: call.from, startedAt: call.receivedAt, connectedAt: null, endedAt: Date.now() });
        next.history = appendHistory(history, entry);
        saveHistory(next.history);
      } else if (outcome && reason === 'busy') {
        // A ring refused while busy never reached `incoming`; still a missed call for the history.
        const entry = makeHistoryEntry({ roomId, direction: 'incoming', outcome: 'missed', peerUserId: null, startedAt: Date.now(), connectedAt: null, endedAt: Date.now() });
        next.history = appendHistory(history, entry);
        saveHistory(next.history);
      }
      useCallStore.setState(next);
    },
  }, {
    get ringTimeoutMs(): number | undefined {
      return ringTimeoutMs();
    },
  });

  bound = {
    client,
    dispose() {
      client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, onStarted);
      client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, onEnded);
      client.off(RoomStateEvent.Events, onRoomState);
      for (const { rtc, onChange } of tracked.values()) rtc.off(MatrixRTCSessionEvent.MembershipsChanged, onChange);
      tracked.clear();
      unsubRingtone();
      unsubHangup();
      ringtone.stop();
      setCallTimelineResolver(null);
    },
  };
}

export function unbindCalls(): void {
  ringWatcher?.dispose();
  ringWatcher = null;
  bound?.dispose();
  bound = null;
}

/** Logout: hang up (best effort) and forget everything but nothing persisted belongs to the next user either. */
export function resetCalls(): void {
  const s = session;
  session = null;
  if (s) void s.leave('hangup');
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  ringtone.stop();
  void stopCallService();
  useCallStore.setState({ activeCall: null, incoming: [], history: [], liveSessions: {}, lastError: null, speaker: 'earpiece' });
}

/** Receiver stats of the active call (tests / devtools): bytes per remote participant prove encrypted media flows. */
export async function activeCallStats(): Promise<Awaited<ReturnType<CallSession['stats']>>> {
  return session ? session.stats() : [];
}

/** Grant the call power levels in a room where this user is an admin (the "enable calls here" affordance). */
export async function enableCallsInRoom(roomId: string): Promise<boolean> {
  const client = getClientOrNull();
  const room = client?.getRoom(roomId);
  if (!client || !room) return false;
  return ensureCallPowerLevels(client, room);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const useActiveCall = (): ActiveCall | null => useCallStore((s) => s.activeCall);
export const useIncomingCalls = (): IncomingCall[] => useCallStore((s) => s.incoming);
export const useIncomingCall = (): IncomingCall | null => useCallStore((s) => s.incoming[0] ?? null);
export const useCallError = (): CallState['lastError'] => useCallStore((s) => s.lastError);
export const useCallSpeaker = (): CallState['speaker'] => useCallStore((s) => s.speaker);

export function useRoomCallSummary(roomId: string | null | undefined): RoomCallSummary {
  const live = useCallStore((s) => (roomId ? s.liveSessions[roomId] : undefined));
  const joined = useCallStore((s) => !!roomId && s.activeCall?.roomId === roomId && s.activeCall.state !== 'ended');
  const ringing = useCallStore((s) => !!roomId && s.incoming.some((c) => c.roomId === roomId));
  if (!live && !joined && !ringing) return EMPTY_SUMMARY;
  return { live: !!live, userIds: live?.userIds ?? [], deviceCount: live?.deviceCount ?? 0, joined, ringing };
}

export function useCallHistory(roomId?: string): CallHistoryEntry[] {
  const history = useCallStore((s) => s.history);
  return roomId ? history.filter((h) => h.roomId === roomId) : history;
}

/**
 * `canCall(roomId)` as a hook: recomputed when the active call changes (busy) and when the room's state does
 * (encryption, power levels), via the room store's snapshot version.
 */
export function useCallAvailability(roomId: string | null | undefined): CallAvailability {
  const active = useCallStore((s) => s.activeCall?.roomId ?? null);
  const subscribe = useCallback((cb: () => void) => useCallStore.subscribe(cb), []);
  const get = useCallback((): string => `${active}|${roomId}|${getClientOrNull()?.getRoom(roomId ?? '')?.currentState.getStateEvents('m.room.power_levels', '')?.getId() ?? ''}`, [active, roomId]);
  useSyncExternalStore(subscribe, get, get);
  if (!roomId) return { ok: false, reason: 'unknown', message: 'No room' };
  return canCall(roomId);
}
