/**
 * Dev-only window hooks (`import.meta.env.DEV`; tree-shaken out of production builds).
 *
 *   window.__matrixPoc = { layout, rooms, session, timeline, threads, getClient, getVoiceMessage, getHsUrl,
 *                          actions, utils, openThread, closeThread, getThreadSummary, getThreadModel, gif, preview, voice, ... }
 *
 *   __matrixPoc.voice = { forceRemuxFailure, encodeToOggOpus }   voice-format QA (docs/VOICE_FORMAT_PLAN.md):
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
import { useCallStore, canCall, enableCallsInRoom, activeCallStats } from '@/store/call.ts';
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
import { isNativeApp, platform } from '@/lib/native.ts';

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
    // Phase 5 (docs/PHASE5_ACCEPTANCE.md): `__matrixPoc.security` = the security module plus
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
    // Alias used by docs/PHASE6_ACCEPTANCE.md: same module plus `clearPreviewCache()`.
    previews: { ...preview, clearPreviewCache: preview.clearLinkPreviewCache },
    // Phase 7: `__matrixPoc.calls.store` = useCallStore (`getState().startCall(roomId, { ring: true })`, `acceptCall`, ...),
    // `canCall(roomId)`, `enableCallsInRoom(roomId)`, `stats()` (receiver bytes per remote participant of the active call),
    // and `rtc` = the whole `@/lib/rtc` barrel (e2e/calls-core.spec.ts drives the call layer through this until the UI lands).
    calls: callsHook,
    rtc,
  };
}

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

