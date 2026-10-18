# Phase 2 Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md (its conventions, registry and criteria stay in force). Numbering `AC-<group>-<n>`: **AC-C\*** Capacitor/build, **AC-M\*** phone shell/navigation, **AC-V\*** voice notes. Each group names the tickets it belongs to (docs/PHASE2_TICKETS.md). Unless stated, "phone" = the Playwright `mobile` project (Pixel 7 descriptor: 412x839 CSS px, touch, `isMobile`), logged in as alice, dirty seed allowed. "desktop" = the existing `chromium` project. Criteria marked **manual (device)** cannot be automated here (no emulator) and are checked by the stakeholder or on the Mac; QA lists them in the mobile smoke report as "not run here".

## Voice message event (the contract Dev B, Principal and QA code against)
`sendVoiceMessage` sends exactly this `m.room.message` content; `getVoiceMessage` parses it (and tolerates other clients' variants).

```json
{
  "msgtype": "m.audio",
  "body": "Voice message",
  "url": "mxc://localhost/abcDEF",
  "info": { "duration": 3120, "mimetype": "audio/ogg", "size": 14023 },
  "org.matrix.msc1767.text": "Voice message",
  "org.matrix.msc1767.file": { "url": "mxc://localhost/abcDEF", "name": "Voice message.ogg", "mimetype": "audio/ogg", "size": 14023 },
  "org.matrix.msc1767.audio": { "duration": 3120, "waveform": [0, 12, 310, 1024, 540] },
  "org.matrix.msc3245.voice": {}
}
```
Rules: `duration` is integer **milliseconds** (same value in `info` and `msc1767.audio`); `waveform` is **about 100** integers (accepted range 30..120 samples) each in `0..1024`, computed from peak amplitude per bucket; `mimetype` is the real container type without codec parameters (`audio/ogg`, `audio/webm`, `audio/mp4`; `audio/wav` for the QA fixture); `name` extension follows the mimetype (`.ogg` / `.webm` / `.m4a` / `.wav`); `size` is the uploaded byte length; unencrypted (no `file.key`). Reading: `isVoice` = `org.matrix.msc3245.voice` present; duration from `msc1767.audio.duration`, else `info.duration`, else `0` (then the player reads it from the `<audio>` element); missing waveform = `[]`.

## Test ID registry (additions)
Conventions as docs/ACCEPTANCE.md. **Dropped from the brief's example list** (same button, one name): `nav-drawer-open`, `nav-drawer-close`, `header-back`. Open with `header-menu`, close with `drawer-backdrop`.

### Shell (Principal, `src/app/**`)
| testid | Element |
|---|---|
| `app-shell` (+`data-layout="phone\|desktop"`) | Existing root; attribute follows `useLayoutStore.isPhone` |
| `nav-drawer` (+`data-open="true\|false"`) | Left drawer container, phone only; holds `space-rail`, `channel-sidebar`, `current-user`/`logout-button` |
| `member-drawer` (+`data-open`) | Right drawer container, phone only; holds `member-list` |
| `drawer-backdrop` | Overlay behind an open `nav-drawer` / `member-drawer`; tap closes (dialogs and the action sheet have their own overlays) |
| `login-advanced-toggle`, `login-hs-url` | "Advanced" disclosure on the login form and the Homeserver URL input (runtime override, `matrix-poc.hsUrl`) |

### Navigation (Dev A, `src/features/navigation/**`)
| testid | Element |
|---|---|
| `header-menu` | Phone-only button at the left of `channel-header`; opens `nav-drawer` |
| `header-menu-unread` | Dot on `header-menu` when another room is unread (P2) |
| `member-toggle` | Existing. On phone opens `member-drawer`; on desktop toggles the inline panel as before. Absent for DMs. |
| `*-dialog` (+`data-variant="sheet\|modal"`) | Existing dialogs; `sheet` on phone (bottom-anchored), `modal` on desktop |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `composer-mic` (+`data-state="idle\|requesting\|denied"`) | Mic button in the composer; visible when the input is empty |
| `composer-recording` (+`data-state="recording\|encoding\|sending\|error"`) | Recording bar replacing the input |
| `recording-timer` | Elapsed `m:ss` |
| `recording-level` (+`data-level` 0..100) | Live input level meter |
| `recording-cancel`, `recording-send` | Discard / stop-and-send |
| `recording-error` | Inline error text in the bar (permission denied, upload failed) |
| `voice-message` (+`data-state="idle\|loading\|playing\|paused\|error"`, `data-duration-ms`, `data-position-ms`, `data-mimetype`) | Playback bubble inside `message-{eventId}` |
| `voice-play` / `voice-pause` | One button; testid follows state |
| `voice-progress` | `<input type="range" min=0 max={durationMs}>` scrubber (`aria-valuenow` = position ms) |
| `voice-duration` | `m:ss`: total when idle, elapsed while playing/paused |
| `voice-waveform` (+`data-samples`) | Bar chart; one bar per waveform sample (flat bars when `[]`) |
| `voice-error` | "Can't play this voice message" + download link |
| `message-action-sheet`, `message-action-sheet-backdrop` | Bottom sheet opened by long-press on phone (contains the existing `message-action-*` buttons) and its own overlay (Dev B cannot render the Principal's `drawer-backdrop`) |

## Criteria

### AC-C1 Capacitor scaffold and Android APK (PRIN-1, PRIN-7; verified by QA-12)
| ID | Given / When / Then |
|---|---|
| AC-C1-1 | Given JDK 21 and the Android SDK installed per docs/MOBILE.md, when `npm run cap:build:android` runs, then it exits 0 within 10 min and `android/app/build/outputs/apk/debug/app-debug.apk` exists and is > 1 MB. (Skips with reason when `JAVA_HOME`/`ANDROID_HOME` are unset.) |
| AC-C1-2 | Given the APK built with `VITE_HS_URL=http://10.0.0.5:8009`, when unzipped, then `assets/public/index.html` exists and some `assets/public/assets/*.js` contains `http://10.0.0.5:8009`. |
| AC-C1-3 | Given the APK, then `aapt dump permissions` lists `android.permission.INTERNET`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`; the manifest has `usesCleartextTraffic=true`; `capacitor.config.ts` sets `server.androidScheme: 'http'`, `server.cleartext: true` and `android.allowMixedContent: true`; `package.json` has `@capacitor/core` at `^7`. |
| AC-C1-4 | Given `npm run build` with no `VITE_HS_URL`, then `dist/assets/*.js` still contains `http://localhost:8008` (desktop unchanged) and `npm run test:e2e` (chromium) is unaffected. |
| AC-C1-5 | docs/MOBILE.md covers: prerequisites and env vars, `cap:*` scripts, build, install (`adb install` or file copy), `hs:lan`, firewall, Java-on-PATH troubleshooting, iOS handoff. |
| AC-C1-6 | **manual (device)** Install the APK, open it: login form within 3 s, no white screen; log in as alice through the LAN proxy; `#general` renders. |

### AC-C2 LAN proxy (PRIN-2)
| ID | Given / When / Then |
|---|---|
| AC-C2-1 | Given Synapse on 127.0.0.1:8008, when `npm run hs:lan` starts, then it listens on `0.0.0.0:8009`, prints `http://<LAN-IP>:8009`, and `GET /_matrix/client/versions` through that URL returns 200 with the same body as via localhost. |
| AC-C2-2 | Given the proxy, when alice calls `/sync?timeout=5000` with no new events, then it returns 200 after >= 5 s (long-poll passes through, no proxy timeout). |
| AC-C2-3 | Given the proxy, when a 2 MB file is uploaded via `/_matrix/media/v3/upload` and downloaded back, then the bytes are identical and `Content-Type` is preserved. |
| AC-C2-4 | Given `npm run dev:lan`, then Vite listens on `0.0.0.0:5173` and honours `VITE_HS_URL` (phone-browser Plan B; manual). |
| AC-C2-5 | Given the login form, when I open `login-advanced-toggle`, enter `127.0.0.1:8008/` in `login-hs-url` and log in as alice, then login succeeds against `http://127.0.0.1:8008` (scheme added, slash dropped), `localStorage['matrix-poc.hsUrl']` holds it, media thumbnails use it, and after logout + reload the field is prefilled; clearing it reverts to the build default. |

### AC-C3 iOS project (PRIN-6)
| ID | Given / When / Then |
|---|---|
| AC-C3-1 | `ios/App/App/Info.plist` contains a non-empty `NSMicrophoneUsageDescription` and `NSAppTransportSecurity` with `NSAllowsArbitraryLoads` true. |
| AC-C3-2 | On Windows, `npx cap copy ios` exits 0 and `ios/App/App/public/index.html` exists (full `cap sync ios` needs CocoaPods: Mac). |
| AC-C3-3 | docs/MOBILE.md "iOS on a Mac" matches the handoff steps in docs/PHASE2_PLAN.md (review). |

### AC-M1 Breakpoint and layout store (PRIN-3)
| ID | Given / When / Then |
|---|---|
| AC-M1-1 | Given phone, when alice logs in, then `app-shell` has `data-layout="phone"`, `nav-drawer` has `data-open="false"`, `space-rail` and `channel-sidebar` are not visible, `message-list` is >= 400 px wide and `composer` is visible. |
| AC-M1-2 | Given desktop, then `data-layout="desktop"`, `nav-drawer`/`member-drawer`/`drawer-backdrop`/`header-menu` are not in the DOM, and the Phase 1 suite passes unchanged. |
| AC-M1-3 | When the viewport goes 1280 -> 412 px wide and back (`setViewportSize`), then `data-layout` follows within 500 ms without reload and the selected room stays open. |
| AC-M1-4 | Given phone after login, then `document.documentElement.scrollWidth <= innerWidth` and `body.scrollHeight <= innerHeight` (nothing scrolls but `message-list`). |

### AC-M2 Navigation drawer (PRIN-3 container, DEV-A-11 content)
| ID | Given / When / Then |
|---|---|
| AC-M2-1 | Given phone, when I tap `header-menu`, then `nav-drawer` has `data-open="true"` within 300 ms, shows `space-rail` (home, Acme HQ, Gaming) on its left and `channel-sidebar` with `channel-list` (general, random, dev) on its right, `current-user` at the bottom, and `drawer-backdrop` is visible. |
| AC-M2-2 | When I tap `channel-item-{random}` in the drawer, then the drawer closes (`data-open="false"`), `channel-header-name` reads `random` and `message-list` shows its messages. |
| AC-M2-3 | When I tap `drawer-backdrop`, then the drawer closes and the room is unchanged. |
| AC-M2-4 | When I tap `space-item-{gaming}` in the drawer, then the drawer **stays open** and `channel-list` shows `lobby` (space switches do not close it; `selectRoom` does). |
| AC-M2-5 | When I tap `space-item-home` then `dm-item-{bob}`, then the drawer closes, `channel-header-name` reads `Bob Ruiz` and `member-toggle` is absent. |
| AC-M2-6 | Given the drawer open, then its width is 75-90 % of the viewport, the rail is 72 px, and every `channel-item-*` / `dm-item-*` is >= 44 px tall. |
| AC-M2-7 | Given `#general` open and the drawer closed, when bob posts in `#random` via API and I open the drawer, then `channel-unread-{random}` shows >= 1 (AC-A5 holds inside the drawer). |
| AC-M2-8 | **manual (device)** Swipe from the left edge opens the drawer; swipe left closes it; Android back closes an open drawer instead of leaving the app. |

### AC-M3 Phone channel header (DEV-A-12)
| ID | Given / When / Then |
|---|---|
| AC-M3-1 | Given phone and `#general`, then `channel-header` is <= 56 px tall and shows `header-menu` (>= 44x44) at the left, `channel-header-name` `general`, `member-toggle` (>= 44x44) at the right; `channel-header-topic` is hidden or one truncated line. |
| AC-M3-2 | Given desktop, then the header is unchanged from Phase 1 (`header-menu` absent, topic visible). |
| AC-M3-3 | Given phone and a DM open, then `member-toggle` is absent and the name is the other user's display name. |

### AC-M4 Member drawer (PRIN-3 container, DEV-A-13 content)
| ID | Given / When / Then |
|---|---|
| AC-M4-1 | Given phone and `#general`, when I tap `member-toggle`, then `member-drawer` has `data-open="true"`, contains `member-list` with the four members and `member-count` `4`, and `drawer-backdrop` is visible. |
| AC-M4-2 | When I tap `drawer-backdrop`, it closes; when I tap `header-menu` while it is open, the member drawer closes and the nav drawer opens (one drawer at a time). |
| AC-M4-3 | Given desktop, `member-toggle` still toggles the inline panel (AC-A4-3 passes). |

### AC-M5 Touch targets and bottom sheets (DEV-A-14, DEV-A-15)
| ID | Given / When / Then |
|---|---|
| AC-M5-1 | Given phone, then every `button`, `[role=button]` and `a` inside `space-rail`, `channel-list`, `dm-list`, `channel-header` and `member-list` has a bounding box >= 44 px in both dimensions (rail items may be 48 px round). |
| AC-M5-2 | Given phone, when I tap `channel-add` in the drawer, then `create-channel-dialog` has `data-variant="sheet"`, spans the viewport width, its bottom edge is within 1 px of the viewport bottom, focus is in `create-channel-name`; creating `memes-<ts>` behaves as AC-A6-2 and the drawer closes with the new room open. |
| AC-M5-3 | Given phone, every `input`/`textarea` in dialogs has computed `font-size` >= 16 px (no iOS focus zoom). |
| AC-M5-4 | Given desktop, dialogs have `data-variant="modal"` and AC-A6..A9 pass unchanged. |

### AC-M6 Safe area, viewport, keyboard (PRIN-4)
| ID | Given / When / Then |
|---|---|
| AC-M6-1 | `index.html` viewport meta is `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. |
| AC-M6-2 | Given phone after login, then `app-shell` height equals `window.innerHeight` (within 1 px) and `--safe-top/right/bottom/left` and `--tap-target` (`44px`) resolve on `:root`. |
| AC-M6-3 | Given phone, `app-shell` has `touch-action: manipulation`, `overscroll-behavior: none` on `html`/`body`, transparent `-webkit-tap-highlight-color`. |
| AC-M6-4 | **manual (device)** With the keyboard open, `composer-input`, mic/send and the newest message are visible; with it closed the composer sits above the gesture bar, not under it. |
| AC-M6-5 | **manual (device)** Status bar area is dark (`--bg-rail`), no content under it, no pull-to-refresh or overscroll bounce. |

### AC-V1 Recording UI (DEV-B-12)
| ID | Given / When / Then |
|---|---|
| AC-V1-1 | Given any room (phone or desktop), then `composer-mic` is visible and enabled while `composer-input` is empty and is not visible once it has text (`composer-send` takes its place); on phone it is >= 44 px. |
| AC-V1-2 | When I tap `composer-mic` (fake microphone, permission granted), then within 1 s `composer-recording` shows `data-state="recording"`, `composer-input` is hidden, `recording-timer` reads `0:00` then `0:01`, `0:02`, `recording-cancel` and `recording-send` are visible, and `recording-level`'s `data-level` changes between two samples 500 ms apart (the fake device emits a tone). |
| AC-V1-3 | When I tap `recording-cancel`, then the bar disappears, `composer-input` is back and focused, and no new row appears within 2 s. |
| AC-V1-4 | Given a recording shorter than 1 s, when I tap `recording-send`, then nothing is sent and a `toast` says the note is too short. |
| AC-V1-5 | Given recording in progress, when I switch room, then the recording is discarded (bar gone, nothing sent). |
| AC-V1-6 | **P2** Given recording, when 120 s elapse, then it auto-stops and sends (timer caps at `2:00`). |

### AC-V2 Sent event (DEV-B-13 UI, PRIN-5 core; QA verifies through the API)
| ID | Given / When / Then |
|---|---|
| AC-V2-1 | Given ~3 s recorded, when I tap `recording-send`, then the bar passes through `encoding`/`sending`, disappears, and a row with `data-sender="@alice:localhost"` containing `voice-message` appears within 5 s; `composer-input` is back. |
| AC-V2-2 | Given that row's settled event id, when fetched via API, then the content matches the contract above: `msgtype` `m.audio`, `body` `Voice message`, `url` mxc, `info.mimetype` in {`audio/ogg`,`audio/webm`,`audio/mp4`}, `info.size` > 0, `info.duration` integer within +-700 ms of the held time and equal to `org.matrix.msc1767.audio.duration`, `waveform` length 30..120 of integers 0..1024 with at least one > 0, `org.matrix.msc3245.voice` = `{}`, `org.matrix.msc1767.file.url` = `url`, `.mimetype` = `info.mimetype`, `org.matrix.msc1767.text` = `Voice message`. |
| AC-V2-3 | Given the mxc, when downloaded via `/_matrix/media/v3/download/localhost/{id}`, then byte length = `info.size` and the magic matches the mimetype: `OggS` (ogg), `1A 45 DF A3` (webm), `ftyp` at offset 4 (mp4). |
| AC-V2-4 | Given Chromium (mobile project), then `info.mimetype` is `audio/ogg` (Tier 1). **Met** by the voice-format change (docs/VOICE_FORMAT_PLAN.md AC-F1/F2: WebM/Opus is remuxed to Ogg/Opus before upload, file name `Voice message.ogg`, bytes `OggS`). The POC-era waiver recorded in docs/STATUS.md no longer applies. |
| AC-V2-5 | Given the event alice sent, when bob (desktop, chromium project) opens the room, then it renders `voice-message` and AC-V3-2 passes there too (cross-client check, P1). |

### AC-V3 Playback bubble (DEV-B-14)
| ID | Given / When / Then |
|---|---|
| AC-V3-1 | Given a `voice-message` in state `idle`, then it shows `voice-play`, `voice-waveform` with `data-samples` = waveform length and that many bars, `voice-duration` = `m:ss` of `round(durationMs / 1000)` (3120 -> `0:03`), `voice-progress` with `aria-valuemax` = `durationMs` and `aria-valuenow` 0; on phone the play button is >= 44 px and the bubble is <= the row width. |
| AC-V3-2 | When I tap `voice-play`, then `data-state="playing"` within 1 s, `voice-pause` replaces `voice-play`, `data-position-ms` and `aria-valuenow` increase across two polls, `voice-duration` shows elapsed. |
| AC-V3-3 | When I tap `voice-pause`, then state `paused` and the position stops; tapping `voice-play` resumes from >= that position. |
| AC-V3-4 | When playback ends, then state returns to `idle`, position 0, `voice-duration` shows the total. |
| AC-V3-5 | When I set `voice-progress` to half the duration (range input + `input` event), then `data-position-ms` is within 300 ms of it and playback continues from there. |
| AC-V3-6 | Given one note playing, when I play another, then the first goes to `paused` (one at a time; P1). |
| AC-V3-7 | Visual: bars left of the playhead are accent-coloured, right are muted; screenshot in the smoke run. |

### AC-V4 Received voice notes (PRIN-5 parsing, DEV-B-14 render)
| ID | Given / When / Then |
|---|---|
| AC-V4-1 | Given `#general` open, when bob posts via API an `m.audio` with the contract shape using `e2e/fixtures/test-voice.wav` (1.5 s, `audio/wav`, hand-made 50-sample waveform), then a row with `data-sender="@bob:localhost"` shows `voice-message` with `voice-duration` `0:02` and 50 bars, without reload. |
| AC-V4-2 | When I tap its `voice-play`, then AC-V3-2 and AC-V3-4 hold for it. |
| AC-V4-3 | Given an `m.audio` without `org.matrix.msc3245.voice` and without a waveform (plain audio file), then it still renders `voice-message` with flat bars and plays; reply quotes preview it as `[audio] <body>` (P1). |
| AC-V4-4 | Given a redacted voice message, then the row shows `message-redacted` and no `voice-message`; no console error. |

### AC-V5 Errors and permissions (DEV-B-12, DEV-B-13)
| ID | Given / When / Then |
|---|---|
| AC-V5-1 | Given `getUserMedia` rejects with `NotAllowedError` (QA stubs it via `addInitScript`), when I tap `composer-mic`, then `recording-error` reads a "Microphone access denied" message with how to fix it, `composer-mic` has `data-state="denied"`, and `composer-input` still works. |
| AC-V5-2 | Given the media upload returns 500 (QA `page.route` on `**/_matrix/media/v3/upload*`), when I tap `recording-send`, then `composer-recording` shows `data-state="error"` with `recording-error` "Upload failed", `recording-send` retries and `recording-cancel` discards; no row appears. |
| AC-V5-3 | **manual (device)** First mic tap shows the Android permission prompt; Allow starts recording; Deny shows `recording-error`; the choice persists across restarts. |
| AC-V5-4 | Given a `voice-message` whose download 404s (QA routes it), when I tap `voice-play`, then `voice-error` appears with a download link and state is `error`; no uncaught exception. |

### AC-V6 Phone composer and message rows (DEV-B-15, DEV-B-16)
| ID | Given / When / Then |
|---|---|
| AC-V6-1 | Given phone, then `composer`'s bottom edge equals `app-shell`'s bottom edge, its `padding-bottom` >= `--safe-bottom`, `composer-input` font-size >= 16 px, and `composer-attach`/`composer-mic`/`composer-send` are >= 44 px. |
| AC-V6-2 | Given phone (`hover: none`), when I tap a row, then `message-actions` is not shown; `reaction-*` pills remain tappable and >= 32 px tall. |
| AC-V6-3 | Given phone, when I long-press a row for 500 ms (CDP touch), then `message-action-sheet` opens with `message-action-react`, `message-action-reply` and, per permissions, `message-action-edit`/`message-action-delete`; tapping `message-action-reply` closes it and shows `composer-reply-banner`; tapping `message-action-sheet-backdrop` closes it. |
| AC-V6-4 | Given phone, when a touch moves > 10 px before 500 ms (scrolling), then no sheet opens. |
| AC-V6-5 | Given phone, then `message-image` is <= the viewport width minus gutters and `pre` blocks scroll inside themselves (`overflow-x: auto`); no horizontal page scroll. |
| AC-V6-6 | Given phone, AC-B3-2 (pagination anchor drift <= 5 px) and AC-B3-4 (stick to bottom) pass in the mobile project. |
| AC-V6-7 | Given desktop, the hover toolbar and AC-B5/B6/B9 pass unchanged. |
