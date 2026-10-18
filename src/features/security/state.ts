/**
 * UI-only state of the security feature (Dev A): which dialog is open and which banner was dismissed.
 * Everything about the crypto itself lives in `useSecurityStore` (`@/store`); this store never mirrors it.
 */
import { create } from 'zustand';
import { useSecurityStore, type PendingPrompt, type RecoveryState, type SecurityState } from '@/store';

/** What `openSecurityDialog` opens: `setup` -> setup-dialog, `verify` -> verify-dialog, `unlock` -> recovery-dialog. */
export type SecurityDialogKind = 'setup' | 'verify' | 'unlock';

/** `security-banner[data-need]`. */
export type BannerNeed = 'setup' | 'verify' | 'unlock' | 'restoring';

interface SecurityUiState {
  open: SecurityDialogKind | null;
  /** Banners dismissed for this page load (per need: dismissing `verify` does not hide a later `unlock`). */
  dismissed: Partial<Record<BannerNeed, true>>;
  /**
   * A recovery-key prompt the user hid (X / Escape) without answering: SecurityDialogs does not pop the dialog
   * back up for this same prompt (a new prompt does); it stays pending and renders when the dialog is reopened
   * from the banner (`bannerNeed` says `unlock` while it waits). Compared by identity with the store's `prompt`.
   */
  hiddenPrompt: PendingPrompt | null;
  openDialog(kind: SecurityDialogKind): void;
  /** Close whatever dialog is open. Never answers a prompt: pass the pending one to keep it from re-opening. */
  closeDialog(hide?: PendingPrompt | null): void;
  dismiss(need: BannerNeed): void;
}

export const useSecurityUiStore = create<SecurityUiState>((set) => ({
  open: null,
  dismissed: {},
  hiddenPrompt: null,
  openDialog: (kind) => set({ open: kind }),
  closeDialog: (hide) => set(hide ? { open: null, hiddenPrompt: hide } : { open: null }),
  dismiss: (need) => set((s) => ({ dismissed: { ...s.dismissed, [need]: true } })),
}));

/**
 * Open a security dialog from anywhere (banner, Dev B's undecryptable-row actions). Opening `verify` drops a
 * finished flow first so the dialog starts at `choose`.
 */
export function openSecurityDialog(kind: SecurityDialogKind): void {
  if (kind === 'verify') {
    const security = useSecurityStore.getState();
    const stage = security.verification?.stage;
    if (stage === 'done' || stage === 'cancelled') security.dismissVerification();
  }
  useSecurityUiStore.getState().openDialog(kind);
}

/**
 * The banner's need: the store's `hint`, except `restoring` wins while keys arrive from the backup and `unlock`
 * while a recovery-key prompt waits for an answer (the user hid the dialog). (AC-E5-5, a
 * recovery key without cross-signing -> `unlock`, is the store's `securityHint` rule.)
 */
export function bannerNeed(s: SecurityState): BannerNeed | null {
  if (!s.cryptoReady) return null;
  // A recovery-key prompt left pending (dialog hidden mid-unlock): the banner is the way back to it.
  if (s.prompt?.kind === 'recovery-key') return 'unlock';
  if (s.recovery.busy === 'restore' || (s.recovery.busy === 'unlock' && s.recovery.progress)) return 'restoring';
  return s.hint;
}

/** A recovery key as Element shows it: groups of 4 separated by single spaces. */
export function formatRecoveryKey(key: string): string {
  return (key.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/** `recovery-error` copy (AC-E5-3) from the store's `recovery.errorKind`; other failures (network, backup) get a generic line. */
export function recoveryErrorText(recovery: Pick<RecoveryState, 'error' | 'errorKind'>): string | null {
  switch (recovery.errorKind) {
    case 'wrong':
      return 'That recovery key is not correct';
    case 'invalid':
      return 'Not a recovery key';
    case 'none':
      return 'This account has no recovery key yet. Verify with another device, or set up encryption';
    default:
      return recovery.error ? 'Could not unlock right now. Check your connection and try again' : null;
  }
}
