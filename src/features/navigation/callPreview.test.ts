import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissedCallForMe, lastRowIsMissedCall, type PreviewEventLike } from './callPreview.ts';

const ME = '@alice:localhost';

function ev(type: string, content: Record<string, unknown> = {}, opts: { state?: boolean; redacted?: boolean; sender?: string } = {}): PreviewEventLike {
  return {
    getType: () => type,
    getContent: () => content,
    getSender: () => opts.sender ?? '@bob:localhost',
    getId: () => '$e',
    isRedacted: () => !!opts.redacted,
    isState: () => !!opts.state,
  };
}

const missed = (participants: unknown = [ME]) => ev('dev.matrixpoc.call', { kind: 'missed', call_id: '$r', participants });
const message = ev('m.room.message', { msgtype: 'm.text', body: 'hi' });
const isRow = (e: PreviewEventLike) => e.getType() === 'm.room.message';

test('isMissedCallForMe: missed line listing me', () => {
  assert.equal(isMissedCallForMe(missed(), ME), true);
  assert.equal(isMissedCallForMe(missed(['@bob:localhost']), ME), false);
  assert.equal(isMissedCallForMe(missed('nope'), ME), false);
  assert.equal(isMissedCallForMe(ev('dev.matrixpoc.call', { kind: 'ended', call_id: '$r', participants: [ME] }), ME), false);
  assert.equal(isMissedCallForMe(ev('dev.matrixpoc.call', { kind: 'missed', call_id: '$r', participants: [ME] }, { redacted: true }), ME), false);
  assert.equal(isMissedCallForMe(missed(), null), false);
  // the caller's own missed line is "No answer from bob", not a missed call
  assert.equal(isMissedCallForMe(ev('dev.matrixpoc.call', { kind: 'missed', call_id: '$r', participants: [ME] }, { sender: ME }), ME), false);
});

test('lastRowIsMissedCall: only when the missed line is the last row', () => {
  assert.equal(lastRowIsMissedCall([message, missed()], ME, isRow), true);
  // state events and non-rows (reactions, receipts) after it do not hide it
  assert.equal(lastRowIsMissedCall([message, missed(), ev('m.room.member', {}, { state: true }), ev('m.reaction')], ME, isRow), true);
  // a later message or call line does
  assert.equal(lastRowIsMissedCall([missed(), message], ME, isRow), false);
  assert.equal(lastRowIsMissedCall([missed(), ev('org.matrix.msc4075.rtc.notification', { notification_type: 'ring' })], ME, isRow), false);
  assert.equal(lastRowIsMissedCall([], ME, isRow), false);
});
