# Mobile: phone browser, Android APK, iOS

Two ways to see the client on a phone. **Step one needs no build and works right now**; step two is the
Capacitor app. Both talk to the same local Synapse through a small LAN proxy; nothing about the homeserver
changes. Section 2 describes the toolchain on JC's Windows PC; on a Mac or Linux box install the same versions
your own way.

Refs: owner Principal (PRIN-1, 2, 6, 7); criteria docs/archive/PHASE2_ACCEPTANCE.md AC-C1..C3.

## 0. The 30-second version

```bash
npm run hs:up && npm run seed       # as in Phase 1
npm run hs:lan                      # terminal 1: LAN proxy 0.0.0.0:8009 -> 127.0.0.1:8008, prints the phone URLs
npm run dev:lan                     # terminal 2: Vite on 0.0.0.0:5173
# phone browser -> http://<PC-LAN-IP>:5173 -> Advanced -> Homeserver URL http://<PC-LAN-IP>:8009 -> alice / password123

npm run cap:build:android:lan       # the APK with http://<PC-LAN-IP>:8009 baked in (JDK + SDK: section 2)
# -> android/app/build/outputs/apk/debug/app-debug.apk ; copy to the phone or `adb install -r`
```

**Windows Firewall**: the first time node.exe binds `0.0.0.0` (proxy and Vite) Windows shows a Defender
Firewall prompt - tick **Private networks** and allow. If you dismissed it, add the rules by hand (admin shell):

```powershell
netsh advfirewall firewall add rule name="matrix-poc lan proxy 8009" dir=in action=allow protocol=TCP localport=8009 profile=private
netsh advfirewall firewall add rule name="matrix-poc vite 5173"      dir=in action=allow protocol=TCP localport=5173 profile=private
```

Phone and PC must be on the same Wi-Fi (guest networks usually isolate clients). `npm run hs:lan` lists every
IPv4 address with its adapter name; use the Wi-Fi/Ethernet one, not WSL/Hyper-V/VPN adapters.

## 1. Step one: phone browser, zero build (look and feel)

1. `npm run hs:lan` - prints, per adapter: `homeserver URL http://<ip>:8009` and `app URL http://<ip>:5173`.
2. `npm run dev:lan` - Vite listening on all interfaces (`vite --host 0.0.0.0 --port 5173`).
3. On the phone, open `http://<ip>:5173`. Login screen > **Advanced** > **Homeserver URL** = `http://<ip>:8009`
   (the field accepts `192.168.1.20:8009` and adds `http://`). The value is stored in `localStorage`
   (`matrix-poc.hsUrl`) and used for login, sync and media. Log in as `alice` / `password123`.
4. You get the phone layout: full-screen conversation, swipe from the left edge (or the header menu once
   Dev A lands it) for the drawer, member drawer from the right edge.

What this path cannot do: **record voice notes**. `getUserMedia` needs a secure context and
`http://192.168.x.x:5173` is not one (`https` for Vite does not help: the page could then not call the
plain-`http` proxy - mixed content). Playback of voice notes works. To record in a browser on the phone, either
use the APK (origin `http://localhost` inside the app *is* a secure context) or on Android Chrome enable
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` with `http://<ip>:5173`.
Phase 5: the same insecure origin has **no `crypto.subtle`**, so encrypted attachments (images, files, voice notes
in encrypted rooms) cannot be encrypted or decrypted there; text in encrypted rooms still works (the Rust engine
brings its own primitives). Same fixes: the APK, `adb reverse`, or the Chrome flag.

Alternative without Wi-Fi (Android, USB debugging on): `adb reverse tcp:5173 tcp:5173` and
`adb reverse tcp:8008 tcp:8008`, then the phone browser opens `http://localhost:5173` and the Homeserver URL is
`http://localhost:8008` - `localhost` on the phone is tunnelled to the PC. `adb` lives in
`~/android-sdk/platform-tools` after section 2.

## 2. Toolchain (what is installed on this machine, and how to redo it)

Capacitor **7.6.9** (`@capacitor/*@7`; Android template: compileSdk/targetSdk **35**, minSdk 23, AGP 8.7.2,
Gradle 8.11.1) compiles its Android library with **Java 21** (`JavaVersion.VERSION_21` in
`node_modules/@capacitor/android/capacitor/build.gradle`), so **JDK 17 is not enough** - the build fails with
`invalid source release: 21`. Nothing here needs admin rights; the winget MSI installers do (UAC), which is why
the portable zips are used.

| Piece | Where | How it got there |
|---|---|---|
| JDK | `~/jdk21` (Temurin 21.0.12.1+1) | `curl -L -o temurin21.zip "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk"`, extract, move the inner `jdk-21.*` folder's contents to `~/jdk21` |
| Android cmdline-tools | `~/android-sdk/cmdline-tools/latest` | zip from https://developer.android.com/studio#command-line-tools-only (currently `commandlinetools-win-15859902_latest.zip`), extract, rename the inner `cmdline-tools` folder to `latest` under `~/android-sdk/cmdline-tools/` |
| SDK packages | `~/android-sdk/{platform-tools,platforms/android-35,build-tools/35.0.0}` | `yes \| sdkmanager.bat --sdk_root=%USERPROFILE%\android-sdk --licenses` then `sdkmanager.bat --sdk_root=... "platform-tools" "platforms;android-35" "build-tools;35.0.0"` (needs `JAVA_HOME` pointing at the JDK) |
| Gradle | `~/.gradle` | downloaded by `gradlew` on the first build (~1.5 min with the AGP dependencies) |
| Env vars | user profile | `node scripts/toolchain.mjs --setx` = `setx JAVA_HOME C:\Users\<you>\jdk21`, `setx ANDROID_HOME C:\Users\<you>\android-sdk` (new shells only; PATH is deliberately not touched) and `org.gradle.java.home=<jdk>` in **`~/.gradle/gradle.properties`** so a plain `gradlew` / Android Studio ignores the Java 8 that is first on PATH |

Check it: `npm run toolchain` prints what was found and fails with a reason if something is missing. The build
script does the same lookup itself (env `JAVA_HOME` / `ANDROID_HOME` first, then `~/jdk21`, `~/android-sdk`,
`%LOCALAPPDATA%\Android\Sdk`, Android Studio's JBR, ...), so it works from a fresh shell without any env var.

Alternatives if you have admin rights: `winget install --id EclipseAdoptium.Temurin.21.JDK -e`,
`winget install --id Google.PlatformTools -e` (adb only); Android Studio (`winget install Google.AndroidStudio`)
brings the SDK to `%LOCALAPPDATA%\Android\Sdk`, which the scripts also find. A `Google.AndroidCLI` winget package
exists (the new `android` CLI that replaces `sdkmanager`); it was not needed.

## 3. Step two: build the Android debug APK

```bash
npm run cap:build:android:lan           # bakes VITE_HS_URL=http://<first LAN IPv4>:8009 (the hs:lan proxy)
npm run cap:build:android               # bakes VITE_HS_URL from your env, else the web default http://localhost:8008
```

Phase 4 (GIF picker): the Klipy key is baked into the APK at build time from `.env` (`VITE_GIF_API_KEY`; both `cap:build:android*`
scripts run `vite build`, which reads `.env`). Rebuild and reinstall after adding or rotating the key; anyone with the APK can
extract it from the bundle (use a Testing key or one you can revoke in the Partner Panel). Without a rebuild, set it at runtime in
the WebView: `chrome://inspect` -> console -> `localStorage.setItem('matrix-poc.gifApiKey', '<key>')`, then reopen the picker.
GIFs load straight from `https://static.klipy.com`, so the phone needs internet, not just the LAN; the mock fixtures are served
from the app bundle and work offline.

```
node scripts/cap-build-android.mjs --hs http://10.0.0.5:8009      # explicit URL
node scripts/cap-build-android.mjs --lan --install                # ...then adb install -r on the connected phone
node scripts/cap-build-android.mjs --skip-web                     # gradle only (reuse dist/ + last sync)
```

What the script does (`scripts/cap-build-android.mjs`): resolve the toolchain, write `android/local.properties`
(`sdk.dir`), write `org.gradle.java.home` to `~/.gradle/gradle.properties`, `vite build` with `VITE_HS_URL`,
`cap sync android` (copies `dist/` to `android/app/src/main/assets/public` and the plugin config),
`gradlew assembleDebug`, then prints `android/app/build/outputs/apk/debug/app-debug.apk` (~8 MB). First build
~1.5 min (Gradle + AGP download), later builds ~30 s. Exit code 2 = toolchain missing (reason printed).

Other scripts: `npm run cap:sync` (`vite build && cap sync`, both platforms), `npm run cap:open:android`
(Android Studio, if installed), `npm run cap:copy:ios` (web assets into the iOS project; works on Windows).

The baked URL is only the **default**: the login screen's Advanced field overrides it at runtime, so one APK can
follow the PC to another network.

### Install on the phone

- **USB**: enable Developer options > USB debugging on the phone, plug in, accept the RSA prompt, then
  `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` (or `--install` above). `adb devices`
  must list the phone; on Windows a vendor USB driver is sometimes needed.
- **No USB**: copy `app-debug.apk` to the phone (Quick Share / Nearby, email, USB file transfer, a browser
  download from `npx serve android/app/build/outputs/apk/debug`), open it from Files and allow
  "Install unknown apps" for that source. It is a debug build signed with the debug key; Play Protect may ask you
  to confirm.

### Point the app at the PC

1. PC: `npm run hs:lan` (keep it running; Ctrl+C stops it). Synapse itself is untouched.
2. Phone: open **Codec**. If the APK was built with `:lan` on this network the homeserver is already
   right; otherwise Advanced > Homeserver URL = `http://<PC-LAN-IP>:8009`. Log in.
3. USB alternative: `adb reverse tcp:8008 tcp:8008` and set the Homeserver URL to `http://localhost:8008`
   (no proxy, no firewall, no Wi-Fi needed; survives until the cable is unplugged).

### Live reload while developing (optional, Android only)

`adb reverse tcp:5173 tcp:5173`, `npm run dev`, and temporarily set `server.url: 'http://localhost:5173'` in
`capacitor.config.ts`, then `npx cap sync android` and run the app from Android Studio (`npm run cap:open:android`).
**Never put a LAN IP in `server.url`**: the WebView origin stops being `localhost`, `navigator.mediaDevices`
disappears (insecure context) and localStorage is a different origin. Revert before building an APK. Do not use
this on iOS.

## 4. iOS on a Mac (cannot be built on Windows)

What is already in the repo: `ios/App` generated by `npx cap add ios` (Capacitor 7, CocoaPods project),
`ios/App/App/Info.plist` with `NSMicrophoneUsageDescription` and `NSAppTransportSecurity > NSAllowsArbitraryLoads = true`
(POC only: cleartext to the LAN proxy; a real build uses TLS and drops it), `npx cap copy ios` verified on Windows
(`ios/App/App/public/index.html`, AC-C3-2). `cap sync ios` on Windows skips `pod install` with a warning - expected.

On the Mac (mirrors docs/archive/PHASE2_PLAN.md "Mac handoff"):

1. Xcode 16+ (Capacitor 7 requirement) and CocoaPods (`sudo gem install cocoapods` or `brew install cocoapods`).
   Node 22+. Clone the repo at the Phase 2 commit, `npm install`.
2. PC on the same Wi-Fi runs `npm run hs:lan`. On the Mac:
   `VITE_HS_URL=http://<PC-LAN-IP>:8009 npm run build && npx cap sync ios` (runs `pod install`).
3. `npm run cap:open:ios` (`npx cap open ios`). Target **App** > Signing & Capabilities: your team; change the
   bundle id if `com.acme.matrixpoc` is taken by another team.
4. Run on a device (iOS 17+; iOS 18.4+ plays Ogg/Opus natively). Phone demo script: docs/archive/PHASE2_PLAN.md.
5. Expected differences to record in docs/BUGS.md (`ios-device` rows): WKWebView records `audio/mp4` (AAC),
   not Opus - the event says so in `info.mimetype`; WebM/Opus notes from Android may not play in WKWebView
   (`voice-error` with download link); keyboard uses `@capacitor/keyboard` `resize: 'native'`;
   `env(safe-area-inset-bottom)` is non-zero on home-indicator devices (the composer pads for it).

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| App shows "Cannot reach the homeserver at http://..." | Proxy not running (`npm run hs:lan`), wrong IP (use the Wi-Fi adapter's), firewall (section 0), phone on another network. Test from the phone browser: `http://<ip>:8009/_matrix/client/versions` must return JSON. |
| `net::ERR_CLEARTEXT_NOT_PERMITTED` in the WebView | `android:usesCleartextTraffic="true"` missing from `android/app/src/main/AndroidManifest.xml` or `server.cleartext` / `androidScheme: 'http'` missing from `capacitor.config.ts`; re-run `cap sync`. |
| Mic button does nothing / `NotAllowedError` | `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` must be in the manifest (they are); Capacitor's `BridgeWebChromeClient.onPermissionRequest` then shows the runtime prompt. Denied once: Android Settings > Apps > Codec > Permissions > Microphone. In a phone *browser* at `http://<ip>:5173` recording is impossible (insecure context, section 1). |
| Keyboard covers the composer | Android resizes the WebView by default; check the viewport meta still has `interactive-widget=resizes-content` and that nothing sets `windowSoftInputMode` to `adjustPan`. iOS: `Keyboard.resize` is `native` in `capacitor.config.ts`. `--keyboard-height` / `--vvh` on `:root` and `useViewport().keyboardOpen` are available to feature code. |
| `invalid source release: 21` / `Unsupported class file major version` | Gradle is running on Java 8 or 17. `npm run toolchain` must show Java 21; run `node scripts/toolchain.mjs --setx`; the scripts set `JAVA_HOME` themselves. |
| `SDK location not found` | `ANDROID_HOME` unset and `android/local.properties` missing; the build script writes it, or `setx ANDROID_HOME`. |
| `Failed to install the following Android SDK packages as some licences have not been accepted` | `yes \| ~/android-sdk/cmdline-tools/latest/bin/sdkmanager.bat --sdk_root=%USERPROFILE%\android-sdk --licenses` |
| `Could not resolve com.android.tools.build:gradle` / Gradle download stuck | First build needs internet (~400 MB). Behind a proxy: `~/.gradle/gradle.properties` `systemProp.https.proxyHost=...`. |
| `port 8009 is already in use` | Another `hs:lan`; `LAN_PROXY_PORT=8019 npm run hs:lan` (then use `:8019` everywhere, or `--hs`). |
| Phone browser cannot open `http://<ip>:5173` | `npm run dev:lan` (not `npm run dev`), firewall rule for 5173, same Wi-Fi. |
| White screen in the APK | `dist/` was stale or missing when syncing: `npm run cap:build:android:lan` rebuilds and re-syncs. Check `adb logcat -s Capacitor Console`. |
| APK installs but opens the desktop layout | Only on tablets wider than 1023 px; the breakpoint is `(max-width: 767px)` or coarse pointer up to 1023 px (`src/store/layout.ts`). |
| `cap sync` warns about CocoaPods / xcodebuild on Windows | Expected; iOS native deps are installed on the Mac (section 4). |
| A proxy / Vite started in the background will not die (`pkill` finds nothing on Windows) | Stop it by port: `netstat -ano \| findstr :8009` (or `:5173`), then `taskkill /PID <pid> /F /T`. |
| Gradle daemon keeps running after a build | Harmless (idles out after 3 h); `cd android && gradlew --stop` (with `JAVA_HOME` set) stops it. |

## 6. What the LAN proxy is (and is not)

`scripts/lan-proxy.mjs` (promoted from the advisor's `docs/advisor/lan-proxy.mjs`): a Node `http` pass-through
on `0.0.0.0:8009` to `127.0.0.1:8008`, streaming request and response bodies, `keepAliveTimeout` 65 s and no
request timeout so `/sync?timeout=30000` long-polls pass through, `Host` rewritten to the target, everything
else untouched (Synapse already answers CORS). It does not terminate TLS, cache, or rewrite URLs; Synapse's
`public_baseurl` stays `http://localhost:8008/` (only affects `.well-known`, which is off). Env:
`LAN_PROXY_PORT` (8009), `LAN_PROXY_HOST`, `HS_TARGET` (`127.0.0.1:8008`), `APP_PORT` (5173, printed only).

## 7. Voice calls on Android

A call must survive the screen locking and the app going to the background, which Android only allows for a
**foreground service** holding the microphone. Codec ships its own small Capacitor plugin instead of an npm one
(`android/app/src/main/java/com/acme/matrixpoc/CallServicePlugin.java` + `CallForegroundService.java`, Java so
no Kotlin Gradle plugin is needed; registered in `MainActivity.onCreate` before `super.onCreate`).

| Piece | What it does |
|---|---|
| `CallForegroundService` | `startForeground(..., FOREGROUND_SERVICE_TYPE_MICROPHONE)` with a low-importance "Codec call" notification (channel `codec_call`, ongoing, category call) carrying a **Hang up** action, plus a partial wake lock (4 h cap). `ACTION_STOP` / `stopService` ends it and removes the notification. |
| `CallServicePlugin` (`CallService` in JS) | `start({ roomName })`: on Android 13+ requests `POST_NOTIFICATIONS` first (a denial still starts the service, the notification is just not shown: AC-R9-5), then `startForegroundService`. `stop()`. `setSpeakerphone({ on })`: `AudioManager.MODE_IN_COMMUNICATION` + `setCommunicationDevice` (API 31+, built-in speaker vs earpiece) or `setSpeakerphoneOn` below. The Hang up action reopens `MainActivity` with `ACTION_HANGUP`, which forwards it as the plugin's `hangup` event. |
| `src/lib/native.ts` | `startCallService(roomName)` (no-op unless Android **and** `document.visibilityState === 'visible'`: Android 12+ refuses background starts), `stopCallService()`, `setSpeakerphone(on)`, `onCallServiceHangup(cb)`; all no-ops on web / iOS. |
| `src/store/call.ts` | `begin()` (Call / Accept / Join taps) starts the service before the session takes the mic and connects; the `ended` snapshot and a failed start stop it; `hangup` -> `leaveCall()`; `setSpeaker('speaker' | 'earpiece')` -> the shim. |

Manifest (`AndroidManifest.xml`, AC-R9-3): `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `WAKE_LOCK`,
`POST_NOTIFICATIONS`, `BLUETOOTH_CONNECT` and `<service android:name=".CallForegroundService"
android:foregroundServiceType="microphone" android:exported="false" />`. `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS`
were already there for voice notes.

### Lock-screen test (AC-R9-4, manual, real phone)
1. Build and install the APK (section 3), log in, open the alice/bob DM; have the other side on a laptop.
2. Receive a call and tap Accept (or tap the phone icon yourself): the "Codec call" notification appears at once
   (Android 13+: the notification permission prompt first; deny it once to check the call still runs).
3. Lock the screen for 2 minutes, then switch to another app for 2 minutes: audio keeps flowing both ways, the
   timer on the laptop keeps counting.
4. Pull the shade and tap **Hang up**: the app comes to the front, the call ends on both sides and the notification
   is gone within 2 s; "Call ended, 4 min" shows in the DM.
5. `adb shell dumpsys activity services com.acme.matrixpoc` shows no `CallForegroundService` after the call.
6. Speaker: the `call-speaker` button toggles between earpiece and loudspeaker without a glitch; a Bluetooth headset
   connected before the call is used automatically (`BLUETOOTH_CONNECT`).

`npm run test:android-build` checks the manifest permissions and service once the SDK is installed (section 2); on a
machine without `~/android-sdk` / `ANDROID_HOME` it skips with a reason.
