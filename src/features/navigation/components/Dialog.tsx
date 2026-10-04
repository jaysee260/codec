/**
 * Shared modal shell for the navigation dialogs (DEV-A-6..9). Rendered in a portal on document.body
 * so it is never clipped by the shell grid.
 *
 * Behaviour required by docs/ACCEPTANCE.md:
 *  - Escape closes (captured, so the composer's own Escape handler does not also fire).
 *  - Click on the backdrop closes.
 *  - The first input/textarea is focused on open.
 *  - `dialog-close` is the shared cancel testid; each dialog passes its own `testId` + `submitTestId`.
 *
 * DEV-A-15: on phone the same dialog renders as a bottom sheet - `data-variant="sheet"` (vs `"modal"`
 * on desktop, AC-M5-4), full viewport width, bottom edge flush with the viewport bottom plus
 * `--safe-bottom`, a grab handle, and a slide-up transition. Escape and the backdrop still close it.
 * The backdrop deliberately closes on `mousedown`/`click` rather than `pointerdown`: pointerdown fires
 * at touch-start, so the sheet would already be gone when the tap's synthesized click lands - on
 * whatever is underneath (the open nav drawer's channel items), i.e. a ghost room switch.
 */
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useIsPhone } from '@/store/hooks.ts';
import styles from './Dialog.module.css';

export interface DialogProps {
  /** data-testid of the dialog root, e.g. `create-channel-dialog`. */
  testId: string;
  title: string;
  description?: string;
  /** Error text shown above the footer; pass the testid QA expects (`invite-error`, ...). */
  error?: string | null;
  errorTestId?: string;
  submitLabel: string;
  submitTestId: string;
  submitDisabled?: boolean;
  busy?: boolean;
  onSubmit(): void;
  onClose(): void;
  children: ReactNode;
}

export function Dialog({
  testId,
  title,
  description,
  error,
  errorTestId,
  submitLabel,
  submitTestId,
  submitDisabled = false,
  busy = false,
  onSubmit,
  onClose,
  children,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const isPhone = useIsPhone();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    // Capture phase: dialogs win over the composer's Escape (AC-B6-4) while they are open.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    const first = cardRef.current?.querySelector<HTMLElement>('input, textarea');
    first?.focus();
    first?.setAttribute('data-autofocused', 'true');
  }, []);

  const onBackdropMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return createPortal(
    <div
      className={`${styles.backdrop} ${isPhone ? styles.backdropSheet : ''}`}
      onMouseDown={onBackdropMouseDown}
      onClick={onBackdropMouseDown}
    >
      <div
        className={`${styles.card} ${isPhone ? styles.cardSheet : ''}`}
        data-testid={testId}
        data-variant={isPhone ? 'sheet' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={cardRef}
      >
        {isPhone && <span className={styles.handle} aria-hidden="true" />}
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitDisabled && !busy) onSubmit();
          }}
        >
          <header className={styles.header}>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {description && <p className={styles.description}>{description}</p>}
          </header>

          <div className={styles.body}>{children}</div>

          {error && (
            <div className={styles.error} data-testid={errorTestId} role="alert">
              {error}
            </div>
          )}

          <footer className={styles.footer}>
            <button type="button" className="u-btn u-btn--ghost" data-testid="dialog-close" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="u-btn" data-testid={submitTestId} disabled={submitDisabled || busy}>
              {busy ? 'Working...' : submitLabel}
            </button>
          </footer>
        </form>

        <button type="button" className={styles.x} aria-label="Close" title="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Labelled text field used by every navigation dialog. */
export function DialogField({
  label,
  hint,
  testId,
  value,
  onChange,
  placeholder,
  prefix,
  maxLength,
}: {
  label: string;
  hint?: string;
  testId: string;
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  prefix?: string;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      <span className={styles.inputWrap}>
        {prefix && <span className={styles.prefix}>{prefix}</span>}
        <input
          id={id}
          className={`u-input ${styles.input} ${prefix ? styles.inputWithPrefix : ''}`}
          data-testid={testId}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}
