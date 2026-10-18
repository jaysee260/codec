/**
 * UI-only state of the security feature (Dev A): which dialog is open and which banner was dismissed.
 * Everything about the crypto itself lives in `useSecurityStore` (`@/store`); this store never mirrors it.
 */
import { create } from 'zustand';
import { useSecurityStore, type SecurityState } from '@/store';

/** What `openSecurityDialog` opens: `setup` -> setup-dialog, `verify` -> verify-dialog, `unlock` -> recovery-dialog. */
export type SecurityDialogKind = 'setup' | 'verify' | 'unlock';

/** `security-banner[data-need]`. */
export type BannerNeed = 'setup' | 'verify' | 'unlock' | 'restoring';

interface SecurityUiState {
  open: SecurityDialogKind | null;
  /** Banners dismissed for this page load (per need: dismissing `verify` does not hide a later `unlock`). */
  dismissed: Partial<Record<BannerNeed, true>>;
  openDialog(kind: SecurityDialogKind): void;
  closeDialog(): void;
  dismiss(need: BannerNeed): void;
}

export const useSecurityUiStore = create<SecurityUiState>((set) => ({
  open: null,
  dismissed: {},
  openDialog: (kind) => set({ open: kind }),
  closeDialog: () => set({ open: null }),
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
 * The banner's need. `restoring` wins while keys arrive from the backup. AC-E5-5: an account that already has
 * secret storage (a recovery key made in Element) is never offered `setup`, it is offered `unlock` instead.
 */
export function bannerNeed(s: SecurityState): BannerNeed | null {
  if (!s.cryptoReady) return null;
  if (s.recovery.busy === 'restore' || (s.recovery.busy === 'unlock' && s.recovery.progress)) return 'restoring';
  if (s.hint === 'setup' && s.status?.secretStorageReady) return 'unlock';
  return s.hint;
}

/** A recovery key as Element shows it: groups of 4 separated by single spaces. */
export function formatRecoveryKey(key: string): string {
  return (key.replace(/\s+/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/** `recovery-error` copy (AC-E5-3) from the store's `recovery.error`. */
export function recoveryErrorText(message: string | null): string | null {
  if (!message) return null;
  if (/incorrect/i.test(message)) return 'That recovery key is not correct';
  if (/not a valid recovery key/i.test(message)) return 'Not a recovery key';
  return message;
}
