/**
 * Unit tests for the receipts UI helpers (DEV-A-R2 / AC-R2-4 "+N", AC-R8-1 labels, AC-R3-5 count text).
 * Run: `npm run test:unit`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarStack, MAX_SHOWN_AVATARS, seenByLabel, unseenCountLabel } from './labels.ts';

const r = (n: number) => ({ userId: `@u${n}:localhost`, displayName: `User ${n}` });

describe('avatarStack', () => {
  test('5 readers -> 3 shown + "+2" (AC-R2-4)', () => {
    const readers = [1, 2, 3, 4, 5].map(r);
    const { shown, more } = avatarStack(readers);
    assert.equal(MAX_SHOWN_AVATARS, 3);
    assert.deepEqual(
      shown.map((x) => x.userId),
      ['@u1:localhost', '@u2:localhost', '@u3:localhost'],
    );
    assert.equal(more, 2);
  });
  test('4 readers -> "+1"; 3 or fewer -> no overflow', () => {
    assert.equal(avatarStack([1, 2, 3, 4].map(r)).more, 1);
    assert.equal(avatarStack([1, 2, 3].map(r)).more, 0);
    assert.equal(avatarStack([1].map(r)).shown.length, 1);
    assert.equal(avatarStack([]).more, 0);
  });
});

describe('seenByLabel', () => {
  test('names in order, no "others" up to 3', () => {
    assert.equal(seenByLabel([{ userId: '@bob:localhost', displayName: 'Bob Ruiz' }]), 'Seen by Bob Ruiz');
    assert.equal(
      seenByLabel([
        { userId: '@bob:localhost', displayName: 'Bob Ruiz' },
        { userId: '@carol:localhost', displayName: 'Carol Nguyen' },
      ]),
      'Seen by Bob Ruiz, Carol Nguyen',
    );
  });
  test('5 readers -> "X, Y, Z and 2 others"; 4 -> "and 1 other"', () => {
    assert.equal(seenByLabel([1, 2, 3, 4, 5].map(r)), 'Seen by User 1, User 2, User 3 and 2 others');
    assert.equal(seenByLabel([1, 2, 3, 4].map(r)), 'Seen by User 1, User 2, User 3 and 1 other');
  });
  test('falls back to the user id when the display name is empty', () => {
    assert.equal(seenByLabel([{ userId: '@x:localhost', displayName: '' }]), 'Seen by @x:localhost');
  });
});

describe('unseenCountLabel', () => {
  test('plural and singular', () => {
    assert.equal(unseenCountLabel(51), "51 others haven't seen it yet");
    assert.equal(unseenCountLabel(1), "1 other hasn't seen it yet");
  });
});
