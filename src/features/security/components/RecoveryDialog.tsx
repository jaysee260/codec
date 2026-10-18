/**
 * DEV-A-26 unlock with the recovery key (or passphrase): one `recovery-input` (monospace, spaces and paste are
 * fine), `recovery-submit` -> `unlockWithRecoveryKey(input)`, which verifies this session from secret storage
 * and restores the key backup. While it runs, `recovery-progress[data-restored][data-total]` climbs; on success
 * `recovery-done`; a wrong key shows `recovery-error` and keeps the dialog open for another try (AC-E5-2/3).
 *
 * Phases (`data-phase`), first match wins, all derived from the store so a dialog hidden mid-flow and reopened
 * from the banner lands in the right one:
 *   auth / prompt  a pending store prompt, busy or not: `recovery-key` -> `prompt` (the SDK needs a secret storage
 *                  key, e.g. the backup's key sits under a second, non-default 4S key; the text says so when the
 *                  key already entered is a different one), password / SSO -> `auth` (`recovery-password`, ...).
 *                  `recovery-submit` answers it, `recovery-prompt-cancel` (Cancel) answers null.
 *   working        unlock / restore running (progress), or a backup reset from `locked` (`busy === 'setup'`)
 *   locked         verified, but the key backup stayed locked (`recovery.backupLocked`): `recovery-locked` says why,
 *                  `recovery-retry` restores again (prompts for the backup's key), `recovery-reset-backup` resets
 *                  cross-signing + secret storage + backup (`setupRecovery({ reset: true })`; the new key then
 *                  shows in the setup dialog), Done closes
 *   done / missing / form
 * Hide (`dialog-close` while working), X (`recovery-close`) and Escape only close the dialog: the operation and
 * any pending prompt stay alive (SecurityDialogs re-opens it for the next prompt; a hidden recovery-key prompt
 * waits behind the banner's Unlock). Cancelling a prompt is only ever the explicit Cancel button.
 * The typed key only lives in component state and is cleared on success / unmount (never persisted).
 * testids: recovery-dialog (+data-phase), recovery-input, recovery-submit, recovery-prompt-cancel, recovery-error,
 *          recovery-progress, recovery-done, recovery-locked, recovery-retry, recovery-reset-backup, recovery-close
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useSecurityStore, type RecoveryState } from '@/store';
import { Dialog } from '@/features/navigation';
import { openSecurityDialog, recoveryErrorText, useSecurityUiStore } from '../state.ts';
import { PromptButtons, PromptFields, submitPrompt } from './PromptFields.tsx';
import styles from './security.module.css';

type RecoveryPhase = 'form' | 'prompt' | 'auth' | 'working' | 'locked' | 'done' | 'missing';

export function RecoveryDialog() {
  const recovery = useSecurityStore((s) => s.recovery);
  const prompt = useSecurityStore((s) => s.prompt);
  const hasSecretStorage = useSecurityStore((s) => s.status?.secretStorageReady !== false);
  const hint = useSecurityStore((s) => s.hint);
  const [input, setInput] = useState('');
  const [promptValue, setPromptValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const busy = recovery.busy === 'unlock' || recovery.busy === 'restore';
  /** A backup reset started from `locked` (until the new key takes over in the setup dialog). */
  const resetting = recovery.busy === 'setup' && !!recovery.backupLocked;

  // A restore that ran while the dialog was open (ours, or the automatic one after SAS) ends in `done`.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && !recovery.error && recovery.lastRestore) setDone(true);
    wasBusy.current = busy;
  }, [busy, recovery.error, recovery.lastRestore]);

  useEffect(() => setPromptValue(''), [prompt]);

  const phase: RecoveryPhase = prompt
    ? prompt.kind === 'recovery-key'
      ? 'prompt'
      : 'auth'
    : busy || resetting
      ? 'working'
      : recovery.backupLocked
        ? 'locked'
        : done
          ? 'done'
          : !hasSecretStorage
            ? 'missing'
            : 'form';

  /** Close only: never answers a prompt (a hidden recovery-key prompt does not pop the dialog back up by itself). */
  const close = (): void => {
    setInput('');
    useSecurityUiStore.getState().closeDialog(prompt?.kind === 'recovery-key' ? prompt : null);
  };

  const retryRestore = (): void => void useSecurityStore.getState().restoreFromBackup();

  const resetBackup = (): void => {
    // Stay on `unlock` (not `setup`) so this dialog shows the reset's progress, its UIA prompts and a failure;
    // SecurityDialogs hands over to the setup dialog as soon as the new recovery key exists.
    useSecurityUiStore.getState().openDialog('unlock');
    void useSecurityStore.getState().setupRecovery({ reset: true });
  };

  const submit = async (): Promise<void> => {
    const key = input.trim();
    if (!key || busy) return;
    setError(null);
    const ok = await useSecurityStore.getState().unlockWithRecoveryKey(key);
    if (ok) {
      setInput('');
      setDone(true);
    } else {
      setError(recoveryErrorText(useSecurityStore.getState().recovery) ?? 'Could not unlock right now. Try again');
    }
  };

  let title = 'Unlock your message history';
  let description: string | undefined = 'Enter the recovery key (or passphrase) you saved when you set up encryption, in Element or in codec.';
  let body: ReactNode;
  let footer: ReactNode;
  let onSubmit = (): void => void submit();

  const progress = recovery.progress;
  switch (phase) {
    case 'auth':
    case 'prompt':
      description = undefined;
      body = <PromptFields prompt={prompt!} prefix="recovery" value={promptValue} onChange={setPromptValue} />;
      if (phase === 'prompt') {
        // The SDK wants the key itself: reuse the main input so tests and users see one field.
        body = (
          <>
            <p className={styles.text} data-different-key={prompt!.differentKey ? 'true' : undefined}>
              {prompt!.message}
            </p>
            <KeyInput value={promptValue} onChange={setPromptValue} />
          </>
        );
      }
      footer = <PromptButtons prompt={prompt!} prefix="recovery" value={promptValue} />;
      if (phase === 'prompt') {
        footer = (
          <>
            <button type="button" className="u-btn u-btn--ghost" data-testid="recovery-prompt-cancel" onClick={() => useSecurityStore.getState().answerPrompt(null)}>
              Cancel
            </button>
            <button type="submit" className="u-btn" data-testid="recovery-submit" disabled={!promptValue.trim()}>
              Continue
            </button>
          </>
        );
      }
      onSubmit = () => submitPrompt(prompt!, promptValue);
      break;

    case 'working': {
      const total = progress?.total ?? 0;
      const imported = progress?.imported ?? 0;
      description = undefined;
      title = resetting ? 'Resetting backup...' : recovery.busy === 'unlock' && total === 0 ? 'Unlocking...' : 'Restoring keys...';
      body = (
        <div className={styles.progress} data-testid="recovery-progress" data-restored={imported} data-total={total} role="status">
          <p className={styles.text}>
            {resetting
              ? 'Creating a new recovery key and key backup...'
              : total > 0
                ? `Restoring ${imported} of ${total} keys`
                : recovery.busy === 'unlock'
                  ? 'Checking your recovery key...'
                  : 'Fetching keys from the backup...'}
          </p>
          <span className={styles.progressBar} aria-hidden="true">
            {total > 0 ? (
              <span className={styles.progressFill} style={{ width: `${Math.min(100, Math.round((imported / total) * 100))}%` }} />
            ) : (
              <span className={`${styles.progressFill} ${styles.progressFillIndeterminate}`} />
            )}
          </span>
          <p className={styles.muted}>You can keep chatting: older messages unlock as their keys arrive.</p>
        </div>
      );
      footer = (
        <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
          Hide
        </button>
      );
      onSubmit = () => {};
      break;
    }

    case 'locked': {
      const reason = recovery.backupLocked!.reason;
      title = 'Session verified';
      description = undefined;
      body = (
        <div className={styles.center}>
          <span className={`${styles.badge} ${styles.badgeOk}`}>
            <ShieldCheck size={30} aria-hidden="true" />
          </span>
          <p className={styles.text} data-testid="recovery-locked" data-reason={reason}>
            {LOCKED_TEXT[reason]}
          </p>
          <p className={styles.muted}>
            {reason === 'failed'
              ? 'Try again in a moment. New messages are readable already.'
              : 'Enter that other recovery key to restore them, or reset the backup: new messages stay readable, older ones stay locked for good.'}
          </p>
        </div>
      );
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="recovery-reset-backup" onClick={resetBackup}>
            Reset backup
          </button>
          <button type="button" className="u-btn u-btn--ghost" data-testid="recovery-retry" onClick={retryRestore}>
            {reason === 'failed' ? 'Try again' : 'Enter other key'}
          </button>
          <button type="submit" className="u-btn" data-testid="dialog-close">
            Done
          </button>
        </>
      );
      onSubmit = close;
      break;
    }

    case 'done': {
      const last = recovery.lastRestore;
      title = 'Unlocked';
      description = undefined;
      body = (
        <div className={styles.center}>
          <span className={`${styles.badge} ${styles.badgeOk}`}>
            <ShieldCheck size={30} aria-hidden="true" />
          </span>
          <p className={styles.text} data-testid="recovery-done">
            {last && last.total > 0 ? `Restored ${last.imported} of ${last.total} keys` : 'Your message history is unlocked'}
          </p>
          <p className={styles.muted}>This session is verified and can read your encrypted messages.</p>
        </div>
      );
      footer = (
        <button type="submit" className="u-btn" data-testid="dialog-close">
          Done
        </button>
      );
      onSubmit = close;
      break;
    }

    case 'missing':
      title = 'No recovery key yet';
      description = undefined;
      body = (
        <p className={styles.text}>
          This account has no recovery key. {hint === 'setup' ? 'Set up encryption to create one.' : 'Verify this session with another device instead.'}
        </p>
      );
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
            Close
          </button>
          <button type="submit" className="u-btn" data-testid="recovery-switch">
            {hint === 'setup' ? 'Set up encryption' : 'Verify with a device'}
          </button>
        </>
      );
      onSubmit = () => openSecurityDialog(hint === 'setup' ? 'setup' : 'verify');
      break;

    default:
      body = (
        <KeyInput
          value={input}
          onChange={(next) => {
            setInput(next);
            if (error) setError(null);
          }}
        />
      );
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="u-btn" data-testid="recovery-submit" disabled={!input.trim()}>
            Unlock
          </button>
        </>
      );
  }

  return (
    <Dialog
      testId="recovery-dialog"
      title={title}
      description={description}
      error={phase === 'form' ? error : phase === 'locked' ? lockedError(recovery.error) : null}
      errorTestId="recovery-error"
      onSubmit={onSubmit}
      onClose={close}
      footer={footer}
      closeTestId="recovery-close"
      closeOnBack
      dataAttrs={{ 'data-phase': phase }}
    >
      {body}
    </Dialog>
  );
}

/** `recovery-locked` copy per `RestoreFailureReason` (the contract sentence for cancelled / wrong-key). */
const LOCKED_TEXT: Record<NonNullable<RecoveryState['backupLocked']>['reason'], string> = {
  cancelled: 'Session verified. Older messages stay locked: the key backup is protected by a different recovery key',
  'wrong-key': 'Session verified. Older messages stay locked: the key backup is protected by a different recovery key',
  'no-key': 'Session verified. Older messages stay locked: the key backup key is not stored with your recovery key',
  failed: 'Session verified. Older messages could not be restored from the key backup right now',
};

/** A failed retry / reset while `locked` (a cancelled password prompt is not an error worth showing). */
function lockedError(error: string | null): string | null {
  if (!error || /cancelled/i.test(error)) return null;
  return error;
}

function KeyInput({ value, onChange }: { value: string; onChange(next: string): void }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        <KeyRound size={12} aria-hidden="true" /> Recovery key or passphrase
      </span>
      <input
        className={`u-input ${styles.keyInput}`}
        data-testid="recovery-input"
        value={value}
        placeholder="EsTc 1234 abcd ..."
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
