/**
 * DEV-A-24 singleton host for the security dialogs, mounted once per page by the Shell in `security-dialogs-host`.
 * At most one dialog at a time, in this order:
 *
 *  1. verify-dialog    an incoming request (`verification && !initiatedByMe`) always wins (AC-E4-7), or `open === 'verify'`
 *  2. setup-dialog     a freshly made key not yet confirmed (`newRecoveryKey`; it is shown once even if the dialog was
 *                      closed while working), a setup in flight, or `open === 'setup'` on an account without secret storage
 *  3. recovery-dialog  `open === 'unlock'`, `open === 'setup'` on an account that already has secret storage (AC-E5-5),
 *                      or the SDK asking for the secret storage key with no dialog open (it re-opens by itself for
 *                      every new prompt, also after Hide; only a prompt the user hid with X / Escape stays hidden,
 *                      `useSecurityUiStore.hiddenPrompt`, until reopened from the banner)
 *  4. security-prompt-dialog  a password / SSO prompt with no dialog open (the user closed the dialog mid-flow)
 */
import { useSecurityStore } from '@/store';
import { useSecurityUiStore } from '../state.ts';
import { VerificationDialog } from './VerificationDialog.tsx';
import { RecoveryDialog } from './RecoveryDialog.tsx';
import { SetupEncryptionDialog } from './SetupEncryptionDialog.tsx';
import { PromptDialog } from './PromptDialog.tsx';

export function SecurityDialogs() {
  const open = useSecurityUiStore((s) => s.open);
  const incoming = useSecurityStore((s) => !!s.verification && !s.verification.initiatedByMe);
  const showKey = useSecurityStore((s) => s.newRecoveryKey !== null);
  const setupBusy = useSecurityStore((s) => s.recovery.busy === 'setup');
  const hasSecretStorage = useSecurityStore((s) => !!s.status?.secretStorageReady);
  const prompt = useSecurityStore((s) => s.prompt);
  const hiddenPrompt = useSecurityUiStore((s) => s.hiddenPrompt);
  const promptKind = prompt && prompt !== hiddenPrompt ? prompt.kind : null;

  if (incoming || open === 'verify') return <VerificationDialog />;
  if (showKey) return <SetupEncryptionDialog />;
  // Secret storage appears half-way through our own setup: keep the setup dialog while it runs.
  if (open === 'setup') return hasSecretStorage && !setupBusy ? <RecoveryDialog /> : <SetupEncryptionDialog />;
  if (open === 'unlock' || promptKind === 'recovery-key') return <RecoveryDialog />;
  if (promptKind) return <PromptDialog />;
  return null;
}
