/**
 * Mac app: Dock badge total and which new messages pop a notification (src/lib/desktop/model.ts).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeCount, notificationFor, NOTIFY_BODY_MAX, NOTIFY_MAX_AGE_MS, type NotifyInput } from './model.ts';

describe('badgeCount', () => {
  test('sums unread across rooms, skips spaces, adds invites', () => {
    const rooms = [
      { isSpace: false, unread: 3 },
      { isSpace: true, unread: 9 },
      { isSpace: false, unread: 0 },
      { isSpace: false, unread: 2 },
    ];
    assert.equal(badgeCount(rooms, 1), 6);
    assert.equal(badgeCount([], 0), 0);
    assert.equal(badgeCount([{ isSpace: false, unread: -1 }], -2), 0);
  });
});

describe('notificationFor', () => {
  const now = 1_000_000;
  const base: NotifyInput = {
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'hello there' },
    sender: '@bob:704.chat',
    senderName: 'Bob',
    roomName: 'general',
    isDm: false,
    originServerTs: now - 1000,
    myUserId: '@jc:704.chat',
    pushNotify: true,
    viewing: false,
    now,
  };

  test('room message: "Bob in general" with the text', () => {
    assert.deepEqual(notificationFor(base), { title: 'Bob in general', body: 'hello there' });
  });

  test('DM: just the sender as the title', () => {
    assert.deepEqual(notificationFor({ ...base, isDm: true }), { title: 'Bob', body: 'hello there' });
  });

  test('silent for my own messages, muted rooms, the room on screen, old catch-up, edits and non-messages', () => {
    assert.equal(notificationFor({ ...base, sender: base.myUserId }), null);
    assert.equal(notificationFor({ ...base, pushNotify: false }), null);
    assert.equal(notificationFor({ ...base, viewing: true }), null);
    assert.equal(notificationFor({ ...base, originServerTs: now - NOTIFY_MAX_AGE_MS - 1 }), null);
    assert.equal(notificationFor({ ...base, content: { msgtype: 'm.text', body: '* fixed', 'm.relates_to': { rel_type: 'm.replace' } } }), null);
    assert.equal(notificationFor({ ...base, type: 'm.reaction', content: {} }), null);
    assert.equal(notificationFor({ ...base, type: 'm.room.encrypted', content: {} }), null);
  });

  test('media, voice notes and GIFs get a short description, never a file name or URL', () => {
    const body = (content: Record<string, unknown>) => notificationFor({ ...base, content })?.body;
    assert.equal(body({ msgtype: 'm.image', body: 'IMG_1234.jpg' }), 'Sent an image');
    assert.equal(body({ msgtype: 'm.audio', body: 'Voice message', 'org.matrix.msc3245.voice': {} }), 'Sent a voice message');
    assert.equal(body({ msgtype: 'm.audio', body: 'song.mp3' }), 'Sent an audio file');
    assert.equal(body({ msgtype: 'm.file', body: 'taxes.pdf' }), 'Sent a file');
    assert.equal(body({ msgtype: 'm.text', body: 'party https://static.klipy.com/x.gif', 'dev.matrixpoc.gif': { id: 'x' } }), 'Sent a GIF');
  });

  test('long text is flattened and cut; reply fallback quotes are dropped', () => {
    const long = notificationFor({ ...base, content: { msgtype: 'm.text', body: `line one\n\n${'x'.repeat(300)}` } });
    assert.equal(long?.body.length, NOTIFY_BODY_MAX);
    assert.ok(long?.body.startsWith('line one x'));
    assert.ok(long?.body.endsWith('…'));
    const reply = notificationFor({ ...base, content: { msgtype: 'm.text', body: '> <@jc:704.chat> lunch?\n\nsure' } });
    assert.equal(reply?.body, 'sure');
  });
});
