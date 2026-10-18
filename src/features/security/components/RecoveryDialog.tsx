/**
 * DEV-A-26 unlock with the recovery key (or passphrase): one `recovery-input` (monospace, spaces and paste are
 * fine), `recovery-submit` -> `unlockWithRecoveryKey(input)`, which verifies this session from secret storage
 * and restores the key backup. While it runs, `recovery-progress[data-restored][data-total]` climbs; on success
 * `recovery-done`; a wrong key shows `recovery-error` and keeps the dialog open for another try (AC-E5-2/3).
 *
 * Also used when:
 *  - the SDK asks for the secret storage key mid-flow (`prompt.kind === 'recovery-key'`): submit answers the prompt;
 *  - a UIA prompt (password / SSO) arrives during the unlock: rendered inline (`recovery-password`, ...);
 *  - a restore runs by itself (after emoji verification handed us the backup key): progress, then done.
 * The typed key only lives in component state and is cleared on success / unmount (never persisted).
 * testids: recovery-dialog (+data-phase), recovery-input, recovery-submit, recovery-error, recovery-progress, recovery-done, recovery-close
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useSecurityStore } from '@/store';
import { Dialog } from '@/features/navigation';
import { openSecurityDialog, recoveryErrorText, useSecurityUiStore } from '../state.ts';
import { PromptButtons, PromptFields, submitPrompt } from './PromptFields.tsx';
import styles from './security.module.css';

type RecoveryPhase = 'form' | 'prompt' | 'auth' | 'working' | 'done' | 'missing';

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

  // A restore that ran while the dialog was open (ours, or the automatic one after SAS) ends in `done`.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && !recovery.error && recovery.lastRestore) setDone(true);
    wasBusy.current = busy;
  }, [busy, recovery.error, recovery.lastRestore]);

  useEffect(() => setPromptValue(''), [prompt]);

  const phase: RecoveryPhase =
    prompt && prompt.kind !== 'recovery-key'
      ? 'auth'
      : prompt?.kind === 'recovery-key' && !busy
        ? 'prompt'
        : busy
          ? 'working'
          : done
            ? 'done'
            : !hasSecretStorage
              ? 'missing'
              : 'form';

  const close = (): void => {
    if (prompt) useSecurityStore.getState().answerPrompt(null);
    setInput('');
    useSecurityUiStore.getState().closeDialog();
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
            <p className={styles.text}>{prompt!.message}</p>
            <KeyInput value={promptValue} onChange={setPromptValue} />
          </>
        );
      }
      footer = <PromptButtons prompt={prompt!} prefix="recovery" value={promptValue} />;
      if (phase === 'prompt') {
        footer = (
          <>
            <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
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
      title = recovery.busy === 'unlock' && total === 0 ? 'Unlocking...' : 'Restoring keys...';
      body = (
        <div className={styles.progress} data-testid="recovery-progress" data-restored={imported} data-total={total} role="status">
          <p className={styles.text}>
            {total > 0 ? `Restoring ${imported} of ${total} keys` : recovery.busy === 'unlock' ? 'Checking your recovery key...' : 'Fetching keys from the backup...'}
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
      error={phase === 'form' ? error : null}
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
