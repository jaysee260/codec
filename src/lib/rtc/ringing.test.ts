/**
 * Phase 7: the ring wire shape Codec sends and the receiving rules it applies (Advisor Wave 19, F2), the decline
 * content, and the expiry arithmetic (MSC4075 caps).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RING_TIMEOUT_MS } from './constants.ts';
import { buildDeclineContent, buildRingContent, evaluateRing, parseRingContent, ringExpiry, RING_MAX_LIFETIME_MS } from './ringing.ts';

const NOW = 1_700_000_000_000;
const me = { userId: '@bob:localhost', deviceId: 'BOB1' };

function ring(overrides: Partial<Parameters<typeof evaluateRing>[0]> = {}) {
  return evaluateRing({
    content: buildRingContent({ membershipEventId: '$member', userIds: ['@bob:localhost'], lifetimeMs: 60_000, now: NOW }),
    sender: '@alice:localhost',
    originServerTs: NOW,
    userId: me.userId,
    deviceId: me.deviceId,
    now: NOW + 1000,
    memberships: [{ userId: '@alice:localhost', deviceId: 'ALICE1' }],
    senderMayMentionRoom: false,
    ...overrides,
  });
}

describe('ring wire shape', () => {
  test('buildRingContent: slot m.call#ROOM, ring, audio, explicit user mentions, m.reference to our membership', () => {
    const c = buildRingContent({ membershipEventId: '$m', userIds: ['@bob:localhost', '@carol:localhost'], lifetimeMs: 60_000, now: NOW });
    assert.deepEqual(c, {
      'slot_id': 'm.call#ROOM',
      'notification_type': 'ring',
      'm.call.intent': 'audio',
      'm.mentions': { user_ids: ['@bob:localhost', '@carol:localhost'] },
      'm.relates_to': { rel_type: 'm.reference', event_id: '$m' },
      'sender_ts': NOW,
      'lifetime': 60_000,
    });
    assert.equal('room' in (c['m.mentions'] as object), false, 'never @room (needs PL 50)');
  });

  test('buildDeclineContent references the notification, sticky key = that id, optional busy reason', () => {
    assert.deepEqual(buildDeclineContent('$n'), { 'm.relates_to': { rel_type: 'm.reference', event_id: '$n' }, msc4354_sticky_key: '$n' });
    assert.equal(buildDeclineContent('$n', 'busy')['io.codec.decline_reason'], 'busy');
  });
});

describe('ring receiving rules', () => {
  test('a well-formed ring for us from a member who is in the call rings', () => {
    const v = ring();
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.content.slot_id, 'm.call#ROOM');
      assert.equal(v.content.membershipEventId, '$member');
      assert.equal(v.expiresAt, NOW + 60_000);
    }
  });

  test('rejections: self, malformed, expired, not mentioned, already joined', () => {
    assert.deepEqual(ring({ sender: me.userId }), { ok: false, reason: 'self' });
    assert.deepEqual(ring({ content: { 'm.mentions': { user_ids: [me.userId] } } }), { ok: false, reason: 'malformed' });
    assert.deepEqual(ring({ content: { sender_ts: NOW, lifetime: 1000, 'm.mentions': { user_ids: [] } } }), { ok: false, reason: 'malformed' });
    assert.deepEqual(ring({ now: NOW + 60_001 }), { ok: false, reason: 'expired' });
    assert.deepEqual(ring({ content: buildRingContent({ membershipEventId: '$m', userIds: ['@carol:localhost'], lifetimeMs: 60_000, now: NOW }) }), { ok: false, reason: 'not-mentioned' });
    assert.deepEqual(ring({ memberships: [{ userId: '@alice:localhost', deviceId: 'A' }, { userId: me.userId, deviceId: 'BOB2' }] }), { ok: false, reason: 'already-joined' });
  });

  test('@room mentions ring only when the sender may trigger them', () => {
    const content = { ...buildRingContent({ membershipEventId: '$m', userIds: [], lifetimeMs: 60_000, now: NOW }), 'm.mentions': { room: true } };
    assert.equal(ring({ content, senderMayMentionRoom: false }).ok, false);
    assert.equal(ring({ content, senderMayMentionRoom: true }).ok, true);
  });

  test('expiry: lifetime capped at 120 s by MSC4075 and at Codec’s 60 s ring timeout; sender_ts far ahead is distrusted', () => {
    const long = parseRingContent({ sender_ts: NOW, lifetime: 999_999, 'm.mentions': { user_ids: [me.userId] } })!;
    assert.equal(long.lifetime, RING_MAX_LIFETIME_MS);
    assert.equal(ringExpiry(long, NOW), NOW + RING_MAX_LIFETIME_MS);
    assert.equal(ringExpiry({ sender_ts: NOW + 60_000, lifetime: 10_000 }, NOW), NOW + 10_000, 'measured from origin_server_ts');
    const v = ring({ content: { ...buildRingContent({ membershipEventId: '$m', userIds: [me.userId], lifetimeMs: 100_000, now: NOW }) }, now: NOW });
    assert.equal(v.ok && v.expiresAt, NOW + RING_TIMEOUT_MS);
  });
});
