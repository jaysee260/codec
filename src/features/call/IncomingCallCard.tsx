/**
 * DEV-B-36: the ringing card (`incoming-call`), mounted once by the shell through `CallHost`.
 *
 * Shows the first ring of `useIncomingCall()`: the caller's avatar and name, the room (DM name or `#room`),
 * Accept / Decline. The store removes the ring when it is answered or declined here or on another device, when the
 * caller hangs up and when the 60 s run out, so the card has no timers of its own. While it is up:
 *  - the tab title alternates with "Incoming call from bob" every second (restored on close);
 *  - "Click anywhere to hear the ringtone" while the browser blocks sound (`ringtone.canPlay()` false);
 *  - phone: full screen, 56 px buttons above the safe area, Android back = Decline (the store vibrates).
 */
import { useEffect, useRef } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { avatarUrlOf, displayNameOf } from '@/lib/matrix/utils.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { useCallStore, useIncomingCall } from '@/store/call.ts';
import { useIsPhone, useRoomSummary } from '@/store/hooks.ts';
import { registerBackHandler } from '@/store/layout.ts';
import { acceptFromUi } from './useCallUi.ts';
import { useRingtoneMuted } from './ringtoneGate.ts';
import styles from './IncomingCallCard.module.css';

export function IncomingCallCard() {
  const call = useIncomingCall();
  const isPhone = useIsPhone();
  const summary = useRoomSummary(call?.roomId ?? null);
  const muted = useRingtoneMuted(!!call);
  const acceptRef = useRef<HTMLButtonElement>(null);

  const roomId = call?.roomId ?? null;
  const room = roomId ? (getClientOrNull()?.getRoom(roomId) ?? null) : null;
  const callerName = call ? displayNameOf(room, call.from) : '';

  useTitleFlash(call ? `Incoming call from ${callerName}` : null);

  // Android back on the card declines (registered while the card is up; newest handler runs first).
  useEffect(() => {
    if (!roomId) return;
    return registerBackHandler(() => {
      void useCallStore.getState().declineCall(roomId);
      return true;
    });
  }, [roomId]);

  // Desktop: focus Accept so Enter answers; the card is a dialog.
  useEffect(() => {
    if (roomId && !isPhone) acceptRef.current?.focus({ preventScroll: true });
  }, [roomId, isPhone]);

  if (!call) return null;

  const avatar = avatarUrlOf(room, call.from, 128);
  // DMs: the DM's name (the caller); rooms: `#room`.
  const roomLabel = summary ? (summary.isDm ? summary.name : `#${summary.name}`) : (room?.name ?? '');
  const accept = (): void => void acceptFromUi(call.roomId);
  const decline = (): void => void useCallStore.getState().declineCall(call.roomId);

  return (
    <div className={`${styles.backdrop} ${isPhone ? styles.phone : ''}`}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="Incoming call"
        data-testid="incoming-call"
        data-room-id={call.roomId}
        data-from={call.from}
      >
        <div className={styles.top}>
          <span className={styles.ringPulse} aria-hidden="true">
            <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(call.from) }}>
              {avatar ? <img src={avatar} alt="" /> : initialsOf(callerName)}
            </span>
          </span>
          <div className={styles.name} data-testid="incoming-call-name">
            {callerName}
          </div>
          <div className={styles.subtitle}>
            {summary?.isDm ? 'Incoming voice call · ' : 'Incoming voice call in '}
            <span className={styles.room} data-testid="incoming-call-room">
              {roomLabel}
            </span>
          </div>
          {muted && (
            <div className={styles.muted} data-testid="incoming-call-muted">
              Click anywhere to hear the ringtone
            </div>
          )}
        </div>
        <div className={styles.actions}>
          <button type="button" className={`${styles.action} ${styles.decline}`} data-testid="incoming-call-decline" onClick={decline}>
            <PhoneOff size={22} aria-hidden="true" />
            <span>Decline</span>
          </button>
          <button
            type="button"
            ref={acceptRef}
            className={`${styles.action} ${styles.accept}`}
            data-testid="incoming-call-accept"
            onClick={accept}
          >
            <Phone size={22} aria-hidden="true" />
            <span>Accept</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Alternate `document.title` with `text` every second while `text` is set; put the real title back after. */
function useTitleFlash(text: string | null): void {
  useEffect(() => {
    if (!text || typeof document === 'undefined') return;
    let original = document.title;
    let showing = false;
    const timer = setInterval(() => {
      if (!showing) {
        // Another part of the app may have changed the title meanwhile (unread count): keep the latest.
        if (document.title !== text) original = document.title;
        document.title = text;
      } else {
        document.title = original;
      }
      showing = !showing;
    }, 1000);
    return () => {
      clearInterval(timer);
      if (document.title === text) document.title = original;
    };
  }, [text]);
}
