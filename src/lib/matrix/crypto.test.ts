/**
 * Unit tests for the secret-storage key cache lookup (recovery unlock hang, bug report 2026-10-18).
 *
 * Run: `npm run test:unit` (Node's built-in runner; Node 22 strips the types, no build step, no dependencies).
 * crypto.ts must stay importable from plain Node (no `@/` imports, no browser globals at import time).
 *
 * The account in the bug has two secret-storage keys: K1 (default, the one the user typed) and K2 (the backup
 * secret is encrypted under K2 only). `getSecretStorageKey` used to match cached keys by id only, so the SDK's
 * request for K2 went to the prompt even when the cached value would have opened it.
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { calculateKeyCheck, type SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage.js';
import {
  cacheSecretStorageKey,
  clearSecretStorageKeyCache,
  cryptoCallbacks,
  findCachedSecretStorageKey,
  hasCachedSecretStorageKey,
  SecretStorageKeyMissError,
  setSecretStorageKeyPrompt,
  type SecretStorageKeyPromptContext,
} from './crypto.ts';

const ALGORITHM = 'm.secret_storage.v1.aes-hmac-sha2';

function randomKey(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** A real key description (iv + mac) for `key`, as `client.secretStorage.addKey` would publish it. */
async function describeKey(key: Uint8Array<ArrayBuffer>, name?: string): Promise<SecretStorageKeyDescription> {
  const { iv, mac } = await calculateKeyCheck(key);
  return { algorithm: ALGORITHM, iv, mac, ...(name ? { name } : {}) } as SecretStorageKeyDescription;
}

/** Production-like checkKey (what `client.secretStorage.checkKey` does for aes-hmac-sha2), counting its calls. */
function countingCheckKey(): { calls: number; fn: (key: Uint8Array<ArrayBuffer>, info: SecretStorageKeyDescription) => Promise<boolean> } {
  const state = {
    calls: 0,
    fn: async (key: Uint8Array<ArrayBuffer>, info: SecretStorageKeyDescription): Promise<boolean> => {
      state.calls += 1;
      const desc = info as { iv?: string; mac?: string };
      const { mac } = await calculateKeyCheck(key, desc.iv);
      return desc.mac?.replace(/=+$/, '') === mac.replace(/=+$/, '');
    },
  };
  return state;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

describe('findCachedSecretStorageKey', () => {
  test('exact id match is returned without calling checkKey', async () => {
    const k1 = randomKey();
    const keys = { k1: await describeKey(k1) };
    const check = countingCheckKey();
    const found = await findCachedSecretStorageKey(keys, new Map([['k1', k1]]), check.fn);
    assert.ok(found, 'a match');
    assert.equal(found[0], 'k1');
    assert.ok(sameBytes(found[1], k1));
    assert.equal(check.calls, 0, 'checkKey is not needed for an id match');
  });

  test('a cached value matches an offered key with a different id', async () => {
    const k = randomKey();
    // The same raw key published twice (e.g. re-added under a new id): cached as "old", offered as "new".
    const keys = { new: await describeKey(k) };
    const check = countingCheckKey();
    const found = await findCachedSecretStorageKey(keys, new Map([['old', k]]), check.fn);
    assert.ok(found, 'value match under a different id');
    assert.equal(found[0], 'new', 'returned under the offered id (the SDK rejects unknown ids)');
    assert.ok(sameBytes(found[1], k));
    assert.ok(check.calls >= 1);
  });

  test('value match is found among several offered ids and several cached keys', async () => {
    const k1 = randomKey();
    const k2 = randomKey();
    const k3 = randomKey();
    const keys = { a: await describeKey(k3), b: await describeKey(k2) };
    const found = await findCachedSecretStorageKey(keys, new Map([['x', k1], ['y', k2]]), countingCheckKey().fn);
    assert.ok(found);
    assert.equal(found[0], 'b');
    assert.ok(sameBytes(found[1], k2));
  });

  test('no cached key opens any offered key -> null', async () => {
    const k1 = randomKey();
    const k2 = randomKey();
    const keys = { k2: await describeKey(k2) };
    assert.equal(await findCachedSecretStorageKey(keys, new Map([['k1', k1]]), countingCheckKey().fn), null);
  });

  test('empty cache -> null without calling checkKey', async () => {
    const keys = { k2: await describeKey(randomKey()) };
    const check = countingCheckKey();
    assert.equal(await findCachedSecretStorageKey(keys, new Map(), check.fn), null);
    assert.equal(check.calls, 0);
  });

  test('a throwing checkKey counts as no match', async () => {
    const k1 = randomKey();
    const keys = { k2: await describeKey(randomKey()) };
    const throwing = async (): Promise<boolean> => {
      throw new Error('boom');
    };
    assert.equal(await findCachedSecretStorageKey(keys, new Map([['k1', k1]]), throwing), null);
  });

  test('a throwing checkKey for one candidate does not hide a later match', async () => {
    const bad = randomKey();
    const good = randomKey();
    const keys = { k2: await describeKey(good) };
    const check = countingCheckKey();
    const flaky = async (key: Uint8Array<ArrayBuffer>, info: SecretStorageKeyDescription): Promise<boolean> => {
      if (sameBytes(key, bad)) throw new Error('boom');
      return check.fn(key, info);
    };
    const found = await findCachedSecretStorageKey(keys, new Map([['k1', bad], ['k9', good]]), flaky);
    assert.ok(found);
    assert.equal(found[0], 'k2');
    assert.ok(sameBytes(found[1], good));
  });
});

describe('cryptoCallbacks.getSecretStorageKey', () => {
  afterEach(() => {
    setSecretStorageKeyPrompt(null);
    clearSecretStorageKeyCache();
  });

  const getKey = (keys: Record<string, SecretStorageKeyDescription>, name: string) =>
    cryptoCallbacks.getSecretStorageKey!({ keys }, name) as Promise<[string, Uint8Array<ArrayBuffer>] | null>;

  test('a cached key under another id that opens the offered key is used without prompting, and cached under the offered id', async () => {
    const k = randomKey();
    cacheSecretStorageKey('k1', k);
    let prompted = 0;
    setSecretStorageKeyPrompt(async () => {
      prompted += 1;
      return null;
    });
    const found = await getKey({ k2: await describeKey(k) }, 'm.megolm_backup.v1');
    assert.ok(found);
    assert.equal(found[0], 'k2');
    assert.ok(sameBytes(found[1], k));
    assert.equal(prompted, 0, 'no prompt when a cached value matches');
    assert.equal(hasCachedSecretStorageKey('k2'), true, 'cached under the offered id');
  });

  test('a different key: prompts with the secret name and differentKey, and the right key typed there is returned', async () => {
    const k1 = randomKey();
    const k2 = randomKey();
    cacheSecretStorageKey('k1', k1);
    const seen: { keyId: string; context: SecretStorageKeyPromptContext }[] = [];
    setSecretStorageKeyPrompt(async (_info, keyId, context) => {
      seen.push({ keyId, context });
      return encodeRecoveryKey(k2)!;
    });
    const found = await getKey({ k2: await describeKey(k2) }, 'm.megolm_backup.v1');
    assert.equal(seen.length, 1, 'prompted once');
    assert.equal(seen[0]!.keyId, 'k2');
    assert.equal(seen[0]!.context.secretName, 'm.megolm_backup.v1');
    assert.equal(seen[0]!.context.differentKey, true, 'a key was entered already, it does not open this secret');
    assert.ok(found);
    assert.equal(found[0], 'k2');
    assert.ok(sameBytes(found[1], k2));
    assert.equal(hasCachedSecretStorageKey('k2'), true);
  });

  test('nothing cached: the prompt context says differentKey false', async () => {
    const k2 = randomKey();
    let context: SecretStorageKeyPromptContext | null = null;
    setSecretStorageKeyPrompt(async (_info, _keyId, c) => {
      context = c;
      return encodeRecoveryKey(k2)!;
    });
    const found = await getKey({ k2: await describeKey(k2) }, 'm.cross_signing.master');
    assert.ok(found);
    assert.deepEqual(context, { secretName: 'm.cross_signing.master', differentKey: false });
  });

  const miss = (reason: string) => (e: unknown): boolean => {
    assert.ok(e instanceof SecretStorageKeyMissError, `SecretStorageKeyMissError, got ${String(e)}`);
    assert.equal(e.reason, reason);
    return true;
  };

  test('a wrong key typed at the prompt rejects (wrong-key), and nothing is cached under the prompted id', async () => {
    const k2 = randomKey();
    setSecretStorageKeyPrompt(async () => encodeRecoveryKey(randomKey())!);
    await assert.rejects(getKey({ k2: await describeKey(k2) }, 'm.megolm_backup.v1'), miss('wrong-key'));
    assert.equal(hasCachedSecretStorageKey('k2'), false);
    assert.equal(hasCachedSecretStorageKey(), false, 'the cache stays empty');
  });

  test('an undecodable answer at the prompt rejects (wrong-key)', async () => {
    setSecretStorageKeyPrompt(async () => 'definitely not a key');
    await assert.rejects(getKey({ k2: await describeKey(randomKey()) }, 'm.megolm_backup.v1'), miss('wrong-key'));
    assert.equal(hasCachedSecretStorageKey(), false);
  });

  test('a cancelled prompt rejects (cancelled)', async () => {
    setSecretStorageKeyPrompt(async () => null);
    await assert.rejects(getKey({ k2: await describeKey(randomKey()) }, 'm.megolm_backup.v1'), miss('cancelled'));
  });

  test('a blank answer counts as cancelled', async () => {
    setSecretStorageKeyPrompt(async () => '   ');
    await assert.rejects(getKey({ k2: await describeKey(randomKey()) }, 'm.megolm_backup.v1'), miss('cancelled'));
  });

  test('no prompt registered and no match rejects (no-key)', async () => {
    cacheSecretStorageKey('k1', randomKey());
    await assert.rejects(getKey({ k2: await describeKey(randomKey()) }, 'm.megolm_backup.v1'), miss('no-key'));
  });

  test('no key ids offered rejects (no-key) without prompting', async () => {
    let prompted = 0;
    setSecretStorageKeyPrompt(async () => {
      prompted += 1;
      return encodeRecoveryKey(randomKey())!;
    });
    await assert.rejects(getKey({}, 'm.megolm_backup.v1'), miss('no-key'));
    assert.equal(prompted, 0);
  });

  test('a typed key for a description without a mac is returned but not cached (the next call prompts again)', async () => {
    const k = randomKey();
    const noMac = { algorithm: ALGORITHM } as SecretStorageKeyDescription;
    let prompted = 0;
    setSecretStorageKeyPrompt(async () => {
      prompted += 1;
      return encodeRecoveryKey(k)!;
    });
    const first = await getKey({ legacy: noMac }, 'm.megolm_backup.v1');
    assert.ok(first);
    assert.equal(first[0], 'legacy');
    assert.ok(sameBytes(first[1], k));
    assert.equal(hasCachedSecretStorageKey('legacy'), false, 'an unchecked key is not remembered');
    const second = await getKey({ legacy: noMac }, 'm.megolm_backup.v1');
    assert.ok(second && sameBytes(second[1], k));
    assert.equal(prompted, 2, 'prompted again on the second read');
  });
});
