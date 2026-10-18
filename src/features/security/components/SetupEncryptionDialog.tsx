/**
 * DEV-A-26 first-time setup (an account with no cross-signing identity and no recovery key):
 *
 *   intro    what a recovery key is                       setup-start -> setupRecovery()
 *   auth     the server wants UIA: setup-password + setup-password-submit (`prompt.kind === 'password'`), or
 *            setup-sso-hint + "Done" on SSO-only servers (`prompt.kind === 'sso'`, the fallback popup).
 *            A failed password lands back here with setup-error; resubmitting retries and answers the next prompt.
 *   working  creating keys
 *   key      setup-key (the base58 key in groups of 4), setup-copy, setup-confirm ("I saved it": enabled after a
 *            copy or after 3 s) -> dismissRecoveryKey() and close (AC-E4-2)
 *   error    setup-error + Try again
 *
 * Never offers a new key on an account that already has secret storage (AC-E5-5): SecurityDialogs routes `setup`
 * to the recovery dialog then, and a "recovery key already exists" refusal switches there too.
 * While the key is on screen the dialog only closes through confirm (the key is shown once).
 * testids: setup-dialog (+data-phase), setup-start, setup-password, setup-password-submit, setup-sso-hint, setup-key,
 *          setup-copy, setup-confirm, setup-error, setup-close
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, LoaderCircle, ShieldCheck } from 'lucide-react';
import { showToast, useSecurityStore } from '@/store';
import { Dialog } from '@/features/navigation';
import { formatRecoveryKey, openSecurityDialog, useSecurityUiStore } from '../state.ts';
import { PasswordField, PromptButtons, PromptFields, submitPrompt } from './PromptFields.tsx';
import styles from './security.module.css';

type SetupPhase = 'intro' | 'auth' | 'working' | 'key' | 'error';

/** How long before "I saved it" unlocks without a copy. */
const CONFIRM_DELAY_MS = 3000;

function isAlreadySetUp(message: string | null): boolean {
  return !!message && /already exists/i.test(message);
}

function isCancelled(message: string | null): boolean {
  return !!message && /cancelled/i.test(message);
}

export function SetupEncryptionDialog() {
  const newKey = useSecurityStore((s) => s.newRecoveryKey);
  const prompt = useSecurityStore((s) => s.prompt);
  const busy = useSecurityStore((s) => s.recovery.busy === 'setup');
  const backupRemaining = useSecurityStore((s) => s.backupRemaining);
  const [error, setError] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [delayPassed, setDelayPassed] = useState(false);
  /** A password typed after a failed attempt: answers the next password prompt of the retry by itself. */
  const retryPassword = useRef<string | null>(null);
  /** The current attempt asked for a password (so a failure is a wrong password, back to `auth`). */
  const askedPassword = useRef(false);

  const phase: SetupPhase = newKey
    ? 'key'
    : prompt
      ? 'auth'
      : busy
        ? 'working'
        : authFailed
          ? 'auth'
          : error
            ? 'error'
            : 'intro';

  useEffect(() => {
    if (prompt?.kind === 'password') askedPassword.current = true;
    if (prompt?.kind === 'password' && retryPassword.current !== null) {
      const pw = retryPassword.current;
      retryPassword.current = null;
      useSecurityStore.getState().answerPrompt(pw);
    }
    setPassword('');
  }, [prompt]);

  useEffect(() => {
    if (!newKey) return;
    setCopied(false);
    setDelayPassed(false);
    const t = window.setTimeout(() => setDelayPassed(true), CONFIRM_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [newKey]);

  const start = async (): Promise<void> => {
    setError(null);
    setAuthFailed(false);
    askedPassword.current = false;
    const key = await useSecurityStore.getState().setupRecovery();
    if (key) return;
    const message = useSecurityStore.getState().recovery.error;
    retryPassword.current = null;
    if (isAlreadySetUp(message)) {
      openSecurityDialog('unlock');
      return;
    }
    if (isCancelled(message)) return; // back to intro, quietly
    if (askedPassword.current) {
      setAuthFailed(true);
      setError(/invalid|forbidden|password/i.test(message ?? '') ? 'That password is not correct' : message);
      return;
    }
    setError(message ?? 'Setup failed');
  };

  const confirm = (): void => {
    useSecurityStore.getState().dismissRecoveryKey();
    useSecurityUiStore.getState().closeDialog();
    showToast('Encryption is set up', 'success');
  };

  const canConfirm = copied || delayPassed;
  const close = (): void => {
    if (phase === 'key') {
      if (canConfirm) confirm(); // the key is shown once: closing counts as "I saved it" only once allowed
      return;
    }
    if (prompt) useSecurityStore.getState().answerPrompt(null);
    useSecurityUiStore.getState().closeDialog();
  };

  const copy = async (): Promise<void> => {
    if (!newKey) return;
    const text = formatRecoveryKey(newKey);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Insecure context / permission denied: select the key so the user can copy it by hand.
      const el = document.querySelector('[data-testid="setup-key"]');
      if (el) window.getSelection()?.selectAllChildren(el);
      setCopied(document.execCommand?.('copy') ?? false);
    }
  };

  let title = 'Set up encryption';
  let description: string | undefined;
  let body: ReactNode;
  let footer: ReactNode;
  let onSubmit = (): void => {};

  switch (phase) {
    case 'intro':
      body = (
        <>
          <p className={styles.text}>
            Your messages in encrypted rooms can only be read on your devices. A <strong>recovery key</strong> lets you read
            them on a new device or after signing out everywhere, and verifies your new sessions. You see it once: keep it in a
            password manager or somewhere safe.
          </p>
        </>
      );
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
            Not now
          </button>
          <button type="submit" className="u-btn" data-testid="setup-start">
            Set up
          </button>
        </>
      );
      onSubmit = () => void start();
      break;

    case 'auth':
      title = 'Confirm it is you';
      if (prompt) {
        body = <PromptFields prompt={prompt} prefix="setup" value={password} onChange={setPassword} />;
        footer = <PromptButtons prompt={prompt} prefix="setup" value={password} />;
        onSubmit = () => submitPrompt(prompt, password);
      } else {
        // Retry after a failed password: type it again, the retry answers the prompt by itself.
        body = (
          <>
            <p className={styles.text}>Confirm your password to publish your encryption keys</p>
            <PasswordField testId="setup-password" value={password} onChange={setPassword} />
          </>
        );
        footer = (
          <>
            <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="u-btn" data-testid="setup-password-submit" disabled={!password}>
              Continue
            </button>
          </>
        );
        onSubmit = () => {
          if (!password) return;
          retryPassword.current = password;
          setPassword('');
          void start();
        };
      }
      break;

    case 'working':
      body = (
        <div className={styles.center} role="status">
          <span className={styles.badge}>
            <LoaderCircle size={28} className={styles.spin} aria-hidden="true" />
          </span>
          <p className={styles.text}>Creating your keys...</p>
        </div>
      );
      footer = null;
      break;

    case 'key':
      title = 'Save your recovery key';
      description = 'Store it somewhere safe. You will not see it again.';
      body = (
        <>
          <p className={styles.keyBox} data-testid="setup-key">
            {formatRecoveryKey(newKey!)}
          </p>
          <div className={styles.copyRow}>
            <button type="button" className="u-btn u-btn--ghost" data-testid="setup-copy" onClick={() => void copy()}>
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className={styles.muted}>
            <ShieldCheck size={12} aria-hidden="true" /> This session is verified.{' '}
            {backupRemaining && backupRemaining > 0 ? `Backing up ${backupRemaining} keys...` : 'Your keys are backed up.'}
          </p>
        </>
      );
      footer = (
        <button type="submit" className="u-btn" data-testid="setup-confirm" disabled={!canConfirm}>
          I saved it
        </button>
      );
      onSubmit = () => {
        if (canConfirm) confirm();
      };
      break;

    case 'error':
      title = 'Setup failed';
      body = <p className={styles.text}>Something went wrong while creating your keys. You can try again.</p>;
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
            Close
          </button>
          <button type="submit" className="u-btn" data-testid="setup-start">
            Try again
          </button>
        </>
      );
      onSubmit = () => void start();
      break;
  }

  return (
    <Dialog
      testId="setup-dialog"
      title={title}
      description={description}
      error={phase === 'auth' || phase === 'error' ? error : null}
      errorTestId="setup-error"
      onSubmit={onSubmit}
      onClose={close}
      footer={footer}
      closeTestId="setup-close"
      closeOnBack
      dataAttrs={{ 'data-phase': phase }}
    >
      {body}
    </Dialog>
  );
}
