/**
 * Unit tests for the pure read-receipt logic (`receipts-core.ts`). Run: `npm run test:unit` (Node 22 strips the
 * types; no build step). The module must stay importable from plain Node: no `@/` imports, no `import.meta.env`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStatus, MatrixEvent } from 'matrix-js-sdk';
import {
  compareReaders,
  getSendStatus,
  mapReadPointsToRows,
  mergeSendReadReceipts,
  pickLatestOwnSentId,
  readSendReadReceipts,
  sameReaders,
  type Reader,
} from './receipts-core.ts';

const ME = '@alice:localhost';
const BOB = '@bob:localhost';

function message(id: string, sender: string, status: EventStatus | null = null): MatrixEvent {
  const ev = new MatrixEvent({ event_id: id, type: 'm.room.message', sender, room_id: '!r:localhost', origin_server_ts: 1, content: { msgtype: 'm.text', body: id } });
  ev.status = status;
  return ev;
}

describe('getSendStatus', () => {
  test("null for other people's messages, whatever their status", () => {
    assert.equal(getSendStatus(message('$1', BOB), ME), null);
    assert.equal(getSendStatus(message('~txn', BOB, EventStatus.SENDING), ME), null);
    assert.equal(getSendStatus(message('$1', ME), null), null);
    assert.equal(getSendStatus(null, ME), null);
  });

  test('E2EE local-echo chain: encrypting / queued / sending -> sending; sent and remote echo -> sent; not_sent / cancelled -> failed', () => {
    assert.equal(getSendStatus(message('~txn', ME, EventStatus.ENCRYPTING), ME), 'sending');
    assert.equal(getSendStatus(message('~txn', ME, EventStatus.QUEUED), ME), 'sending');
    assert.equal(getSendStatus(message('~txn', ME, EventStatus.SENDING), ME), 'sending');
    assert.equal(getSendStatus(message('$1', ME, EventStatus.SENT), ME), 'sent');
    assert.equal(getSendStatus(message('$1', ME, null), ME), 'sent');
    assert.equal(getSendStatus(message('~txn', ME, EventStatus.NOT_SENT), ME), 'failed');
    assert.equal(getSendStatus(message('~txn', ME, EventStatus.CANCELLED), ME), 'failed');
  });
});

describe('mapReadPointsToRows', () => {
  // Unfiltered timeline: m1, reaction r1 (hidden), m2, edit e1 (hidden), state s1 (hidden), m3.
  const ordered = ['$m1', '$r1', '$m2', '$e1', '$s1', '$m3'];
  const displayed = ['$m1', '$m2', '$m3'];

  test('a read point on a displayed row lands on that row', () => {
    const rows = mapReadPointsToRows(ordered, displayed, [{ userId: BOB, eventId: '$m2' }]);
    assert.deepEqual([...rows], [['$m2', [BOB]]]);
  });

  test('a read point on a hidden event (reaction, edit, state) attaches to the nearest earlier displayed row', () => {
    assert.deepEqual([...mapReadPointsToRows(ordered, displayed, [{ userId: BOB, eventId: '$r1' }])], [['$m1', [BOB]]]);
    assert.deepEqual([...mapReadPointsToRows(ordered, displayed, [{ userId: BOB, eventId: '$e1' }])], [['$m2', [BOB]]]);
    assert.deepEqual([...mapReadPointsToRows(ordered, displayed, [{ userId: BOB, eventId: '$s1' }])], [['$m2', [BOB]]]);
  });

  test('read points outside the loaded timeline or before the first displayed row are dropped', () => {
    assert.equal(mapReadPointsToRows(ordered, displayed, [{ userId: BOB, eventId: '$old' }]).size, 0);
    // Only m3 is displayed; a point on m1 has no row at or before it.
    assert.equal(mapReadPointsToRows(ordered, ['$m3'], [{ userId: BOB, eventId: '$m1' }]).size, 0);
    assert.equal(mapReadPointsToRows(ordered, [], [{ userId: BOB, eventId: '$m1' }]).size, 0);
  });

  test('several users on one row keep the input order; different rows stay separate', () => {
    const rows = mapReadPointsToRows(ordered, displayed, [
      { userId: '@carol:localhost', eventId: '$m3' },
      { userId: BOB, eventId: '$e1' },
      { userId: '@dave:localhost', eventId: '$m2' },
    ]);
    assert.deepEqual(rows.get('$m3'), ['@carol:localhost']);
    assert.deepEqual(rows.get('$m2'), [BOB, '@dave:localhost']);
  });

  test('a displayed id missing from the ordered timeline is ignored, not guessed', () => {
    const rows = mapReadPointsToRows(ordered, ['$ghost', '$m2'], [{ userId: BOB, eventId: '$m3' }]);
    assert.deepEqual([...rows], [['$m2', [BOB]]]);
  });
});

describe('pickLatestOwnSentId (the single "sent" check)', () => {
  const reader: Reader = { userId: BOB, displayName: 'Bob', avatarUrl: null, ts: 1 };

  test('my newest sent message, newest row, nobody has read it -> that id', () => {
    const rows = [message('$1', BOB), message('$2', ME)];
    assert.equal(pickLatestOwnSentId(rows, ME, new Map()), '$2');
    assert.equal(pickLatestOwnSentId(rows, ME, new Map([['$1', [reader]]])), '$2'); // a reader on an older row does not matter
  });

  test('no check while it is still sending, when it failed, or when it is a local echo', () => {
    assert.equal(pickLatestOwnSentId([message('~txn', ME, EventStatus.SENDING)], ME, new Map()), null);
    assert.equal(pickLatestOwnSentId([message('~txn', ME, EventStatus.NOT_SENT)], ME, new Map()), null);
    assert.equal(pickLatestOwnSentId([message('$2', ME, EventStatus.SENT)], ME, new Map()), '$2'); // SENT = the server has it
  });

  test('no check once someone read it (their avatars replace it) or once someone else posted after it', () => {
    assert.equal(pickLatestOwnSentId([message('$2', ME)], ME, new Map([['$2', [reader]]])), null);
    assert.equal(pickLatestOwnSentId([message('$2', ME), message('$3', BOB)], ME, new Map()), null);
    assert.equal(pickLatestOwnSentId([], ME, new Map()), null);
    assert.equal(pickLatestOwnSentId([message('$2', ME)], null, new Map()), null);
  });
});

describe('"Send read receipts" setting (im.vector.web.settings)', () => {
  test('default ON; only an explicit false turns it off', () => {
    assert.equal(readSendReadReceipts(undefined), true);
    assert.equal(readSendReadReceipts({}), true);
    assert.equal(readSendReadReceipts({ sendReadReceipts: true }), true);
    assert.equal(readSendReadReceipts({ sendReadReceipts: 'no' }), true);
    assert.equal(readSendReadReceipts({ sendReadReceipts: false }), false);
  });

  test('writing merges into the existing content and never clobbers other keys', () => {
    const existing = { showTypingNotifications: false, language: 'fr', sendReadReceipts: true };
    const merged = mergeSendReadReceipts(existing, false);
    assert.deepEqual(merged, { showTypingNotifications: false, language: 'fr', sendReadReceipts: false });
    assert.deepEqual(existing.sendReadReceipts, true, 'input not mutated');
    assert.deepEqual(mergeSendReadReceipts(undefined, true), { sendReadReceipts: true });
  });
});

describe('reader helpers', () => {
  test('compareReaders: newest receipt first, then user id', () => {
    const a: Reader = { userId: '@b:x', displayName: 'B', avatarUrl: null, ts: 10 };
    const b: Reader = { userId: '@a:x', displayName: 'A', avatarUrl: null, ts: 20 };
    const c: Reader = { userId: '@c:x', displayName: 'C', avatarUrl: null, ts: 10 };
    assert.deepEqual([a, b, c].sort(compareReaders).map((r) => r.userId), ['@a:x', '@b:x', '@c:x']);
  });

  test('sameReaders compares by value so unchanged rows can keep their array identity', () => {
    const r = (ts: number): Reader => ({ userId: BOB, displayName: 'Bob', avatarUrl: null, ts });
    assert.equal(sameReaders([r(1)], [r(1)]), true);
    assert.equal(sameReaders([r(1)], [r(2)]), false);
    assert.equal(sameReaders(undefined, []), false);
    assert.equal(sameReaders([], []), true);
  });
});
