/**
 * Dev-only window hooks (`import.meta.env.DEV`; tree-shaken out of production builds).
 *
 *   window.__matrixPoc = { layout, rooms, session, timeline, threads, getClient, getVoiceMessage, getHsUrl,
 *                          actions, utils, openThread, closeThread, getThreadSummary, getThreadModel, gif, voice, ... }
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
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { getHsUrl } from '@/lib/matrix/config.ts';
import * as actions from '@/lib/matrix/actions.ts';
import * as utils from '@/lib/matrix/utils.ts';
import { getDisplayBody, getVoiceMessage } from '@/lib/matrix/utils.ts';
import { analyzeAudio, encodeToOggOpus, pickRecordingMimeType } from '@/lib/audio/index.ts';
import { voiceSendDebug } from '@/features/conversation/hooks/useVoiceRecorder.ts';
import * as gif from '@/lib/gif/index.ts';
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
  };
}
