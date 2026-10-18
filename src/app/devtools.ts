/**
 * Dev-only window hooks (`import.meta.env.DEV`; tree-shaken out of production builds).
 *
 *   window.__matrixPoc = { layout, rooms, session, timeline, threads, getClient, getVoiceMessage, getHsUrl,
 *                          actions, utils, openThread, closeThread, getThreadSummary, getThreadModel, gif, preview, voice,
 *                          receipts, ... }
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
    // Read receipts (docs/RECEIPTS_ACCEPTANCE.md): QA drives the reading side through these.
    receipts: receiptsHook,
  };
}

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
    await receiptsModule.setSendReadReceipts(client, on);
    useReceiptStore.setState((s) => ({ settingsVersion: s.settingsVersion + 1 }));
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

