/**
 * The store's `prompt` (the SDK asking for something mid-flow) rendered inline in whichever security dialog is
 * open. Fields only: the owning dialog's form submits through `submitPrompt`.
 *
 *   password      `${prefix}-password` (UIA `m.login.password`)            submit `${prefix}-password-submit`
 *   sso           `${prefix}-sso-hint` + a link to the fallback page        submit `${prefix}-sso-done` ("Done")
 *   recovery-key  `${prefix}-prompt-key` (the secret storage key)           submit `${prefix}-prompt-submit`
 */
import { useSecurityStore, type PendingPrompt } from '@/store';
import { DialogField } from '@/features/navigation';
import styles from './security.module.css';

export function PromptFields({
  prompt,
  prefix,
  value,
  onChange,
}: {
  prompt: PendingPrompt;
  prefix: string;
  value: string;
  onChange(next: string): void;
}) {
  if (prompt.kind === 'sso') {
    return (
      <div className={styles.center}>
        <p className={styles.text} data-testid={`${prefix}-sso-hint`}>
          {prompt.popupBlocked ? prompt.message : 'Finish signing in in the window that opened'}
        </p>
        {prompt.url && (
          <a className={styles.link} href={prompt.url} target="_blank" rel="noopener noreferrer" data-testid={`${prefix}-sso-link`}>
            {prompt.popupBlocked ? 'Open the sign-in page' : "Window didn't open? Open the sign-in page"}
          </a>
        )}
        <p className={styles.muted}>Then come back and press Done.</p>
      </div>
    );
  }
  if (prompt.kind === 'password') {
    return (
      <>
        <p className={styles.text}>{prompt.message}</p>
        <PasswordField testId={`${prefix}-password`} value={value} onChange={onChange} />
      </>
    );
  }
  return (
    <>
      <p className={styles.text}>{prompt.message}</p>
      <DialogField label="Recovery key or passphrase" testId={`${prefix}-prompt-key`} value={value} onChange={onChange} />
    </>
  );
}

/** Password input (DialogField is text-only). */
export function PasswordField({ testId, value, onChange }: { testId: string; value: string; onChange(next: string): void }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>Password</span>
      <input
        className="u-input"
        type="password"
        data-testid={testId}
        value={value}
        autoComplete="current-password"
        autoFocus
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Footer buttons for a prompt: Cancel (answers null) + the submit button. */
export function PromptButtons({ prompt, prefix, value }: { prompt: PendingPrompt; prefix: string; value: string }) {
  const submitId = prompt.kind === 'sso' ? `${prefix}-sso-done` : prompt.kind === 'password' ? `${prefix}-password-submit` : `${prefix}-prompt-submit`;
  return (
    <>
      <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={() => useSecurityStore.getState().answerPrompt(null)}>
        Cancel
      </button>
      <button type="submit" className="u-btn" data-testid={submitId} disabled={prompt.kind !== 'sso' && value.trim().length === 0}>
        {prompt.kind === 'sso' ? 'Done' : 'Continue'}
      </button>
    </>
  );
}

/** Answer the prompt from the dialog's form submit. */
export function submitPrompt(prompt: PendingPrompt, value: string): void {
  if (prompt.kind !== 'sso' && !value.trim()) return;
  useSecurityStore.getState().answerPrompt(prompt.kind === 'sso' ? 'done' : prompt.kind === 'password' ? value : value.trim());
}
