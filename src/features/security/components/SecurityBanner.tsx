/**
 * DEV-A-24 security banner, mounted by the Shell in `security-banner-host` above `channel-header` (both layouts).
 * One banner at a time, from `bannerNeed()` (the store's `hint`, plus `restoring` while backup keys arrive):
 *
 *   setup     "Set up encryption for this account"   action "Set up"  -> setup-dialog
 *   verify    "Verify this session"                  action "Verify"  -> verify-dialog
 *   unlock    "Unlock your message history"          action "Unlock"  -> recovery-dialog
 *             (verified session: "Older messages are locked" / "Enter your recovery key or import keys from
 *             Element"; hidden for the rest of the session once keys were imported)
 *   unavailable "Older messages are locked" (one line)   action "Fix" -> recovery-dialog (E2: `locked` /
 *             `unavailable` phase). Its dismissal is remembered for this device across reloads (localStorage flag
 *             keyed by user + device id, a value only)
 *   restoring "Restoring keys..." + N of M           no action, no dismiss
 *
 * Dismiss hides that need for this page load only (`useSecurityUiStore.dismissed`), except while a recovery-key
 * prompt is pending: then `unlock` shows regardless (the way back to a prompt hidden with X).
 * testids: security-banner (+data-need), security-banner-action, security-banner-dismiss
 */
import { KeyRound, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import { useSecurityStore } from '@/store';
import {
  bannerNeed,
  isUnavailableDismissed,
  openSecurityDialog,
  rememberUnavailableDismissed,
  useSecurityUiStore,
  type BannerNeed,
  type SecurityDialogKind,
} from '../state.ts';
import styles from './SecurityBanner.module.css';

const COPY: Record<Exclude<BannerNeed, 'restoring'>, { text: string; action: string; dialog: SecurityDialogKind }> = {
  setup: { text: 'Set up encryption for this account', action: 'Set up', dialog: 'setup' },
  verify: { text: 'Verify this session', action: 'Verify', dialog: 'verify' },
  unlock: { text: 'Unlock your message history', action: 'Unlock', dialog: 'unlock' },
  unavailable: { text: 'Older messages are locked', action: 'Fix', dialog: 'unlock' },
};

/** `unlock` on a verified session (backup key not available): older messages, not the session, are locked. */
const LOCKED_HISTORY_COPY = {
  text: 'Older messages are locked',
  action: 'Unlock',
  dialog: 'unlock' as SecurityDialogKind,
  sub: 'Enter your recovery key or import keys from Element',
};

const SUBTEXT: Record<Exclude<BannerNeed, 'restoring'>, string> = {
  setup: 'Create a recovery key so you can read your messages on other devices.',
  verify: 'Confirm it is you with another device or your recovery key.',
  unlock: 'Enter your recovery key to read older encrypted messages.',
  unavailable: '',
};

export function SecurityBanner() {
  const need = useSecurityStore(bannerNeed);
  const dismissed = useSecurityUiStore((s) => (need ? !!s.dismissed[need] : false));
  const progress = useSecurityStore((s) => s.recovery.progress);
  // A pending recovery-key prompt (dialog hidden mid-unlock) overrides a dismissal: the banner is the only way
  // back to it, and the unlock waits on it.
  const promptPending = useSecurityStore((s) => s.prompt?.kind === 'recovery-key');
  const verified = useSecurityStore((s) => !!s.status?.verified);
  const userId = useSecurityStore((s) => s.status?.userId ?? null);
  const deviceId = useSecurityStore((s) => s.status?.deviceId ?? null);
  // Remembered per device across reloads (read on render: a value in localStorage, no subscription needed).
  const unavailableDismissed = need === 'unavailable' && !!userId && !!deviceId && isUnavailableDismissed(userId, deviceId);

  if (!need || ((dismissed || unavailableDismissed) && !promptPending)) return null;

  if (need === 'restoring') {
    const total = progress?.total ?? 0;
    const imported = progress?.imported ?? 0;
    return (
      <div className={`${styles.banner} ${styles.restoring}`} data-testid="security-banner" data-need="restoring" role="status">
        <LoaderCircle size={16} className={styles.spin} aria-hidden="true" />
        <span className={styles.text}>
          <span className={styles.title}>Restoring keys...</span>
          {total > 0 && (
            <span className={styles.sub}>
              {imported} of {total}
            </span>
          )}
        </span>
        {total > 0 && (
          <span className={styles.bar} aria-hidden="true">
            <span className={styles.barFill} style={{ width: `${Math.min(100, Math.round((imported / total) * 100))}%` }} />
          </span>
        )}
      </div>
    );
  }

  // Verified but the backup key is missing: the history is what is locked, and a key file is the other way in.
  const copy = need === 'unlock' && verified ? LOCKED_HISTORY_COPY : { ...COPY[need], sub: SUBTEXT[need] };
  const Icon = need === 'unlock' ? KeyRound : ShieldAlert;
  return (
    <div className={styles.banner} data-testid="security-banner" data-need={need} role="region" aria-label="Encryption">
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>
        <span className={styles.title}>{copy.text}</span>
        {copy.sub && <span className={styles.sub}>{copy.sub}</span>}
      </span>
      <button type="button" className={styles.action} data-testid="security-banner-action" onClick={() => openSecurityDialog(copy.dialog)}>
        {copy.action}
      </button>
      <button
        type="button"
        className={styles.dismiss}
        data-testid="security-banner-dismiss"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => {
          if (need === 'unavailable' && userId && deviceId) rememberUnavailableDismissed(userId, deviceId);
          useSecurityUiStore.getState().dismiss(need);
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
