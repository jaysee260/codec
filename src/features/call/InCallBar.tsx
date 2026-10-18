/**
 * DEV-B-37: the slim "In call 01:23, tap to return" bar (`in-call-bar`) shown while a call is live and its screen
 * is minimised. `Conversation` mounts it (desktop: right above the composer, outside the scroll area; phone: at
 * the top of the conversation under the header, so the keyboard never covers it). Click reopens the screen;
 * `in-call-bar-leave` hangs up.
 */
import type { KeyboardEvent } from 'react';
import { PhoneOff, Volume2 } from 'lucide-react';
import { useCallStore } from '@/store/call.ts';
import { useRoomSummary } from '@/store/hooks.ts';
import { formatTimer } from './model.ts';
import { useCallUi } from './useCallUi.ts';
import { useCallView, useTick } from './useCallView.ts';
import styles from './InCallBar.module.css';

export function InCallBar() {
  const { call, barVisible, connectedSince, screen } = useCallView();
  const summary = useRoomSummary(call?.roomId ?? null);
  const now = useTick(barVisible && !!connectedSince);
  if (!call || !barVisible) return null;

  const open = (): void => useCallUi.getState().openScreen();
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  const time = connectedSince ? formatTimer(now - connectedSince) : null;
  const label = time ? `In call ${time}, tap to return` : screen === 'calling' ? 'Calling..., tap to return' : 'Connecting..., tap to return';
  const where = summary ? (summary.isDm ? summary.name : `#${summary.name}`) : '';

  return (
    <div
      className={styles.bar}
      data-testid="in-call-bar"
      data-room-id={call.roomId}
      role="button"
      tabIndex={0}
      aria-label={`${label}${where ? ` (${where})` : ''}`}
      onClick={open}
      onKeyDown={onKey}
    >
      <Volume2 size={16} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>
        {label}
        {where && <span className={styles.where}> · {where}</span>}
      </span>
      <button
        type="button"
        className={styles.leave}
        data-testid="in-call-bar-leave"
        aria-label="Leave call"
        title="Leave call"
        onClick={(e) => {
          e.stopPropagation();
          void useCallStore.getState().leaveCall();
        }}
      >
        <PhoneOff size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
