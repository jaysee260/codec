/**
 * Phase 7: pure participant bookkeeping (unit-tested). The session feeds it the MatrixRTC memberships (who is in
 * the call, from room state), the LiveKit participants (whose media is connected) and the identities we hold keys for.
 */
import type { CallParticipant } from './types.ts';

export interface MembershipLike {
  userId: string;
  deviceId: string;
}

export interface LivekitParticipantLike {
  identity: string;
  speaking: boolean;
  /** Microphone published and not muted. */
  micEnabled: boolean;
}

export const identityOf = (userId: string, deviceId: string): string => `${userId}:${deviceId}`;

/** Split a legacy LiveKit identity back into user + device (the device id never contains ':'; the user id may). */
export function parseIdentity(identity: string): MembershipLike | null {
  const idx = identity.lastIndexOf(':');
  if (idx <= 0 || idx === identity.length - 1) return null;
  const userId = identity.slice(0, idx);
  if (!userId.startsWith('@') || !userId.includes(':')) return null;
  return { userId, deviceId: identity.slice(idx + 1) };
}

export interface MergeInput {
  self: MembershipLike;
  memberships: MembershipLike[];
  livekit: LivekitParticipantLike[];
  /** Identities we hold at least one media key for (our own counts). */
  keyedIdentities: Iterable<string>;
  /** Identities whose key grace period has elapsed without a key (`keyState: 'missing'`). */
  keysOverdue?: Iterable<string>;
  /** Our own mute state (LiveKit's local participant is in `livekit` too, but mute is local truth). */
  selfMuted: boolean;
}

/**
 * One row per device in the MatrixRTC session (plus LiveKit participants whose membership has not synced yet, so a
 * voice never arrives from "nobody"), ourselves first, then by user id / device id. Stable order for the UI.
 */
export function mergeParticipants(input: MergeInput): CallParticipant[] {
  const keyed = new Set(input.keyedIdentities);
  const overdue = new Set(input.keysOverdue ?? []);
  const byIdentity = new Map<string, LivekitParticipantLike>();
  for (const p of input.livekit) byIdentity.set(p.identity, p);
  const rows = new Map<string, CallParticipant>();
  const add = (m: MembershipLike): void => {
    const identity = identityOf(m.userId, m.deviceId);
    if (rows.has(identity)) return;
    const lk = byIdentity.get(identity);
    const isSelf = m.userId === input.self.userId && m.deviceId === input.self.deviceId;
    const hasKey = isSelf || keyed.has(identity);
    rows.set(identity, {
      userId: m.userId,
      deviceId: m.deviceId,
      identity,
      isSelf,
      connected: !!lk,
      speaking: !!lk?.speaking,
      muted: isSelf ? input.selfMuted : !lk?.micEnabled,
      hasKey,
      keyState: hasKey ? 'ok' : overdue.has(identity) ? 'missing' : 'pending',
    });
  };
  add(input.self);
  for (const m of input.memberships) add(m);
  for (const p of input.livekit) {
    if (rows.has(p.identity)) continue;
    const parsed = parseIdentity(p.identity);
    if (parsed) add(parsed);
  }
  const list = [...rows.values()];
  list.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.userId.localeCompare(b.userId) || a.deviceId.localeCompare(b.deviceId));
  return list;
}

/** The other users in the call (one entry per user, however many devices). */
export function otherUserIds(participants: CallParticipant[]): string[] {
  const seen = new Set<string>();
  for (const p of participants) if (!p.isSelf) seen.add(p.userId);
  return [...seen];
}

/** Any other device of our own user is a member: that device answered the call (multi-device "answered elsewhere"). */
export function answeredElsewhere(memberships: MembershipLike[], self: MembershipLike): boolean {
  return memberships.some((m) => m.userId === self.userId && m.deviceId !== self.deviceId);
}
