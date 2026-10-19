/**
 * Unit tests for the pure read-receipt logic (`receipts-core.ts`). Run: `npm run test:unit` (Node 22 strips the
 * types; no build step). The module must stay importable from plain Node: no `@/` imports, no `import.meta.env`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStatus, MatrixEvent } from 'matrix-js-sdk';
import {
  clearPendingSendReadReceipts,
  collectReadPoints,
  compareReaders,
  getPendingSendReadReceipts,
  getSendStatus,
  latestReceiptTs,
  mapReadPointsToRows,
  mergeSendReadReceipts,
  pickLatestOwnSentId,
  ReaderCache,
  readSendReadReceipts,
  resolveSendReadReceipts,
  sameReaders,
  withPendingSendReadReceipts,
  type Reader,
  type ReadPointSource,
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

// ---------------------------------------------------------------------------
// Review-finding regressions
// ---------------------------------------------------------------------------

describe('collectReadPoints (holder -> rows, with the thread-reply fallback)', () => {
  // Main timeline: m1, thread root t1, m2. The reply $reply lives in the thread, not in the main timeline.
  const main = ['$m1', '$t1', '$m2'];
  const source = (readUpTo: Record<string, string | null>, ts: Record<string, number> = {}): ReadPointSource => ({
    timelineIds: () => main,
    readUpTo: (u) => readUpTo[u] ?? null,
    receiptTs: (u) => ts[u] ?? 0,
    threadRootOf: (id) => (id === '$reply' ? '$t1' : undefined),
  });

  test('an unthreaded receipt pointing at a thread reply lands on the root row of the main list (finding 4)', () => {
    const { rows, ts } = collectReadPoints(source({ [BOB]: '$reply' }, { [BOB]: 7 }), [BOB], main);
    assert.deepEqual([...rows], [['$t1', [BOB]]]);
    assert.equal(ts.get(BOB), 7);
  });

  test('the root is subject to the hidden-event rule too, and an unknown read point is still dropped', () => {
    // Root hidden from the list -> nearest earlier displayed row.
    assert.deepEqual([...collectReadPoints(source({ [BOB]: '$reply' }), [BOB], ['$m1', '$m2']).rows], [['$m1', [BOB]]]);
    // Not in the timeline and no known thread root (older than the window): dropped, no ts recorded.
    const unknown = collectReadPoints(source({ [BOB]: '$old' }), [BOB], main);
    assert.equal(unknown.rows.size, 0);
    assert.equal(unknown.ts.size, 0);
    // No read point at all.
    assert.equal(collectReadPoints(source({}), [BOB], main).rows.size, 0);
    assert.equal(collectReadPoints(source({ [BOB]: '$m2' }), [], main).rows.size, 0);
    assert.equal(collectReadPoints(source({ [BOB]: '$m2' }), [BOB], []).rows.size, 0);
  });

  test('an in-timeline read point is used as is (no thread lookup) and keeps its ts', () => {
    let lookups = 0;
    const src = source({ [BOB]: '$m2', '@carol:localhost': '$m1' }, { [BOB]: 5, '@carol:localhost': 3 });
    src.threadRootOf = () => {
      lookups++;
      return undefined;
    };
    const { rows, ts } = collectReadPoints(src, [BOB, '@carol:localhost'], main);
    assert.deepEqual(rows.get('$m2'), [BOB]);
    assert.deepEqual(rows.get('$m1'), ['@carol:localhost']);
    assert.equal(ts.get(BOB), 5);
    assert.equal(ts.get('@carol:localhost'), 3);
    assert.equal(lookups, 0);
  });
});

describe('latestReceiptTs (thread holder vs unthreaded fallback, finding 3)', () => {
  test('takes the newer of the holder receipt and the room-level unthreaded receipt; 0 when neither is known', () => {
    assert.equal(latestReceiptTs(undefined, undefined), 0);
    assert.equal(latestReceiptTs(null, 0), 0);
    // Thread has no receipt of its own, the read point came from the unthreaded receipt: show that ts, not 0.
    assert.equal(latestReceiptTs(undefined, 42), 42);
    // Thread receipt is stale, the unthreaded one is newer.
    assert.equal(latestReceiptTs(10, 42), 42);
    // Thread receipt is the newer one.
    assert.equal(latestReceiptTs(50, 42), 50);
  });
});

describe('ReaderCache (finding 5: seen-by ts 0 vs read-point ts must not thrash)', () => {
  test('keeps one identity per (user, ts) across interleaved buildReadPoints / getSeenBy calls', () => {
    const cache = new ReaderCache();
    const withTs = cache.get(BOB, 'Bob', null, 100);
    const zero = cache.get(BOB, 'Bob', null, 0); // a "not seen" / unknown-ts entry for the same user
    assert.notEqual(withTs, zero);
    // The timestamped entry survives the ts-0 lookup and vice versa (a single-slot cache would rebuild both).
    assert.equal(cache.get(BOB, 'Bob', null, 100), withTs);
    assert.equal(cache.get(BOB, 'Bob', null, 0), zero);
    assert.equal(cache.get(BOB, 'Bob', null, 100), withTs);
  });

  test('a new ts, name or avatar yields a new object; other users are independent', () => {
    const cache = new ReaderCache();
    const a = cache.get(BOB, 'Bob', null, 100);
    assert.notEqual(cache.get(BOB, 'Bob', null, 200), a);
    const b = cache.get(BOB, 'Bob', null, 200);
    assert.notEqual(cache.get(BOB, 'Robert', null, 200), b);
    const c = cache.get(BOB, 'Robert', null, 200);
    assert.notEqual(cache.get(BOB, 'Robert', 'http://x/avatar', 200), c);
    const carol = cache.get('@carol:localhost', 'Carol', null, 200);
    assert.equal(cache.get('@carol:localhost', 'Carol', null, 200), carol);
    assert.deepEqual(carol, { userId: '@carol:localhost', displayName: 'Carol', avatarUrl: null, ts: 200 });
  });
});

describe('"Send read receipts" optimistic override (finding 1)', () => {
  const stored = { sendReadReceipts: true }; // what getAccountData still returns until the /sync echo
  const deferred = (): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } => {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  test('the new value is effective synchronously, before the PUT resolves; cleared once the echo landed', async () => {
    clearPendingSendReadReceipts();
    assert.equal(resolveSendReadReceipts(stored), true);
    const put = deferred();
    const write = withPendingSendReadReceipts(false, () => put.promise);
    // A receipt sent right now (user toggled OFF and scrolled) must already be private.
    assert.equal(resolveSendReadReceipts(stored), false);
    assert.equal(getPendingSendReadReceipts(), false);
    put.resolve();
    await write;
    assert.equal(getPendingSendReadReceipts(), null);
    // After the echo the stored content is the new one and is what resolves.
    assert.equal(resolveSendReadReceipts({ sendReadReceipts: false }), false);
    assert.equal(resolveSendReadReceipts(stored), true);
  });

  test('a failed PUT reverts to the stored value and rejects', async () => {
    clearPendingSendReadReceipts();
    const put = deferred();
    const write = withPendingSendReadReceipts(false, () => put.promise);
    assert.equal(resolveSendReadReceipts(stored), false);
    put.reject(new Error('M_LIMIT_EXCEEDED'));
    await assert.rejects(write, /M_LIMIT_EXCEEDED/);
    assert.equal(getPendingSendReadReceipts(), null);
    assert.equal(resolveSendReadReceipts(stored), true);
  });

  test('overlapping writes: the older write settling does not clear the newer override', async () => {
    clearPendingSendReadReceipts();
    const first = deferred();
    const second = deferred();
    const w1 = withPendingSendReadReceipts(false, () => first.promise);
    const w2 = withPendingSendReadReceipts(true, () => second.promise);
    assert.equal(resolveSendReadReceipts({ sendReadReceipts: true }), true);
    first.resolve();
    await w1;
    // The first echo landed (stored = false) but the ON write is still in flight: the user's latest choice wins.
    assert.equal(getPendingSendReadReceipts(), true);
    assert.equal(resolveSendReadReceipts({ sendReadReceipts: false }), true);
    second.resolve();
    await w2;
    assert.equal(getPendingSendReadReceipts(), null);
    assert.equal(resolveSendReadReceipts({ sendReadReceipts: true }), true);
  });

  test('clearPendingSendReadReceipts (logout) drops an in-flight override', async () => {
    const put = deferred();
    const write = withPendingSendReadReceipts(false, () => put.promise);
    assert.equal(getPendingSendReadReceipts(), false);
    clearPendingSendReadReceipts();
    assert.equal(getPendingSendReadReceipts(), null);
    put.resolve();
    await write;
    assert.equal(getPendingSendReadReceipts(), null);
  });
});
