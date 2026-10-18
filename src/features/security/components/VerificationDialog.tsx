/**
 * DEV-A-25 emoji (SAS) verification, driven by `useSecurityStore.verification`. One dialog for both directions:
 *
 *   choose      (outgoing, no flow yet)  verify-use-device -> startSelfVerification(); verify-use-recovery -> recovery-dialog
 *   requested   outgoing request sent, or both sides ready and the SAS is starting   verify-waiting, verify-cancel
 *   incoming    another device (Element, another codec) asked us                     verify-accept / verify-decline
 *   sas         7 verify-emoji-item (text = emoji, data-name = SAS name)             verify-match / verify-mismatch / verify-cancel
 *   confirming  we clicked "They match", waiting for the other side                  verify-cancel
 *   done        verify-done ("Verified"); Done (`dialog-close`) only closes, never opens the recovery-key form (the
 *               backup key may still arrive from the other device; the banner says what next after the grace)
 *   cancelled   verify-error = the reason; error = the request could not even start (crypto off, no other device)
 *
 * Escape cancels the flow (and stays open on `cancelled`) in requested / sas / confirming; it closes otherwise.
 * The corner X (`verify-close`) and the backdrop cancel any live flow, then close.
 * testids: verify-dialog (+data-phase, data-direction), the ones above, verify-close
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { KeyRound, LoaderCircle, ShieldCheck, ShieldX, Smartphone } from 'lucide-react';
import { useSecurityStore, type VerificationFlow } from '@/store';
import { Dialog } from '@/features/navigation';
import { openSecurityDialog, useSecurityUiStore } from '../state.ts';
import styles from './security.module.css';

export type VerifyPhase = 'choose' | 'requested' | 'incoming' | 'sas' | 'confirming' | 'done' | 'cancelled' | 'error';

/** Pure: the dialog phase for a flow (exported for the __dev__ harness). */
export function verifyPhase(flow: VerificationFlow | null, opts: { starting: boolean; confirming: boolean }): VerifyPhase {
  if (!flow) return opts.starting ? 'requested' : 'choose';
  switch (flow.stage) {
    case 'cancelled':
      return flow.otherUserId === '' ? 'error' : 'cancelled';
    case 'done':
      return 'done';
    case 'sas':
      return opts.confirming ? 'confirming' : 'sas';
    case 'requested':
      return flow.initiatedByMe ? 'requested' : 'incoming';
    default:
      return 'requested'; // ready / started: both sides agreed, the SAS keys are being exchanged
  }
}

/** `verify-error` copy: the store's reason, with the raw cancel codes made readable. */
export function cancelReason(error: string | null): string {
  if (!error) return 'Verification was cancelled';
  const code = /\((m\.[a-z_]+)\)/.exec(error)?.[1];
  if (code === 'm.user') return 'Verification was cancelled';
  if (code === 'm.timeout') return 'The request timed out';
  if (code === 'm.mismatched_sas') return 'The emoji did not match';
  if (code === 'm.accepted') return 'Another session answered the request';
  return error;
}

const LIVE: ReadonlySet<VerifyPhase> = new Set(['requested', 'incoming', 'sas', 'confirming']);

export function VerificationDialog() {
  const flow = useSecurityStore((s) => s.verification);
  const hint = useSecurityStore((s) => s.hint);
  const canUseRecovery = useSecurityStore((s) => s.status?.secretStorageReady !== false);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // A new flow (or none) starts unconfirmed; `starting` ends once the store has the request.
  useEffect(() => {
    if (flow?.stage !== 'sas') setConfirming(false);
    if (flow) setStarting(false);
  }, [flow]);

  const phase = verifyPhase(flow, { starting, confirming });
  const direction = flow && !flow.initiatedByMe ? 'incoming' : 'outgoing';
  const store = useSecurityStore.getState;

  const close = (): void => {
    if (LIVE.has(phase) && flow) void store().cancelVerification();
    store().dismissVerification();
    setStarting(false);
    useSecurityUiStore.getState().closeDialog();
  };
  const escape = (): void => {
    if (flow && (phase === 'requested' || phase === 'sas' || phase === 'confirming')) void store().cancelVerification();
    else close();
  };
  const useDevice = (): void => {
    setStarting(true);
    void store()
      .startSelfVerification()
      .finally(() => {
        if (!store().verification) setStarting(false);
      });
  };
  const retry = (): void => {
    store().dismissVerification();
    setStarting(false);
  };
  const match = (): void => {
    setConfirming(true);
    void store().confirmSas();
  };

  let title = 'Verify this session';
  let description: string | undefined;
  let body: ReactNode = null;
  let footer: ReactNode = null;
  let onSubmit = (): void => {};

  const cancelButton = (
    <button type="button" className="u-btn u-btn--ghost" data-testid="verify-cancel" onClick={() => void store().cancelVerification()}>
      Cancel
    </button>
  );
  const closeButton = (label = 'Close') => (
    <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={close}>
      {label}
    </button>
  );
  const deviceLabel = flow?.otherDeviceId ? `session ${flow.otherDeviceId}` : 'session';

  switch (phase) {
    case 'choose':
      description = 'Confirm it is really you, so this session can read your encrypted messages.';
      body = (
        <div className={styles.options}>
          <button type="button" className={styles.option} data-testid="verify-use-device" onClick={useDevice}>
            <Smartphone size={24} className={styles.optionIcon} aria-hidden="true" />
            <span className={styles.optionText}>
              <span className={styles.optionTitle}>Use another device</span>
              <span className={styles.optionSub}>Compare emoji with Element or another signed-in session</span>
            </span>
          </button>
          {canUseRecovery && (
            <button type="button" className={styles.option} data-testid="verify-use-recovery" onClick={() => openSecurityDialog('unlock')}>
              <KeyRound size={24} className={styles.optionIcon} aria-hidden="true" />
              <span className={styles.optionText}>
                <span className={styles.optionTitle}>Use your recovery key</span>
                <span className={styles.optionSub}>The key (or passphrase) you saved when you set up encryption</span>
              </span>
            </button>
          )}
        </div>
      );
      footer = closeButton('Cancel');
      break;

    case 'requested': {
      const agreed = flow && flow.stage !== 'requested';
      body = (
        <div className={styles.center}>
          <span className={styles.badge}>
            <LoaderCircle size={28} className={styles.spin} aria-hidden="true" />
          </span>
          <p className={styles.text} data-testid="verify-waiting">
            {agreed ? 'Starting the emoji comparison...' : 'Accept the request on your other device'}
          </p>
          {!agreed && <p className={styles.muted}>Open Element or codec where you are already signed in.</p>}
        </div>
      );
      footer = cancelButton;
      break;
    }

    case 'incoming':
      title = flow?.isSelf ? 'Verify your other session' : 'Verification request';
      body = (
        <div className={styles.center}>
          <span className={styles.badge}>
            <Smartphone size={28} aria-hidden="true" />
          </span>
          <p className={styles.text}>
            {flow?.isSelf ? `Your ${deviceLabel} wants to be verified by this one.` : `${flow?.otherUserId} wants to verify with you.`}
          </p>
          <p className={styles.muted}>Only accept if you just asked for it.</p>
        </div>
      );
      footer = (
        <>
          <button type="button" className="u-btn u-btn--ghost" data-testid="verify-decline" onClick={() => void store().cancelVerification()}>
            Decline
          </button>
          <button type="submit" className="u-btn" data-testid="verify-accept">
            Accept
          </button>
        </>
      );
      onSubmit = () => void store().acceptVerification();
      break;

    case 'sas':
    case 'confirming':
      title = 'Compare emoji';
      description = 'Check that the same emoji appear in the same order on both devices.';
      body = (
        <>
          <ol className={styles.emojiGrid} data-testid="verify-emoji">
            {(flow?.sas?.emoji ?? []).map(([symbol, name], i) => (
              <li key={i} className={styles.emojiTile}>
                <span className={styles.emojiSymbol} data-testid="verify-emoji-item" data-name={name} aria-label={name} role="img">
                  {symbol}
                </span>
                <span className={styles.emojiName} aria-hidden="true">
                  {name}
                </span>
              </li>
            ))}
          </ol>
          {phase === 'confirming' && (
            <p className={`${styles.muted} ${styles.center}`}>Waiting for the other device to confirm...</p>
          )}
        </>
      );
      footer =
        phase === 'confirming' ? (
          cancelButton
        ) : (
          <>
            {cancelButton}
            <span className={styles.footerSpacer} />
            <button type="button" className="u-btn u-btn--danger" data-testid="verify-mismatch" onClick={() => store().mismatchSas()}>
              They don't match
            </button>
            <button type="submit" className="u-btn" data-testid="verify-match">
              They match
            </button>
          </>
        );
      onSubmit = phase === 'sas' ? match : () => {};
      break;

    case 'done':
      title = 'Verified';
      body = (
        <div className={styles.center}>
          <span className={`${styles.badge} ${styles.badgeOk}`}>
            <ShieldCheck size={30} aria-hidden="true" />
          </span>
          <p className={styles.text} data-testid="verify-done">
            {direction === 'incoming' ? 'Your other session is verified' : 'This session is verified'}
          </p>
          {direction === 'outgoing' && hint === 'unlock' && (
            <p className={styles.muted}>Older messages unlock here as your other device shares their keys.</p>
          )}
        </div>
      );
      // Done only closes: no recovery-key form right after the emoji match (the other device may still be handing
      // the backup key over). The banner carries the next step once the store's gossip grace has passed.
      footer = (
        <button type="submit" className="u-btn" data-testid="dialog-close">
          Done
        </button>
      );
      onSubmit = close;
      break;

    case 'cancelled':
    case 'error':
      title = phase === 'error' ? 'Could not start verification' : 'Verification cancelled';
      body = (
        <div className={styles.center}>
          <span className={`${styles.badge} ${styles.badgeBad}`}>
            <ShieldX size={30} aria-hidden="true" />
          </span>
          <p className={styles.text} data-testid="verify-error" role="alert">
            {cancelReason(flow?.error ?? null)}
          </p>
          <p className={styles.muted}>Nothing changed: this session is still unverified.</p>
        </div>
      );
      footer =
        direction === 'outgoing' ? (
          <>
            {closeButton()}
            <button type="submit" className="u-btn" data-testid="verify-retry">
              Try again
            </button>
          </>
        ) : (
          closeButton()
        );
      onSubmit = direction === 'outgoing' ? retry : close;
      break;
  }

  return (
    <Dialog
      testId="verify-dialog"
      title={title}
      description={description}
      onSubmit={onSubmit}
      onClose={close}
      onEscape={escape}
      // Keyed by phase so one phase's button node is never reused for the next phase's (see RecoveryDialog).
      footer={footer == null ? footer : <Fragment key={phase}>{footer}</Fragment>}
      closeTestId="verify-close"
      closeOnBack
      dataAttrs={{ 'data-phase': phase, 'data-direction': direction }}
    >
      {body}
    </Dialog>
  );
}
