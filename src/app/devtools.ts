/**
 * Dev-only window hooks (`import.meta.env.DEV`; tree-shaken out of production builds).
 *
 *   window.__matrixPoc = { layout, rooms, session, timeline, getClient, getVoiceMessage, getHsUrl }
 *
 * Used by scripts/verify-phone-shell.mjs (open the nav drawer for a screenshot, round-trip a voice event
 * through the real parser) and handy in the browser console. Never referenced by product code.
 */
import { useLayoutStore } from '@/store/layout.ts';
import { useRoomStore } from '@/store/rooms.ts';
import { useSessionStore } from '@/store/session.ts';
import { useTimelineStore } from '@/store/timeline.ts';
import { getClientOrNull } from '@/lib/matrix/client.ts';
import { getHsUrl } from '@/lib/matrix/config.ts';
import { getDisplayBody, getVoiceMessage } from '@/lib/matrix/utils.ts';
import { analyzeAudio, pickRecordingMimeType } from '@/lib/audio/index.ts';
import { isNativeApp, platform } from '@/lib/native.ts';

export function installDevHooks(): void {
  (window as unknown as { __matrixPoc?: unknown }).__matrixPoc = {
    layout: useLayoutStore,
    rooms: useRoomStore,
    session: useSessionStore,
    timeline: useTimelineStore,
    getClient: getClientOrNull,
    getHsUrl,
    getVoiceMessage,
    getDisplayBody,
    analyzeAudio,
    pickRecordingMimeType,
    isNativeApp,
    platform,
  };
}
