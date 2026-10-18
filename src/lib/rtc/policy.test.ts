/**
 * Phase 7: ring policy (AC-R3-2) and Signal-bridge detection (PRIN-33, AC-R3-1 bridge rows, AC-R4-6).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeGhostOnly, bridgeGhostPrefixes, CALL_RING_MAX_MEMBERS, hasBridgeGhost, isBridgedRoom, isBridgeGhost, ringPolicy, ringTargets, type PolicyRoomLike } from './policy.ts';

const me = '@alice:localhost';

function room(members: string[], state: Record<string, Record<string, unknown>[]> = {}): PolicyRoomLike {
  return {
    roomId: '!r:localhost',
    getJoinedMembers: () => members.map((userId) => ({ userId })),
    currentState: { getStateEvents: (type: string) => (state[type] ?? []).map((content) => ({ getContent: () => content })) },
  };
}

describe('ringPolicy', () => {
  test('DMs ring; rooms ring up to CALL_RING_MAX_MEMBERS others; bigger rooms are drop-in', () => {
    assert.equal(CALL_RING_MAX_MEMBERS, 5);
    assert.equal(ringPolicy(room([me, '@bob:localhost']), me, { isDm: true }), 'ring');
    const five = ['@b:l', '@c:l', '@d:l', '@e:l', '@f:l'];
    assert.equal(ringPolicy(room([me, ...five]), me), 'ring');
    assert.equal(ringPolicy(room([me, ...five, '@g:l']), me), 'drop-in');
    assert.deepEqual(ringTargets(room([me, ...five]), me), five);
  });

  test('ghosts are neither counted nor rung', () => {
    const r = room([me, '@bob:localhost', '@signal_1:localhost', '@signal_2:localhost', '@signal_3:localhost', '@signal_4:localhost', '@signal_5:localhost']);
    assert.equal(ringPolicy(r, me), 'ring');
    assert.deepEqual(ringTargets(r, me), ['@bob:localhost']);
  });
});

describe('bridge detection', () => {
  const signalBridge = { 'm.bridge': [{ bridgebot: '@signalbot:localhost', protocol: { id: 'signal', displayname: 'Signal' }, channel: { id: '+1555' } }] };

  test('isBridgedRoom from m.bridge / uk.half-shot.bridge state (empty content = redacted = no bridge)', () => {
    assert.equal(isBridgedRoom(room([me])), false);
    assert.equal(isBridgedRoom(room([me], signalBridge)), true);
    assert.equal(isBridgedRoom(room([me], { 'uk.half-shot.bridge': [{ protocol: { id: 'signal' } }] })), true);
    assert.equal(isBridgedRoom(room([me], { 'm.bridge': [{}] })), false);
  });

  test('ghost prefixes: @signal_ always, plus @<protocol.id>_ from the state', () => {
    assert.deepEqual(bridgeGhostPrefixes(null), ['@signal_']);
    assert.deepEqual(bridgeGhostPrefixes(room([me], { 'm.bridge': [{ protocol: { id: 'whatsapp' } }] })), ['@signal_', '@whatsapp_']);
    assert.equal(isBridgeGhost('@signal_123:localhost'), true);
    assert.equal(isBridgeGhost('@Signal_123:localhost'), true);
    assert.equal(isBridgeGhost('@bob:localhost'), false);
    assert.equal(isBridgeGhost('@whatsapp_1:localhost', ['@signal_', '@whatsapp_']), true);
  });

  test('bridged DM (only other member is a ghost) vs bridged group vs plain rooms', () => {
    const dm = room([me, '@signal_123:localhost']);
    assert.equal(bridgeGhostOnly(dm, me), true);
    assert.equal(hasBridgeGhost(dm, me), true);
    const dmWithBot = room([me, '@signal_123:localhost', '@signalbot:localhost'], signalBridge);
    assert.equal(bridgeGhostOnly(dmWithBot, me), true); // the bridge bot named in m.bridge is not a Codec member
    const group = room([me, '@bob:localhost', '@signal_123:localhost']);
    assert.equal(bridgeGhostOnly(group, me), false);
    assert.equal(hasBridgeGhost(group, me), true);
    assert.deepEqual(ringTargets(group, me), ['@bob:localhost']);
    const plain = room([me, '@bob:localhost']);
    assert.equal(bridgeGhostOnly(plain, me), false);
    assert.equal(hasBridgeGhost(plain, me), false);
    assert.equal(bridgeGhostOnly(room([me]), me), false); // alone: not a bridged DM
  });
});
