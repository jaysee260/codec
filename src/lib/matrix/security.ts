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
import { MatrixError, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import type { IAuthData, UIAFlow, UIAuthCallback } from 'matrix-js-sdk';
import {
  CryptoEvent,
  DecryptionKeyDoesNotMatchError,
  type CryptoApi,
  type EventEncryptionInfo,
  type GeneratedSecretStorageKey,
  type ImportRoomKeyProgressData,
  type KeyBackupRestoreResult,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { VerificationRequest, Verifier } from 'matrix-js-sdk/lib/crypto-api/verification.js';
import { getClient, getClientOrNull } from './client.ts';
import { cacheSecretStorageKey, lastSecretStorageKeyMiss, resolveRecoveryInput } from './crypto.ts';

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
}

/** One snapshot of this device's trust and backup state (several SDK calls; the store caches it). */
export async function getOwnDeviceStatus(): Promise<OwnDeviceStatus> {
  const { client, crypto } = requireCrypto();
  const userId = client.getSafeUserId();
  const deviceId = client.getDeviceId() ?? '';
  const [device, hasCrossSigningKeys, crossSigningReady, defaultKeyId, backup] = await Promise.all([
    crypto.getDeviceVerificationStatus(userId, deviceId),
    crypto.userHasCrossSigningKeys(userId, false).catch(() => false),
    crypto.isCrossSigningReady().catch(() => false),
    client.secretStorage.getDefaultKeyId().catch(() => null),
    getKeyBackupSummary(),
  ]);
  return {
    deviceId,
    verified: !!device?.crossSigningVerified,
    hasCrossSigningKeys,
    crossSigningReady,
    secretStorageReady: !!defaultKeyId,
    defaultKeyId,
    backup,
  };
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
  constructor(
    readonly kind: 'none' | 'invalid' | 'wrong',
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
 * key may be encrypted under another 4S key whose prompt the user cancelled: the session is still verified).
 */
export async function unlockWithRecoveryKey(input: string, opts: { uia?: UiaOptions; onProgress?: (p: ImportRoomKeyProgressData) => void } = {}): Promise<UnlockResult> {
  const { crypto } = requireCrypto();
  await checkRecoveryKey(input);
  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: makeUiaCallback(opts.uia) });
  return { verified: true, ...(await attemptRestoreFromBackup(opts.onProgress)) };
}

/**
 * `restoreFromBackup`, classified instead of thrown. A null answer of our `getSecretStorageKey` during the call
 * (`lastSecretStorageKeyMiss().seq` moved) says cancelled / wrong key / nobody to ask; otherwise the SDK's error
 * type / the missing-secret case; everything else is `failed`.
 */
export async function attemptRestoreFromBackup(onProgress?: (p: ImportRoomKeyProgressData) => void): Promise<RestoreAttempt> {
  const before = lastSecretStorageKeyMiss().seq;
  try {
    return { restore: await restoreFromBackup(onProgress) };
  } catch (e) {
    const miss = lastSecretStorageKeyMiss();
    const message = e instanceof Error ? e.message : String(e);
    let reason: RestoreFailureReason = 'failed';
    if (miss.seq !== before && miss.reason) reason = miss.reason;
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
  const { crypto } = requireCrypto();
  const info = await crypto.getKeyBackupInfo();
  if (!info) return { total: 0, imported: 0 };
  if (!(await crypto.getSessionBackupPrivateKey())) {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  }
  await crypto.checkKeyBackupAndEnable();
  return crypto.restoreKeyBackup(onProgress ? { progressCallback: onProgress } : undefined);
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
 * secret storage with a fresh recovery key, store the cross-signing keys in it, and create a key backup.
 * Returns the recovery key to show the user **once** (`encodedPrivateKey`, `EsTc ...` form).
 */
export async function setupRecovery(opts: SetupRecoveryOptions = {}): Promise<string> {
  const { crypto } = requireCrypto();
  await crypto.bootstrapCrossSigning({ setupNewCrossSigning: !!opts.reset, authUploadDeviceSigningKeys: makeUiaCallback(opts.uia) });
  let generated: GeneratedSecretStorageKey | undefined;
  const active = await crypto.getActiveSessionBackupVersion();
  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: !!opts.reset,
    setupNewKeyBackup: !!opts.reset || active === null,
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
