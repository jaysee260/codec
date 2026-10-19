/**
 * Phase 7 (PRIN-30 / PRIN-33): call policy over room state, pure and unit-tested with plain objects.
 *
 *   ringPolicy(room)        'ring' (DMs; rooms with <= CALL_RING_MAX_MEMBERS joined members besides me and bridge ghosts)
 *                           | 'drop-in' (bigger rooms: start quietly, others join from the "Join voice" chip)
 *   ringTargets(room)       the joined members the ring mentions (never me, never a bridge ghost)
 *   isBridgedRoom(room)     an `m.bridge` / `uk.half-shot.bridge` state event (mautrix-signal and friends) is present
 *   bridgeGhostPrefixes     '@signal_' always (the homelab bridge), plus prefixes derived from the bridge state events
 *   isBridgeGhost(userId)   the user is a bridge puppet (cannot run Codec, so a call would ring nobody)
 *   bridgeGhostOnly(room)   every other joined member is a ghost (a bridged DM: calls are refused, `bridged-dm`)
 *   hasBridgeGhost(room)    at least one ghost among the others (a bridged group: allowed, hint `codec-only`)
 *
 * The room shape is the subset of the SDK `Room` these read; `src/store/call.ts` passes the real one.
 */

/** Rooms with more joined members than this (besides me and ghosts) are drop-in calls, not rings. */
export const CALL_RING_MAX_MEMBERS = 5;

export const BRIDGE_STATE_TYPES = ['m.bridge', 'uk.half-shot.bridge'] as const;

/** The homelab bridge (mautrix-signal) puppets users as `@signal_<id>:<server>`. */
export const DEFAULT_GHOST_PREFIXES = ['@signal_'] as const;

export interface BridgeStateLike {
  getContent(): Record<string, unknown>;
}

export interface MemberLike {
  userId: string;
}

export interface PolicyRoomLike {
  roomId?: string;
  getJoinedMembers(): MemberLike[];
  currentState: { getStateEvents(type: string): BridgeStateLike[] };
}

export type RingPolicy = 'ring' | 'drop-in';

/** Every `m.bridge` / `uk.half-shot.bridge` state event of the room. */
export function bridgeStateEvents(room: PolicyRoomLike): BridgeStateLike[] {
  const out: BridgeStateLike[] = [];
  for (const type of BRIDGE_STATE_TYPES) {
    const events = room.currentState.getStateEvents(type);
    if (Array.isArray(events)) out.push(...events);
  }
  return out;
}

export function isBridgedRoom(room: PolicyRoomLike): boolean {
  return bridgeStateEvents(room).some((e) => {
    const c = e.getContent();
    return !!c && typeof c === 'object' && Object.keys(c).length > 0;
  });
}

/**
 * Ghost user-id prefixes: the defaults plus `@<protocol.id>_` for every bridge state event with a protocol id
 * (MSC2346: `protocol: { id: 'signal' }`), so a bridge named differently still counts.
 */
export function bridgeGhostPrefixes(room: PolicyRoomLike | null | undefined): string[] {
  const prefixes = new Set<string>(DEFAULT_GHOST_PREFIXES);
  if (room) {
    for (const e of bridgeStateEvents(room)) {
      const protocol = e.getContent()['protocol'] as { id?: unknown } | undefined;
      if (protocol && typeof protocol.id === 'string' && /^[a-z0-9]+$/i.test(protocol.id)) prefixes.add(`@${protocol.id.toLowerCase()}_`);
    }
  }
  return [...prefixes];
}

export function isBridgeGhost(userId: string, prefixes: readonly string[] = DEFAULT_GHOST_PREFIXES): boolean {
  const lower = userId.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p));
}

/** The user ids of the bridge bot(s) named by the state events (`bridgebot`), never rung either. */
function bridgeBots(room: PolicyRoomLike): Set<string> {
  const bots = new Set<string>();
  for (const e of bridgeStateEvents(room)) {
    const bot = e.getContent()['bridgebot'];
    if (typeof bot === 'string') bots.add(bot);
  }
  return bots;
}

/** Joined members other than `myUserId`, split into Codec-capable humans and bridge ghosts / bots. */
export function splitMembers(room: PolicyRoomLike, myUserId: string): { humans: string[]; ghosts: string[] } {
  const prefixes = bridgeGhostPrefixes(room);
  const bots = bridgeBots(room);
  const humans: string[] = [];
  const ghosts: string[] = [];
  for (const m of room.getJoinedMembers()) {
    if (m.userId === myUserId) continue;
    if (isBridgeGhost(m.userId, prefixes) || bots.has(m.userId)) ghosts.push(m.userId);
    else humans.push(m.userId);
  }
  return { humans, ghosts };
}

/** A room whose only other joined members are ghosts (a Signal DM): calls would ring nobody. */
export function bridgeGhostOnly(room: PolicyRoomLike, myUserId: string): boolean {
  const { humans, ghosts } = splitMembers(room, myUserId);
  return ghosts.length > 0 && humans.length === 0;
}

/** A room with at least one ghost and at least one Codec member (a bridged group): "Codec members only". */
export function hasBridgeGhost(room: PolicyRoomLike, myUserId: string): boolean {
  return splitMembers(room, myUserId).ghosts.length > 0;
}

/** Who the ring mentions: joined Codec members other than me (AC-R3-2: ghosts are neither counted nor rung). */
export function ringTargets(room: PolicyRoomLike, myUserId: string): string[] {
  return splitMembers(room, myUserId).humans;
}

/** DMs and small rooms ring; above `CALL_RING_MAX_MEMBERS` others the call is a quiet drop-in (AC-R3-2). */
export function ringPolicy(room: PolicyRoomLike, myUserId: string, opts: { isDm?: boolean; maxMembers?: number } = {}): RingPolicy {
  if (opts.isDm) return 'ring';
  const n = ringTargets(room, myUserId).length;
  return n <= (opts.maxMembers ?? CALL_RING_MAX_MEMBERS) ? 'ring' : 'drop-in';
}
