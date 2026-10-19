/**
 * Dev-only window hooks (`import.meta.env.DEV`; tree-shaken out of production builds).
 *
 *   window.__matrixPoc = { layout, rooms, session, timeline, threads, getClient, getVoiceMessage, getHsUrl,
 *                          actions, utils, openThread, closeThread, getThreadSummary, getThreadModel, gif, preview, voice,
 *                          receipts, ... }
 *
 *   __matrixPoc.voice = { forceRemuxFailure, encodeToOggOpus }   voice-format QA (docs/archive/VOICE_FORMAT_PLAN.md):
 *     `forceRemuxFailure = true` makes voice sends (while true) skip the WebM -> Ogg remux as if it threw, so the
 *     original recording is sent with its own mimetype (AC-F9); `encodeToOggOpus(blob, mime?)` is the send
 *     seam itself (AC-F10).
 *
 * Used by scripts/verify-phone-shell.mjs and scripts/verify-thread-shell.mjs (open the nav drawer / a thread for
 * a screenshot, round-trip events through the real parsers) and handy in the browser console. `actions` and
 * `utils` are the whole modules (`__matrixPoc.actions.sendText(roomId, 'hi', { threadRoot })`).
 * Never referenced by product code.
 */
import { runBackHandlers, useLayoutStore } from '@/store/layout.ts';
import { useRoomStore } from '@/store/rooms.ts';
import { useSessionStore } from '@/store/session.ts';
import { useTimelineStore, paginateBack, refreshThread, isRedactedThreadReply } from '@/store/timeline.ts';
import { useThreadStore, getThreadSummary, getThreadModel, isThreadReady } from '@/store/threads.ts';
import { useSecurityStore } from '@/store/security.ts';
import { useCallStore, canCall, ringPolicy, enableCallsInRoom, activeCallStats, setRingTimeoutMs, ringTimeoutMs } from '@/store/call.ts';
import { ringtone } from '@/lib/audio/ringtone.ts';
import { currentSpeakerphoneImpl, overrideSpeakerphone } from '@/lib/native.ts';
import * as rtc from '@/lib/rtc/index.ts';
import { getClientOrNull, getCryptoError } from '@/lib/matrix/client.ts';
import { getHsUrl } from '@/lib/matrix/config.ts';
import * as actions from '@/lib/matrix/actions.ts';
import * as utils from '@/lib/matrix/utils.ts';
import * as security from '@/lib/matrix/security.ts';
import * as attachments from '@/lib/matrix/attachments.ts';
import * as cryptoLifecycle from '@/lib/matrix/crypto.ts';
import { getDisplayBody, getVoiceMessage } from '@/lib/matrix/utils.ts';
import { analyzeAudio, encodeToOggOpus, pickRecordingMimeType } from '@/lib/audio/index.ts';
import { voiceSendDebug } from '@/features/conversation/hooks/useVoiceRecorder.ts';
import * as gif from '@/lib/gif/index.ts';
import * as preview from '@/lib/preview/index.ts';
import { isNativeApp, platform, startCallService, stopCallService, isCallServiceRunning } from '@/lib/native.ts';
import type { MatrixEvent } from 'matrix-js-sdk';
import * as receiptsModule from '@/lib/matrix/receipts.ts';
import { useReceiptStore } from '@/store/receipts.ts';
import { isDisplayableEvent, isMainTimelineEvent } from '@/lib/matrix/utils.ts';

export function installDevHooks(): void {
  (window as unknown as { __matrixPoc?: unknown }).__matrixPoc = {
    layout: useLayoutStore,
    rooms: useRoomStore,
    session: useSessionStore,
    timeline: useTimelineStore,
    threads: useThreadStore,
    getClient: getClientOrNull,
    getHsUrl,
    getVoiceMessage,
    getDisplayBody,
    analyzeAudio,
    pickRecordingMimeType,
    isNativeApp,
    platform,
    // Phase 3
    actions,
    utils,
    paginateBack,
    refreshThread,
    isRedactedThreadReply,
    openThread: (rootId: string, roomId?: string) => useThreadStore.getState().openThread(rootId, roomId),
    closeThread: () => useThreadStore.getState().closeThread(),
    getThreadSummary,
    getThreadModel,
    isThreadReady,
    // Phase 4: Android back chain head (feature handlers), the whole gif module (`__matrixPoc.gif.getGifProvider().trending()`, `setGifApiKey`, ...)
    runBackHandlers,
    gif,
    // Voice format (Ogg remux): a live view of the send path's switch, plus the seam.
    voice: {
      get forceRemuxFailure(): boolean {
        return voiceSendDebug.forceRemuxFailure;
      },
      set forceRemuxFailure(v: boolean) {
        voiceSendDebug.forceRemuxFailure = !!v;
      },
      encodeToOggOpus,
    },
    // Phase 5 (docs/archive/PHASE5_ACCEPTANCE.md): `__matrixPoc.security` = the security module plus
    // `{ store, getCryptoApi, getOwnDeviceStatus, cryptoDatabasePrefix, importRoomKeys(json), exportRoomKeys() }`;
    // `__matrixPoc.crypto` is the same object. `attachments` is the whole module (`encryptAttachment`, ...).
    securityStore: useSecurityStore,
    security: securityHook,
    crypto: securityHook,
    attachments,
    cryptoLifecycle,
    getCryptoError,
    // Phase 6: the whole preview module (`__matrixPoc.preview.getLinkPreview(url)`, `getPreviewUrls(ev)`, `clearLinkPreviewCache()`, ...)
    preview,
    // Alias used by docs/archive/PHASE6_ACCEPTANCE.md: same module plus `clearPreviewCache()`.
    previews: { ...preview, clearPreviewCache: preview.clearLinkPreviewCache },
    // Phase 7: `__matrixPoc.calls.store` = useCallStore (`getState().startCall(roomId, { ring: true })`, `acceptCall`, ...),
    // `canCall(roomId)`, `enableCallsInRoom(roomId)`, `stats()` (receiver bytes per remote participant of the active call),
    // and `rtc` = the whole `@/lib/rtc` barrel (e2e/calls-core.spec.ts drives the call layer through this until the UI lands).
    calls: callsHook,
    // Phase 7 Wave 2 (docs/archive/PHASE7_ACCEPTANCE.md "Shell and core"): `__matrixPoc.call` = the store (`getState()`, `subscribe`)
    // + `canCall`, `ringPolicy`, `getCallLine`, `describeCallEvent`, `CALL_RING_MAX_MEMBERS`, `rtc` ({ isMicrophoneEnabled(),
    // isE2EEEnabled(), setSpeakerphone (assignable: QA stubs it), room }), `ringtone` ({ canPlay(), lastPlayedAt }), `native`.
    call: callHook,
    rtc,
    // Read receipts (docs/archive/RECEIPTS_ACCEPTANCE.md): QA drives the reading side through these.
    receipts: receiptsHook,
  };
}

/** `window.__matrixPoc.call` (Phase 7, Wave 2): the acceptance-doc name. */
const callHook = Object.assign(useCallStore, {
  store: useCallStore,
  canCall,
  ringPolicy,
  getCallLine: rtc.getCallLine,
  formatCallLine: rtc.formatCallLine,
  describeCallEvent: rtc.describeCallEvent,
  CALL_RING_MAX_MEMBERS: rtc.CALL_RING_MAX_MEMBERS,
  CALL_RING_TIMEOUT_MS: rtc.RING_TIMEOUT_MS,
  /** STATUS request #24 (dev builds only, reset on reload): shorten the 60 s ring for the e2e missed-call cases. */
  setRingTimeoutMs: (ms: number | null) => setRingTimeoutMs(ms),
  ringTimeoutMs: () => ringTimeoutMs() ?? rtc.RING_TIMEOUT_MS,
  CALL_KEYS_TIMEOUT_MS: rtc.CALL_KEYS_TIMEOUT_MS,
  startCall: (roomId: string, opts?: { ring?: boolean }) => useCallStore.getState().startCall(roomId, opts),
  accept: (roomId: string) => useCallStore.getState().acceptCall(roomId),
  decline: (roomId: string) => useCallStore.getState().declineCall(roomId),
  join: (roomId: string) => useCallStore.getState().joinCall(roomId),
  leave: () => useCallStore.getState().leaveCall(),
  toggleMute: () => useCallStore.getState().toggleMute(),
  setSpeaker: (mode: 'earpiece' | 'speaker') => useCallStore.getState().setSpeaker(mode),
  state: () => {
    const { activeCall, incoming, history, liveSessions, lastError, speaker } = useCallStore.getState();
    return { activeCall, incoming, history, liveSessions, lastError, speaker };
  },
  stats: () => activeCallStats(),
  rtc: {
    isMicrophoneEnabled: () => !(useCallStore.getState().activeCall?.muted ?? true),
    isE2EEEnabled: () => useCallStore.getState().activeCall?.encrypted ?? false,
    /** Assign a function to stub the speakerphone shim (AC-R9-1); the store's `setSpeaker` goes through it. */
    get setSpeakerphone(): (on: boolean) => Promise<void> | void {
      return currentSpeakerphoneImpl();
    },
    set setSpeakerphone(fn: ((on: boolean) => Promise<void> | void) | null) {
      overrideSpeakerphone(fn);
    },
    get room(): unknown {
      return useCallStore.getState().activeCall;
    },
  },
  ringtone,
  native: { startCallService, stopCallService, isCallServiceRunning },
});

/** `window.__matrixPoc.calls` (Phase 7). */
const callsHook = {
  store: useCallStore,
  canCall,
  enableCallsInRoom,
  startCall: (roomId: string, opts?: { ring?: boolean }) => useCallStore.getState().startCall(roomId, opts),
  joinCall: (roomId: string) => useCallStore.getState().joinCall(roomId),
  acceptCall: (roomId: string) => useCallStore.getState().acceptCall(roomId),
  declineCall: (roomId: string) => useCallStore.getState().declineCall(roomId),
  leaveCall: () => useCallStore.getState().leaveCall(),
  setMuted: (muted: boolean) => useCallStore.getState().setMuted(muted),
  /** Snapshot without functions (safe to `JSON.stringify` from Playwright). */
  state: () => {
    const { activeCall, incoming, history, liveSessions, lastError } = useCallStore.getState();
    return { activeCall, incoming, history, liveSessions, lastError };
  },
  stats: () => activeCallStats(),
};

/** The rows a list renders for a source, from the store snapshot (same filter as `useTimeline(source).events`). */
function displayedEventsOf(roomId: string, threadRootId?: string): MatrixEvent[] {
  const st = useTimelineStore.getState();
  if (threadRootId) return (st.eventsByThread[`${roomId}|${threadRootId}`] ?? []).filter((e) => e.getId() !== threadRootId && isDisplayableEvent(e));
  return (st.eventsByRoom[roomId] ?? []).filter((e) => isMainTimelineEvent(e) && !isRedactedThreadReply(roomId, e.getId()));
}

/**
 * `window.__matrixPoc.receipts`: the whole `src/lib/matrix/receipts.ts` module plus JSON-friendly readers over
 * the live client (`getReadPoints(roomId, threadRootId?)` -> `{ [rowEventId]: Reader[] }`,
 * `getLatestOwnSentId(roomId, threadRootId?)`, `getSeenBy(roomId, eventId, threadRootId?)`,
 * `getSendStatus(roomId, eventId)`, `getSendReadReceipts()`, `setSendReadReceipts(on)`, `markRead(roomId, eventId?, threadRootId?)`
 * = `actions.sendReadReceipt` for the newest row (honours the setting), `store` = `useReceiptStore`).
 */
const receiptsHook = {
  ...receiptsModule,
  store: useReceiptStore,
  getReadPoints(roomId: string, threadRootId?: string): Record<string, receiptsModule.Reader[]> {
    const holder = receiptsModule.getReceiptHolder(getClientOrNull()?.getRoom(roomId), threadRootId);
    const map = receiptsModule.buildReadPoints(holder, displayedEventsOf(roomId, threadRootId), useSessionStore.getState().userId);
    return Object.fromEntries(map);
  },
  getLatestOwnSentId(roomId: string, threadRootId?: string): string | null {
    const holder = receiptsModule.getReceiptHolder(getClientOrNull()?.getRoom(roomId), threadRootId);
    return receiptsModule.buildReadPointsSnapshot(holder, displayedEventsOf(roomId, threadRootId), useSessionStore.getState().userId).latestOwnSentId;
  },
  getSeenBy(roomId: string, eventId: string, threadRootId?: string): receiptsModule.SeenBy {
    const holder = receiptsModule.getReceiptHolder(getClientOrNull()?.getRoom(roomId), threadRootId);
    return receiptsModule.getSeenBy(holder, eventId, useSessionStore.getState().userId);
  },
  getSendStatus(roomId: string, eventId: string): receiptsModule.SendStatus {
    const ev = getClientOrNull()?.getRoom(roomId)?.findEventById(eventId);
    return receiptsModule.getSendStatus(ev, useSessionStore.getState().userId);
  },
  getSendReadReceipts(): boolean {
    return receiptsModule.getSendReadReceipts(getClientOrNull());
  },
  async setSendReadReceipts(on: boolean): Promise<void> {
    const client = getClientOrNull();
    if (!client) throw new Error('not logged in');
    const write = receiptsModule.setSendReadReceipts(client, on); // the optimistic override is set synchronously
    useReceiptStore.setState((s) => ({ settingsVersion: s.settingsVersion + 1 })); // toggle shows the new value now
    try {
      await write;
    } finally {
      useReceiptStore.setState((s) => ({ settingsVersion: s.settingsVersion + 1 })); // echo landed, or reverted
    }
  },
  /** Send a read receipt (type per the setting) for `eventId`, or for the newest displayed row of the source. */
  async markRead(roomId: string, eventId?: string, threadRootId?: string): Promise<void> {
    const rows = displayedEventsOf(roomId, threadRootId);
    const target = eventId ?? rows[rows.length - 1]?.getId();
    if (!target) return;
    await actions.sendReadReceipt(roomId, target, threadRootId ? { threadId: threadRootId } : {});
  },
};

/** `window.__matrixPoc.security` (Phase 5). Room keys travel as the SDK's JSON export (`seed/e2ee-keys.json`). */
const securityHook = {
  ...security,
  store: useSecurityStore,
  cryptoDatabasePrefix: cryptoLifecycle.cryptoDatabasePrefix,
  getCryptoError,
  /** Import Megolm sessions exported by `npm run e2ee:sample` (or `exportRoomKeys()`); decrypts matching rows at once. */
  async importRoomKeys(json: string | unknown[]): Promise<void> {
    const crypto = security.getCryptoApi();
    if (!crypto) throw new Error('crypto not ready');
    await crypto.importRoomKeysAsJson(typeof json === 'string' ? json : JSON.stringify(json));
  },
  /** Every Megolm session this device holds, as the SDK's JSON export string. */
  async exportRoomKeys(): Promise<string> {
    const crypto = security.getCryptoApi();
    if (!crypto) throw new Error('crypto not ready');
    return crypto.exportRoomKeysAsJson();
  },
};

