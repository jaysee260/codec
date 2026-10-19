/**
 * Phase 7: the LiveKit token contract shared with scripts/lib/lk-jwt.mjs (room name / identity derivation as in
 * lk-jwt-service, HS256 JWT). Run: `npm run test:unit`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLegacySfuRequest,
  decodeJwtClaims,
  hashedLivekitIdentity,
  legacyLivekitIdentity,
  livekitRoomAliasFor,
  mintLivekitToken,
  serverNameOfUserId,
  validateLegacySfuRequest,
  verifyLivekitToken,
} from './livekit-token.ts';

describe('livekit-token', () => {
  test('room alias is unpadded base64 SHA-256 of the JSON array [roomId, slotId] (lk-jwt-service livekit_room_alias_for)', async () => {
    // Computed with: echo -n '["!abc:localhost","m.call#ROOM"]' | sha256sum | xxd -r -p | base64 | tr -d '='
    const alias = await livekitRoomAliasFor('!abc:localhost');
    assert.equal(alias, 'Ax8rZVh6N6GSgRoDmH1XeQktdUAHYWOzZN/v8XAxH5k');
    assert.notEqual(await livekitRoomAliasFor('!abc:localhost', 'm.call#other'), alias);
  });

  test('legacy identity is userId:deviceId, MSC4195 identity is a hash of [user, device, member]', async () => {
    assert.equal(legacyLivekitIdentity('@alice:localhost', 'DEV1'), '@alice:localhost:DEV1');
    const h = await hashedLivekitIdentity('@alice:localhost', 'DEV1', 'member-1');
    assert.match(h, /^[A-Za-z0-9+/]{43}$/);
    assert.notEqual(h, await hashedLivekitIdentity('@alice:localhost', 'DEV1', 'member-2'));
  });

  test('mintLivekitToken signs HS256 claims LiveKit accepts and verifyLivekitToken checks them', async () => {
    const jwt = await mintLivekitToken({ apiKey: 'devkey', apiSecret: 'secret', identity: '@a:x:D', room: 'r', now: 1_700_000_000_000, roomCreate: true });
    assert.equal(jwt.split('.').length, 3);
    const claims = decodeJwtClaims(jwt);
    assert.equal(claims.iss, 'devkey');
    assert.equal(claims.sub, '@a:x:D');
    assert.equal(claims.nbf, 1_700_000_000);
    assert.equal(claims.exp, 1_700_000_000 + 3600);
    assert.deepEqual(claims.video, { room: 'r', roomJoin: true, roomCreate: true, canPublish: true, canSubscribe: true, canPublishData: true });
    assert.equal(await verifyLivekitToken(jwt, 'secret'), true);
    assert.equal(await verifyLivekitToken(jwt, 'wrong'), false);
    assert.equal(await verifyLivekitToken('not.a.jwt.at.all', 'secret'), false);
  });

  test('restricted users get roomCreate false and canPublish is configurable', async () => {
    const jwt = await mintLivekitToken({ apiKey: 'k', apiSecret: 's', identity: 'i', room: 'r', canPublish: false });
    assert.equal(decodeJwtClaims(jwt).video.roomCreate, false);
    assert.equal(decodeJwtClaims(jwt).video.canPublish, false);
  });

  test('serverNameOfUserId', () => {
    assert.equal(serverNameOfUserId('@alice:localhost'), 'localhost');
    assert.equal(serverNameOfUserId('@alice:704.chat'), '704.chat');
    assert.equal(serverNameOfUserId('alice:localhost'), null);
    assert.equal(serverNameOfUserId('@:localhost'), null);
    assert.equal(serverNameOfUserId('@alice:'), null);
  });

  test('buildLegacySfuRequest / validateLegacySfuRequest mirror lk-jwt-service field checks', () => {
    const openid = { access_token: 't', token_type: 'Bearer', matrix_server_name: 'localhost', expires_in: 3600 };
    const body = buildLegacySfuRequest('!r:localhost', openid, 'DEV');
    assert.deepEqual(body, { room: '!r:localhost', openid_token: openid, device_id: 'DEV' });
    assert.equal(validateLegacySfuRequest(body), null);
    assert.match(validateLegacySfuRequest({ ...body, room: '' })!, /room/);
    assert.match(validateLegacySfuRequest({ ...body, device_id: '' })!, /device_id/);
    assert.match(validateLegacySfuRequest({ ...body, openid_token: { access_token: 't' } })!, /matrix_server_name/);
    assert.match(validateLegacySfuRequest(null)!, /JSON object/);
  });
});
