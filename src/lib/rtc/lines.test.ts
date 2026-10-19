/**
 * Phase 7 Wave 2: the `dev.matrixpoc.call` contract (docs/archive/PHASE7_ACCEPTANCE.md "Wire shapes", AC-R3-7 / AC-R7),
 * the "started" row of a drop-in call (opening membership) and the room-list preview.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCallLineContent,
  callLinePreviewText,
  endLineFor,
  formatCallLine,
  formatCallLineDuration,
  getCallLine,
  isCallOpeningMembership,
  isMissedForViewer,
  type CallLineEventLike,
  type MembershipEventLike,
} from './lines.ts';

const alice = '@alice:localhost';
const bob = '@bob:localhost';
const carol = '@carol:localhost';
const names = (u: string): string => u.replace(/^@/, '').replace(/:.*$/, '');

function ev(content: Record<string, unknown>, sender = bob, type = 'dev.matrixpoc.call', id = '$e'): CallLineEventLike {
  return { getType: () => type, getSender: () => sender, getId: () => id, getContent: () => content };
}

describe('getCallLine', () => {
  test('parses the four kinds; `participants` with `missed` as an alias', () => {
    assert.deepEqual(getCallLine(ev({ kind: 'ended', call_id: '$n', duration_ms: 312000 })), { kind: 'ended', callId: '$n', sender: bob, durationMs: 312000 });
    assert.deepEqual(getCallLine(ev({ kind: 'missed', call_id: '$n', participants: [alice] })), { kind: 'missed', callId: '$n', sender: bob, participants: [alice] });
    assert.deepEqual(getCallLine(ev({ kind: 'missed', call_id: '$n', missed: [alice] })), { kind: 'missed', callId: '$n', sender: bob, participants: [alice] });
    assert.deepEqual(getCallLine(ev({ kind: 'declined', call_id: '$n', reason: 'busy' })), { kind: 'declined', callId: '$n', sender: bob, reason: 'busy' });
    assert.deepEqual(getCallLine(ev({ kind: 'started', call_id: '$n' })), { kind: 'started', callId: '$n', sender: bob });
  });

  test('null for other types, unknown kind, bad call_id, non-array participants, negative duration, missed without names', () => {
    assert.equal(getCallLine(ev({ kind: 'ended', call_id: '$n' }, bob, 'm.room.message')), null);
    assert.equal(getCallLine(ev({ kind: 'x', call_id: '$n' })), null);
    assert.equal(getCallLine(ev({ kind: 'ended' })), null);
    assert.equal(getCallLine(ev({ kind: 'ended', call_id: 7 })), null);
    assert.equal(getCallLine(ev({ kind: 'missed', call_id: '$n', missed: 'alice' })), null);
    assert.equal(getCallLine(ev({ kind: 'missed', call_id: '$n', participants: [1] })), null);
    assert.equal(getCallLine(ev({ kind: 'missed', call_id: '$n' })), null);
    assert.equal(getCallLine(ev({ kind: 'ended', call_id: '$n', duration_ms: -5 })), null);
    assert.equal(getCallLine(ev({ kind: 'ended', call_id: '$n', duration_ms: '5' })), null);
    assert.equal(getCallLine({ ...ev({ kind: 'ended', call_id: '$n' }), getSender: () => undefined }), null);
  });

  test('buildCallLineContent round-trips through getCallLine', () => {
    const ended = buildCallLineContent({ kind: 'ended', callId: '$n', durationMs: 70_400.6, participants: [alice, bob] });
    assert.deepEqual(ended, { kind: 'ended', call_id: '$n', duration_ms: 70401, participants: [alice, bob] });
    assert.equal(getCallLine(ev(ended))!.durationMs, 70401);
    const missed = buildCallLineContent({ kind: 'missed', callId: '$n', participants: [alice, carol] });
    assert.deepEqual(missed, { kind: 'missed', call_id: '$n', participants: [alice, carol] });
    assert.deepEqual(getCallLine(ev(missed))!.participants, [alice, carol]);
  });
});

describe('formatCallLine / preview', () => {
  test('ended: minutes, "< 1 min" under 60 s', () => {
    assert.equal(formatCallLineDuration(0), '< 1 min');
    assert.equal(formatCallLineDuration(59_000), '< 1 min');
    assert.equal(formatCallLineDuration(60_000), '1 min');
    assert.equal(formatCallLineDuration(12 * 60_000 + 20_000), '12 min');
    assert.equal(formatCallLineDuration(65 * 60_000), '1 h 05 min');
    assert.equal(formatCallLine(getCallLine(ev({ kind: 'ended', call_id: '$n', duration_ms: 312000 }))!, alice, names), 'Call ended, 5 min');
    assert.equal(callLinePreviewText(getCallLine(ev({ kind: 'ended', call_id: '$n', duration_ms: 1 }))!, alice), 'Call ended');
  });

  test('missed: "Missed call from bob" for the rung viewer, "No answer from alice" for the caller and bystanders', () => {
    const line = getCallLine(ev({ kind: 'missed', call_id: '$n', participants: [alice, carol] }, bob))!;
    assert.equal(isMissedForViewer(line, alice), true);
    assert.equal(isMissedForViewer(line, bob), false);
    assert.equal(isMissedForViewer(line, '@dave:localhost'), false);
    assert.equal(isMissedForViewer(line, null), false);
    assert.equal(formatCallLine(line, alice, names), 'Missed call from bob');
    assert.equal(formatCallLine(line, bob, names), 'No answer from alice and carol');
    assert.equal(formatCallLine(line, '@dave:localhost', names), 'No answer from alice and carol');
    assert.equal(formatCallLine(getCallLine(ev({ kind: 'missed', call_id: '$n', participants: [alice] }, bob))!, bob), `No answer from ${alice}`);
    assert.equal(callLinePreviewText(line, alice), 'Missed call');
    assert.equal(callLinePreviewText(line, bob), 'No answer');
    // The caller is never "missed" even when a bad sender lists itself.
    assert.equal(isMissedForViewer(getCallLine(ev({ kind: 'missed', call_id: '$n', participants: [bob] }, bob))!, bob), false);
  });

  test('declined / started wire kinds', () => {
    assert.equal(formatCallLine(getCallLine(ev({ kind: 'declined', call_id: '$n' }))!, alice, names), 'bob declined');
    assert.equal(formatCallLine(getCallLine(ev({ kind: 'declined', call_id: '$n', reason: 'busy' }))!, alice, names), 'bob declined (busy)');
    assert.equal(callLinePreviewText(getCallLine(ev({ kind: 'declined', call_id: '$n' }))!, alice), 'Call declined');
    assert.equal(formatCallLine(getCallLine(ev({ kind: 'started', call_id: '$n' }))!, alice, names), 'bob started a voice call');
    assert.equal(callLinePreviewText(getCallLine(ev({ kind: 'started', call_id: '$n' }))!, alice), 'Voice call');
  });
});

describe('isCallOpeningMembership', () => {
  const T0 = 1_700_000_000_000;
  function member(sender: string, id: string, ts: number, content: Record<string, unknown> | 'leave', prev: Record<string, unknown> = {}): MembershipEventLike {
    const c = content === 'leave' ? {} : { application: 'm.call', call_id: '', device_id: 'D', expires: 14_400_000, ...content };
    return {
      getType: () => 'org.matrix.msc3401.call.member',
      getSender: () => sender,
      getId: () => id,
      getContent: () => c,
      getTs: () => ts,
      getStateKey: () => `_${sender}_D_m.call`,
      getPrevContent: () => prev,
    };
  }
  function ring(id: string, membershipId: string, ts: number): MembershipEventLike {
    return { getType: () => 'org.matrix.msc4075.rtc.notification', getSender: () => alice, getId: () => id, getContent: () => ({ 'm.relates_to': { rel_type: 'm.reference', event_id: membershipId } }), getTs: () => ts };
  }

  test('the first join opens; a later join does not; after everyone left a new join opens again', () => {
    const a = member(alice, '$a', T0, {});
    const b = member(bob, '$b', T0 + 1000, {});
    const aLeave = member(alice, '$al', T0 + 5000, 'leave', { application: 'm.call' });
    const bLeave = member(bob, '$bl', T0 + 6000, 'leave', { application: 'm.call' });
    const c = member(carol, '$c', T0 + 9000, {});
    const timeline = [a, b, aLeave, bLeave, c];
    assert.equal(isCallOpeningMembership(a, timeline), true);
    assert.equal(isCallOpeningMembership(b, timeline), false);
    assert.equal(isCallOpeningMembership(aLeave, timeline), false);
    assert.equal(isCallOpeningMembership(c, timeline), true);
    assert.equal(isCallOpeningMembership(a, []), true); // not yet in the timeline: still the opener
  });

  test('an expired earlier membership does not block; a membership update (prev content) is not a join', () => {
    const stale = member(bob, '$s', T0 - 20_000_000, { expires: 1000 });
    const a = member(alice, '$a', T0, {});
    assert.equal(isCallOpeningMembership(a, [stale, a]), true);
    const update = member(alice, '$u', T0 + 100, {}, { application: 'm.call' });
    assert.equal(isCallOpeningMembership(update, [a, update]), false);
  });

  test('a ring referencing the membership takes the "started" row instead', () => {
    const a = member(alice, '$a', T0, {});
    assert.equal(isCallOpeningMembership(a, [a, ring('$r', '$a', T0 + 50)]), false);
    assert.equal(isCallOpeningMembership(a, [a, ring('$r', '$other', T0 + 50)]), true);
  });
});

describe('end lines (BUG-34 / BUG-35)', () => {
  const base = { endReason: 'hangup', rang: [] as string[], answered: false, lastToLeave: false, connectedAt: null as number | null };

  test('missed: our ring timed out, or we hung up while still ringing; never after an answer or a decline', () => {
    assert.equal(endLineFor({ ...base, endReason: 'no-answer', rang: [bob] }), 'missed');
    assert.equal(endLineFor({ ...base, endReason: 'hangup', rang: [bob], connectedAt: 1 }), 'missed');
    assert.equal(endLineFor({ ...base, endReason: 'hangup', rang: [bob], answered: true, lastToLeave: true, connectedAt: 1 }), 'ended');
    assert.equal(endLineFor({ ...base, endReason: 'declined', rang: [bob] }), null);
    assert.equal(endLineFor({ ...base, endReason: 'busy', rang: [bob] }), null);
    assert.equal(endLineFor({ ...base, endReason: 'hangup', rang: [] }), null); // a drop-in start that rang nobody
  });

  test('ended: only the last one out of a connected call', () => {
    assert.equal(endLineFor({ ...base, endReason: 'remote-hangup', answered: true, lastToLeave: true, connectedAt: 1 }), 'ended');
    assert.equal(endLineFor({ ...base, endReason: 'hangup', answered: true, lastToLeave: false, connectedAt: 1 }), null);
    assert.equal(endLineFor({ ...base, endReason: 'error', answered: true, lastToLeave: true, connectedAt: 1 }), 'ended');
    assert.equal(endLineFor({ ...base, endReason: 'hangup', answered: true, lastToLeave: true, connectedAt: null }), null);
  });

  test('ended content carries every participant, de-duplicated', () => {
    const c = buildCallLineContent({ kind: 'ended', callId: '$n', durationMs: 65_000, participants: [alice, bob, alice] });
    assert.deepEqual(c, { kind: 'ended', call_id: '$n', duration_ms: 65000, participants: [alice, bob] });
    assert.deepEqual(getCallLine(ev(c))!.participants, [alice, bob]);
  });
});
