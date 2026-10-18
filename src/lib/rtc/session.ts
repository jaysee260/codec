/**
 * Phase 7: one call, from "start" to "ended": the MatrixRTC membership (matrix-js-sdk `MatrixRTCSession`: the
 * `m.call.member` state event with its delayed leave, the slot, the media keys over Olm, the ring notification) on one
 * side and the LiveKit `Room` (audio tracks, frame encryption with those keys) on the other. No React, no store: the
 * store (`src/store/call.ts`) owns one `CallSession` at a time and mirrors `snapshot()` into state through `onChange`.
 *
 * Start sequence (every step throws a `CallError` with a code the UI can map):
 *   preflight (encrypted room, crypto engine, media support, power levels) -> mic permission -> focus discovery ->
 *   LiveKit Room with the key provider + worker -> joinRTCSession (state event + delayed leave + keys) -> /sfu/get
 *   token -> room.connect -> publish the mic -> `connected` (or `ringing` while a DM ring waits for the other side).
 *
 * The ring is Codec's own event (Advisor Wave 19, F2): once our `m.call.member` state event exists we send
 * `org.matrix.msc4075.rtc.notification` with `m.mentions.user_ids` = the rung members (the SDK's helper hardcodes
 * `@room`, which needs PL 50, and its receive rules need an `rtc.slot` state event we never create). No slot events.
 *
 * Reconnects: LiveKit handles media (`Reconnecting` / `Reconnected`); the SDK's membership manager restarts the delayed
 * leave event and re-sends the membership, and tells us when it probably failed (`ProbablyLeft`). Both surface as
 * `reconnecting`; an unrecoverable membership error ends the call with `error`.
 */
import { ClientEvent, EventType, RelationType, RoomEvent, SyncState, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { MatrixRTCSessionEvent, MembershipManagerEvent, type MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc/index.js';
import {
  ConnectionState,
  DisconnectReason,
  Room as LivekitRoom,
  RoomEvent as LivekitRoomEvent,
  Track,
  type Participant,
  type RemoteAudioTrack,
  type RemoteTrack,
} from 'livekit-client';
import { createE2EEWorker, mediaEncryptionSupported } from './e2ee-worker.ts';
import { discoverFocus } from './focus.ts';
import { MatrixKeyProvider } from './key-provider.ts';
import { answeredElsewhere, identityOf, mergeParticipants, otherUserIds, type LivekitParticipantLike } from './participants.ts';
import { ensureCallPowerLevels } from './permissions.ts';
import { CALL_DECLINE_TYPE, CALL_NOTIFICATION_TYPE, DECLINE_REASON_KEY } from './timeline.ts';
import { fetchSfuToken } from './token.ts';
import { CallError, type CallEndReason, type CallParticipant, type CallStateName, type LivekitFocus } from './types.ts';

import { CALL_KEYS_TIMEOUT_MS, DELAYED_LEAVE_MS, LEAVE_TIMEOUT_MS, RING_TIMEOUT_MS } from './constants.ts';
import { buildRingContent, whenCallEventReadable } from './ringing.ts';

export { CALL_KEYS_TIMEOUT_MS, DELAYED_LEAVE_MS, LEAVE_TIMEOUT_MS, RING_TIMEOUT_MS };

export interface CallSessionSnapshot {
  roomId: string;
  state: CallStateName;
  participants: CallParticipant[];
  muted: boolean;
  /** `setSinkId` device id in effect, null = default output. */
  audioOutput: string | null;
  startedAt: number;
  /** First moment media was connected to the SFU; null until then. */
  connectedAt: number | null;
  /** True while we rang and no other device has joined yet. */
  ringing: boolean;
  endReason: CallEndReason | null;
  error: { code: CallError['code']; message: string } | null;
  /** Media is always end-to-end encrypted in Codec calls (unencrypted rooms are refused). */
  encrypted: true;
  /** The browser blocked audio playback until a user gesture; call `resumeAudio()` from a click. */
  audioBlocked: boolean;
}

export interface CallSessionOptions {
  client: MatrixClient;
  room: Room;
  /** Send an `rtc.notification` ring when we are the first member (DM call button). */
  ring: boolean;
  /** Who the ring mentions; default: every joined member of the room but us. */
  ringTargets?: string[];
  onChange: (snapshot: CallSessionSnapshot) => void;
  ringTimeoutMs?: number;
  /** Test hook: skip the getUserMedia preflight (the e2e run uses a fake device, so the default is fine). */
  skipMicPreflight?: boolean;
}

interface MicError extends Error {
  name: string;
}

function micErrorToCallError(e: unknown): CallError {
  const name = (e as MicError)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return new CallError('mic-denied', 'Microphone access was denied', { cause: e });
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return new CallError('mic-missing', 'No microphone was found', { cause: e });
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return new CallError('mic-busy', 'The microphone is in use by another app', { cause: e });
  return new CallError('unknown', (e as Error)?.message ?? 'Could not open the microphone', { cause: e });
}

export class CallSession {
  readonly roomId: string;
  private readonly client: MatrixClient;
  private readonly room: Room;
  private readonly onChange: (s: CallSessionSnapshot) => void;
  private readonly ring: boolean;
  private readonly ringTargets: string[] | null;
  private readonly ringTimeoutMs: number;
  private readonly skipMicPreflight: boolean;
  private readonly userId: string;
  private readonly deviceId: string;

  private state: CallStateName = 'connecting';
  private muted = false;
  private audioOutput: string | null = null;
  private readonly startedAt = Date.now();
  private connectedAt: number | null = null;
  private ringing = false;
  private endReason: CallEndReason | null = null;
  private error: CallSessionSnapshot['error'] = null;
  private audioBlocked = false;
  private participants: CallParticipant[] = [];
  /** When each other device was first seen in the call (membership or media), for the key grace period. */
  private readonly firstSeen = new Map<string, number>();
  private keyTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyEventId: string | null = null;
  private ringSent = false;
  private sawOthers = false;

  private rtcSession: MatrixRTCSession | null = null;
  private lkRoom: LivekitRoom | null = null;
  private readonly keyProvider = new MatrixKeyProvider();
  private worker: Worker | null = null;
  private focus: LivekitFocus | null = null;
  private audioHost: HTMLElement | null = null;
  private readonly attached = new Map<string, HTMLMediaElement[]>();
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanups: (() => void)[] = [];
  private ended = false;
  private leaving: Promise<void> | null = null;

  constructor(opts: CallSessionOptions) {
    this.client = opts.client;
    this.room = opts.room;
    this.roomId = opts.room.roomId;
    this.onChange = opts.onChange;
    this.ring = opts.ring;
    this.ringTargets = opts.ringTargets ?? null;
    this.ringTimeoutMs = opts.ringTimeoutMs ?? RING_TIMEOUT_MS;
    this.skipMicPreflight = opts.skipMicPreflight ?? false;
    const userId = opts.client.getUserId();
    const deviceId = opts.client.getDeviceId();
    if (!userId || !deviceId) throw new CallError('unknown', 'No user / device id for this session');
    this.userId = userId;
    this.deviceId = deviceId;
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  snapshot(): CallSessionSnapshot {
    return {
      roomId: this.roomId,
      state: this.state,
      participants: this.participants,
      muted: this.muted,
      audioOutput: this.audioOutput,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      ringing: this.ringing,
      endReason: this.endReason,
      error: this.error,
      encrypted: true,
      audioBlocked: this.audioBlocked,
    };
  }

  /** Whether another device of ours answered (used by the store to stop an incoming ring on this device). */
  get identity(): string {
    return identityOf(this.userId, this.deviceId);
  }

  /** The id of the ring notification we sent, once the SDK reports it. */
  get sentNotificationId(): string | null {
    return this.notifyEventId;
  }

  async start(): Promise<void> {
    try {
      await this.preflight();
      if (!this.skipMicPreflight) await this.micPreflight();
      this.focus = await discoverFocus(this.client);
      this.rtcSession = this.client.matrixRTC.getRoomSession(this.room);
      this.createLivekitRoom();
      this.joinMatrixRtc();
      await this.connectLivekit();
      if (this.ended) return;
      this.publishChange();
    } catch (e) {
      const err = e instanceof CallError ? e : new CallError('unknown', (e as Error)?.message ?? String(e), { cause: e });
      await this.teardown('error', err);
      throw err;
    }
  }

  /** Hang up. Idempotent; never throws. */
  async leave(reason: CallEndReason = 'hangup'): Promise<void> {
    if (this.leaving) return this.leaving;
    this.leaving = this.teardown(reason, null);
    return this.leaving;
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    this.publishChange();
    try {
      await this.lkRoom?.localParticipant.setMicrophoneEnabled(!muted);
    } catch (e) {
      // Keep the UI truthful: the mic state is whatever LiveKit has.
      this.muted = !(this.lkRoom?.localParticipant.isMicrophoneEnabled ?? !muted);
      this.publishChange();
      throw micErrorToCallError(e);
    }
  }

  /** Route playback to an output device (`enumerateDevices` kind `audiooutput`); '' or null = default. */
  async setAudioOutput(deviceId: string | null): Promise<void> {
    const id = deviceId || '';
    if (this.lkRoom) await this.lkRoom.switchActiveDevice('audiooutput', id);
    this.audioOutput = id || null;
    this.publishChange();
  }

  /** Call from a user gesture when `audioBlocked` is true. */
  async resumeAudio(): Promise<void> {
    if (!this.lkRoom) return;
    await this.lkRoom.startAudio();
    this.audioBlocked = !this.lkRoom.canPlaybackAudio;
    this.publishChange();
  }

  /** Receiver stats per remote participant (tests: proves encrypted media flows). */
  async stats(): Promise<{ identity: string; bytesReceived: number; packetsReceived: number; decrypting: boolean }[]> {
    const out: { identity: string; bytesReceived: number; packetsReceived: number; decrypting: boolean }[] = [];
    if (!this.lkRoom) return out;
    for (const p of this.lkRoom.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        const track = pub.track as RemoteAudioTrack | undefined;
        if (!track) continue;
        const s = await track.getReceiverStats();
        out.push({ identity: p.identity, bytesReceived: s?.bytesReceived ?? 0, packetsReceived: s?.packetsReceived ?? 0, decrypting: p.isEncrypted });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Start steps
  // ---------------------------------------------------------------------------

  private async preflight(): Promise<void> {
    if (!this.room.hasEncryptionStateEvent()) throw new CallError('unencrypted', 'Calls need an encrypted room');
    if (!this.client.getCrypto()) throw new CallError('crypto-unavailable', 'Encryption is not available in this session');
    if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new CallError('media-unsupported', 'This browser cannot make calls');
    if (!mediaEncryptionSupported()) throw new CallError('media-unsupported', 'This browser cannot encrypt call audio');
    if (this.client.getSyncState() !== SyncState.Syncing && this.client.getSyncState() !== SyncState.Prepared) {
      throw new CallError('connect', 'Not connected to the homeserver');
    }
    const allowed = await ensureCallPowerLevels(this.client, this.room);
    if (!allowed) throw new CallError('not-allowed', "You can't start calls in this room (ask an admin)");
  }

  private async micPreflight(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      throw micErrorToCallError(e);
    }
    for (const t of stream.getTracks()) t.stop();
  }

  private createLivekitRoom(): void {
    this.worker = createE2EEWorker();
    const room = new LivekitRoom({
      adaptiveStream: false,
      dynacast: false,
      e2ee: { keyProvider: this.keyProvider, worker: this.worker },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.lkRoom = room;
    // livekit-client's typed emitter and a generic cleanup list do not mix well; the handlers below are typed by hand.
    const on = (event: LivekitRoomEvent, fn: (...args: never[]) => void): void => {
      room.on(event as never, fn as never);
      this.cleanups.push(() => room.off(event as never, fn as never));
    };
    on(LivekitRoomEvent.ParticipantConnected, () => this.publishChange());
    on(LivekitRoomEvent.ParticipantDisconnected, () => this.publishChange());
    on(LivekitRoomEvent.ActiveSpeakersChanged, () => this.publishChange());
    on(LivekitRoomEvent.TrackMuted, () => this.publishChange());
    on(LivekitRoomEvent.TrackUnmuted, () => this.publishChange());
    on(LivekitRoomEvent.TrackSubscribed, ((track: RemoteTrack, _pub: unknown, participant: Participant) => this.attachTrack(track, participant)) as never);
    on(LivekitRoomEvent.TrackUnsubscribed, ((track: RemoteTrack, _pub: unknown, participant: Participant) => this.detachTrack(track, participant)) as never);
    on(LivekitRoomEvent.Reconnecting, () => this.setState('reconnecting'));
    on(LivekitRoomEvent.SignalReconnecting, () => this.setState('reconnecting'));
    on(LivekitRoomEvent.Reconnected, () => this.setState(this.ringing ? 'ringing' : 'connected'));
    on(LivekitRoomEvent.AudioPlaybackStatusChanged, () => {
      this.audioBlocked = !room.canPlaybackAudio;
      this.publishChange();
    });
    on(LivekitRoomEvent.MediaDevicesError, ((e: Error) => {
      this.error = { code: micErrorToCallError(e).code, message: e.message };
      this.publishChange();
    }) as never);
    on(LivekitRoomEvent.Disconnected, ((reason?: DisconnectReason) => {
      if (this.ended || this.leaving) return;
      // LiveKit gave up reconnecting (or the SFU kicked us): the call is over for us.
      const why: CallEndReason = reason === DisconnectReason.CLIENT_INITIATED ? 'hangup' : 'error';
      void this.teardown(why, why === 'error' ? new CallError('connect', `Lost the connection to the call server (${reason ?? 'unknown'})`) : null);
    }) as never);
  }

  private joinMatrixRtc(): void {
    const session = this.rtcSession!;
    const onKey = (key: Uint8Array, index: number, _membership: unknown, rtcBackendIdentity: string): void => {
      void this.keyProvider.setParticipantKey(key, rtcBackendIdentity, index).then(() => this.publishChange());
    };
    const onMemberships = (): void => this.onMembershipsChanged();
    const onManagerError = (e: unknown): void => {
      void this.teardown('error', new CallError('membership', 'The call could not be kept alive on the homeserver', { cause: e }));
    };
    const onProbablyLeft = (probablyLeft: boolean): void => {
      if (probablyLeft) this.setState('reconnecting');
      else if (this.state === 'reconnecting' && this.lkRoom?.state === ConnectionState.Connected) this.setState(this.ringing ? 'ringing' : 'connected');
    };
    session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
    session.on(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
    session.on(MatrixRTCSessionEvent.MembershipManagerError, onManagerError);
    session.on(MembershipManagerEvent.ProbablyLeft, onProbablyLeft);
    this.cleanups.push(() => {
      session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
      session.off(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
      session.off(MatrixRTCSessionEvent.MembershipManagerError, onManagerError);
      session.off(MembershipManagerEvent.ProbablyLeft, onProbablyLeft);
    });
    // Declines reference our notification (DM: the call is over; room: just a row in the timeline).
    const onTimeline = (raw: MatrixEvent, room: Room | undefined): void => {
      if (room?.roomId !== this.roomId) return;
      whenCallEventReadable(raw, onDecline);
    };
    const onDecline = (event: MatrixEvent): void => {
      if (event.getType() !== CALL_DECLINE_TYPE) return;
      const rel = event.getContent()['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined;
      if (rel?.rel_type !== RelationType.Reference || !this.notifyEventId || rel.event_id !== this.notifyEventId) return;
      if (event.getSender() === this.userId) return;
      if (this.isTwoPartyRoom()) {
        const busy = event.getContent()[DECLINE_REASON_KEY] === 'busy';
        void this.teardown(busy ? 'busy' : 'declined', null);
      }
    };
    this.client.on(RoomEvent.Timeline, onTimeline);
    this.cleanups.push(() => this.client.off(RoomEvent.Timeline, onTimeline));
    // A sync that drops to ERROR and back is a membership risk the SDK handles; mirror it as reconnecting.
    const onSync = (state: SyncState): void => {
      if (state === SyncState.Error) this.setState('reconnecting');
      else if ((state === SyncState.Syncing || state === SyncState.Prepared) && this.state === 'reconnecting' && this.lkRoom?.state === ConnectionState.Connected) {
        this.setState(this.ringing ? 'ringing' : 'connected');
      }
    };
    this.client.on(ClientEvent.Sync, onSync);
    this.cleanups.push(() => this.client.off(ClientEvent.Sync, onSync));

    const isFirst = session.memberships.filter((m) => !m.isExpired()).length === 0;
    this.ringing = this.ring && isFirst;
    session.joinRTCSession({ userId: this.userId, deviceId: this.deviceId, memberId: identityOf(this.userId, this.deviceId) }, [this.focus!], undefined, {
      manageMediaKeys: true,
      callIntent: 'audio',
      delayedLeaveEventDelayMs: DELAYED_LEAVE_MS,
      useKeyDelay: 250,
    });
    session.reemitEncryptionKeys();
    if (this.ringing) {
      this.ringTimer = setTimeout(() => {
        this.ringTimer = null;
        if (this.ringing && !this.sawOthers) void this.teardown('no-answer', null);
      }, this.ringTimeoutMs);
    }
    this.onMembershipsChanged();
  }

  private async connectLivekit(): Promise<void> {
    const room = this.lkRoom!;
    let token;
    try {
      token = await fetchSfuToken(this.client, this.focus!, this.roomId);
    } catch (e) {
      // A stale focus (well-known changed) is worth one re-discovery.
      this.focus = await discoverFocus(this.client, { fresh: true });
      token = await fetchSfuToken(this.client, this.focus, this.roomId).catch(() => {
        throw e;
      });
    }
    try {
      await room.setE2EEEnabled(true);
      await room.connect(token.url, token.jwt, { autoSubscribe: true });
    } catch (e) {
      throw new CallError('connect', `Could not connect to the call server: ${(e as Error)?.message ?? e}`, { cause: e });
    }
    if (this.ended) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!this.muted);
    } catch (e) {
      throw micErrorToCallError(e);
    }
    this.connectedAt = Date.now();
    this.audioBlocked = !room.canPlaybackAudio;
    this.setState(this.ringing ? 'ringing' : 'connected');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private isTwoPartyRoom(): boolean {
    return this.room.getJoinedMemberCount() <= 2;
  }

  /** Who to ring: the explicit targets, else every joined member but us. */
  private ringUserIds(): string[] {
    if (this.ringTargets) return this.ringTargets.filter((id) => id !== this.userId);
    return this.room
      .getJoinedMembers()
      .map((m) => m.userId)
      .filter((id) => id !== this.userId);
  }

  /** Send the ring once our membership event exists (the notification references it). Best effort: a failed ring
   * leaves the call joinable from the chip; the error surfaces as `lastError` through the snapshot. */
  private sendRing(membershipEventId: string): void {
    if (this.ringSent) return;
    this.ringSent = true;
    const targets = this.ringUserIds();
    if (targets.length === 0) return;
    const content = buildRingContent({ membershipEventId, userIds: targets, lifetimeMs: this.ringTimeoutMs, now: Date.now() });
    this.client
      .sendEvent(this.roomId, CALL_NOTIFICATION_TYPE as never, content as never)
      .then((res) => {
        this.notifyEventId = res.event_id;
      })
      .catch((e: unknown) => {
        this.error = { code: 'not-allowed', message: `Could not ring: ${(e as Error)?.message ?? e}` };
        this.publishChange();
      });
  }

  private onMembershipsChanged(): void {
    const session = this.rtcSession;
    if (!session || this.ended) return;
    const memberships = session.memberships.filter((m) => !m.isExpired());
    const others = memberships.filter((m) => !(m.userId === this.userId && m.deviceId === this.deviceId));
    const own = memberships.find((m) => m.userId === this.userId && m.deviceId === this.deviceId);
    if (this.ringing && own && !this.ringSent) this.sendRing(own.eventId);
    void answeredElsewhere; // a device of ours joining a room call we rang is fine: both stay
    if (others.length > 0) {
      this.sawOthers = true;
      if (this.ringing) {
        this.ringing = false;
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.ringTimer = null;
        if (this.state === 'ringing') this.state = 'connected';
      }
    } else if (this.sawOthers && this.isTwoPartyRoom() && this.state !== 'connecting') {
      // The other side hung up a DM call: end ours too (a room call stays open for drop-ins).
      void this.teardown('remote-hangup', null);
      return;
    }
    this.publishChange();
  }

  /** Start the key grace period for every other device we see; re-publish when it elapses. */
  private noteSeen(identities: string[]): void {
    const now = Date.now();
    let scheduled = false;
    for (const id of identities) {
      if (this.firstSeen.has(id)) continue;
      this.firstSeen.set(id, now);
      scheduled = true;
    }
    if (scheduled && !this.keyTimer) {
      this.keyTimer = setTimeout(() => {
        this.keyTimer = null;
        this.publishChange();
      }, CALL_KEYS_TIMEOUT_MS + 50);
    }
  }

  private keysOverdue(): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [id, at] of this.firstSeen) {
      if (now - at >= CALL_KEYS_TIMEOUT_MS && !this.keyProvider.hasKeyFor(id)) out.push(id);
    }
    return out;
  }

  private attachTrack(track: RemoteTrack, participant: Participant): void {
    if (track.kind !== Track.Kind.Audio) return;
    const host = this.ensureAudioHost();
    const el = track.attach();
    el.setAttribute('data-identity', participant.identity);
    host.appendChild(el);
    const list = this.attached.get(participant.identity) ?? [];
    list.push(el);
    this.attached.set(participant.identity, list);
    if (this.audioOutput && 'setSinkId' in el) void (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.audioOutput).catch(() => undefined);
    this.publishChange();
  }

  private detachTrack(track: RemoteTrack, participant: Participant): void {
    if (track.kind !== Track.Kind.Audio) return;
    for (const el of track.detach()) el.remove();
    this.attached.delete(participant.identity);
    this.publishChange();
  }

  private ensureAudioHost(): HTMLElement {
    if (this.audioHost) return this.audioHost;
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'call-audio');
    host.style.display = 'none';
    document.body.appendChild(host);
    this.audioHost = host;
    return host;
  }

  private setState(state: CallStateName): void {
    if (this.ended || this.state === state) return;
    this.state = state;
    this.publishChange();
  }

  private livekitParticipants(): LivekitParticipantLike[] {
    const room = this.lkRoom;
    if (!room || room.state === ConnectionState.Disconnected) return [];
    const toLike = (p: Participant): LivekitParticipantLike => ({ identity: p.identity, speaking: p.isSpeaking, micEnabled: p.isMicrophoneEnabled });
    return [toLike(room.localParticipant), ...[...room.remoteParticipants.values()].map(toLike)];
  }

  private publishChange(): void {
    if (this.ended && this.state !== 'ended') return;
    const memberships = (this.rtcSession?.memberships ?? []).filter((m) => !m.isExpired()).map((m) => ({ userId: m.userId, deviceId: m.deviceId }));
    const livekit = this.livekitParticipants();
    const me = identityOf(this.userId, this.deviceId);
    this.noteSeen([...memberships.map((m) => identityOf(m.userId, m.deviceId)), ...livekit.map((p) => p.identity)].filter((id) => id !== me));
    this.participants = mergeParticipants({
      self: { userId: this.userId, deviceId: this.deviceId },
      memberships,
      livekit,
      keyedIdentities: this.keyProvider.identitiesWithKeys(),
      keysOverdue: this.keysOverdue(),
      selfMuted: this.muted,
    });
    this.onChange(this.snapshot());
  }

  /** The other users seen in this call (for the history entry). */
  peerUserIds(): string[] {
    return otherUserIds(this.participants);
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  private async teardown(reason: CallEndReason, error: CallError | null): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    if (this.keyTimer) clearTimeout(this.keyTimer);
    this.keyTimer = null;
    this.endReason = reason;
    if (error) this.error = { code: error.code, message: error.message };
    for (const c of this.cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
    const lk = this.lkRoom;
    this.lkRoom = null;
    if (lk) {
      try {
        await lk.disconnect(true);
      } catch {
        /* ignore */
      }
    }
    const session = this.rtcSession;
    this.rtcSession = null;
    if (session?.isJoined()) {
      try {
        await session.leaveRoomSession(LEAVE_TIMEOUT_MS);
      } catch {
        /* the membership expires server-side via the delayed leave */
      }
    }
    for (const els of this.attached.values()) for (const el of els) el.remove();
    this.attached.clear();
    this.audioHost?.remove();
    this.audioHost = null;
    this.worker?.terminate();
    this.worker = null;
    this.state = 'ended';
    this.ringing = false;
    this.onChange(this.snapshot());
  }
}

/** The type of event the SDK uses for the membership state (exported for the store's live-session watcher). */
export const MEMBERSHIP_EVENT_TYPE: string = EventType.GroupCallMemberPrefix;
