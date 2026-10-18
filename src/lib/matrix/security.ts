/**
 * Security API (Phase 5): thin wrappers over the SDK `CryptoApi` (`client.getCrypto()`) for device verification,
 * cross-signing / secret storage bootstrap, recovery keys and key backup. No React, no state: the Zustand store
 * `src/store/security.ts` drives these and holds what the UI renders. Every function resolves plainly or throws
 * an `Error` with a user-readable message; nothing here prompts the user (prompts are store concerns).
 *
 * Vocabulary (Element's): *verify this session* = cross-sign this device with the account's identity, either by
 * emoji SAS against another signed-in device or by entering the recovery key; *recovery key* = the secret storage
 * (4S) key that unlocks the cross-signing private keys and the key backup decryption key; *key backup* = the
 * server-side, recovery-key-encrypted copy of every Megolm session, which is how a new device reads old messages.
 */
import { ClientPrefix, MatrixError, Method, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import type { IAuthData, UIAFlow, UIAuthCallback } from 'matrix-js-sdk';
import {
  CryptoEvent,
  DecryptionKeyDoesNotMatchError,
  type CryptoApi,
  type EventEncryptionInfo,
  type GeneratedSecretStorageKey,
  type ImportRoomKeyProgressData,
  type KeyBackupInfo,
  type KeyBackupRestoreResult,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { VerificationRequest, Verifier } from 'matrix-js-sdk/lib/crypto-api/verification.js';
import { getClient, getClientOrNull } from './client.ts';
import { cacheSecretStorageKey, hasCachedSecretStorageKey, resolveRecoveryInput, SecretStorageKeyMissError } from './crypto.ts';
import { decryptMegolmKeyExport } from './key-export.ts';

/** `client.getCrypto()` or null when nobody is logged in or the engine failed to start (`getCryptoError()`). */
export function getCryptoApi(): CryptoApi | null {
  return getClientOrNull()?.getCrypto() ?? null;
}

/** True when the crypto engine runs for the current session. */
export function isCryptoReady(): boolean {
  return getCryptoApi() !== null;
}

function requireCrypto(): { client: MatrixClient; crypto: CryptoApi } {
  const client = getClient();
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Encryption is not available in this session');
  return { client, crypto };
}

/**
 * The server's current key backup, asked of the server now. `getKeyBackupInfo()` answers from the SDK's first check
 * on this page, so a backup another client made since then reads as "none"; it also turns a failed check into
 * `null`. Here `null` means the server said there is no backup, and a failed request throws.
 */
async function fetchServerBackupInfo(client: MatrixClient): Promise<KeyBackupInfo | null> {
  try {
    return await client.http.authedRequest<KeyBackupInfo>(Method.Get, '/room_keys/version', undefined, undefined, {
      prefix: ClientPrefix.V3,
    });
  } catch (e) {
    if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface KeyBackupSummary {
  /** Backup version on the server, or null when the account has no key backup. */
  version: string | null;
  /** The backup is signed by a trusted device / identity, or matches our decryption key. */
  trusted: boolean;
  /** This device holds the backup decryption key (it can restore and it uploads new keys). */
  keyCached: boolean;
  /** This device is actively backing up to `version` (`getActiveSessionBackupVersion`). */
  enabled: boolean;
}

export interface OwnDeviceStatus {
  /** The signed-in user (with `deviceId`: the key of per-device UI flags such as a dismissed banner). */
  userId: string;
  deviceId: string;
  /** This device is cross-signed by the account identity (what Element calls "verified"). */
  verified: boolean;
  /** The account has published cross-signing keys (so there is an identity to verify against / restore). */
  hasCrossSigningKeys: boolean;
  /** This device holds the cross-signing private keys (it can verify others and sign new devices). */
  crossSigningReady: boolean;
  /** Secret storage (a recovery key) exists on the account. */
  secretStorageReady: boolean;
  /** Id of the default secret storage key, or null when none is set up. */
  defaultKeyId: string | null;
  backup: KeyBackupSummary;
  /**
   * Other devices of this account verified by its identity (Codec or Element): they can share keys by emoji
   * verification and answer room key requests. Local device list, no request.
   */
  otherVerifiedDevices: number;
}

/** One snapshot of this device's trust and backup state (several SDK calls; the store caches it). */
export async function getOwnDeviceStatus(): Promise<OwnDeviceStatus> {
  const { client, crypto } = requireCrypto();
  const userId = client.getSafeUserId();
  const deviceId = client.getDeviceId() ?? '';
  const [device, hasCrossSigningKeys, crossSigningReady, defaultKeyId, backup, otherVerifiedDevices] = await Promise.all([
    crypto.getDeviceVerificationStatus(userId, deviceId),
    // Downloaded, not the local list (empty on a fresh device until its first key query): a guess of "no identity"
    // would offer setup to an account that has one. On failure assume one exists: never offer setup on a guess.
    crypto.userHasCrossSigningKeys(userId, true).catch(() => true),
    crypto.isCrossSigningReady().catch(() => false),
    client.secretStorage.getDefaultKeyId().catch(() => null),
    getKeyBackupSummary(),
    countOtherVerifiedDevices(crypto, userId, deviceId).catch(() => 0),
  ]);
  return {
    userId,
    deviceId,
    verified: !!device?.crossSigningVerified,
    hasCrossSigningKeys,
    crossSigningReady,
    secretStorageReady: !!defaultKeyId,
    defaultKeyId,
    backup,
    otherVerifiedDevices,
  };
}

/** Devices of `userId` other than `deviceId` that its identity signed (from the local device list). */
async function countOtherVerifiedDevices(crypto: CryptoApi, userId: string, deviceId: string): Promise<number> {
  const devices = (await crypto.getUserDeviceInfo([userId])).get(userId);
  let n = 0;
  for (const id of devices?.keys() ?? []) {
    if (id === deviceId) continue;
    const status = await crypto.getDeviceVerificationStatus(userId, id).catch(() => null);
    if (status?.crossSigningVerified) n += 1;
  }
  return n;
}

export async function getKeyBackupSummary(): Promise<KeyBackupSummary> {
  const { crypto } = requireCrypto();
  const [info, active, privateKey] = await Promise.all([
    crypto.getKeyBackupInfo().catch(() => null),
    crypto.getActiveSessionBackupVersion().catch(() => null),
    crypto.getSessionBackupPrivateKey().catch(() => null),
  ]);
  const trust = info ? await crypto.isKeyBackupTrusted(info).catch(() => null) : null;
  return {
    version: info?.version ?? null,
    trusted: !!trust && (trust.trusted || trust.matchesDecryptionKey),
    keyCached: !!privateKey,
    enabled: active !== null,
  };
}

/** Shield to show next to a decrypted event (`null` for unencrypted events or when crypto is off). */
export function getEventEncryptionInfo(event: MatrixEvent): Promise<EventEncryptionInfo | null> {
  const crypto = getCryptoApi();
  if (!crypto || !event.isEncrypted()) return Promise.resolve(null);
  return crypto.getEncryptionInfoForEvent(event).catch(() => null);
}

// ---------------------------------------------------------------------------
// Verification (emoji SAS)
// ---------------------------------------------------------------------------

/** Ask every other signed-in device of this account to verify this one (`m.key.verification.request` to-device). */
export function requestOwnUserVerification(): Promise<VerificationRequest> {
  return requireCrypto().crypto.requestOwnUserVerification();
}

/** Ask one specific device (ours or someone else's) to verify. */
export function requestDeviceVerification(userId: string, deviceId: string): Promise<VerificationRequest> {
  return requireCrypto().crypto.requestDeviceVerification(userId, deviceId);
}

/** Subscribe to incoming verification requests (from Element, another codec session, or another user). */
export function onVerificationRequestReceived(listener: (request: VerificationRequest) => void): () => void {
  const client = getClientOrNull();
  if (!client) return () => undefined;
  client.on(CryptoEvent.VerificationRequestReceived, listener);
  return () => client.off(CryptoEvent.VerificationRequestReceived, listener);
}

/** Start the emoji flow on a request in phase Ready. The store attaches `VerifierEvent.ShowSas` and calls `verify()`. */
export function startSas(request: VerificationRequest): Promise<Verifier> {
  return request.startVerification('m.sas.v1');
}

// ---------------------------------------------------------------------------
// User-interactive auth (uploading cross-signing keys)
// ---------------------------------------------------------------------------

/** Where to get a password when the server demands `m.login.password` for a UIA stage (null = user cancelled). */
export type PasswordPrompt = () => Promise<string | null>;

export interface UiaOptions {
  password?: PasswordPrompt;
  /**
   * SSO-only servers: called with the fallback URL right after the popup opened (or with `popupBlocked` when it
   * could not open). Resolve when the user says they finished; reject to cancel. The resubmit also happens by
   * itself when the popup posts `authDone` or closes, whichever comes first.
   */
  sso?: (url: string, popupBlocked: boolean) => Promise<void>;
}

/**
 * `authUploadDeviceSigningKeys` for `bootstrapCrossSigning`. Tries without auth first (spec v1.11 / Synapse 1.151:
 * the first upload needs no UIA, re-uploads do), then `m.login.password` through `opts.password`, then
 * `m.login.sso` by opening Synapse's fallback page in a popup and resubmitting once it posts `authDone`
 * (the SSO-only 704.chat path; least exercised, see ARCHITECTURE "Phase 5 gotchas").
 */
export function makeUiaCallback(opts: UiaOptions = {}): UIAuthCallback<void> {
  return async (makeRequest) => {
    try {
      await makeRequest(null);
      return;
    } catch (e) {
      if (!(e instanceof MatrixError) || e.httpStatus !== 401) throw e;
      const data = e.data as IAuthData;
      const flows = data.flows ?? [];
      const session = data.session;
      const stageOffered = (stage: string): boolean => flows.some((f: UIAFlow) => f.stages.length === 1 && f.stages[0] === stage);
      if (stageOffered('m.login.password') && opts.password) {
        const password = await opts.password();
        if (!password) throw new Error('Authentication cancelled');
        const user = getClient().getSafeUserId();
        await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, session });
        return;
      }
      if (stageOffered('m.login.sso') && session) {
        await ssoFallback(session, opts.sso);
        await makeRequest({ session });
        return;
      }
      throw new Error(`The server requires an authentication method this client does not support (${flows.map((f) => f.stages.join('+')).join(', ') || 'none offered'})`);
    }
  };
}

/** The `m.login.sso` UIA fallback page for a UIA session (Synapse serves it; it posts `authDone` to `window.opener`). */
export function ssoFallbackUrl(session: string): string {
  const base = getClient().baseUrl.replace(/\/+$/, '');
  return `${base}/_matrix/client/v3/auth/m.login.sso/fallback/web?session=${encodeURIComponent(session)}`;
}

/**
 * Open the fallback page in a popup and resolve when it reports completion, is closed, or the UI says the user
 * finished (`ui`); reject when the UI cancels.
 */
function ssoFallback(session: string, ui?: (url: string, popupBlocked: boolean) => Promise<void>): Promise<void> {
  const url = ssoFallbackUrl(session);
  const popup = window.open(url, 'matrix-poc-uia', 'width=600,height=720');
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.data === 'authDone') done();
    };
    const timer = setInterval(() => {
      if (popup && popup.closed) done(); // the user may have finished and closed it; the resubmit tells us
    }, 500);
    window.addEventListener('message', onMessage);
    if (ui) {
      ui(url, !popup).then(done, (e: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e instanceof Error ? e : new Error('Authentication cancelled'));
      });
    } else if (!popup) {
      settled = true;
      cleanup();
      reject(new Error(`Popup blocked. Open ${url} in a new tab, then try again`));
    }
  });
}

/** Thrown by `checkRecoveryKey` / `unlockWithRecoveryKey`: `kind` says what went wrong, `message` is user text. */
export class RecoveryKeyError extends Error {
  /**
   * `none` = the account has no recovery key, `invalid` = not a recovery key / passphrase shape, `wrong` = does not
   * open the default secret storage key, `unusable` = it does, but the identity (cross-signing) keys are not stored
   * under it (missing from secret storage, or only under an old key), so it cannot verify this device: use emoji
   * verification from another device instead.
   */
  constructor(
    readonly kind: 'none' | 'invalid' | 'wrong' | 'unusable',
    message: string,
  ) {
    super(message);
    this.name = 'RecoveryKeyError';
  }
}

// ---------------------------------------------------------------------------
// Recovery key / secret storage / key backup
// ---------------------------------------------------------------------------

export interface RecoveryKeyCheck {
  keyId: string;
  key: Uint8Array<ArrayBuffer>;
}

/**
 * Validate a typed recovery key or passphrase against the account's default secret storage key and cache it for
 * the session. Throws with a user-readable message ("No recovery key is set up", "Incorrect recovery key").
 */
export async function checkRecoveryKey(input: string): Promise<RecoveryKeyCheck> {
  const { client } = requireCrypto();
  const tuple = await client.secretStorage.getKey();
  if (!tuple) throw new RecoveryKeyError('none', 'No recovery key is set up on this account yet');
  const [keyId, keyInfo] = tuple;
  const key = await resolveRecoveryInput(input, keyInfo);
  if (!key) {
    throw new RecoveryKeyError('invalid', keyInfo.passphrase ? 'That is not a valid recovery key or passphrase' : 'That is not a valid recovery key');
  }
  if (!(await client.secretStorage.checkKey(key, keyInfo))) throw new RecoveryKeyError('wrong', 'Incorrect recovery key');
  cacheSecretStorageKey(keyId, key);
  return { keyId, key };
}

/**
 * Why the backup restore of an otherwise successful unlock failed:
 *   cancelled  the SDK asked for another secret storage key (the backup key sits under a non-default 4S key) and
 *              the user cancelled the prompt;
 *   wrong-key  the key typed at that prompt does not open it, or the backup key in 4S does not match the backup;
 *   no-key     the backup decryption key is not in secret storage (or nobody could be asked for its 4S key);
 *   failed     anything else (network, server): worth a retry.
 */
export type RestoreFailureReason = 'cancelled' | 'wrong-key' | 'no-key' | 'failed';

export interface UnlockResult {
  verified: true;
  /** Restore result, or null when it failed (see restoreError). {0,0} when the account has no backup. */
  restore: KeyBackupRestoreResult | null;
  restoreError?: { reason: RestoreFailureReason; message: string };
}

/** `restoreFromBackup` that never throws: the result, or why it failed (`RestoreFailureReason`). */
export type RestoreAttempt = Pick<UnlockResult, 'restore' | 'restoreError'>;

const UNUSABLE_KEY_TEXT = "This recovery key can't verify this device. Verify it from your other device instead.";
const SETUP_HAS_IDENTITY_TEXT = 'This account already has encryption set up elsewhere. Verify this device from your other device instead.';

const RESTORE_FAILURE_TEXT: Record<Exclude<RestoreFailureReason, 'failed'>, string> = {
  cancelled: 'The key backup is protected by a different recovery key, and it was not entered',
  'wrong-key': 'The key backup is protected by a different recovery key',
  'no-key': 'The key backup decryption key is not stored with your recovery key',
};

/**
 * Unlock with an existing recovery key: validates and caches it, imports the cross-signing private keys from
 * secret storage (which signs this device: it becomes verified), then, best effort, loads the backup key and
 * restores old room keys. Verification is the success condition: errors of `checkRecoveryKey` (RecoveryKeyError)
 * and `bootstrapCrossSigning` throw; a failed restore resolves with `restore: null` and `restoreError` (the backup
 * key may be encrypted under another 4S key, which is never asked for here: the session is still verified).
 *
 * Nothing destructive on the way in: when the account has an identity but its private keys are neither on this
 * device nor in secret storage under the default key, `bootstrapCrossSigning` would either fail ("Content is not
 * encrypted!", or a secret under a key nobody is asked for) or, with the secrets missing altogether, create a new
 * identity. So that case throws `RecoveryKeyError('unusable')` up front ("verify from your other device"), and any
 * such SDK failure is mapped to it. No silent retry. A device that is already verified (emoji) skips the identity
 * step entirely and goes straight to the restore: its identity secrets may sit under an old key, which is fine.
 */
export async function unlockWithRecoveryKey(input: string, opts: { uia?: UiaOptions; onProgress?: (p: ImportRoomKeyProgressData) => void } = {}): Promise<UnlockResult> {
  const { client, crypto } = requireCrypto();
  await checkRecoveryKey(input);
  // Already verified (e.g. by emoji): nothing to restore identity-wise, whatever key the identity secrets sit under.
  const own = await crypto.getDeviceVerificationStatus(client.getSafeUserId(), client.getDeviceId() ?? '').catch(() => null);
  if (own?.crossSigningVerified) return { verified: true, ...(await attemptRestoreFromBackup(opts.onProgress)) };
  await assertIdentityRecoverable(crypto, UNUSABLE_KEY_TEXT);
  try {
    await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: makeUiaCallback(opts.uia) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof SecretStorageKeyMissError || /Content is not encrypted|none of the keys it is encrypted with/i.test(message)) {
      console.warn('[security] recovery key cannot restore the identity keys', e);
      throw new RecoveryKeyError('unusable', UNUSABLE_KEY_TEXT);
    }
    throw e;
  }
  return { verified: true, ...(await attemptRestoreFromBackup(opts.onProgress)) };
}

/**
 * Refuse to let `bootstrapCrossSigning` run when it could only fail or replace the account's identity: the identity
 * exists (asked from the server, not just the local device list, which is empty on a fresh device until its first
 * key query) but its private keys are neither on this device nor in secret storage under the default key. Throws
 * `RecoveryKeyError('unusable', message)`. Without this, `bootstrapCrossSigning({ setupNewCrossSigning: false })`
 * throws "Content is not encrypted!" or, with the secrets missing altogether, silently calls `resetCrossSigning`
 * (CrossSigningIdentity.js:86-88): a new identity on the way in.
 */
export async function assertIdentityRecoverable(crypto: CryptoApi, message: string): Promise<IdentityKeysState> {
  const state = await identityKeysState(crypto);
  if (state.identityExists && !state.localKeys && !state.inSecretStorage) throw new RecoveryKeyError('unusable', message);
  return state;
}

export interface IdentityKeysState {
  /** The account has published cross-signing keys (downloaded: `userHasCrossSigningKeys(userId, true)`). */
  identityExists: boolean;
  /** This device holds all three cross-signing private keys. */
  localKeys: boolean;
  /** All three are in secret storage under the default key. */
  inSecretStorage: boolean;
}

async function identityKeysState(crypto: CryptoApi): Promise<IdentityKeysState> {
  const [identityExists, cs] = await Promise.all([crypto.userHasCrossSigningKeys(undefined, true), crypto.getCrossSigningStatus()]);
  const local = cs.privateKeysCachedLocally;
  return { identityExists, localKeys: local.masterKey && local.selfSigningKey && local.userSigningKey, inSecretStorage: cs.privateKeysInSecretStorage };
}

/**
 * `restoreFromBackup`, classified instead of thrown. Our `getSecretStorageKey` throwing `SecretStorageKeyMissError`
 * (the SDK passes it through) says cancelled / wrong key / nobody to ask; otherwise the SDK's error type / the
 * missing-secret case; everything else is `failed`.
 */
export async function attemptRestoreFromBackup(onProgress?: (p: ImportRoomKeyProgressData) => void): Promise<RestoreAttempt> {
  try {
    return { restore: await restoreFromBackup(onProgress) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let reason: RestoreFailureReason = 'failed';
    if (e instanceof SecretStorageKeyMissError) reason = e.reason;
    else if (e instanceof DecryptionKeyDoesNotMatchError) reason = 'wrong-key';
    else if (/missing decryption key in secret storage/i.test(message)) reason = 'no-key';
    console.warn('[security] backup restore failed:', reason, e);
    return { restore: null, restoreError: { reason, message: reason === 'failed' ? message : RESTORE_FAILURE_TEXT[reason] } };
  }
}

/**
 * Pull every room key from the server-side key backup into this device. Needs the backup decryption key: already
 * cached (gossiped by the device that verified us), else loaded from secret storage (needs the recovery key
 * cached by `checkRecoveryKey`). Resolves `{ total: 0, imported: 0 }` when there is no backup.
 */
export async function restoreFromBackup(onProgress?: (p: ImportRoomKeyProgressData) => void): Promise<KeyBackupRestoreResult> {
  const { client, crypto } = requireCrypto();
  // The server's backup now, not the SDK's first answer on this page: another client (Element's "Change recovery
  // key", key storage toggle) may have replaced it since. A failed request throws: a failed restore, not "no backup".
  const info = await fetchServerBackupInfo(client);
  if (!info?.version) return { total: 0, imported: 0 };
  // Bring the SDK's copy up to date: loading the key from secret storage checks it against that copy.
  await crypto.checkKeyBackupAndEnable();
  const cached = await crypto.isKeyBackupTrusted(info).catch(() => null);
  if (!cached?.matchesDecryptionKey) {
    // No cached key, or one for a backup that has since been replaced: restoring with it would ask for a version
    // that no longer exists.
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  }
  await crypto.checkKeyBackupAndEnable();
  return crypto.restoreKeyBackup(onProgress ? { progressCallback: onProgress } : undefined);
}

export interface KeyImportResult {
  /** Sessions the engine accepted (new or better than what it had). */
  imported: number;
  /** Sessions in the file. */
  total: number;
}

/**
 * Import an Element key export (Settings > Encryption > Advanced > Export keys): decrypt it with the
 * passphrase (key-export.ts; throws `KeyExportError` kind `passphrase` / `format`) and hand the sessions to the
 * engine (`importRoomKeysAsJson`, progress as `load_keys` like a backup restore). The engine retries decrypting
 * the timeline's undecryptable events as the keys land. The way into history when the key backup is locked under
 * a lost secret storage key and no device gossips the backup key. Then `checkKeyBackupAndEnable()` so the imported
 * sessions are uploaded to the current backup. Nothing is persisted besides the room keys.
 */
export async function importRoomKeysFromFile(
  fileText: string,
  passphrase: string,
  onProgress?: (p: ImportRoomKeyProgressData) => void,
): Promise<KeyImportResult> {
  const { crypto } = requireCrypto();
  const json = await decryptMegolmKeyExport(fileText, passphrase);
  const total = (JSON.parse(json) as unknown[]).length;
  // Rust reports load_keys progress *before* each key, so `successes` peaks at total - 1, and the JS SDK drops
  // Rust's final RoomKeyImportResult. The import resolves only once every key is processed, so count them all.
  await crypto.importRoomKeysAsJson(json, { progressCallback: onProgress });
  const imported = total;
  // Upload the imported sessions to the current backup (it only needs the backup's public key, which we trust
  // through our identity): without this they would sit on this device only.
  await crypto.checkKeyBackupAndEnable().catch((e: unknown) => console.warn('[security] enabling key backup after import failed', e));
  return { imported, total };
}

// ---------------------------------------------------------------------------
// Key storage self-heal / backup reachability
// ---------------------------------------------------------------------------

/** Secrets `syncSecretsToDefaultKey` re-stored: the three cross-signing keys (as one) and / or the backup key. */
export type HealedSecret = 'cross-signing' | 'm.megolm_backup.v1';

/**
 * Self-heal out-of-sync key storage, silently: when this device is verified, the account's *default* secret
 * storage key is cached (a successful unlock) and this device holds a secret locally (the cross-signing private
 * keys; the backup decryption key matching the current backup) that secret storage does not have under the
 * default key (another client re-created 4S and left it under an old key), re-store it under the default key so
 * the next device unlocks with the current recovery key alone.
 *
 * Done by `crypto.bootstrapSecretStorage({})` (rust-crypto.js:706-769): with an AES default key present it never
 * creates a key (no `createSecretStorageKey` is passed, so it would throw rather than create), re-stores the
 * cross-signing keys only when they are not all under the default key, and stores the backup key when the cached
 * one matches the current backup. `secretStorage.store` writes the secret under the default key only (the copy
 * under the old key is replaced: secret-storage.js:249-289). The default key is cached by id, so it never prompts.
 * Never resets, never creates keys. Resolves the secrets it re-stored ([] when nothing to do / not possible).
 */
export async function syncSecretsToDefaultKey(): Promise<HealedSecret[]> {
  const { client, crypto } = requireCrypto();
  const defaultKeyId = await client.secretStorage.getDefaultKeyId();
  if (!defaultKeyId || !hasCachedSecretStorageKey(defaultKeyId)) return [];
  const device = await crypto.getDeviceVerificationStatus(client.getSafeUserId(), client.getDeviceId() ?? '');
  if (!device?.crossSigningVerified) return [];
  // Refresh the SDK's cached backup info first: a backup made by another client since the page loaded counts too.
  await crypto.checkKeyBackupAndEnable().catch(() => null);
  const [cs, backupInfo, backupKey, backupStored] = await Promise.all([
    crypto.getCrossSigningStatus(),
    crypto.getKeyBackupInfo().catch(() => null),
    crypto.getSessionBackupPrivateKey().catch(() => null),
    client.secretStorage.isStored('m.megolm_backup.v1').catch(() => null),
  ]);
  const missing: HealedSecret[] = [];
  const local = cs.privateKeysCachedLocally;
  if (local.masterKey && local.selfSigningKey && local.userSigningKey && !cs.privateKeysInSecretStorage) missing.push('cross-signing');
  if (backupInfo?.version && backupKey && !(backupStored && defaultKeyId in backupStored)) {
    const trust = await crypto.isKeyBackupTrusted(backupInfo).catch(() => null);
    if (trust?.matchesDecryptionKey) missing.push('m.megolm_backup.v1');
  }
  if (!missing.length) return [];
  await crypto.bootstrapSecretStorage({});
  return missing;
}

/**
 * Can this account's key backup be opened with the *current* recovery key? True when there is no backup, or its
 * decryption key (`m.megolm_backup.v1`) is stored in secret storage under the default key; false when it only sits
 * under other (old) 4S keys or is not in secret storage at all. Reads cached account data (no request after the
 * first sync) and the server's current backup.
 */
export async function isBackupSecretOnDefaultKey(): Promise<boolean> {
  const { client, crypto } = requireCrypto();
  const info = await fetchServerBackupInfo(client).catch(() => crypto.getKeyBackupInfo().catch(() => null));
  if (!info?.version) return true;
  const [defaultKeyId, stored] = await Promise.all([
    client.secretStorage.getDefaultKeyId().catch(() => null),
    client.secretStorage.isStored('m.megolm_backup.v1').catch(() => null),
  ]);
  return !!defaultKeyId && !!stored && defaultKeyId in stored;
}

export interface SetupRecoveryOptions {
  /** Derive the recovery key from a passphrase as well (the user can type either later). */
  passphrase?: string;
  /** Replace existing cross-signing keys, secret storage and key backup (lost recovery key). */
  reset?: boolean;
  uia?: UiaOptions;
}

/**
 * First-time setup (or reset): create cross-signing keys for the account (this device signs itself), create
 * secret storage with a fresh recovery key, store the cross-signing keys in it, and create a key backup. Without
 * `reset` it never creates an identity over an existing one (`assertIdentityRecoverable`; an identity whose keys
 * this device lacks throws "A recovery key already exists..." or `RecoveryKeyError('unusable')`) and never
 * replaces an existing server backup.
 * Returns the recovery key to show the user **once** (`encodedPrivateKey`, `EsTc ...` form).
 */
export async function setupRecovery(opts: SetupRecoveryOptions = {}): Promise<string> {
  const { client, crypto } = requireCrypto();
  if (!opts.reset) {
    // Never a new identity or a replaced backup without `reset` (B1): an existing identity whose keys this device
    // lacks is unlocked or verified, not set up.
    const state = await assertIdentityRecoverable(crypto, SETUP_HAS_IDENTITY_TEXT);
    if (state.identityExists && !state.localKeys) throw new Error('A recovery key already exists for this account; enter it instead');
  }
  await crypto.bootstrapCrossSigning({ setupNewCrossSigning: !!opts.reset, authUploadDeviceSigningKeys: makeUiaCallback(opts.uia) });
  let generated: GeneratedSecretStorageKey | undefined;
  // Asked of the server now, never the SDK's cache: a backup another client made since this page loaded must not
  // read as "none" and be deleted below. A failed request throws rather than counting as "no backup".
  const serverBackup = opts.reset ? null : await fetchServerBackupInfo(client);
  // Also refresh the SDK's own copy, which bootstrapSecretStorage reads when it saves the backup key.
  await crypto.checkKeyBackupAndEnable().catch(() => null);
  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: !!opts.reset,
    // `setupNewKeyBackup` goes through `resetKeyBackup`, which deletes every server backup version: only on reset,
    // or when the server has no backup at all (not merely "this device is not backing up").
    setupNewKeyBackup: !!opts.reset || !serverBackup,
    createSecretStorageKey: async () => {
      generated = await crypto.createRecoveryKeyFromPassphrase(opts.passphrase || undefined);
      return generated;
    },
  });
  await crypto.checkKeyBackupAndEnable();
  if (!generated?.encodedPrivateKey) {
    // Secret storage already existed and was kept (no reset): nothing new to show.
    throw new Error('A recovery key already exists for this account; enter it instead, or reset');
  }
  return generated.encodedPrivateKey;
}
