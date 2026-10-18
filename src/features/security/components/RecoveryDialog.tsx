/**
 * DEV-A-26 unlock with the recovery key (or passphrase): one `recovery-input` (monospace, spaces and paste are
 * fine), `recovery-submit` -> `unlockWithRecoveryKey(input)`, which verifies this session from secret storage
 * and restores the key backup. While it runs, `recovery-progress[data-restored][data-total]` climbs; on success
 * `recovery-done`; a wrong key shows `recovery-error` and keeps the dialog open for another try (AC-E5-2/3).
 *
 * Phases (`data-phase`), first match wins, all derived from the store so a dialog hidden mid-flow and reopened
 * from the banner lands in the right one (design: recovery-ux/DESIGN.md, "One ask only", E1 / E2):
 *   auth / prompt  a pending store prompt, busy or not: password / SSO -> `auth` (`recovery-password`, ...);
 *                  `recovery-key` -> `prompt`, which only ever comes from E2's explicit "I have a different recovery
 *                  key" (`restoreWithDifferentKey`: no other flow registers the prompt, so a normal unlock / restore
 *                  never shows it). `recovery-submit` answers it, `recovery-prompt-cancel` (Cancel) answers null.
 *   working        unlock / restore / key-file import running (`recovery-progress`)
 *   import         "Import a key file from Element" (`recovery-import`, offered in `form` and E2): an Element key
 *                  export file (`recovery-import-file`) + its passphrase (`recovery-import-passphrase`),
 *                  `recovery-import-submit` -> `importKeysFromFile`; a wrong passphrase / not a key file shows
 *                  `recovery-import-error` and stays here; progress is `working`, success is `done` (E1) with
 *                  "Imported N keys"; `recovery-import-back` returns.
 *   locked / unavailable  E2 "Older messages can't be unlocked yet": the device is verified but the backup can't be
 *                  opened, either by an attempt this session (`recovery.backupLocked` -> `locked`) or found unreachable
 *                  (`historyUnavailable`: no key cached, nothing gossiped, the 4S copy only under an old key ->
 *                  `unavailable`). One screen: `recovery-locked` (container, `data-reason` when locked) holding
 *                  `recovery-unavailable` (the body), then the options in order: Import a key file from Element
 *                  (primary, `recovery-import`), "Get keys from another device" (`recovery-other-device`, only when
 *                  another verified device exists), the link "I have a different recovery key"
 *                  (`recovery-enter-other-key`); a restore that failed on the network adds `recovery-retry`. Done
 *                  (`dialog-close`) closes; the banner then reads "Older messages are locked · Fix". Nothing
 *                  destructive here: resetting lives in Settings only (not in this PR).
 *   done           E1 "Unlocked" (`recovery-done`)
 *   missing / form the recovery key form; a key that opens secret storage but cannot restore the identity
 *                  (`errorKind: 'unusable'`) shows "This recovery key can't verify this device. Verify it from your
 *                  other device instead." with `recovery-verify-device` (emoji verification). No silent retry.
 * Hide (`dialog-close` while working), X (`recovery-close`) and Escape only close the dialog: the operation and
 * any pending prompt stay alive (SecurityDialogs re-opens it for the next prompt; a hidden recovery-key prompt
 * waits behind the banner's Unlock). Cancelling a prompt is only ever the explicit Cancel button.
 * The typed key only lives in component state and is cleared on success / unmount (never persisted).
 * testids: recovery-dialog (+data-phase), recovery-input, recovery-submit, recovery-prompt-cancel, recovery-error,
 *          recovery-progress, recovery-done, recovery-locked, recovery-unavailable, recovery-other-device,
 *          recovery-enter-other-key, recovery-retry, recovery-verify-device, recovery-close, recovery-import,
 *          recovery-import-file, recovery-import-passphrase, recovery-import-submit, recovery-import-error,
 *          recovery-import-back
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useSecurityStore } from '@/store';
import { Dialog } from '@/features/navigation';
import { openSecurityDialog, recoveryErrorText, useSecurityUiStore } from '../state.ts';
import { PromptButtons, PromptFields, submitPrompt } from './PromptFields.tsx';
import styles from './security.module.css';

type RecoveryPhase = 'form' | 'prompt' | 'auth' | 'working' | 'import' | 'locked' | 'unavailable' | 'done' | 'missing';

/** Local sub-flow of the dialog: the key-file import form, and its result once done. */
type ImportMode = 'off' | 'form' | 'done';

export function RecoveryDialog() {
  const recovery = useSecurityStore((s) => s.recovery);
  const prompt = useSecurityStore((s) => s.prompt);
  const hasSecretStorage = useSecurityStore((s) => s.status?.secretStorageReady !== false);
  const hint = useSecurityStore((s) => s.hint);
  const unavailable = useSecurityStore((s) => s.historyUnavailable && !!s.status?.verified);
  const otherDevices = useSecurityStore((s) => s.status?.otherVerifiedDevices ?? 0);
  const [input, setInput] = useState('');
  const [promptValue, setPromptValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('off');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const busy = recovery.busy === 'unlock' || recovery.busy === 'restore' || recovery.busy === 'import';

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
    : busy
      ? 'working'
      : importMode === 'done'
        ? 'done'
        : importMode === 'form'
          ? 'import'
          : recovery.backupLocked
            ? 'locked'
            : done
              ? 'done'
              : unavailable
                ? 'unavailable'
                : !hasSecretStorage
                  ? 'missing'
                  : 'form';

  /** Close only: never answers a prompt (a hidden recovery-key prompt does not pop the dialog back up by itself). */
  const close = (): void => {
    setInput('');
    setImportPassphrase('');
    setImportMode('off');
    useSecurityUiStore.getState().closeDialog(prompt?.kind === 'recovery-key' ? prompt : null);
  };

  /** Network retry of a failed restore: asks nobody. */
  const retryRestore = (): void => void useSecurityStore.getState().restoreFromBackup();
  /** E2's "I have a different recovery key": the only action that may ask for a recovery key mid-flow. */
  const differentKey = (): void => void useSecurityStore.getState().restoreWithDifferentKey();

  const startImport = (): void => {
    setImportError(null);
    setImportMode('form');
  };

  const submitImport = async (): Promise<void> => {
    if (!importFile || !importPassphrase || busy) return;
    setImportError(null);
    let text: string;
    try {
      text = await importFile.text();
    } catch {
      setImportError('Could not read that file');
      return;
    }
    const ok = await useSecurityStore.getState().importKeysFromFile(text, importPassphrase);
    if (ok) {
      setImportPassphrase('');
      setImportMode('done');
    } else {
      const err = useSecurityStore.getState().recovery.importError;
      setImportError(
        err?.kind === 'passphrase'
          ? 'That passphrase does not open this key file'
          : err?.kind === 'format'
            ? 'This is not an Element key export file'
            : `Could not import the keys${err ? `: ${err.message}` : ''}`,
      );
    }
  };

  const importLink = (
    <button type="button" className={styles.linkButton} data-testid="recovery-import" onClick={startImport}>
      Import a key file from Element
    </button>
  );

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
            <button type="button" className="u-btn u-btn--ghost" data-testid="recovery-prompt-cancel" onClick={(e) => {
              // Cancel settles the store synchronously enough that E2's submit button can take this node's place
              // before the click finishes; without preventDefault that click would then submit (close) the dialog.
              e.preventDefault();
              useSecurityStore.getState().answerPrompt(null);
            }}>
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
      const importing = recovery.busy === 'import';
      title = importing ? 'Importing keys...' : recovery.busy === 'unlock' && total === 0 ? 'Unlocking...' : 'Restoring keys...';
      body = (
        <div className={styles.progress} data-testid="recovery-progress" data-restored={imported} data-total={total} role="status">
          <p className={styles.text}>
            {importing
              ? total > 0
                ? `Importing ${imported} of ${total} keys`
                : 'Decrypting the key file...'
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

    case 'locked':
    case 'unavailable': {
      const reason = recovery.backupLocked?.reason;
      title = "Older messages can't be unlocked yet";
      description = undefined;
      body = (
        <div className={styles.e2} data-testid="recovery-locked" data-reason={reason}>
          <p className={styles.text} data-testid="recovery-unavailable">
            This device is verified and reads new messages. Older messages need keys this account's backup can't provide. You can get
            them from:
          </p>
          <div className={styles.option}>
            <button type="button" className="u-btn" data-testid="recovery-import" onClick={startImport}>
              Import a key file from Element
            </button>
            <p className={styles.muted}>In Element: Settings &gt; Encryption &gt; Advanced &gt; Export keys. Choose that file here.</p>
          </div>
          {otherDevices > 0 && (
            <div className={styles.option} data-testid="recovery-other-device">
              <p className={styles.text}>Get keys from another device</p>
              <p className={styles.muted}>Keep Codec or Element open on that device; messages unlock here as keys arrive.</p>
            </div>
          )}
          {reason === 'failed' && (
            <button type="button" className={styles.linkButton} data-testid="recovery-retry" onClick={retryRestore}>
              Couldn't reach the key backup. Try again
            </button>
          )}
          <button type="button" className={styles.linkButton} data-testid="recovery-enter-other-key" onClick={differentKey}>
            I have a different recovery key
          </button>
        </div>
      );
      footer = (
        <button type="submit" className="u-btn u-btn--ghost" data-testid="dialog-close">
          Done
        </button>
      );
      onSubmit = close;
      break;
    }

    case 'import':
      title = 'Import keys from Element';
      description = 'In Element: Settings > Encryption > Advanced > Export keys. Then choose that file here and enter the passphrase you gave it.';
      body = (
        <>
          <label className={styles.field}>
            <span className={styles.label}>Key file</span>
            <input
              type="file"
              accept=".txt,text/plain,*/*"
              data-testid="recovery-import-file"
              onChange={(e) => {
                setImportFile(e.target.files?.[0] ?? null);
                setImportError(null);
              }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Passphrase</span>
            <input
              className="u-input"
              type="password"
              data-testid="recovery-import-passphrase"
              value={importPassphrase}
              autoComplete="off"
              onChange={(e) => {
                setImportPassphrase(e.target.value);
                setImportError(null);
              }}
            />
          </label>
        </>
      );
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="recovery-import-back" onClick={() => setImportMode('off')}>
            Back
          </button>
          <button type="submit" className="u-btn" data-testid="recovery-import-submit" disabled={!importFile || !importPassphrase}>
            Import
          </button>
        </>
      );
      onSubmit = () => void submitImport();
      break;

    case 'done': {
      if (importMode === 'done') {
        const result = recovery.lastImport;
        title = 'Unlocked';
        description = undefined;
        body = (
          <div className={styles.center}>
            <span className={`${styles.badge} ${styles.badgeOk}`}>
              <ShieldCheck size={30} aria-hidden="true" />
            </span>
            <p className={styles.text} data-testid="recovery-done" data-imported={result?.imported ?? 0} data-total={result?.total ?? 0}>
              {`Imported ${(result?.imported ?? 0).toLocaleString('en-US')} keys`}
            </p>
            <p className={styles.muted}>This device can read your messages, including older ones.</p>
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
          <p className={styles.muted}>This device can read your messages, including older ones.</p>
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
        <>
          <KeyInput
            value={input}
            onChange={(next) => {
              setInput(next);
              if (error) setError(null);
            }}
          />
          {recovery.errorKind === 'unusable' && error && (
            <button type="button" className="u-btn u-btn--ghost" data-testid="recovery-verify-device" onClick={() => openSecurityDialog('verify')}>
              Verify with my other device
            </button>
          )}
          {importLink}
        </>
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
      error={phase === 'form' ? error : phase === 'locked' || phase === 'unavailable' ? lockedError(recovery.error) : phase === 'import' ? importError : null}
      errorTestId={phase === 'import' ? 'recovery-import-error' : 'recovery-error'}
      onSubmit={onSubmit}
      onClose={close}
      // Keyed by phase: React must not reuse one phase's button node for the next phase's (a click on a type="button"
      // that swaps the phase would otherwise land as a submit on its replacement).
      footer={footer == null ? footer : <Fragment key={phase}>{footer}</Fragment>}
      closeTestId="recovery-close"
      closeOnBack
      dataAttrs={{ 'data-phase': phase }}
    >
      {body}
    </Dialog>
  );
}

/** A failed network retry while in E2 (a cancelled prompt is not an error worth showing). */
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
