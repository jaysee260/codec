/**
 * Crypto lifecycle (Phase 5): the Rust crypto engine (`initRustCrypto`, matrix-sdk-crypto compiled to WASM) and the
 * secret-storage key cache the SDK consults when it needs the recovery key.
 *
 * Lifecycle (owned by client.ts):
 *   createClient({ cryptoCallbacks })  ->  initCrypto(client)  ->  startClient(...)
 *   logout / token rejected            ->  stopClient()        ->  wipeCryptoStore(client, session)
 *
 * Persistence: one IndexedDB pair per `cryptoDatabasePrefix(session)` (`matrix-poc:<userId>:<deviceId>`), so a
 * reload reuses the device's Olm account and Megolm sessions, two users on one browser never share a store, and
 * a new SSO login (a new device id, every time) starts clean. The store is **not** encrypted at rest
 * (`storageKey` unset): the access token sits in plain localStorage on the same origin anyway, and a lost key
 * would brick the store and lose every room key not yet in backup. Revisit for the native (Capacitor) build.
 *
 * Recovery key: `getSecretStorageKey` is consulted by the SDK whenever it reads or writes server-side secret
 * storage (restoring cross-signing keys, the backup key). It answers from an in-memory cache filled by
 * `unlockWithRecoveryKey` (security store) / `cacheSecretStorageKey` (set up by `bootstrapSecretStorage`), else
 * from an optional prompt the UI registers (`setSecretStorageKeyPrompt`), else `null` (the SDK call then fails
 * with "secret storage key not available", which the store reports). Never persisted.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { decodeRecoveryKey, deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { CryptoCallbacks } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage.js';
import type { StoredSession } from './client.ts';

/** IndexedDB name prefix of the crypto store for a session (the SDK appends `::matrix-sdk-crypto[-meta]`). */
export function cryptoDatabasePrefix(session: Pick<StoredSession, 'userId' | 'deviceId'>): string {
  return `${CRYPTO_DB_PREFIX}${session.userId}:${session.deviceId}`;
}

/** Every crypto store this app creates starts with this (AC-E1-2/3: `indexedDB.databases()` checks). */
export const CRYPTO_DB_PREFIX = 'matrix-poc-crypto:';

/** The verification methods this client offers / accepts (emoji SAS only; no QR scanning in the POC). */
export const VERIFICATION_METHODS = ['m.sas.v1'];

let lastCryptoError: string | null = null;

/** Message of the last `initCrypto` failure, or null when the engine started (or was never attempted). */
export function getCryptoError(): string | null {
  return lastCryptoError;
}

/**
 * Start the Rust crypto engine for a freshly created (not yet started) client. Loads the WASM on first call
 * (~7.8 MB, cached by the browser afterwards), opens / migrates the IndexedDB store. Must run before
 * `startClient` so the first /sync already decrypts and uploads device keys.
 *
 * Resolves `true` on success. On failure (WASM blocked, IndexedDB unavailable in a private window, store
 * corrupted) it logs, remembers the message for `getCryptoError()` and resolves `false`: the client then runs
 * without crypto (encrypted rooms stay unreadable, sends into them throw) instead of blocking login.
 */
export async function initCrypto(client: MatrixClient, session: Pick<StoredSession, 'userId' | 'deviceId'>): Promise<boolean> {
  lastCryptoError = null;
  const prefix = cryptoDatabasePrefix(session);
  await retryPendingWipes(prefix);
  try {
    await client.initRustCrypto({ cryptoDatabasePrefix: prefix });
    return true;
  } catch (e) {
    lastCryptoError = e instanceof Error ? e.message : String(e);
    console.error('[crypto] initRustCrypto failed; running without encryption', e);
    return false;
  }
}

/** localStorage key: crypto store prefixes whose deletion was blocked at logout and must be retried on the next boot. */
export const PENDING_WIPES_KEY = 'matrix-poc.pendingCryptoWipes';
/** How long a logout waits for the IndexedDB deletion before moving on (the delete stays queued in the browser). */
const WIPE_TIMEOUT_MS = 4000;
const STORE_SUFFIXES = ['::matrix-sdk-crypto', '::matrix-sdk-crypto-meta'];

function readPendingWipes(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_WIPES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writePendingWipes(list: string[]): void {
  try {
    if (list.length) localStorage.setItem(PENDING_WIPES_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_WIPES_KEY);
  } catch {
    /* storage unavailable */
  }
}

function markPendingWipe(prefix: string, pending: boolean): void {
  const list = readPendingWipes().filter((p) => p !== prefix);
  writePendingWipes(pending ? [...list, prefix] : list);
}

/** `indexedDB.deleteDatabase` as a promise; resolves false when blocked longer than `timeoutMs` or on error. */
function deleteDatabase(name: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(true);
    };
    req.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

/**
 * Delete the stores of prefixes whose wipe was blocked earlier (see `wipeCryptoStore`). Runs before the engine
 * opens `current`, when nothing of ours holds a connection; a prefix that still cannot be deleted stays listed.
 */
export async function retryPendingWipes(current: string): Promise<void> {
  for (const prefix of readPendingWipes()) {
    if (prefix === current) continue;
    const results = await Promise.all(STORE_SUFFIXES.map((suffix) => deleteDatabase(prefix + suffix, WIPE_TIMEOUT_MS)));
    if (results.every(Boolean)) markPendingWipe(prefix, false);
    else console.warn('[crypto] crypto store still in use, will retry next boot', prefix);
  }
}

/**
 * Delete the crypto store of a session (Olm account, Megolm sessions, cross-signing private keys). Call after
 * `stopClient()` (the SDK refuses while running) on logout and when the server rejects the token: the device is
 * gone server-side, so its keys must not linger for the next user of this browser. Never throws.
 *
 * `clearStores` waits for `indexedDB.deleteDatabase`, which stays **blocked** while any connection is open. The
 * Rust engine normally closes its connection in `stopClient()`, but an in-flight backup upload (right after
 * `setupRecovery`) can keep one open for the rest of the page's life, so the wait is bounded: after
 * `WIPE_TIMEOUT_MS` the prefix is recorded in localStorage and `initCrypto` deletes it on the next boot (the
 * queued delete also completes by itself as soon as the connection closes).
 */
export async function wipeCryptoStore(client: MatrixClient, session: Pick<StoredSession, 'userId' | 'deviceId'>): Promise<void> {
  const prefix = cryptoDatabasePrefix(session);
  markPendingWipe(prefix, true);
  try {
    const done = await Promise.race([
      client.clearStores({ cryptoDatabasePrefix: prefix }).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WIPE_TIMEOUT_MS)),
    ]);
    if (done) markPendingWipe(prefix, false);
    else console.warn('[crypto] crypto store deletion blocked (connection still open); queued for the next boot', prefix);
  } catch (e) {
    console.warn('[crypto] clearStores failed', e);
  }
}

// ---------------------------------------------------------------------------
// Secret storage key cache (recovery key)
// ---------------------------------------------------------------------------

const cachedKeys = new Map<string, Uint8Array<ArrayBuffer>>();

/** A UI hook that asks the user for their recovery key / passphrase when the SDK needs it and nothing is cached. */
export type SecretStorageKeyPrompt = (keyInfo: SecretStorageKeyDescription, keyId: string) => Promise<string | null>;

let prompt: SecretStorageKeyPrompt | null = null;

/** Register (or clear with null) the UI prompt used when the SDK needs the recovery key and it is not cached. */
export function setSecretStorageKeyPrompt(fn: SecretStorageKeyPrompt | null): void {
  prompt = fn;
}

/** Remember a secret storage private key for this session (memory only). */
export function cacheSecretStorageKey(keyId: string, key: Uint8Array<ArrayBuffer>): void {
  cachedKeys.set(keyId, key);
}

/** True when the key with `keyId` (or any key when omitted) is cached. */
export function hasCachedSecretStorageKey(keyId?: string): boolean {
  return keyId ? cachedKeys.has(keyId) : cachedKeys.size > 0;
}

/** Forget every cached secret storage key (logout). */
export function clearSecretStorageKeyCache(): void {
  cachedKeys.clear();
}

/**
 * Turn what the user typed into the raw secret storage private key: a recovery key (`EsTc ...`, base58 with
 * spaces) is decoded; anything else is treated as a passphrase and derived with the key's PBKDF2 parameters
 * (only possible when the key was created from a passphrase). Returns null when neither works.
 */
export async function resolveRecoveryInput(
  input: string,
  keyInfo: SecretStorageKeyDescription | undefined,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return decodeRecoveryKey(trimmed);
  } catch {
    /* not a recovery key: try as a passphrase */
  }
  const pass = keyInfo?.passphrase;
  if (!pass || pass.algorithm !== 'm.pbkdf2' || typeof pass.salt !== 'string' || typeof pass.iterations !== 'number') return null;
  try {
    return await deriveRecoveryKeyFromPassphrase(trimmed, pass.salt, pass.iterations, pass.bits);
  } catch {
    return null;
  }
}

/**
 * The `cryptoCallbacks` passed to `createClient`. The SDK calls `getSecretStorageKey` for every secret it reads
 * or writes; the answer must be one of the offered `keys`.
 */
export const cryptoCallbacks: CryptoCallbacks = {
  async getSecretStorageKey({ keys }) {
    for (const [keyId, key] of cachedKeys) if (keys[keyId]) return [keyId, key];
    if (!prompt) return null;
    // Prefer the account's default key when it is among the requested ones.
    const keyId = Object.keys(keys)[0];
    if (!keyId) return null;
    const keyInfo = keys[keyId]!;
    const input = await prompt(keyInfo, keyId);
    if (!input) return null;
    const key = await resolveRecoveryInput(input, keyInfo);
    if (!key) return null;
    cachedKeys.set(keyId, key);
    return [keyId, key];
  },
  cacheSecretStorageKey(keyId, _keyInfo, key) {
    cachedKeys.set(keyId, key);
  },
};
