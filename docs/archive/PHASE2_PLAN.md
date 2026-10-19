# Phase 2 Plan: Phone POC (Capacitor) + Voice Notes

Phase 1 shipped the desktop three-column web client (docs/archive/PLAN.md, docs/archive/DEMO.md). Phase 2 wraps the same code in Capacitor so the stakeholder can hold it on a phone, and adds voice notes. Tickets: docs/archive/PHASE2_TICKETS.md. Criteria and testids: docs/archive/PHASE2_ACCEPTANCE.md. Status: docs/STATUS.md "Phase 2".

## Goals
1. **Android and iOS phone POCs "to evaluate" the look and feel.** Android debug APK built on this machine; iOS project generated here and finished on a Mac (handoff below).
2. **Voice notes.** Record from the composer, send as a Matrix voice message (MSC3245 / MSC1767 shape, Element-compatible), play back inline with a waveform.
3. **Phone layout (prerequisite).** Drawer navigation (space rail + channel/DM list), full-screen conversation, bottom-anchored composer, 44 px touch targets, safe-area aware.

## What "lands well" means (phone evaluation)
1. The stakeholder installs the APK, logs in as alice and completes the phone demo script below with no crash, blank screen, dead tap, or pinch-zoom needed.
2. It reads as Discord mobile: drawer with rail + channel list, full-screen chat, composer pinned to the bottom above the keyboard, rows and buttons sized for thumbs.
3. A voice note recorded on the phone plays back on the phone, in the desktop web client, and in Element Web (same homeserver) with a waveform.
4. `npm run test:e2e` stays green for the Phase 1 suite; the new `mobile` Playwright project (Pixel 7 emulation, fake microphone) is green; `npm run cap:build:android` produces an APK on this machine.
5. The iOS project opens in Xcode on a Mac with the documented steps and nothing left to figure out.

## In scope
| Area | Owner | Deliverable |
|---|---|---|
| Capacitor | Principal | Capacitor 7 scaffold (already in the working tree; 8 needs Xcode 26 and API 36), `capacitor.config.ts`, `android/` + `ios/` projects, `cap:*` scripts, debug APK build, docs/MOBILE.md |
| LAN access | Principal | `scripts/lan-proxy.mjs` (0.0.0.0:**8009** -> 127.0.0.1:8008; Synapse already holds 8008 on loopback and a wildcard bind on the same port is unreliable on Windows), `VITE_HS_URL` baked at build time, runtime "Homeserver" override on the login screen (`getHsUrl()`), `dev:lan` fallback |
| Responsive shell | Principal | `useLayoutStore` (`isPhone`, drawer state), `useViewport()`, `Drawer` container, phone shell branch, safe-area / `100dvh` / viewport meta / keyboard handling |
| Voice core | Principal | Encoding helper (Ogg/Opus with fallback), waveform helper, `sendVoiceMessage`, `getVoiceMessage`, `isNativeApp` |
| Phone navigation | Dev A | Drawer content (rail + channel/DM list), header menu button, member drawer content, 44 px targets, dialogs as bottom sheets |
| Voice UI + phone conversation | Dev B | Mic button, recording bar (timer, level meter, cancel, send), playback bubble (play/pause, scrubber, duration, waveform), bottom composer, long-press action sheet |
| QA | QA | `mobile` Playwright project, voice suite with fake media + API verification, drawer suite, mobile smoke with screenshots, APK build check, bug format update |

## Out of scope
Push notifications · E2EE · voice/video calls · background audio / lock-screen playback · app-store or TestFlight release, signing, icons beyond the default · iOS build on this machine · tablet layouts · landscape polish · voice transcription · search, threads, presence (unchanged from Phase 1) · any change to the running homeserver.

## Phone demo script (stakeholder, Android device on the same Wi-Fi as the PC)
Prep by us: homeserver up and seeded, `npm run hs:lan` running (prints the PC's LAN IP), APK built with `VITE_HS_URL=http://<LAN-IP>:8009`, APK copied to the phone and installed ("install unknown apps" allowed). If the IP changed since the build, the login screen's **Advanced > Homeserver** field takes the new URL (persisted on the phone). A bob voice note has been posted to `#general` via the API (QA fixture) so there is something to play that alice did not record.

| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Open the app, log in as `alice` / `password123` | Loading screen, then `#general` full-screen within 3 s: compact header (menu button, `#general`, members button), messages, composer with a mic button pinned to the bottom. Nothing hidden under the status bar or the gesture bar. |
| 2 | Tap the menu button (or swipe from the left edge) | A drawer slides in covering most of the screen: space rail on its left (Home, Acme HQ, Gaming), channel list on its right with `#random` badge **3**. Tap outside it to close. |
| 3 | Open the drawer, tap `#random` | Drawer closes by itself, `#random` opens, the badge is gone the next time the drawer opens. |
| 4 | Back in `#general`, scroll up | Grouped messages, bold text, code block, link, image, reply quote, reaction pills, all readable at phone width with no horizontal scrolling. |
| 5 | Tap the composer, type `Hello from my phone`, send | Keyboard rises, composer stays visible above it, message appears at the bottom under alice, keyboard does not cover the last message. |
| 6 | Tap the mic, allow microphone access, speak for a few seconds, tap send | Recording bar replaces the input: red dot, running timer, level meter reacting to your voice. On send a voice bubble appears under alice with a waveform and a duration like `0:04`. |
| 7 | Tap play on that bubble | Your voice plays back, progress moves across the waveform, time counts up, the button becomes pause. |
| 8 | Scroll to bob's voice note (posted by us), tap play | It plays with its waveform, exactly like yours. |
| 9 | Open the drawer, tap Home, tap **Bob Ruiz** | The DM opens full-screen with `Bob Ruiz` in the header; the members button is hidden for DMs. |
| 10 | Tap the members button in a channel | A right-hand drawer lists the members with roles; tap outside to close. |

Optional on the laptop: open http://localhost:5173 or Element Web as bob and play the voice note alice just recorded (interop proof).

## Mac handoff for iOS (cannot be built on Windows)
1. Clone the repo at the Phase 2 commit; `npm install`; install Xcode 15+ and CocoaPods (`sudo gem install cocoapods`).
2. `VITE_HS_URL=http://<LAN-IP>:8009 npm run build && npx cap sync ios` (runs `pod install`). The PC must run `npm run hs:lan`; phone and PC on the same Wi-Fi. (Or leave the default and type the URL in the login screen's Advanced field.)
3. `npx cap open ios`; in Xcode select the `App` target, Signing & Capabilities: your team, and a unique bundle id if `com.acme.matrixpoc` is taken.
4. Check `ios/App/App/Info.plist` already has `NSMicrophoneUsageDescription` and `NSAppTransportSecurity > NSAllowsArbitraryLoads = true` (cleartext to the LAN IP; POC only). Both are committed by PRIN-6.
5. Run on a device (iOS 17+; iOS 18.4+ to play Ogg/Opus notes natively). Walk the phone demo script. Known differences to record: WKWebView records `audio/mp4` (AAC), not Opus (see encoding strategy); keyboard handling (the config ships Keyboard `resize: 'native'`; if the composer is still covered on iOS try `'body'` or `'ionic'` in `capacitor.config.ts`); safe-area on notched devices.
6. File findings as `ios-device` rows in docs/BUGS.md (QA-13 format).

## Encoding strategy for voice notes (decision, agreed with the advisor)
Three tiers; the event always carries the real `info.mimetype`, so every client plays what it can.

| Tier | Where | How |
|---|---|---|
| 1 Ogg/Opus (target) | Android WebView, desktop Chromium | `MediaRecorder` records `audio/webm;codecs=opus`; `encodeToOggOpus()` **remuxes** the Opus packets into an Ogg container (no decode, no re-encode, no WASM). Candidate library: `mediabunny` (pure TS, WebM in / Ogg out). PRIN-5 opens with a 1-2 h spike whose exit criterion is "recorded blob -> blob starting with `OggS` that plays in `<audio>` in Chromium". If the spike fails, Tier 1 becomes `opus-recorder` (Element Web's WASM encoder, live-encodes the mic stream) and Dev B's hook hands it the stream instead of using `MediaRecorder`. |
| 2 iOS | WKWebView | Records `audio/mp4` (AAC). Re-encoding to Opus needs a WebCodecs Opus encoder in Safari, unverified; the POC sends `audio/mp4` with the honest mimetype. Documented in the Mac handoff; Element clients play AAC. |
| 3 Native fallback | anywhere | `pickVoiceMimeType()` returns the first of `audio/ogg;codecs=opus`, `audio/webm;codecs=opus`, `audio/mp4` that `MediaRecorder.isTypeSupported` accepts; if `encodeToOggOpus` fails for any reason the native blob is sent as is. |

Playback is always `<audio src={mxcToHttp(url)}>` with `type` = event mimetype; Chromium plays Ogg/Opus, WebM/Opus and MP4/AAC; iOS 18.4+ plays Ogg/Opus. Media URLs work because `enable_authenticated_media: false` in `homeserver/homeserver.yaml` (superseded: authenticated media is now supported, see ARCHITECTURE.md "Media").

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Audio format interop (WebM/Opus on Android, MP4/AAC on iOS) | Notes not playable in Element or across phones | Three-tier strategy above; Tier 1 spike first; honest `info.mimetype`; QA checks the uploaded bytes' magic (`OggS` / `1A 45 DF A3`) through the media API (AC-V2). |
| Mixed content: with the default `https://localhost` origin, XHR to `http://<LAN-IP>:8009` is blocked regardless of cleartext | Login fails in the APK | As scaffolded (Principal's final choice): `androidScheme: 'http'` (`http://localhost` is still a secure context, so `getUserMedia` works and nothing is mixed content) plus `server.cleartext: true` and `android.allowMixedContent: true` as belt and braces; `android:usesCleartextTraffic="true"`. AC-C1-3. |
| Cleartext HTTP to the LAN IP | Blocked by Android 9+ default | Same config; Info.plist `NSAllowsArbitraryLoads` on iOS. POC only; a real deployment uses TLS. |
| JDK / SDK on this machine: only Java 8 installed at time of writing, no `JAVA_HOME`/`ANDROID_HOME`; Capacitor 7 requires **JDK 21** | Gradle build fails | Install JDK 21 + cmdline-tools; set `org.gradle.java.home` in `android/gradle.properties` (immune to PATH order); the `cap:build:android` script exports `ANDROID_HOME`; `sdkmanager --licenses` once; documented in docs/MOBILE.md. |
| Phone cannot reach the baked URL (DHCP gave the PC a new IP) | Login fails after a rebuild-free day | Login screen Advanced > Homeserver override (`matrix-poc.hsUrl`, wins over `VITE_HS_URL`; already in `src/lib/matrix/config.ts`), so no rebuild is needed to repoint the app. |
| No emulator (virtualization off), so device bugs surface late | Demo-day surprises | Playwright `mobile` project (Pixel 7, touch, fake mic) covers layout and voice; the APK check proves the build and the baked `VITE_HS_URL`; a first real-device pass by the stakeholder is scheduled before the demo with docs/BUGS.md `android-device` rows; Plan B for look-and-feel is `npm run dev:lan` + phone Chrome at `http://<LAN-IP>:5173` (layout yes, mic no: insecure context). |
| WebView microphone permission plumbing | Mic prompt never appears, `getUserMedia` rejects | `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` in `AndroidManifest.xml` (Capacitor's WebChromeClient then grants the WebView request after the runtime prompt); `NSMicrophoneUsageDescription` on iOS; Dev B shows `recording-error` on `NotAllowedError`. Manual AC-V5-3. |
| Keyboard covering the composer | Cannot type | `@capacitor/keyboard` `resize: 'native'` (shipped in `capacitor.config.ts`: the WebView is resized to the visible area on both platforms); `interactive-widget=resizes-content` in the viewport meta; `100dvh` + `visualViewport` fallback (`--vvh`). Manual AC-M6. |
| `100vh` wrong on mobile browsers | Composer below the fold | `height: 100dvh` with `100%` fallback on the shell; `overscroll-behavior: none`; body never scrolls. |
| LAN proxy and Windows Firewall | Phone cannot reach Synapse; `/sync` long-poll or uploads broken | Proxy streams request/response bodies untouched, no timeout on `/sync` (30 s+ long-poll), handles multi-MB uploads; first run triggers the firewall prompt (allow on private networks) or a `netsh advfirewall` rule in docs/MOBILE.md; `hs:lan` prints the URL to bake. Nobody restarts or reconfigures the homeserver. |
| Playwright cannot swipe, long-press, or show a soft keyboard | Gaps in automation | Every gesture has a tap path (`header-menu`, `drawer-backdrop`); long-press via CDP `Input.dispatchTouchEvent`; keyboard, safe-area and permission-prompt criteria are explicitly manual (device). |
| Phase 1 suite on a dirty seed | Fresh-seed skips | Unchanged: `requireFreshSeed` skips, never fails. Phase 2 runs are on a dirty seed by the homeserver rule. |
| Two owners on one concept (member panel open state) | Divergent behaviour | Rule in the Shared API: `useLayoutStore` owns the phone drawers only; `useNavUiStore.membersOpen` keeps the desktop panel. |

## Advisor consultations (recorded per the stakeholder's instruction)
| Topic | Options considered | Advisor's position / outcome |
|---|---|---|
| Voice encoding | (a) WASM encoder (`opus-recorder`) always; (b) native `MediaRecorder` only; (c) remux WebM/Opus -> Ogg/Opus with a pure-TS muxer, fallback native | (c) as Tier 1 with a time-boxed spike in PRIN-5, because the muxer's Ogg/Opus output could not be verified offline; `opus-recorder` is the spike's fallback; iOS sends MP4/AAC honestly; `info.mimetype` always real. Adopted. |
| Capacitor major | 6.x (JDK 17) vs 7 (JDK 21) vs 8 (JDK 21, Xcode 26, API 36) | Advisor recommended **7.x**: 8 needs Xcode 26 and API 36, which the Mac handoff cannot assume. Tree has `@capacitor/* ^7.6.9`; JDK 21 is the requirement and is pinned via `org.gradle.java.home`. Resolved. |
| Mixed content on Android | `androidScheme: 'http'` + cleartext vs `https` + `allowMixedContent: true` | Advisor: decide in the plan, not on the device. The Principal's final choice is `androidScheme: 'http'` plus `cleartext: true` and `allowMixedContent: true` (belt and braces). Resolved. |
| LAN proxy port | 8008 (brief) vs 8009 | Synapse holds `127.0.0.1:8008` and `[::1]:8008`; the Principal's advisor prototype (`docs/advisor/lan-proxy.mjs`) binds 8009. Plan uses 8009. |
| Drawer state ownership | Dev A's `useNavUiStore` vs a Principal `useLayoutStore`; who closes the drawer on room select | `useLayoutStore` for phone drawers only; the store itself closes the nav drawer when `selectedRoomId` changes, so Dev A does not have to remember it per item. Adopted. |
| Testid consolidation | the brief's `nav-drawer-open`, `nav-drawer-close`, `header-back`, `header-menu` all land on one button | One testid = one element = one action: `header-menu` opens the nav drawer, `member-toggle` (existing) opens the member drawer on phone, `drawer-backdrop` closes either; dropped names listed in the registry. Adopted. |
| Emulator-free acceptance | what can be automated without a device | Verify sent events and uploaded bytes through the Matrix API; grep the baked `VITE_HS_URL` inside the APK; mark keyboard, safe-area and permission prompts as manual device checks. Adopted. The Principal's probe `docs/advisor/fake-mic-probe.mjs` already shows `getUserMedia` + `MediaRecorder` (WebM/Opus) + `decodeAudioData` + a 100-bucket waveform working under Playwright's fake microphone in headless Chromium; Dev B and QA reuse it as the reference pipeline. |

## Sequence
| Wave | Who | Output |
|---|---|---|
| 4 | Principal | PRIN-1..5 (scaffold, proxy, layout store + Drawer + phone shell, safe-area, voice core incl. spike), then PRIN-7 docs. Dev A / Dev B / QA start their P0s on day 1 against the Shared API table (shapes are fixed by the table, not by the code landing). |
| 5 | Dev A, Dev B, QA in parallel | P0 tickets, then P1 |
| 6 | All | APK on the stakeholder's device, docs/BUGS.md triage, mobile smoke green, docs/STATUS.md final, Mac handoff package |
