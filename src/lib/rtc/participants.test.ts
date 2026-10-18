/**
 * Phase 7: participant merge (memberships x LiveKit participants x keys), identities, "answered elsewhere".
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { answeredElsewhere, identityOf, mergeParticipants, otherUserIds, parseIdentity } from './participants.ts';

const me = { userId: '@alice:localhost', deviceId: 'ALICE1' };
const bob = { userId: '@bob:localhost', deviceId: 'BOB1' };

describe('participants', () => {
  test('identityOf / parseIdentity round-trip, including user ids with ports', () => {
    assert.equal(identityOf('@a:localhost', 'D'), '@a:localhost:D');
    assert.deepEqual(parseIdentity('@a:localhost:D'), { userId: '@a:localhost', deviceId: 'D' });
    assert.deepEqual(parseIdentity('@a:host:8448:DEV'), { userId: '@a:host:8448', deviceId: 'DEV' });
    assert.equal(parseIdentity('garbage'), null);
    assert.equal(parseIdentity('@a:localhost:'), null);
  });

  test('self first, then others; media / speaking / mute / key state from LiveKit and the key provider', () => {
    const rows = mergeParticipants({
      self: me,
      memberships: [bob, me],
      livekit: [
        { identity: identityOf(me.userId, me.deviceId), speaking: false, micEnabled: true },
        { identity: identityOf(bob.userId, bob.deviceId), speaking: true, micEnabled: false },
      ],
      keyedIdentities: [identityOf(bob.userId, bob.deviceId)],
      selfMuted: true,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.isSelf, true);
    assert.equal(rows[0]!.muted, true, 'own mute is local truth');
    assert.equal(rows[0]!.keyState, 'ok');
    assert.equal(rows[1]!.userId, bob.userId);
    assert.equal(rows[1]!.connected, true);
    assert.equal(rows[1]!.speaking, true);
    assert.equal(rows[1]!.muted, true);
    assert.equal(rows[1]!.hasKey, true);
    assert.equal(rows[1]!.keyState, 'ok');
  });

  test('a member without media is listed as not connected; keys pending, then missing once overdue', () => {
    const pending = mergeParticipants({ self: me, memberships: [bob], livekit: [], keyedIdentities: [], selfMuted: false });
    assert.equal(pending[1]!.connected, false);
    assert.equal(pending[1]!.keyState, 'pending');
    const overdue = mergeParticipants({ self: me, memberships: [bob], livekit: [], keyedIdentities: [], keysOverdue: [identityOf(bob.userId, bob.deviceId)], selfMuted: false });
    assert.equal(overdue[1]!.keyState, 'missing');
  });

  test('a LiveKit participant whose membership has not synced yet still gets a row', () => {
    const rows = mergeParticipants({ self: me, memberships: [], livekit: [{ identity: '@carol:localhost:C1', speaking: false, micEnabled: true }], keyedIdentities: [], selfMuted: false });
    assert.deepEqual(rows.map((r) => r.userId), [me.userId, '@carol:localhost']);
    assert.equal(rows[1]!.deviceId, 'C1');
  });

  test('otherUserIds de-duplicates devices; answeredElsewhere sees our other device only', () => {
    const rows = mergeParticipants({ self: me, memberships: [bob, { userId: bob.userId, deviceId: 'BOB2' }], livekit: [], keyedIdentities: [], selfMuted: false });
    assert.deepEqual(otherUserIds(rows), [bob.userId]);
    assert.equal(answeredElsewhere([me, bob], me), false);
    assert.equal(answeredElsewhere([{ userId: me.userId, deviceId: 'ALICE2' }], me), true);
  });
});
