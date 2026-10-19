/**
 * DEV-B-35: the phone button in the channel header (Dev A mounts `<CallButton roomId />` in `ChannelHeader`).
 *
 *  - `header-call[data-mode="ring|drop-in"]`: DMs and rooms with <= 5 members ring everyone, bigger rooms are a
 *    quiet drop-in (`ringPolicy`);
 *  - disabled with `data-disabled-reason` + a `title` when `canCall` says no ("Calls need an encrypted room",
 *    "You're already in a call", or the store's own message for the rarer reasons);
 *  - not rendered at all for a DM with only a bridge ghost (`bridged-dm`), and hidden while a call is live in this
 *    room (Dev A's "Join voice (n)" chip, or the in-call bar when I am in it, takes its place);
 *  - `header-call-hint` "Codec members only" in a bridged group (`hint: 'codec-only'`).
 * Disabled is `aria-disabled` (not the attribute) so the tooltip still shows on hover and a click is a no-op.
 * A failed start (mic denied, no call server) is a toast from the store's `lastError` (`CallHost`).
 */
import { useState } from 'react';
import { Phone } from 'lucide-react';
import { useCallAvailability, useRoomCallSummary } from '@/store/call.ts';
import { disabledTitle } from './model.ts';
import { ringModeFor, startCallFromUi } from './useCallUi.ts';
import styles from './CallButton.module.css';

export function CallButton({ roomId }: { roomId: string }) {
  const availability = useCallAvailability(roomId);
  const summary = useRoomCallSummary(roomId);
  const [starting, setStarting] = useState(false);

  const reason = availability.ok ? null : availability.reason;
  const hint = (availability as { hint?: string }).hint;
  if ((reason as string | null) === 'bridged-dm') return null;
  if (summary.live || summary.joined) return null;

  const disabled = reason !== null;
  const mode = ringModeFor(roomId);
  const title = availability.ok ? 'Start a call' : disabledTitle(availability.reason, availability.message);

  const onClick = (): void => {
    if (disabled || starting) return;
    setStarting(true);
    void startCallFromUi(roomId).finally(() => setStarting(false));
  };

  return (
    <>
      {hint === 'codec-only' && (
        <span className={styles.hint} data-testid="header-call-hint">
          Codec members only
        </span>
      )}
      <button
        type="button"
        className={styles.button}
        data-testid="header-call"
        data-mode={mode}
        data-disabled-reason={reason ?? undefined}
        aria-label="Start a call"
        aria-disabled={disabled || undefined}
        title={title}
        onClick={onClick}
      >
        <Phone size={20} aria-hidden="true" />
      </button>
    </>
  );
}
