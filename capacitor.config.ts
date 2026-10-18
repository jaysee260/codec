/// <reference types="@capacitor/keyboard" />
import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

/**
 * Capacitor 7 config (Phase 2, PRIN-1). The web build in `dist/` is wrapped unchanged; runtime
 * mobile behaviour lives in src/lib/native.ts, build-time behaviour here.
 *
 * POC-only relaxations (remove for anything beyond a demo):
 *  - server.androidScheme 'http': the app is served from http://localhost (still a secure context, so
 *    getUserMedia works) instead of https://localhost, so XHR to the plain-http LAN proxy
 *    (scripts/lan-proxy.mjs) is not mixed content. AC-C1-3.
 *  - server.cleartext + android.allowMixedContent: belt and braces for the same reason; the manifest
 *    also carries android:usesCleartextTraffic="true".
 *  - ios/App/App/Info.plist carries NSAllowsArbitraryLoads for the same reason.
 *
 * Never set `server.url` to a LAN IP: the origin stops being localhost and navigator.mediaDevices
 * disappears. Live reload only via `adb reverse tcp:5173 tcp:5173` + server.url http://localhost:5173
 * (docs/MOBILE.md), and never on iOS.
 */
const config: CapacitorConfig = {
  appId: 'com.acme.matrixpoc',
  appName: 'Codec',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  ios: {
    // The shell paints its own safe-area padding from env(safe-area-inset-*); do not let iOS inset the web view.
    contentInset: 'never',
  },
  plugins: {
    Keyboard: {
      // iOS only (Android always resizes the WebView). 'native' resizes the WebView frame, so 100dvh / 100%
      // and env() follow the keyboard; 'body' only shrinks <body> and leaves dvh untouched (advisor).
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#1e1f22',
    },
  },
};

export default config;
