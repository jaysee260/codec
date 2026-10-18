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
 * `unlockWithRecoveryKey` (security store) / `cacheSecretStorageKey` (set up by `bootstrapSecretStorage`), matched
 * by key id and then by value (an account may hold several 4S keys, the backup key encrypted under a non-default
 * one), else from an optional prompt the UI registers (`setSecretStorageKeyPrompt`, told which secret and whether
 * a different key was already entered), else `null`: the SDK call then fails ("getSecretStorageKey callback
 * returned falsey") and `lastSecretStorageKeyMiss()` says why (cancelled / wrong key / nobody to ask), which
 * security.ts turns into a `RestoreFailureReason`. Never persisted.
 *
 * Importable from plain Node (type stripping; the unit test): no `@/` imports, no runtime import of client.ts,
 * nothing touches window / localStorage / indexedDB at import time.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { decodeRecoveryKey, deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { CryptoCallbacks } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { calculateKeyCheck, SECRET_STORAGE_ALGORITHM_V1_AES, type SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage.js';
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

/** What the prompt is told besides the key description (see `getSecretStorageKey`). */
export interface SecretStorageKeyPromptContext {
  /** Secret being read, e.g. 'm.megolm_backup.v1' / 'm.cross_signing.master' (undefined if the SDK gave none). */
  secretName?: string;
  /** A recovery key was already entered this session but does not open this secret. */
  differentKey: boolean;
}

/** A UI hook that asks the user for their recovery key / passphrase when the SDK needs it and nothing cached opens it. */
export type SecretStorageKeyPrompt = (keyInfo: SecretStorageKeyDescription, keyId: string, context: SecretStorageKeyPromptContext) => Promise<string | null>;

export interface SecretStorageKeyPromptOptions {
  /** The account's default secret storage key id (`client.secretStorage.getDefaultKeyId`): prompted for first. */
  defaultKeyId?: () => Promise<string | null>;
}

let prompt: SecretStorageKeyPrompt | null = null;
let promptOptions: SecretStorageKeyPromptOptions = {};

/**
 * Register (or clear with null) the UI prompt used when the SDK needs the recovery key and nothing cached opens
 * it. `opts.defaultKeyId` is injected by the caller (the store, which has the client) so this module never
 * imports client.ts at runtime (client.ts imports us; and the unit test loads this file in plain Node).
 */
export function setSecretStorageKeyPrompt(fn: SecretStorageKeyPrompt | null, opts: SecretStorageKeyPromptOptions = {}): void {
  prompt = fn;
  promptOptions = fn ? opts : {};
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

/** Why the last `getSecretStorageKey` answered null: the prompt was cancelled, the typed key did not open the
 * prompted key, or there was nobody to ask (no prompt registered / no key offered). */
export type SecretStorageKeyMiss = 'cancelled' | 'wrong-key' | 'no-key';

let lastMiss: { seq: number; reason: SecretStorageKeyMiss | null } = { seq: 0, reason: null };

/**
 * The last time `getSecretStorageKey` answered null and why. `seq` grows on every miss: snapshot it before an SDK
 * call and compare afterwards to tell "the user cancelled the prompt" from any other failure without matching the
 * SDK's error text ("getSecretStorageKey callback returned falsey").
 */
export function lastSecretStorageKeyMiss(): { seq: number; reason: SecretStorageKeyMiss | null } {
  return lastMiss;
}

function miss(reason: SecretStorageKeyMiss): null {
  lastMiss = { seq: lastMiss.seq + 1, reason };
  return null;
}

/**
 * Pure core of getSecretStorageKey's cache lookup, exported for the unit test. Returns the `[keyId, key]` to
 * answer the SDK with, or null when no cached key opens any of the offered `keys`:
 *  1. a key cached under one of the offered ids (no check needed: only validated keys are cached);
 *  2. otherwise any cached key whose value opens one of the offered keys (`checkKey`, the MAC of 32 zero bytes),
 *     e.g. one recovery key registered twice under two ids. A throwing `checkKey` counts as "no match".
 */
export async function findCachedSecretStorageKey(
  keys: Record<string, SecretStorageKeyDescription>,
  cached: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  checkKey: (key: Uint8Array<ArrayBuffer>, info: SecretStorageKeyDescription) => Promise<boolean>,
): Promise<[string, Uint8Array<ArrayBuffer>] | null> {
  const offered = Object.keys(keys);
  for (const keyId of offered) {
    const key = cached.get(keyId);
    if (key) return [keyId, key];
  }
  for (const keyId of offered) {
    for (const key of cached.values()) {
      let ok = false;
      try {
        ok = await checkKey(key, keys[keyId]!);
      } catch {
        ok = false;
      }
      if (ok) return [keyId, key];
    }
  }
  return null;
}

/**
 * Does `key` open the secret storage key `info`? `client.secretStorage.checkKey` without the client: the MAC of
 * 32 zero bytes encrypted with `key` and the key's IV must equal the stored `mac`. A key description without a MAC
 * cannot be checked: `strict` says "no" (value matching must never guess), otherwise "yes" (the SDK's own rule
 * for a typed key; the decrypt then tells).
 */
export async function secretStorageKeyMatches(key: Uint8Array<ArrayBuffer>, info: SecretStorageKeyDescription, strict = true): Promise<boolean> {
  if (info.algorithm !== SECRET_STORAGE_ALGORITHM_V1_AES) return false;
  if (!info.mac) return !strict;
  const { mac } = await calculateKeyCheck(key, info.iv);
  return trimPadding(info.mac) === trimPadding(mac);
}

function trimPadding(b64: string): string {
  return b64.replace(/=+$/, '');
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
 * The `cryptoCallbacks` passed to `createClient`. The SDK calls `getSecretStorageKey({ keys }, name)` for every
 * secret it reads or writes; the answer must be one of the offered `keys`. An account can have several secret
 * storage keys (another client re-created 4S, so the backup key sits under an older key id than the cross-signing
 * keys): a cached key is matched by id, then by value; only when nothing cached opens any offered key is the user
 * asked, for the default key if offered, with `name` and `differentKey` so the UI can say why. A typed key that
 * does not open the prompted key answers null (never cached under the wrong id).
 */
export const cryptoCallbacks: CryptoCallbacks = {
  async getSecretStorageKey({ keys }, name) {
    const hit = await findCachedSecretStorageKey(keys, cachedKeys, (key, info) => secretStorageKeyMatches(key, info));
    if (hit) {
      cachedKeys.set(hit[0], hit[1]);
      return hit;
    }
    const ids = Object.keys(keys);
    if (!prompt || !ids.length) return miss('no-key');
    const defaultKeyId = await promptOptions.defaultKeyId?.().catch(() => null);
    const keyId = defaultKeyId && keys[defaultKeyId] ? defaultKeyId : ids[0]!;
    const keyInfo = keys[keyId]!;
    const input = await prompt(keyInfo, keyId, { secretName: name || undefined, differentKey: cachedKeys.size > 0 });
    if (!input?.trim()) return miss('cancelled');
    const key = await resolveRecoveryInput(input, keyInfo);
    if (!key || !(await secretStorageKeyMatches(key, keyInfo, false).catch(() => false))) return miss('wrong-key');
    cachedKeys.set(keyId, key);
    return [keyId, key];
  },
  cacheSecretStorageKey(keyId, _keyInfo, key) {
    cachedKeys.set(keyId, key);
  },
};
