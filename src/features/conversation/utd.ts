/**
 * Undecryptable-row reasons (DEV-B-27, docs/PHASE5_ACCEPTANCE.md AC-E2-2 / AC-E2-3).
 *
 * `data-reason` comes from the SDK's `DecryptionFailureCode` (`getDecryptionState(event).code`), refined by
 * what the security store knows *now*: the code is computed once, when the decryption failed, so a restore that
 * is running (the unlock dialog, the automatic restore after a verification) shows `restoring` on every
 * historical row while keys arrive (AC-E5-7), and a "no backup" verdict reached before the backup info loaded
 * becomes `locked-backup` once the store sees a backup whose key is not cached.
 */
import type { DecryptionState } from '@/lib/matrix/utils.ts';
import type { OwnDeviceStatus } from '@/lib/matrix/security.ts';
import type { RecoveryState } from '@/store/hooks.ts';

export type UtdReason = 'locked-backup' | 'no-backup' | 'restoring' | 'unverified' | 'not-joined' | 'unknown';

/** Row copy per reason (AC-E2-3). */
export const UTD_COPY: Record<UtdReason, string> = {
  'locked-backup': 'Unlock with your recovery key to read older messages',
  'no-backup': "This session can't read older messages (no key backup)",
  restoring: 'Restoring from backup...',
  unverified: "The sender's device withheld the key. Verify this session.",
  'not-joined': 'Sent before you joined',
  unknown: 'Unable to decrypt',
};

/** The action link per reason; absent for the others (AC-E2-3). */
export const UTD_ACTION: Partial<Record<UtdReason, { label: string; dialog: 'unlock' | 'verify' }>> = {
  'locked-backup': { label: 'Unlock', dialog: 'unlock' },
  unverified: { label: 'Verify', dialog: 'verify' },
};

/** The ticket's code -> reason table, without any store refinement. */
export function reasonForCode(code: string | undefined): UtdReason {
  switch (code) {
    case 'HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED':
      return 'locked-backup';
    case 'HISTORICAL_MESSAGE_NO_KEY_BACKUP':
      return 'no-backup';
    case 'HISTORICAL_MESSAGE_WORKING_BACKUP':
      return 'restoring';
    case 'MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE':
    case 'UNSIGNED_SENDER_DEVICE':
    case 'UNKNOWN_SENDER_DEVICE':
    case 'SENDER_IDENTITY_PREVIOUSLY_VERIFIED':
      return 'unverified';
    case 'HISTORICAL_MESSAGE_USER_NOT_JOINED':
      return 'not-joined';
    default:
      return 'unknown';
  }
}

/** Codes a key-backup restore can fix (the "sent before this session existed" family). */
const BACKUP_CODES = new Set(['HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED', 'HISTORICAL_MESSAGE_NO_KEY_BACKUP', 'HISTORICAL_MESSAGE_WORKING_BACKUP']);

export function utdReason(
  decryption: Pick<DecryptionState, 'code'>,
  live: { status: OwnDeviceStatus | null; recovery: Pick<RecoveryState, 'busy'> },
): UtdReason {
  const code = decryption.code ? String(decryption.code) : undefined;
  const base = reasonForCode(code);
  if (!code || !BACKUP_CODES.has(code)) return base;
  // A restore is running: every row it may fix says so, whatever the code said at failure time.
  if (live.recovery.busy === 'unlock' || live.recovery.busy === 'restore') return 'restoring';
  const backup = live.status?.backup;
  if (base === 'no-backup' && backup?.version && !backup.keyCached) return 'locked-backup';
  return base;
}
