/**
 * Phase 7: the livekit-client frame-encryption worker, bundled by Vite (`?worker` on the package's `e2ee-worker`
 * export; dev serves it as a module worker, the build emits a separate chunk). Works from the Capacitor
 * `http://localhost` origin like `getUserMedia` does (Advisor B3). `isE2EESupported()` is livekit's own check for
 * Insertable Streams (Chromium, Android WebView) or `RTCRtpScriptTransform` (Firefox, Safari).
 */
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { isE2EESupported } from 'livekit-client';

export function createE2EEWorker(): Worker {
  return new E2EEWorker();
}

export function mediaEncryptionSupported(): boolean {
  try {
    return isE2EESupported();
  } catch {
    return false;
  }
}
