# Phase 2 Tickets

Priorities: **P0** = the phone demo script (docs/PHASE2_PLAN.md) breaks without it. P1 = demo noticeably better. P2 = polish / stretch. Work top-down inside your column. Estimates are focused hours. Ticket numbers continue from Phase 1 so every ID in docs/STATUS.md stays unique (Dev A resumes at 11, Dev B at 12, QA at 8; PRIN-* is new).

## Ownership map (hard rule, extends docs/TICKETS.md)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Principal | `src/app/**`, `src/store/**`, `src/lib/**` (incl. new `src/lib/audio/**`, `src/lib/native.ts`), `src/styles/**`, `index.html`, `vite.config.ts`, `capacitor.config.ts`, `android/**`, `ios/**`, `scripts/**`, `package.json`, `.env.example`, `docs/MOBILE.md`, `docs/ARCHITECTURE.md` | - |
| Dev A | `src/features/navigation/**` | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**` (new `e2e/mobile/**`, `e2e/build/**`), `playwright.config.ts`, `docs/BUGS.md`, the `test:*` script lines in `package.json` | anything else |

Shared-layer needs go in your report as **Request to Principal: file, function, shape, why**, exactly as in Phase 1. Dev A and Dev B build against the Shared API table below from day 1; the shapes are the contract even before the code lands.

## Shared API (Principal exposes; devs consume only)
| Module | Export | Shape / rule |
|---|---|---|
| `src/store/layout.ts` | `useLayoutStore` | `{ isPhone: boolean, navOpen: boolean, membersOpen: boolean, openNav(), closeNav(), toggleNav(), openMembers(), closeMembers(), closeAll() }`. `isPhone` mirrors `matchMedia('(max-width: 767px)')` live. Opening one drawer closes the other. **`useRoomStore.selectRoom()` calls `closeNav()` when `isPhone`** (space switches via `selectSpace` do not). Phone-only: on desktop the drawers are not rendered and `useNavUiStore.membersOpen` (Dev A) keeps governing the inline member panel. |
| `src/store/hooks.ts` | `useIsPhone()` | `() => boolean` (selector over `useLayoutStore`) |
| | `useViewport()` | `() => { isPhone: boolean, width: number, height: number, keyboardOpen: boolean }` (`visualViewport` based; `keyboardOpen` = viewport shrank > 150 px) |
| `src/app/Shell.tsx` | phone branch | `app-shell[data-layout="phone"]`: one column `[ChannelHeader][Conversation]`; `nav-drawer` mounts `<SpaceRail/>`, `<ChannelSidebar/>`, `<UserFooter/>` side by side (rail 72 px + list); `member-drawer` mounts `<MemberPanel roomId/>`. Drawer container (`src/app/Drawer.tsx`): overlay, `drawer-backdrop`, slide animation, swipe-to-close, Escape, Android back button via `@capacitor/app`. Devs never import `Drawer`. |
| `src/lib/native.ts` | `isNativeApp()`, `getPlatform()`, `hapticTap()` | `() => boolean`; `() => 'android' \| 'ios' \| 'web'`; `() => void` light impact via `@capacitor/haptics`, no-op on web (wrap `@capacitor/core`; all safe on web) |
| `src/lib/matrix/config.ts` | `getHsUrl()`, `setHsUrl(url)`, `hasHsUrlOverride()` | Already shipped: runtime override in `localStorage['matrix-poc.hsUrl']` -> `VITE_HS_URL` -> `http://localhost:8008`. Features never read `HS_URL` directly; `mxcToHttp` already resolves per call. |
| `src/lib/audio/encode.ts` | `pickVoiceMimeType()` | `() => string` first supported of `audio/ogg;codecs=opus`, `audio/webm;codecs=opus`, `audio/mp4`; `''` if `MediaRecorder` is missing |
| | `encodeToOggOpus(blob)` | `(Blob) => Promise<{ blob: Blob, mimetype: string }>`. Ogg/Opus when the input is Opus (remux) or re-encodable; otherwise resolves with the input blob and its own base mimetype (`audio/webm` / `audio/mp4`). Never rejects for format reasons. |
| | `decodeToPcm(blob)` | `(Blob) => Promise<AudioBuffer>` (Web Audio `decodeAudioData`) |
| | `computeWaveform(src, samples = 100)` | `(AudioBuffer \| Float32Array, number) => number[]` ints 0..1024 from peak amplitude per bucket, normalised so the loudest bucket is 1024 |
| | `baseMimetype(mime)` | `'audio/webm;codecs=opus' -> 'audio/webm'` |
| `src/lib/matrix/actions.ts` | `sendVoiceMessage(roomId, blob, meta)` | `meta: { durationMs: number, waveform: number[], mimetype: string } => Promise<eventId>`; uploads, then sends the exact content in docs/PHASE2_ACCEPTANCE.md |
| `src/lib/matrix/utils.ts` | `getVoiceMessage(event)` | `=> { mxc: string, url: string (http via mxcToHttp), durationMs: number, waveform: number[], mimetype: string, size?: number, isVoice: boolean } \| null`; non-null for any non-redacted `m.audio` with a `url`; `waveform` `[]` when absent |
| | `previewText` | `[voice message]` for voice, `[audio] <body>` for other `m.audio` |
| `src/app/theme.css` | CSS variables | `--safe-top/--safe-right/--safe-bottom/--safe-left` (`env(safe-area-inset-*, 0px)`), `--tap-target: 44px`, `--phone-header-h: 56px`, `--vvh` (visual viewport height in px, kept current by the shell) |
| `src/styles/global.css` | phone base | `100dvh` shell height with `100%` fallback, `overscroll-behavior: none`, `touch-action: manipulation`, `@media (hover: none)` is the touch signal features should use |
| `index.html` | viewport meta | `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` |

---

## Principal

| ID | P | Title | Est |
|---|---|---|---|
| PRIN-1 | P0 | Capacitor 7 scaffold + Android debug APK build | 5h |
| PRIN-2 | P0 | LAN proxy (8009) + `VITE_HS_URL` wiring + login Homeserver override + `dev:lan` | 3h |
| PRIN-3 | P0 | Layout store, `Drawer` container, phone shell branch | 6h |
| PRIN-4 | P0 | Safe area, `100dvh`, viewport meta, keyboard, status bar, touch CSS | 3h |
| PRIN-5 | P0 | Voice core: encoder spike, helpers, `sendVoiceMessage`, `getVoiceMessage` | 7h |
| PRIN-6 | P1 | iOS project generation + Info.plist + Mac handoff | 2h |
| PRIN-7 | P0 | docs/MOBILE.md + ARCHITECTURE deltas | 2h |

**PRIN-1 Capacitor scaffold** - Already in the working tree: `capacitor.config.ts` (`com.acme.matrixpoc`, `webDir: 'dist'`, `server: { androidScheme: 'http', cleartext: true }`, `android.allowMixedContent: true`, Keyboard `resize: 'native'`, StatusBar dark `#1e1f22`), `@capacitor/{core,cli,android,ios,app,keyboard,status-bar,haptics}` **7.x** (`^7.6.9`; requires **JDK 21**; 8 was rejected with the advisor because it needs Xcode 26 and API 36). Remaining: `npx cap add android`; `AndroidManifest.xml`: `INTERNET`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `usesCleartextTraffic="true"`; `android/gradle.properties` `org.gradle.java.home` to the installed JDK (only Java 8 is on PATH here); `.gitignore` for `android/app/build`, `android/.gradle`, `android/local.properties`; `src/lib/native.ts`. Scripts: `cap:sync` (`vite build && cap sync`), `cap:build:android` (exports `ANDROID_HOME`, `gradlew assembleDebug`, prints the APK path), `cap:open:android`. Verify once end to end on this machine after the JDK/SDK install; note `sdkmanager --licenses`. AC: AC-C1-1..4.

**PRIN-2 LAN proxy + homeserver override** - Promote `docs/advisor/lan-proxy.mjs` to `scripts/lan-proxy.mjs` (`npm run hs:lan`): `0.0.0.0:8009` -> `127.0.0.1:8008` (`LISTEN`/`TARGET` env), streaming bodies both ways, `keepAliveTimeout` 65 s and no request timeout (30 s `/sync` long-poll), prints `http://<LAN-IP>:8009` from `os.networkInterfaces()` (first non-internal IPv4). `.env.example` with `VITE_HS_URL`. `LoginScreen.tsx`: "Advanced" disclosure (`login-advanced-toggle`) with a Homeserver input (`login-hs-url`) bound to `getHsUrl()`/`setHsUrl()` from `config.ts` (already shipped), expanded by default when `hasHsUrlOverride()`. `dev:lan` = `vite --host` for the phone-browser Plan B. Firewall note in MOBILE.md. AC: AC-C2-1..5.

**PRIN-3 Layout store + Drawer + phone shell** - `src/store/layout.ts` per the table; `selectRoom` in `rooms.ts` calls `closeNav()` on phone; `src/app/Drawer.tsx` + css (`side`, `open`, `onClose`, `width`, `testid`; overlay with `drawer-backdrop`, `translateX` transition 200 ms, pointer-based swipe-to-close, `inert` on the main column while open, Escape); `Shell.tsx` phone branch per the table with `data-layout`; Android back button (`@capacitor/app` `backButton`: close drawers/sheets first, else `minimizeApp`); exports in `src/store/index.ts`. AC: AC-M1-1..4, AC-M2-1/3/4 (container half), AC-M4-1/2 (container half).

**PRIN-4 Safe area + viewport + keyboard** - `index.html` meta; `theme.css` variables; `global.css` `100dvh`/fallback, `overscroll-behavior`, `touch-action`, tap highlight; `--vvh` from `visualViewport` resize in the shell; StatusBar and Keyboard (`resize: 'native'`) are already configured in `capacitor.config.ts`, verify they apply on native via `isNativeApp()`; 16 px minimum on `.u-input`. AC: AC-M6-1..3 (4/5 manual).

**PRIN-5 Voice core** - Step 1, **spike (time-box 2 h)**: `MediaRecorder` WebM/Opus blob -> Ogg/Opus via `mediabunny` (WebM in, Ogg out, audio track copied, no re-encode). Exit: output starts with `OggS`, plays in Chromium `<audio>`, size within 20 % of input. Pass -> implement `encodeToOggOpus` on it. Fail -> switch to `opus-recorder` (WASM, live encode) and give Dev B a `createOpusRecorder(stream)` adapter instead; record the outcome in STATUS and PHASE2_PLAN. Step 2: `src/lib/audio/encode.ts` per the table; `sendVoiceMessage` (`uploadContent` with `type` = mimetype, `name` per extension, then the contract content); `getVoiceMessage` + `previewText` in `utils.ts`; `isDisplayableEvent` already keeps `m.room.message`. Unit-check the waveform helper with a synthetic buffer (100 samples, max 1024). AC: AC-V2-2..4 (shape half), AC-V4-1/3/4 (parsing half).

**PRIN-6 iOS project** - `@capacitor/ios`, `npx cap add ios` (template only on Windows), `Info.plist`: `NSMicrophoneUsageDescription`, `NSAppTransportSecurity/NSAllowsArbitraryLoads`; `npx cap copy ios` must pass here; commit `ios/` minus `Pods/`. AC: AC-C3-1..3.

**PRIN-7 docs/MOBILE.md** - Prerequisites (winget ids for JDK 21 + cmdline-tools, `sdkmanager` packages, env vars), build, install (`adb install -r` or file copy), `hs:lan` + firewall, Plan B (`dev:lan`), troubleshooting (Java PATH, licences, Gradle offline), iOS handoff (mirrors PHASE2_PLAN). ARCHITECTURE deltas: layout store, audio module, Capacitor folders. AC: AC-C1-5, AC-C3-3.

---

## Dev A - Navigation (`src/features/navigation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-A-11 | P0 | Drawer content: rail + channel/DM list laid out for the drawer | 4h |
| DEV-A-12 | P0 | Phone channel header: `header-menu`, compact title, `member-toggle` opens the member drawer | 2h |
| DEV-A-13 | P1 | Member drawer content | 2h |
| DEV-A-14 | P0 | Touch-friendly sizes (44 px targets) | 2h |
| DEV-A-15 | P1 | Dialogs as bottom sheets on phone | 3h |
| DEV-A-16 | P2 | Phone navigation polish | 2h |

**DEV-A-11 Drawer content** - `SpaceRail`, `ChannelSidebar` and their css work inside `nav-drawer` (Principal mounts them): `useIsPhone()` branch, list fills the drawer width minus the 72 px rail, section headers and footer spacing for touch, no inner horizontal scroll. Room taps call `selectRoom` as today (the store closes the drawer); space taps keep it open. Unread badges unchanged. AC: AC-M2-1/2/4/5/6/7.

**DEV-A-12 Phone header** - `ChannelHeader.tsx`: on phone render `header-menu` (hamburger, 44 px) calling `useLayoutStore.openNav()`, one-line name, topic hidden, `member-toggle` calling `openMembers()` (desktop keeps `useNavUiStore.toggleMembers()`); hidden for DMs; height `--phone-header-h`. AC: AC-M3-1..3, AC-M4-1 (open half).

**DEV-A-13 Member drawer content** - `MemberPanel` styles for the drawer (full height, 44 px rows, title row with room name), re-reads members on `useRoomStore.version` as today. AC: AC-M4-1..3.

**DEV-A-14 Touch targets** - `min-height: var(--tap-target)` on channel/DM items, rail buttons, header buttons, section toggles, dialog buttons; `@media (hover: none)` removes hover-only reveals (e.g. `channel-add` always visible on phone). AC: AC-M5-1.

**DEV-A-15 Bottom sheets** - `Dialog.tsx` renders `data-variant="sheet"` on phone: bottom-anchored, full width, handle bar, `padding-bottom: var(--safe-bottom)`, slide-up transition, backdrop tap and `dialog-close` close it; inputs 16 px. All four dialogs inherit it. AC: AC-M5-2..4.

**DEV-A-16 Polish** - `header-menu-unread` dot, drawer scroll position memory, long-press on a channel item shows its topic, active-state feedback on tap. No new AC beyond AC-M3 (P2 row).

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-B-12 | P0 | Mic button + recording bar (`useVoiceRecorder`) | 6h |
| DEV-B-13 | P0 | Send flow: encode -> upload -> event; errors and retry | 3h |
| DEV-B-14 | P0 | Voice message bubble: play/pause, scrubber, duration, waveform | 5h |
| DEV-B-15 | P0 | Phone composer + message rows | 3h |
| DEV-B-16 | P1 | Long-press message action sheet | 3h |
| DEV-B-17 | P2 | Voice polish | 3h |

**DEV-B-12 Recording** - reference pipeline: `docs/advisor/fake-mic-probe.mjs` (proven under Playwright's fake mic). `hooks/useVoiceRecorder.ts`: `getUserMedia({ audio: { echoCancellation, noiseSuppression } })`, `MediaRecorder` with `pickVoiceMimeType()` (`timeslice` 250 ms), `AudioContext` + `AnalyserNode` for `recording-level` (RMS -> 0..100 at ~15 fps), elapsed timer, states `idle | requesting | recording | encoding | sending | error | denied`, `start/stop/cancel`, auto-stop at 120 s, stop all tracks on cancel/unmount/room change. `components/VoiceRecorderBar.tsx` + css replacing the input while active (`composer-recording`, `recording-timer`, `recording-level`, `recording-cancel`, `recording-send`, `recording-error`). `Composer.tsx`: `composer-mic` shown when the input is empty; typing notifications off while recording. AC: AC-V1-1..6, AC-V5-1/3.

**DEV-B-13 Send flow** - on `recording-send`: reject < 1 s with a toast; `decodeToPcm` -> `computeWaveform` (100 samples) and `durationMs` from the buffer (fall back to the timer); `encodeToOggOpus(blob)`; `sendVoiceMessage(roomId, blob, { durationMs, waveform, mimetype })`; bar shows `encoding` then `sending`; on failure state `error` with `recording-error`, `recording-send` retries the upload with the same blob, `recording-cancel` discards. AC: AC-V2-1, AC-V5-2.

**DEV-B-14 Playback bubble** - `components/VoiceMessage.tsx` + css, mounted by `MessageBody` when `getVoiceMessage(event)` is non-null (`isVoice` or not): a single `<audio preload="metadata">` per bubble, `voice-play`/`voice-pause`, `voice-waveform` bars (SVG or flex divs, `data-samples`, min bar height for `[]`), `voice-progress` range bound to `currentTime`, `voice-duration`, `data-state`/`data-position-ms`/`data-duration-ms`/`data-mimetype` on `voice-message`; duration from the event, else from `loadedmetadata`; `error` event -> `voice-error` with a download link; 44 px play button on phone; one `AudioContext`-free implementation (plain `<audio>`). AC: AC-V3-1..5/7, AC-V4-1..4, AC-V5-4.

**DEV-B-15 Phone composer + rows** - `Composer.module.css`: bottom-anchored, `padding-bottom: var(--safe-bottom)`, 16 px input, 44 px buttons, `MAX_HEIGHT` reduced on phone; `MessageRow.module.css`/`MessageActions.module.css`: `@media (hover: none)` hides the hover toolbar and gutter time, pills >= 32 px; `MessageBody`/`ImageAttachment`: images `max-width: 100%`, `pre` scrolls inside; keep AC-B3 anchoring. AC: AC-V6-1/2/5/6/7.

**DEV-B-16 Long-press sheet** - `hooks/useLongPress.ts` (pointer events, 500 ms, cancel on > 10 px move or scroll, `touch-action: pan-y`), `components/MessageActionSheet.tsx` (`message-action-sheet`, bottom sheet reusing `MessageActions` buttons and permissions, own overlay `message-action-sheet-backdrop`; `drawer-backdrop` is the Principal's), haptic via `hapticTap()` from `src/lib/native.ts`. AC: AC-V6-3/4.

**DEV-B-17 Voice polish** - only one bubble playing at a time (AC-V3-6, promote to P1 if time), optional preview-before-send (play back before `recording-send`), 1x/1.5x/2x speed, remember playback position per event, "Recording..." typing-style hint for others (P2). No new AC beyond AC-V3-6.

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est |
|---|---|---|---|
| QA-8 | P0 | `mobile` Playwright project + mobile fixtures | 3h |
| QA-9 | P0 | Voice-note suite (AC-V*) with API verification | 5h |
| QA-10 | P1 | Mobile navigation suite (AC-M*) | 3h |
| QA-11 | P0 | Mobile smoke = phone demo script, screenshots | 3h |
| QA-12 | P0 | Android build check | 2h |
| QA-13 | P1 | Bug format update for phone work | 1h |

**QA-8 Mobile project** - `playwright.config.ts`: project `mobile` = `devices['Pixel 7']`, `testMatch: /e2e\/mobile\/.*\.spec\.ts/`, `permissions: ['microphone']`; project `chromium` gets `testIgnore` for `e2e/mobile/**` and `e2e/build/**`; global `launchOptions.args`: `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--autoplay-policy=no-user-gesture-required` (harmless to desktop). `e2e/fixtures/mobile.ts`: `tap(page, testid)`, `openDrawer(page)`, `closeDrawer(page)`, `longPress(page, locator, ms)` via CDP `Input.dispatchTouchEvent`, `denyMicrophone(page)` (`addInitScript` stubbing `getUserMedia` to reject `NotAllowedError`), `bbox` size assertions. Start from `docs/advisor/fake-mic-probe.mjs` for the launch flags and the headless-shell vs full-Chromium check. Scripts: `test:e2e:mobile`, `test:e2e:apk` (request to Principal for the lines; QA edits only those). AC covered: harness for everything below.

**QA-9 Voice suite** - `e2e/mobile/voice.spec.ts`: AC-V1-1..5, AC-V2-1..4 (fetch the settled event via `ApiUser.getEvent`, assert the contract field by field, download the mxc with `fetch` and check magic bytes + `Content-Type`), AC-V3-1..5, AC-V4-1/2/4, AC-V5-1/2/4. Bob's fixture: extend `e2e/fixtures/make-test-assets.mjs` to synthesise `test-voice.wav` (1.5 s, 440 Hz, PCM16 mono, no ffmpeg on this machine) and `ApiUser.sendVoice(roomId, wavPath, waveform)` in `matrix-api.ts` uploading via `/_matrix/media/v3/upload` with `Content-Type: audio/wav` and sending the contract shape. AC-V2-5 and AC-V4-3 as P1 at the end. Note in the spec header which criteria are manual.

**QA-10 Mobile navigation suite** - `e2e/mobile/navigation.spec.ts`: AC-M1-1..4, AC-M2-1..7, AC-M3-1..3, AC-M4-1..3, AC-M5-1..4, AC-M6-1..3 (CSS/computed-style checks), AC-V6-1/2/5 (layout half of Dev B's rows). Desktop regression: run `npm run test:e2e` once after the shell lands and record the result in STATUS.

**QA-11 Mobile smoke** - `e2e/mobile/smoke.spec.ts`: serial walk of the phone demo script steps 1-10 (step 6 with the fake mic, step 8 against the bob fixture), full-page screenshot per step into `e2e/results/demo-mobile/` even when green (stakeholder pre-read of the phone look). Fresh-seed-sensitive steps (badge `3`) use `requireFreshSeed` and skip on a dirty seed like Phase 1. Must pass before the Wave 6 device pass.

**QA-12 Android build check** - `e2e/build/android-apk.spec.ts` in a browserless `build` project (`npm run test:e2e:apk`): skips with a reason when `JAVA_HOME`/`ANDROID_HOME` are unset; otherwise runs `npm run cap:build:android` with `VITE_HS_URL=http://10.0.0.5:8009` (10 min timeout), asserts the APK exists and is > 1 MB, extracts it (`tar -xf` works on Windows zips) to `e2e/tmp/apk/`, greps the baked URL in `assets/public/assets/*.js`, runs `aapt dump permissions` / `aapt dump badging` from `$ANDROID_HOME/build-tools/*/` for the three permissions and `usesCleartextTraffic`. AC: AC-C1-1..4, AC-C3-1/2 (plist and `cap copy ios` as cheap file checks).

**QA-13 Bug format** - docs/BUGS.md: add a `Platform` column (`web-desktop` / `web-mobile-emulated` / `android-device` / `ios-device`) and a `Manual` flag, a "Phase 2" section, and the device-report template the stakeholder fills in (device model, Android version, WebView version from `chrome://version` in the WebView or Play Store "Android System WebView", steps, screenshot). Every failing mobile criterion and every device finding gets a row.

## P0 set (phone demo works with exactly these)
PRIN-1, 2, 3, 4, 5, 7 · DEV-A-11, A-12, A-14 · DEV-B-12, B-13, B-14, B-15 · QA-8, QA-9, QA-11, QA-12. Total **64 h** (Principal 26 h, A 8 h, B 17 h, QA 13 h). The Principal is the critical path in Wave 4 (everything in the Shared API table); Dev A finishes early and then takes DEV-B-16 (long-press sheet) if Dev B is behind, coordinating file names via STATUS notes as in Phase 1. P1 (member drawer, sheets, iOS project, nav suite, bug format): 13 h. P2: 5 h.
