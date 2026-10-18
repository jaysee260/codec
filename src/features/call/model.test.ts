import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDelayFor, errorText, formatTimer, screenStateOf, statusText, tilesOf } from './model.ts';

const ME = '@alice:localhost';
const BOB = '@bob:localhost';

test('screenStateOf maps store states onto the screen states', () => {
  assert.equal(screenStateOf({ state: 'connecting' }, 'ring'), 'calling');
  assert.equal(screenStateOf({ state: 'connecting' }, 'join'), 'connecting');
  assert.equal(screenStateOf({ state: 'connecting' }, null), 'connecting');
  assert.equal(screenStateOf({ state: 'ringing' }, 'ring'), 'calling');
  assert.equal(screenStateOf({ state: 'connected' }, 'ring'), 'connected');
  assert.equal(screenStateOf({ state: 'reconnecting' }, null), 'reconnecting');
  assert.equal(screenStateOf({ state: 'ended', endReason: 'no-answer' }, 'ring'), 'no-answer');
  assert.equal(screenStateOf({ state: 'ended', endReason: 'busy' }, 'ring'), 'busy');
  assert.equal(screenStateOf({ state: 'ended', endReason: 'remote-hangup' }, null), 'ended');
  assert.equal(screenStateOf({ state: 'no-answer' }, null), 'no-answer');
});

test('closeDelayFor: own hang-up closes at once, no-answer waits, others close by themselves', () => {
  assert.equal(closeDelayFor('ended', 'hangup'), 0);
  assert.equal(closeDelayFor('ended', 'remote-hangup'), 2000);
  assert.equal(closeDelayFor('ended', 'declined'), 3000);
  assert.equal(closeDelayFor('busy', 'busy'), 3000);
  assert.equal(closeDelayFor('no-answer', 'no-answer'), null);
  assert.equal(closeDelayFor('connected', null), null);
});

test('statusText', () => {
  assert.equal(statusText('calling'), 'Calling...');
  assert.equal(statusText('reconnecting'), 'Reconnecting...');
  assert.equal(statusText('ended', { endReason: 'declined', peerName: 'alice' }), 'alice declined');
  assert.equal(statusText('ended', { endReason: 'remote-hangup' }), 'Call ended');
});

test('formatTimer', () => {
  assert.equal(formatTimer(0), '00:00');
  assert.equal(formatTimer(65_400), '01:05');
  assert.equal(formatTimer(75 * 60_000 + 3000), '75:03');
  assert.equal(formatTimer(-5), '00:00');
});

test('tilesOf: one tile per user, self first, devices merged', () => {
  const tiles = tilesOf(
    [
      { userId: BOB, speaking: false, muted: true, keyState: 'ok' },
      { userId: BOB, speaking: true, muted: false, keyState: 'missing' },
      { userId: ME, isSelf: true, muted: false, keyState: 'pending' },
    ],
    ME,
  );
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0]!.userId, ME);
  assert.equal(tiles[0]!.keys, 'ok');
  assert.deepEqual(
    { speaking: tiles[1]!.speaking, muted: tiles[1]!.muted, keys: tiles[1]!.keys },
    { speaking: true, muted: false, keys: 'missing' },
  );
});

test('errorText: the mic-denied toast text is exact', () => {
  assert.equal(errorText('mic-denied'), "Codec can't use your microphone. Allow it in the browser's site settings and try again");
  assert.equal(errorText('weird', 'boom'), 'boom');
});
