# Codec on a phone - Demo Handoff (Phase 2)

The Phase 1 web client (docs/archive/DEMO.md), now in a phone layout with voice notes, wrapped as an Android app. Everything runs on this PC; the phone only needs the same Wi-Fi. Details and troubleshooting: docs/MOBILE.md.

## 1. Start everything (this PC, `C:\Users\jcgon\Development\matrix-poc`)
| Step | Command | Notes |
|---|---|---|
| 1 | `npm run hs:up` then `npm run seed` | As in Phase 1. For pristine badges use `npm run seed:reset` (about 1 min). Restart the homeserver once if it has been running since Phase 1 (`npm run hs:down && npm run hs:up`) so the relaxed room-creation limit applies. |
| 2 | `npm run hs:lan` (keep it open) | LAN proxy `0.0.0.0:8009 -> 127.0.0.1:8008`; prints the phone URLs. The first time, Windows Defender Firewall asks: tick **Private networks**, Allow. The homeserver itself is not touched. |
| 3 | `npm run voice:sample -- --room "#general:localhost"` | Posts bob's voice note (2.5 s) to `#general` for walkthrough step 8. |
| 4 | Pick a path below | A needs no build and shows the layout in a phone browser; B is the real app. |

This PC's Wi-Fi address today is **192.168.1.127** (`hs:lan` prints the current one; use the Wi-Fi adapter, not WSL/VPN).

### Path A - phone browser, zero build
1. `npm run dev:lan` (second terminal).
2. On the phone open **http://192.168.1.127:5173**.
3. Login screen: tap **Advanced**, set **Homeserver URL** to `http://192.168.1.127:8009`, log in as **alice** / **password123**.
4. Limitation: **recording a voice note is unavailable here** (a LAN IP is an insecure context, so the browser hides the microphone; the mic button says so). Everything else, including playing voice notes, works.

### Path B - the Android app
1. APK: `android/app/build/outputs/apk/debug/app-debug.apk` (build it with `npm run cap:build:android:lan` so the LAN homeserver URL is baked in).
2. Install over USB (Developer options > USB debugging on): `~/android-sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. Or copy the file to the phone, open it from Files and allow "Install unknown apps" for that source (debug build; Play Protect may ask to confirm).
3. Open **Codec**. If the homeserver is not prefilled (different network than the build), use **Advanced > Homeserver URL** = `http://192.168.1.127:8009`. Log in as **alice** / **password123**.

## 2. The walkthrough (as alice, about three minutes)
| # | Do | You should see |
|---|---|---|
| 1 | Log in | `#general` full-screen within 3 s: header with the menu button (**Open navigation**), `#general`, and the people icon (**Show Members**); messages; composer at the bottom with a microphone button (**Record a voice message**). Nothing under the status bar or the gesture bar. |
| 2 | Tap the menu button (or swipe in from the left edge) | A drawer covers most of the screen: space rail on the left (Home, **Acme HQ**, **Gaming**), channel list on the right. `#random` carries an unread badge (**3** on a fresh seed). Tap the dark area to close. |
| 3 | Open the drawer, tap `#random` | The drawer closes by itself and `#random` opens. Open the drawer again: the badge is gone. Tap **Gaming** in the rail: the drawer stays open and shows `#lobby`. |
| 4 | Back in `#general`, scroll up | Grouped messages, bold text, a code block, a link, an image, a reply quote, reaction pills, all at phone width with no sideways scrolling. Older messages load at the top. |
| 5 | Tap the composer, type `Hello from my phone`, tap send | The keyboard rises, the composer stays above it, the message lands at the bottom under your name. |
| 6 | Tap the microphone, allow microphone access, speak for a few seconds, tap **Send voice message** | The input turns into a recording bar: red dot, running timer, level meter moving with your voice, **Discard recording** on the left. On send a voice bubble appears under alice with a waveform and a duration like `0:04`. |
| 7 | Tap **Play voice message** on it | Your voice plays, the waveform fills left to right, the time counts, the button becomes **Pause**. |
| 8 | Find bob's voice note (posted in step 3 of the prep), tap play | Plays with its own waveform, exactly like yours. |
| 9 | Open the drawer, tap **Home** (top of the rail), tap **Bob Ruiz** | The DM opens full-screen with **Bob Ruiz** in the header; the people icon is hidden for DMs. |
| 10 | Back in a channel, tap the people icon | A right-hand drawer lists the members with their roles; tap the dark area to close. Long-press any message for react / reply / edit / delete. |

Second screen, optional: open http://localhost:5173 on the PC as **bob** (incognito) and play the voice note alice just recorded; it is a standard Matrix voice message (also plays in Element Web against this homeserver). Phone screenshots of every step, taken by the automated run: `e2e/demo-mobile/`.

## 3. iPhone (Mac needed; this PC cannot build iOS)
1. The iOS project is in the repo (`ios/App`, Capacitor 7, microphone permission and cleartext exception already set).
2. On a Mac with Xcode 16+ and CocoaPods: clone, `npm install`, `VITE_HS_URL=http://192.168.1.127:8009 npm run build && npx cap sync ios`.
3. `npm run cap:open:ios`, set your signing team on the **App** target, run on a device (iOS 17+).
4. Keep `npm run hs:lan` running on this PC; same Wi-Fi.
5. Walk section 2 and note differences; everything is spelled out in docs/MOBILE.md section 4.

## 4. Known limitations (on purpose for a POC)
- Voice notes are sent in the phone's native format (WebM/Opus from Android and desktop Chrome, MP4/AAC from iPhone) with no transcoding. WebM notes **do not play on iPhones below iOS 18.4** (a download link is shown instead). Android plays everything.
- No push notifications, no background or lock-screen audio, no voice/video calls, no encryption (unchanged from Phase 1).
- The homeserver restart for the relaxed room-creation limit and a `seed:reset` are still pending from Phase 1 (section 1, step 1). Login can feel slow (about 10 s) only right after the automated suites have hammered the homeserver (BUG-4 in docs/BUGS.md); do not run them just before the demo.
- Debug build, default icon, cleartext HTTP to the PC: fine on a private Wi-Fi, not for distribution.

## 5. If it lands well
| Next | Effort |
|---|---|
| Ogg/Opus transcoding so every client, including older iPhones, plays every note | 2-3 days |
| Presence (online/idle/offline) in member and DM lists | 2-3 days |
| Native share sheet and deep links (open a room from a link, share a file into a room) | 2-3 days |
| Push notifications (Sygnal gateway + FCM/APNs) | 1-2 weeks |
| App-store hardening: release signing, icons/splash, TLS homeserver, crash reporting, store listings | 1-2 weeks |
