/**
 * Native (Capacitor) integration, Phase 2. Every export is a no-op on the plain web, so feature code can
 * call these unconditionally.
 *
 *   isNativeApp()            true inside the Android/iOS app (Capacitor WebView), false in a browser
 *   platform()               'android' | 'ios' | 'web'
 *   initNative(opts)         once at app start (App.tsx): status bar colour/style, keyboard listeners
 *                            (`--keyboard-height` on :root + `data-keyboard="open"`), Android back button
 *   tap(style)               haptic impact ('light' default); resolves immediately on the web
 *   onAppStateChange(cb)     foreground/background callback (Capacitor `appStateChange`); returns unsubscribe
 *
 * Phase 7 (PRIN-31, Android only; every one a no-op elsewhere, never throws):
 *   startCallService(roomName)   foreground service (type microphone) + "Codec call" notification with Hang up; call it
 *                                only while the app is visible (Android 12+ refuses background starts), before room.connect
 *   stopCallService()            stops it (leave / ended)
 *   setSpeakerphone(on)          AudioManager route: loudspeaker or earpiece; `overrideSpeakerphone(fn)` for QA stubs
 *   onCallServiceHangup(cb)      the notification's Hang up action; returns unsubscribe
 * Backed by android/app/src/main/java/com/acme/matrixpoc/{CallServicePlugin,CallForegroundService}.java (a custom
 * ~100-line Capacitor plugin, no npm dependency).
 *
 * The Keyboard plugin's `resize: 'native'` (capacitor.config.ts) already shrinks the WebView when the keyboard
 * shows, so `--keyboard-height` is informational (level meters, "scroll to bottom" nudges); nothing in the shell
 * depends on it. Mic permission needs nothing here: Capacitor's BridgeWebChromeClient answers the WebView's
 * AUDIO_CAPTURE request with the runtime RECORD_AUDIO prompt because AndroidManifest.xml declares it.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';

export type NativePlatform = 'android' | 'ios' | 'web';

/** Status bar background on both platforms; matches --bg-rail in src/app/theme.css. */
export const STATUS_BAR_COLOR = '#1e1f22';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function platform(): NativePlatform {
  const p = Capacitor.getPlatform();
  return p === 'android' || p === 'ios' ? p : 'web';
}

/** Same as `platform()` (name used in docs/archive/PHASE2_TICKETS.md). */
export const getPlatform = platform;

export interface NativeInitOptions {
  /** Called with the keyboard height in px on show (> 0) and hide (0). */
  onKeyboard?(heightPx: number): void;
  /**
   * Android hardware/gesture back. Return true when you consumed it (closed a drawer / sheet); when false
   * the app is minimised (Capacitor's default would exit it on the first screen).
   */
  onBackButton?(): boolean;
}

let initialised = false;
const handles: Promise<PluginListenerHandle>[] = [];

function setKeyboardCss(heightPx: number): void {
  const root = document.documentElement;
  root.style.setProperty('--keyboard-height', `${Math.max(0, Math.round(heightPx))}px`);
  if (heightPx > 0) root.dataset.keyboard = 'open';
  else delete root.dataset.keyboard;
}

/** Idempotent. Safe to call on the web (only sets `--keyboard-height: 0px`). */
export async function initNative(opts: NativeInitOptions = {}): Promise<void> {
  if (initialised) return;
  initialised = true;
  setKeyboardCss(0);
  if (!isNativeApp()) return;

  const native = platform();
  try {
    if (native === 'android') await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    if (native === 'android') await StatusBar.setBackgroundColor({ color: STATUS_BAR_COLOR });
  } catch {
    /* StatusBar is best effort */
  }

  const onShow = (info: { keyboardHeight: number }): void => {
    setKeyboardCss(info.keyboardHeight);
    opts.onKeyboard?.(info.keyboardHeight);
  };
  const onHide = (): void => {
    setKeyboardCss(0);
    opts.onKeyboard?.(0);
  };
  try {
    handles.push(Keyboard.addListener('keyboardWillShow', onShow));
    handles.push(Keyboard.addListener('keyboardDidShow', onShow));
    handles.push(Keyboard.addListener('keyboardWillHide', onHide));
    handles.push(Keyboard.addListener('keyboardDidHide', onHide));
  } catch {
    /* Keyboard plugin unavailable */
  }

  if (native === 'android') {
    try {
      handles.push(
        CapApp.addListener('backButton', () => {
          if (opts.onBackButton?.()) return;
          void CapApp.minimizeApp();
        }),
      );
    } catch {
      /* App plugin unavailable */
    }
  }
}

const IMPACT: Record<'light' | 'medium' | 'heavy', ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
};

/** Haptic tap. No-op on the web; never throws. */
export async function tap(style: 'light' | 'medium' | 'heavy' = 'light'): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await Haptics.impact({ style: IMPACT[style] });
  } catch {
    /* no haptics on this device */
  }
}

/** Light haptic tap, fire-and-forget (name used in docs/archive/PHASE2_TICKETS.md). No-op on the web. */
export function hapticTap(): void {
  void tap('light');
}

/** Foreground/background changes (`isActive`). Returns an unsubscribe; no-op on the web. */
export function onAppStateChange(callback: (isActive: boolean) => void): () => void {
  if (!isNativeApp()) return () => undefined;
  const handle = CapApp.addListener('appStateChange', (state) => callback(state.isActive));
  return () => {
    void handle.then((h) => h.remove());
  };
}

// ---------------------------------------------------------------------------
// Phase 7: call foreground service + audio route (Android)
// ---------------------------------------------------------------------------

interface CallServicePlugin {
  start(opts: { roomName: string }): Promise<{ notifications: boolean }>;
  stop(): Promise<void>;
  setSpeakerphone(opts: { on: boolean }): Promise<{ on: boolean }>;
  addListener(event: 'hangup', cb: () => void): Promise<PluginListenerHandle>;
}

const CallService = registerPlugin<CallServicePlugin>('CallService');

function callServiceAvailable(): boolean {
  return isNativeApp() && platform() === 'android' && Capacitor.isPluginAvailable('CallService');
}

let serviceRunning = false;

/** Start the foreground call service. Resolves `{ notifications }` (false when POST_NOTIFICATIONS was denied: the
 * service still runs, the UI may warn "Calls may drop when the screen locks"). No-op on web / iOS -> `null`. */
export async function startCallService(roomName: string): Promise<{ notifications: boolean } | null> {
  if (!callServiceAvailable()) return null;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return null; // never from the background
  try {
    const res = await CallService.start({ roomName });
    serviceRunning = true;
    return res;
  } catch (e) {
    console.warn('[native] call service start failed', e);
    return null;
  }
}

export async function stopCallService(): Promise<void> {
  if (!callServiceAvailable() || !serviceRunning) return;
  serviceRunning = false;
  try {
    await CallService.stop();
  } catch {
    /* ignore */
  }
}

export function isCallServiceRunning(): boolean {
  return serviceRunning;
}

async function nativeSpeakerphone(on: boolean): Promise<void> {
  if (!callServiceAvailable()) return;
  try {
    await CallService.setSpeakerphone({ on });
  } catch (e) {
    console.warn('[native] speakerphone failed', e);
  }
}

let speakerphoneImpl: (on: boolean) => Promise<void> | void = nativeSpeakerphone;

/** Loudspeaker (`true`) or earpiece (`false`). No-op on the web (there is no earpiece; `setSinkId` is the desktop path). */
export async function setSpeakerphone(on: boolean): Promise<void> {
  await speakerphoneImpl(on);
}

/** QA / devtools: replace the route switch (`__matrixPoc.call.rtc.setSpeakerphone = fn`); `null` restores the native one. */
export function overrideSpeakerphone(fn: ((on: boolean) => Promise<void> | void) | null): void {
  speakerphoneImpl = fn ?? nativeSpeakerphone;
}

export function currentSpeakerphoneImpl(): (on: boolean) => Promise<void> | void {
  return speakerphoneImpl;
}

/** The notification's "Hang up" action. Returns an unsubscribe; no-op off Android. */
export function onCallServiceHangup(callback: () => void): () => void {
  if (!callServiceAvailable()) return () => undefined;
  const handle = CallService.addListener('hangup', callback);
  return () => {
    void handle.then((h) => h.remove()).catch(() => undefined);
  };
}
