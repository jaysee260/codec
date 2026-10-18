/**
 * Preconditions that make otherwise one-shot criteria re-runnable against a *live, shared*
 * homeserver (the devs are using the same Synapse, so `npm run seed:reset` is off the table
 * during this phase).
 *
 * Why this file exists
 * -------------------
 * Two seeded preconditions are consumed the first time they are exercised and cannot be put back:
 *
 *  1. **Unread counts.** The seed leaves #random at 3 and #lobby at 2 for alice. The moment any
 *     test opens those rooms the app sends an `m.read` receipt and the count is gone. Synapse
 *     refuses to move a read receipt backwards (verified against this homeserver), so the state
 *     cannot be restored by re-sending the older receipt.
 *  2. **Pending invites.** Inviting carol to Gaming succeeds once; the second run gets
 *     `M_FORBIDDEN: already invited`.
 *
 * So instead of asserting the literal seeded numbers, the unread criteria assert that the badge
 * equals the count derived from receipts + timeline (`ApiUser.unreadFor`), and `ensureUnread`
 * tops the room up from a second user when the seeded unread has already been consumed. Any run
 * where the derived count differs from the number in docs/ACCEPTANCE.md records an annotation, so
 * the report still says "this needed a fresh seed" rather than quietly passing on a different number.
 */
import { expect, test } from '@playwright/test';
import { asUser, type ApiUser } from './matrix-api.ts';
import { HS_URL, userId, type UserKey } from './seed.ts';

/** Adds a test annotation (shows up in the HTML report and in `--reporter=list` output). */
export function annotate(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

/**
 * Notes that the live homeserver no longer matches the number the criterion was written against.
 * The test still asserts real behaviour (badge === derived count); this records the drift.
 */
export function noteSeedDrift(criterion: string, expected: number, actual: number): void {
  if (expected === actual) return;
  annotate(
    'seed-drift',
    `${criterion}: docs/ACCEPTANCE.md expects ${expected} on a fresh seed, this homeserver derives ${actual}. ` +
      `Asserting the derived value; run \`npm run seed:reset\` for the literal number.`,
  );
}

export interface EnsuredUnread {
  /** Unread count for the target user after topping up. */
  count: number;
  /** True when messages had to be injected because the seeded unread was already consumed. */
  toppedUp: boolean;
}

/**
 * Guarantees `forUser` has at least `min` unread messages in `roomId`, sending filler from
 * `sender` when needed. Filler bodies are marked so they are obvious in the room.
 */
export async function ensureUnread(
  roomId: string,
  min = 1,
  forUser: UserKey = 'alice',
  sender: UserKey = 'bob',
): Promise<EnsuredUnread> {
  const target = userId(forUser);
  const reader = await asUser(sender);
  const before = await reader.unreadFor(roomId, target);
  if (before.count >= min) return { count: before.count, toppedUp: false };

  const missing = min - before.count;
  for (let i = 0; i < missing; i += 1) {
    await reader.send(roomId, `[qa] unread filler ${new Date().toISOString()} (${i + 1}/${missing})`);
  }
  annotate(
    'precondition',
    `ensureUnread: seeded unread in ${roomId} was ${before.count}, sent ${missing} message(s) as ${sender} to reach ${min}.`,
  );

  let count = before.count;
  await expect
    .poll(
      async () => {
        count = (await reader.unreadFor(roomId, target)).count;
        return count;
      },
      { timeout: 10_000, intervals: [200, 300, 500] },
    )
    .toBeGreaterThanOrEqual(min);
  return { count, toppedUp: true };
}

/**
 * Revokes a pending invite (and only a pending invite) so an invite criterion can run again.
 * Joined members are left alone — kicking a seeded member would damage the fixture.
 */
export async function revokePendingInvite(
  admin: ApiUser,
  roomIds: string[],
  inviteeId: string,
): Promise<string[]> {
  const revoked: string[] = [];
  for (const roomId of roomIds) {
    const membership = await admin.membership(roomId, inviteeId).catch(() => undefined);
    if (membership === 'invite') {
      await admin.kick(roomId, inviteeId, 'e2e cleanup: replaying the invite criterion');
      revoked.push(roomId);
    }
  }
  if (revoked.length) {
    annotate(
      'precondition',
      `revokePendingInvite: withdrew ${inviteeId}'s pending invite in ${revoked.length} room(s) so the invite flow can be replayed.`,
    );
  }
  return revoked;
}

/** A space's joined child room ids, from the server's hierarchy view. */
export async function childRoomIds(api: ApiUser, spaceId: string): Promise<string[]> {
  const { rooms } = await api.hierarchy(spaceId);
  return rooms.filter((r) => r.room_id !== spaceId).map((r) => r.room_id);
}

/**
 * Marks `roomId` read for `user` up to its newest event: unthreaded `m.read` (covers every thread) plus
 * `m.fully_read`, through `/read_markers`. Used to make "the only unread is X" preconditions self-sufficient when
 * other specs on the same worker (bob posting into #dev / #vault) left unread behind (Phase 6, AC-A5-2).
 */
export async function markRoomRead(roomId: string, user: UserKey = 'alice'): Promise<void> {
  const api = await asUser(user);
  const [newest] = await api.messages(roomId, 1);
  if (!newest?.event_id) return;
  await fetch(`${HS_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ 'm.fully_read': newest.event_id, 'm.read': newest.event_id }),
  });
}
