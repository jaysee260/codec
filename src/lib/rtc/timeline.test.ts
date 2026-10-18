/**
 * Phase 7: timeline rows for call events, history outcomes, power-level checks, token error texts.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCallEvent, formatCallDuration, isCallEvent, isCallTimelineEvent, type EventLike } from './timeline.ts';
import { appendHistory, makeHistoryEntry, missedOutcome, outcomeOf, parseStoredHistory, HISTORY_LIMIT } from './history.ts';
import { CALL_POWER_LEVELS, missingCallPowerLevels } from './permissions.ts';
import { describeTokenFailure, fetchSfuToken, parseSfuResponse } from './token.ts';
import { CallError } from './types.ts';

function ev(type: string, content: Record<string, unknown>, sender = '@alice:localhost', id = '$e'): EventLike {
  return { getType: () => type, getSender: () => sender, getId: () => id, getContent: () => content };
}

describe('timeline rows', () => {
  test('notification -> "started", decline -> "declined" / "busy", state events hidden', () => {
    const n = ev('org.matrix.msc4075.rtc.notification', { slot_id: 'm.call#ROOM' }, '@alice:localhost', '$n');
    assert.deepEqual(describeCallEvent(n, { displayName: 'Alice', myUserId: '@bob:localhost' }), {
      kind: 'started',
      userId: '@alice:localhost',
      text: 'Alice started a call',
      notifyEventId: '$n',
      callId: '$n',
      missedByMe: false,
      previewText: 'Voice call',
    });
    assert.equal(describeCallEvent(n, { displayName: 'Alice', myUserId: '@alice:localhost' })!.text, 'You started a call');
    const d = ev('org.matrix.msc4310.rtc.decline', { 'm.relates_to': { rel_type: 'm.reference', event_id: '$n' } }, '@bob:localhost');
    const dRow = describeCallEvent(d, { displayName: 'Bob' })!;
    assert.equal(dRow.kind, 'declined');
    assert.equal(dRow.text, 'Bob declined');
    assert.equal(dRow.notifyEventId, '$n');
    assert.equal(dRow.previewText, 'Call declined');
    const b = ev('org.matrix.msc4310.rtc.decline', { 'm.relates_to': { rel_type: 'm.reference', event_id: '$n' }, 'io.codec.decline_reason': 'busy' }, '@bob:localhost');
    assert.equal(describeCallEvent(b, { displayName: 'Bob' })!.kind, 'busy');
    assert.equal(describeCallEvent(b, { displayName: 'Bob' })!.text, 'Bob declined (busy)');
    const member = ev('org.matrix.msc3401.call.member', {});
    assert.equal(describeCallEvent(member, { displayName: 'x' }), null);
    assert.equal(isCallEvent(member), true);
    assert.equal(isCallTimelineEvent(member), false);
    assert.equal(isCallTimelineEvent(n), true);
    assert.equal(isCallEvent(ev('m.room.message', {})), false);
  });

  test('dev.matrixpoc.call rows: ended / missed (viewer rung vs caller), malformed -> null', () => {
    const names = (u: string): string => u.replace(/^@/, '').replace(/:.*$/, '');
    const ended = ev('dev.matrixpoc.call', { kind: 'ended', call_id: '$n', duration_ms: 312_000 }, '@bob:localhost', '$e1');
    const eRow = describeCallEvent(ended, { displayName: 'Bob', myUserId: '@alice:localhost', nameOf: names })!;
    assert.equal(eRow.kind, 'ended');
    assert.equal(eRow.text, 'Call ended, 5 min');
    assert.equal(eRow.durationMs, 312_000);
    assert.equal(eRow.callId, '$n');
    assert.equal(eRow.previewText, 'Call ended');
    assert.equal(isCallTimelineEvent(ended), true);
    assert.equal(isCallEvent(ended), true);
    const missed = ev('dev.matrixpoc.call', { kind: 'missed', call_id: '$n', participants: ['@alice:localhost'] }, '@bob:localhost', '$m1');
    const forAlice = describeCallEvent(missed, { displayName: 'Bob', myUserId: '@alice:localhost', nameOf: names })!;
    assert.equal(forAlice.text, 'Missed call from Bob');
    assert.equal(forAlice.missedByMe, true);
    assert.equal(forAlice.previewText, 'Missed call');
    const forBob = describeCallEvent(missed, { displayName: 'Bob', myUserId: '@bob:localhost', nameOf: names })!;
    assert.equal(forBob.text, 'No answer from alice');
    assert.equal(forBob.missedByMe, false);
    assert.equal(forBob.previewText, 'No answer');
    assert.equal(describeCallEvent(ev('dev.matrixpoc.call', { kind: 'x', call_id: '$n' }), { displayName: 'x' }), null);
    assert.equal(describeCallEvent(ev('dev.matrixpoc.call', { kind: 'ended', call_id: '$n', duration_ms: -1 }), { displayName: 'x' }), null);
  });

  test('formatCallDuration', () => {
    assert.equal(formatCallDuration(0), '0 s');
    assert.equal(formatCallDuration(45_000), '45 s');
    assert.equal(formatCallDuration(12 * 60_000 + 7_000), '12 min');
    assert.equal(formatCallDuration(65 * 60_000), '1 h 05 min');
  });
});

describe('history', () => {
  test('outcomeOf maps end reasons; completed only when media connected', () => {
    assert.equal(outcomeOf('hangup', true), 'completed');
    assert.equal(outcomeOf('hangup', false), 'cancelled');
    assert.equal(outcomeOf('remote-hangup', true), 'completed');
    assert.equal(outcomeOf('declined', false), 'declined');
    assert.equal(outcomeOf('busy', false), 'busy');
    assert.equal(outcomeOf('no-answer', false), 'no-answer');
    assert.equal(outcomeOf('error', false), 'failed');
    assert.equal(outcomeOf('error', true), 'completed');
    assert.equal(outcomeOf('answered-elsewhere', false), 'cancelled');
  });

  test('missedOutcome: expired / caller left = missed; accepted / answered elsewhere = nothing', () => {
    assert.equal(missedOutcome('expired'), 'missed');
    assert.equal(missedOutcome('caller-left'), 'missed');
    assert.equal(missedOutcome('declined'), 'declined');
    assert.equal(missedOutcome('busy'), 'busy');
    assert.equal(missedOutcome('accepted'), null);
    assert.equal(missedOutcome('answered-elsewhere'), null);
  });

  test('entries carry the connected duration; appendHistory is newest-first, de-duplicated and capped; parse tolerates junk', () => {
    const e = makeHistoryEntry({ roomId: '!r', direction: 'outgoing', outcome: 'completed', peerUserId: '@b:x', startedAt: 1000, connectedAt: 4000, endedAt: 10_000 });
    assert.equal(e.durationMs, 6000);
    assert.equal(makeHistoryEntry({ ...e, connectedAt: null }).durationMs, 0);
    let h = appendHistory([], e);
    h = appendHistory(h, { ...e, id: 'other', startedAt: 2000 });
    h = appendHistory(h, { ...e, outcome: 'failed' });
    assert.equal(h.length, 2);
    assert.equal(h[0]!.outcome, 'failed', 'same id replaced and moved to the front');
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({ ...e, id: String(i) })).reduce((acc, x) => appendHistory(acc, x), [] as typeof h);
    assert.equal(many.length, HISTORY_LIMIT);
    assert.deepEqual(parseStoredHistory('not json'), []);
    assert.deepEqual(parseStoredHistory(JSON.stringify([e, { nope: true }, 3])), [e]);
    assert.deepEqual(parseStoredHistory(null), []);
  });
});

describe('permissions', () => {
  test('missingCallPowerLevels: public preset (state_default 50) lacks the member event; DM-like PL 0 lacks nothing', () => {
    assert.deepEqual(missingCallPowerLevels({ state_default: 50, events_default: 0 }), ['org.matrix.msc3401.call.member']);
    assert.deepEqual(missingCallPowerLevels({ state_default: 0 }), []);
    assert.deepEqual(missingCallPowerLevels({ events: { ...CALL_POWER_LEVELS } }), []);
    assert.deepEqual(missingCallPowerLevels({ events: { ...CALL_POWER_LEVELS, 'org.matrix.msc4075.rtc.notification': 50 } }), ['org.matrix.msc4075.rtc.notification']);
    assert.deepEqual(missingCallPowerLevels(undefined), ['org.matrix.msc3401.call.member']);
  });
});

describe('token', () => {
  test('describeTokenFailure / parseSfuResponse', () => {
    assert.match(describeTokenFailure(401, { errcode: 'M_LOOKUP_FAILED' }), /OpenID/);
    assert.match(describeTokenFailure(400, { error: 'missing room' }), /missing room/);
    assert.match(describeTokenFailure(404, null), /livekit_service_url/);
    assert.match(describeTokenFailure(502, null), /502/);
    assert.deepEqual(parseSfuResponse({ url: 'ws://localhost:7880', jwt: 'x.y.z' }), { url: 'ws://localhost:7880', jwt: 'x.y.z' });
    assert.throws(() => parseSfuResponse({ url: 'ftp://x', jwt: 'j' }), (e: unknown) => e instanceof CallError && e.code === 'token');
    assert.throws(() => parseSfuResponse({}), (e: unknown) => e instanceof CallError && e.code === 'token');
  });

  test('fetchSfuToken posts the legacy /sfu/get body and maps failures to CallError(token)', async () => {
    const openid = { access_token: 'oid', token_type: 'Bearer', matrix_server_name: 'localhost', expires_in: 3600 };
    const client = { getOpenIdToken: async () => openid, getDeviceId: () => 'DEV' };
    const focus = { type: 'livekit' as const, livekit_service_url: 'http://jwt.test' };
    let seen: { url: string; body: unknown } | null = null;
    const ok = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ url: 'ws://sfu', jwt: 'j.w.t' }));
    }) as typeof fetch;
    const res = await fetchSfuToken(client, focus, '!r:localhost', ok);
    assert.deepEqual(res, { url: 'ws://sfu', jwt: 'j.w.t' });
    assert.deepEqual(seen, { url: 'http://jwt.test/sfu/get', body: { room: '!r:localhost', openid_token: openid, device_id: 'DEV' } });
    const denied = (async () => new Response(JSON.stringify({ errcode: 'M_LOOKUP_FAILED', error: 'nope' }), { status: 401 })) as typeof fetch;
    await assert.rejects(fetchSfuToken(client, focus, '!r:localhost', denied), (e: unknown) => e instanceof CallError && e.code === 'token' && /OpenID/.test(e.message));
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(fetchSfuToken(client, focus, '!r:localhost', down), (e: unknown) => e instanceof CallError && /Cannot reach/.test(e.message));
    await assert.rejects(fetchSfuToken({ ...client, getOpenIdToken: async () => { throw new Error('boom'); } }, focus, '!r', ok), (e: unknown) => e instanceof CallError && /OpenID token/.test(e.message));
  });
});
