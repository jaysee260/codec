/**
 * DEV-B-37 / DEV-B-39: the in-call screen (`call-screen[data-state]`), mounted once by the shell (`CallHost`).
 *
 * Desktop: a panel over the right-hand column (members or thread), so the conversation stays usable; in a DM
 * (no right column) the panel reserves its own width (`:root[data-call-panel='reserve']`, see the CSS).
 * Phone: full screen, controls in a bottom bar of 56 px buttons above the safe area; Android back minimises.
 *
 * Contents: lock (`call-lock`), status (`call-status`) and timer (`call-timer`, mm:ss since connected), one tile per
 * person (`call-participant-{userId}`: green outline while speaking, crossed mic when muted, a warning on a poor
 * connection, "No call keys from X yet" when their media keys have not arrived), a "turn on call audio" button
 * when the browser blocked playback, and Mute / Speaker (phone) / Leave / Minimise. After the call: "No answer"
 * offers Call back + Close; "Busy" and "declined" close after 3 s, "Call ended" after 2 s, our own hang-up at once.
 */
import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { ChevronDown, Lock, Mic, MicOff, Phone, PhoneOff, SignalLow, Volume2, VolumeX, Ear, X } from 'lucide-react';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { avatarUrlOf, displayNameOf } from '@/lib/matrix/utils.ts';
import { colorFor, initialsOf } from '@/lib/format.ts';
import { useCallStore } from '@/store/call.ts';
import { useIsPhone, useMyUserId, useRoomSummary } from '@/store/hooks.ts';
import { registerBackHandler } from '@/store/layout.ts';
import { closeDelayFor, formatTimer, statusText, tilesOf, type Tile } from './model.ts';
import { startCallFromUi, useCallUi, useSpeakerMode } from './useCallUi.ts';
import { useCallView, useTick } from './useCallView.ts';
import styles from './CallScreen.module.css';

const LOCK_TITLE = 'End-to-end encrypted (the call server only sees scrambled audio)';

export function CallScreen() {
  const { call, screen, screenVisible, connectedSince } = useCallView();
  const isPhone = useIsPhone();
  const myUserId = useMyUserId();
  const summary = useRoomSummary(call?.roomId ?? null);
  const [speaker, setSpeaker] = useSpeakerMode();
  const live = !!call && call.state !== 'ended';
  const now = useTick(screenVisible && !!connectedSince);

  // Auto-close once the call is over (no-answer waits for Close / Call back).
  const endReason = call?.endReason ?? null;
  useEffect(() => {
    if (!call || call.state !== 'ended' || !screen) return;
    const delay = closeDelayFor(screen, endReason);
    if (delay === null) return;
    if (delay === 0) {
      useCallUi.getState().dismiss();
      return;
    }
    const timer = setTimeout(() => useCallUi.getState().dismiss(), delay);
    return () => clearTimeout(timer);
  }, [call?.state, screen, endReason, call]);

  // Android back while the screen is open: minimise (the call goes on behind the bar).
  useEffect(() => {
    if (!screenVisible || !live) return;
    return registerBackHandler(() => {
      useCallUi.getState().minimiseScreen();
      return true;
    });
  }, [screenVisible, live]);

  const panelStyle = useDesktopPanel(screenVisible && !isPhone);

  if (!call || !screen || !screenVisible) return null;

  const room = getClientOrNull()?.getRoom(call.roomId) ?? null;
  const roomLabel = summary ? (summary.isDm ? summary.name : `#${summary.name}`) : (room?.name ?? '');
  const tiles = tilesOf(call.participants, myUserId);
  // Our own tile is there from the first frame (the snapshot lists us once our membership is on the wire).
  if (myUserId && !tiles.some((t) => t.userId === myUserId)) {
    tiles.unshift({ userId: myUserId, isSelf: true, speaking: false, muted: call.muted, poor: false, keys: 'ok' });
  }
  // Before anyone else joins a DM ring, show who we are calling next to our own tile.
  const calleeId = summary?.isDm ? summary.dmUserId : undefined;
  const waitingFor = (screen === 'calling' || screen === 'no-answer' || screen === 'busy') && calleeId && !tiles.some((t) => t.userId === calleeId) ? calleeId : null;
  const status = statusText(screen, { endReason, peerName: summary?.isDm ? summary.name : undefined, errorMessage: call.error?.message });
  const showTimer = !!connectedSince && (screen === 'connected' || screen === 'reconnecting');
  const store = useCallStore.getState();
  const close = (): void => useCallUi.getState().dismiss();

  return (
    <div
      className={`${styles.screen} ${isPhone ? styles.phone : styles.desktop}`}
      style={panelStyle}
      role="dialog"
      aria-label="Voice call"
      data-testid="call-screen"
      data-state={screen}
      data-room-id={call.roomId}
    >
      <div className={styles.header}>
        <span className={styles.lock} data-testid="call-lock" title={LOCK_TITLE} aria-label={LOCK_TITLE} role="img">
          <Lock size={14} aria-hidden="true" />
        </span>
        <span className={styles.room} title={roomLabel}>
          {roomLabel}
        </span>
        {live && (
          <button
            type="button"
            className={styles.headerButton}
            data-testid="call-minimise"
            aria-label="Minimise call"
            title="Minimise call"
            onClick={() => useCallUi.getState().minimiseScreen()}
          >
            <ChevronDown size={20} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className={styles.statusBlock}>
        <div className={`${styles.status} ${screen === 'reconnecting' ? styles.warn : ''}`} data-testid="call-status" role="status">
          {status}
        </div>
        {showTimer && (
          <div className={styles.timer} data-testid="call-timer">
            {formatTimer(now - (connectedSince ?? now))}
          </div>
        )}
      </div>

      {call.audioBlocked && live && (
        <button type="button" className={styles.audioBlocked} data-testid="call-audio-blocked" onClick={() => void store.resumeAudio()}>
          <Volume2 size={16} aria-hidden="true" />
          Click to turn on call audio
        </button>
      )}

      <div className={styles.tiles}>
        {tiles.map((tile) => (
          <ParticipantTile key={tile.userId} tile={tile} roomId={call.roomId} />
        ))}
        {waitingFor && <WaitingTile userId={waitingFor} roomId={call.roomId} />}
      </div>

      <div className={styles.controls}>
        {screen === 'no-answer' ? (
          <>
            <button type="button" className={`${styles.control} ${styles.callBack}`} data-testid="call-back" onClick={() => void startCallFromUi(call.roomId)}>
              <Phone size={20} aria-hidden="true" />
              <span className={styles.controlLabel}>Call back</span>
            </button>
            <button type="button" className={styles.control} data-testid="call-close" onClick={close}>
              <X size={20} aria-hidden="true" />
              <span className={styles.controlLabel}>Close</span>
            </button>
          </>
        ) : live ? (
          <>
            <button
              type="button"
              className={`${styles.control} ${call.muted ? styles.controlOn : ''}`}
              data-testid="call-mute"
              aria-pressed={call.muted}
              aria-label={call.muted ? 'Unmute' : 'Mute'}
              title={call.muted ? 'Unmute' : 'Mute'}
              onClick={() => void store.toggleMute()}
            >
              {call.muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}
              <span className={styles.controlLabel}>{call.muted ? 'Unmute' : 'Mute'}</span>
            </button>
            {isPhone && (
              <button
                type="button"
                className={`${styles.control} ${speaker === 'speaker' ? styles.controlOn : ''}`}
                data-testid="call-speaker"
                aria-pressed={speaker === 'speaker'}
                aria-label="Speaker"
                onClick={() => setSpeaker(speaker === 'speaker' ? 'earpiece' : 'speaker')}
              >
                {speaker === 'speaker' ? <Volume2 size={20} aria-hidden="true" /> : <Ear size={20} aria-hidden="true" />}
                <span className={styles.controlLabel}>Speaker</span>
              </button>
            )}
            <button
              type="button"
              className={`${styles.control} ${styles.leave}`}
              data-testid="call-leave"
              aria-label="Leave call"
              title="Leave call"
              onClick={() => void store.leaveCall()}
            >
              <PhoneOff size={20} aria-hidden="true" />
              <span className={styles.controlLabel}>Leave</span>
            </button>
          </>
        ) : (
          <button type="button" className={styles.control} data-testid="call-close" onClick={close}>
            <X size={20} aria-hidden="true" />
            <span className={styles.controlLabel}>Close</span>
          </button>
        )}
      </div>
    </div>
  );
}

function ParticipantTile({ tile, roomId }: { tile: Tile; roomId: string }) {
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const name = displayNameOf(room, tile.userId);
  const avatar = avatarUrlOf(room, tile.userId, 128);
  const label = tile.isSelf ? `${name} (you)` : name;
  return (
    <div
      className={styles.tile}
      data-testid={`call-participant-${tile.userId}`}
      data-speaking={tile.speaking ? 'true' : 'false'}
      data-muted={tile.muted ? 'true' : 'false'}
      data-poor={tile.poor ? 'true' : 'false'}
      data-keys={tile.keys}
      title={label}
    >
      <span className={styles.avatarWrap}>
        <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(tile.userId) }}>
          {avatar ? <img src={avatar} alt="" /> : initialsOf(name)}
        </span>
        {tile.muted && (
          <span className={styles.badge} aria-label="Muted" role="img">
            <MicOff size={14} aria-hidden="true" />
          </span>
        )}
        {tile.poor && (
          <span className={`${styles.badge} ${styles.badgePoor}`} aria-label="Poor connection" title="Poor connection" role="img">
            <SignalLow size={14} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className={styles.tileName}>{label}</span>
      {tile.keys === 'missing' && (
        <span className={styles.noKeys} data-testid="call-participant-nokeys">
          <VolumeX size={12} aria-hidden="true" /> No call keys from {name} yet
        </span>
      )}
    </div>
  );
}

/** The person we are ringing, greyed out until they join (not a participant: no testid). */
function WaitingTile({ userId, roomId }: { userId: string; roomId: string }) {
  const room = getClientOrNull()?.getRoom(roomId) ?? null;
  const name = displayNameOf(room, userId);
  const avatar = avatarUrlOf(room, userId, 128);
  return (
    <div className={`${styles.tile} ${styles.waiting}`} title={name}>
      <span className={styles.avatarWrap}>
        <span className={`u-avatar ${styles.avatar}`} style={{ background: colorFor(userId) }}>
          {avatar ? <img src={avatar} alt="" /> : initialsOf(name)}
        </span>
      </span>
      <span className={styles.tileName}>{name}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop placement
// ---------------------------------------------------------------------------

const RIGHT_COLUMNS = '[data-testid="app-shell"][data-layout="desktop"] > aside[aria-label="Members"], [data-testid="thread-panel-container"]';

/**
 * Desktop: sit exactly over the right column (members 240 px or thread 400 px) when one is showing; otherwise
 * reserve a column of our own (`data-call-panel="reserve"` on <html> shrinks `main`, CallScreen.module.css).
 */
function useDesktopPanel(active: boolean): CSSProperties | undefined {
  const [rect, setRect] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    let frame = 0;
    // Members aside toggles between empty and filled, and asides come and go with the thread: re-watch each time.
    const asideMo = new MutationObserver(() => schedule());
    const measure = (): void => {
      frame = 0;
      asideMo.disconnect();
      for (const aside of Array.from(document.querySelectorAll('[data-testid="app-shell"] > aside'))) asideMo.observe(aside, { childList: true });
      let found: { left: number; width: number } | null = null;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(RIGHT_COLUMNS))) {
        const box = el.getBoundingClientRect();
        if (box.width > 0) {
          found = { left: box.left, width: box.width };
          break;
        }
      }
      if (found) delete root.dataset.callPanel;
      else root.dataset.callPanel = 'reserve';
      setRect((prev) => (prev?.left === found?.left && prev?.width === found?.width ? prev : found));
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const shell = document.querySelector('[data-testid="app-shell"]');
    const mo = new MutationObserver(schedule);
    if (shell) mo.observe(shell, { childList: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mo.disconnect();
      asideMo.disconnect();
      window.removeEventListener('resize', schedule);
      delete root.dataset.callPanel;
    };
  }, [active]);
  if (!active || !rect) return undefined;
  return { left: rect.left, width: rect.width, right: 'auto' };
}
