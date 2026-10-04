# Architecture (source of truth for the shared layer)

This document is the contract between the Principal-owned core (`src/lib`, `src/store`, `src/app`,
`seed`, `scripts`, `homeserver`, and since Phase 2 `capacitor.config.ts`, `android/`, `ios/`) and the
feature owners. Where it differs from `docs/TICKETS.md` / `docs/PHASE2_TICKETS.md` "Shared API",
**this file wins**; the differences are listed first.

## Phase 2 deltas (mobile + voice notes)

What the Phase 2 brief, docs/PHASE2_PLAN.md and docs/PHASE2_TICKETS.md say versus what is shipped, and why.

| Topic | Brief / plan / tickets say | What is actually shipped | Why |
|---|---|---|---|
| Capacitor major | brief: latest stable (8); plan: 6; tickets: 7 | **7.6.9** (`@capacitor/{core,cli,android,ios}@7.6.9`, app 7.1.2, haptics 7.0.5, keyboard 7.0.6, status-bar 7.0.6). Android template: compileSdk/targetSdk 35, minSdk 23, AGP 8.7.2, Gradle 8.11.1, CocoaPods iOS project. | Orchestrator decision: 8 needs Xcode 26 + API 36 for the Mac handoff. (8.5.2 was installed first and *also* built a debug APK here - it is not a toolchain limitation.) |
| JDK | brief/plan: 17; tickets: 21 | **Temurin 21** (portable zip at `~/jdk21`, no admin rights). | Capacitor 7 compiles with `JavaVersion.VERSION_21`; JDK 17 fails (`invalid source release: 21`). The winget MSI needs a UAC prompt nobody can click here. |
| Android SDK packages | `platforms;android-35`, `build-tools;35.0.0` | Same (plus android-36 / 36.0.0 left over from the Capacitor 8 attempt, harmless). cmdline-tools 22.0 at `~/android-sdk`. | - |
| `org.gradle.java.home` | tickets: in `android/gradle.properties` | Written to the **user's** `~/.gradle/gradle.properties` by `scripts/toolchain.mjs --setx` and by every `cap:build:android`; the committed `android/gradle.properties` is untouched. | A machine-specific JDK path must not be committed (Mac handoff). The scripts also set `JAVA_HOME`/`ANDROID_HOME` in the child env. |
| LAN proxy port / kind | brief: 8018 TCP; plan + AC-C2-1: 8008; tickets: 8009 | **8009**, plain HTTP pass-through (the advisor's proven `docs/advisor/lan-proxy.mjs`, promoted to `scripts/lan-proxy.mjs`, + address printing). | 8008 is Synapse's own loopback port; 8009 per the orchestrator. The advisor suggested raw TCP; the orchestrator asked to reuse the proven HTTP one - equivalent for Matrix (no WebSockets). |
| `server.androidScheme` | brief: default (`https`) + `allowMixedContent` | **`http`** + `cleartext: true` + `allowMixedContent: true`; manifest `usesCleartextTraffic="true"`. | AC-C1-3 / plan: `http://localhost` is still a secure context (getUserMedia works) and plain-http XHR to the LAN proxy is then not mixed content. Never set `server.url` to a LAN IP (origin stops being localhost; `navigator.mediaDevices` disappears). |
| Keyboard resize mode | brief: body or native; plan/tickets: body | **`native`** (`KeyboardResize.Native`). | iOS-only option (Android always resizes the WebView). `body` only shrinks `<body>`; `100dvh`/`env()` would not follow the keyboard. Advisor consultation. |
| Voice event shape | brief: no `msc1767.text`, `msc1767.file { url, mimetype }` | Element's `createVoiceMessageContent` shape verbatim (docs/PHASE2_ACCEPTANCE.md): + `org.matrix.msc1767.text`, `msc1767.file { url, name, mimetype, size }`. | Acceptance contract. |
| Waveform | brief: RMS per bucket | **Peak amplitude** per bucket, **normalised so the loudest bucket is 1024**, 100 samples. | Acceptance (peak) + tickets (normalised). Non-normalised is `waveformFromSamples(src, n, { normalize: false })`. |
| Audio format | brief: WASM Ogg/Opus encoder, else native; plan: remux spike (mediabunny) | **Native MediaRecorder container, no transcoding**: `audio/webm` (Opus) on Android/Chromium, `audio/mp4` (AAC) on iOS, `audio/ogg` on Firefox; `info.mimetype` is always the real base type. `encodeToOggOpus()` is an identity and the single P1 seam. **AC-V2-4 (Ogg on Chromium) is waived for the POC.** | Orchestrator decision (the only testable artifact here is the Android APK, which records and plays WebM/Opus). `wasm-media-encoders` was evaluated and dropped: it is Ogg *Vorbis*, not Opus. `opus-recorder` (Element Web's WASM encoder) and a WebM->Ogg remux remain the P1 options. |
| `computeWaveform` signature | brief: `(blob) => Promise<number[]>`; tickets: `(AudioBuffer \| Float32Array, samples) => number[]` | Tickets' sync version is `computeWaveform` (encode.ts); the brief's blob version is `computeWaveformFromBlob(blob)` / `analyzeAudio(blob)`. | Dev B codes against the tickets table. |
| Mimetype picker | brief: `pickRecordingMimeType(): string \| null`; tickets: `pickVoiceMimeType(): string` | Both. Candidate order: `audio/ogg;codecs=opus`, `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/ogg` (Chromium -> webm;opus, Safari -> mp4, Firefox -> ogg). | - |
| `useLayoutStore` | tickets: `closeAll()`; brief: `openMembers/closeMembers` only | `closeAll()` **and** `closeDrawers()` (same), plus `toggleMembers()`, `keyboardHeight`, `viewportWidth/Height`, `keyboardOpen`, `setIsPhone`, `setKeyboardHeight`, `setViewport`. "`selectRoom()` closes the nav drawer" is implemented with `onRoomSelected()` (rooms.ts) subscribed in layout.ts, so rooms.ts stays layout-agnostic. | Superset. |
| `useViewport()` | tickets: `{ isPhone, width, height, keyboardOpen }` in hooks.ts | Same + `isDesktop`, `layout`, `keyboardHeight`; defined in layout.ts, re-exported from hooks.ts and store/index.ts. `useIsPhone()` too. | - |
| `src/lib/native.ts` names | brief: `platform()`, `tap()`; tickets: `getPlatform()`, `hapticTap()` | All four (`getPlatform === platform`; `hapticTap()` = fire-and-forget `tap('light')`). | - |
| `Drawer` props | tickets: `side, open, onClose, width, testid`, `inert` on the main column | `side, open, label, testId`; closed drawers are `visibility: hidden` (not focusable, `toBeVisible()` false); no `inert` (React 18 has no typed prop). Devs never import it. | - |
| Member drawer content | - | The Shell mounts `<MemberPanel roomId/>` inside `member-drawer`. Today `MemberPanel` returns `null` when `useNavUiStore.membersOpen` is false (desktop toggle state), so the drawer can render empty. **Dev A (DEV-A-13): on phone render regardless of `useNavUiStore.membersOpen`** (`useIsPhone()`); the drawer's visibility is `useLayoutStore.membersOpen`. | Ownership rule from the plan. |
| Login testids | brief: `login-hs-url` under an Advanced toggle | `login-advanced-toggle`, `login-hs-url`, `login-hs-url-reset`, `login-hs-url-effective`. Stored under localStorage `matrix-poc.hsUrl`. | - |
| `HS_URL` | constant | **Deprecated**; `getHsUrl()` (runtime override -> `VITE_HS_URL` -> `http://localhost:8008`) is read per call by login, register, `loadSession` fallback, `mxcToHttp`, `describeError`. | Phones point at the LAN proxy at runtime; media URLs must follow. |
| Phone gestures | AC-M2-8 manual | Edge swipe (28 px edge, 56 px travel) opens the nav/member drawer, swipe back closes; Escape closes; Android back closes drawers else minimises the app. Implemented by the Shell, not by features. | Usable before Dev A's header buttons exist. |
| Dev hooks | - | `window.__matrixPoc` (stores, `getClient`, `getVoiceMessage`, `getDisplayBody`, `analyzeAudio`, ...) in **dev builds only** (`import.meta.env.DEV`, `src/app/devtools.ts`). | Used by `scripts/verify-phone-shell.mjs`; handy for QA. |
| Capacitor 7 on Windows | - | `cap sync` prints `Skipping pod install because CocoaPods is not installed` and `Unable to find "xcodebuild"`; both expected. `cap copy ios` works. | - |

### Advisor consultations (Phase 2, Principal)

| Topic | Options | Outcome |
|---|---|---|
| JDK / SDK versions | brief said JDK 17 + android-35; `capacitor/build.gradle` said Java 21 (+ compileSdk 36 on Cap 8) | Trust the template: JDK 21. SDK 36 while on Cap 8, 35 after the orchestrator's switch to Cap 7. Both built. |
| Keyboard resize | `body` vs `native` | `native` (see table). |
| Mic permission plumbing | custom `MainActivity` vs manifest only | Manifest only: `BridgeWebChromeClient.onPermissionRequest` already requests `RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS` for `AUDIO_CAPTURE` and grants. Verified in the installed source. |
| Audio strategy | WASM encoder / remux / native | P0 native MediaRecorder format, P1 Ogg/Opus seam; decode with `OfflineAudioContext.decodeAudioData` (not subject to iOS's gesture rule), one decode for duration + waveform, never `<audio>.duration` (WebM blobs report `Infinity`). Orchestrator then fixed "no transcoding in the POC". |
| LAN proxy | raw TCP vs HTTP | Advisor: raw TCP; orchestrator: reuse the proven HTTP one -> HTTP. |
| Blind spots raised | `HS_URL` is a module constant with 5 consumers; the zero-build path cannot record (insecure context); `isPhone` must not flip the desktop suite (width-capped coarse pointer); `useNavUiStore.membersOpen` vs the phone drawer; stale `dist/` in the first `cap sync`; add `login-hs-url` + the new localStorage key to the registry | All addressed above / in docs/MOBILE.md. |

## Deltas from TICKETS.md "Shared API" (Phase 1)

| Topic | TICKETS.md says | What is actually shipped | Why |
|---|---|---|---|
| Homeserver folder | `docker/**` | `homeserver/**`: `homeserver/homeserver.yaml` is the single Synapse config, used by `homeserver/docker-compose.yml` (Docker) and by the WSL1 fallback in `homeserver/wsl/` (for machines without virtualization). `npm run hs:*` picks the backend automatically. | Orchestrator brief + this machine has no virtualization. |
| `useSessionStore` | `{ status, userId, displayName, error, login, logout }` | Same, plus `avatarUrl`, `syncState`, `register(u,p)`, `restore()`. `status` values are exactly `'logged-out' \| 'logging-in' \| 'syncing' \| 'ready' \| 'error'`. | Register toggle on the login screen; page-load restore. |
| `useRoomStore` | `{ spaces, channelsBySpace, dms, selectedSpaceId, selectedRoomId, unreadByRoom, selectSpace, selectRoom, version }` | Same, plus `roomsById`, `orphanRooms`, `invites`, `highlightByRoom`, `lastRoomBySpace`, `ready`. **The store already auto-selects the first channel on space change, remembers the last channel per space and persists `nav.selection` to localStorage** (DEV-A-2 need not implement that; just call `selectSpace` / `selectRoom`). First-ever load lands on the first space (alphabetical), i.e. Acme HQ / #general. | Keeps selection logic in one place, testable, and identical for QA fixtures. |
| `RoomSummary` | `{ roomId, name, topic?, avatarUrl?, isSpace, parentSpaceId?, order?, isDm, dmUserId? }` | Same fields plus `canonicalAlias?`, `joinRule`, `membership`, `lastActiveTs`, `memberCount`, `unread`, `highlight`. | Superset; nothing renamed. |
| `useTimelineStore` | `{ eventsByRoom, canPaginateBack, paginateBack(roomId, limit=30), typingByRoom, version }` | Same, plus `isPaginating: Record<roomId, boolean>`. `paginateBack` also refreshes the snapshot before resolving. Hooks `useRoomTimeline`, `useTyping`, `useMembers` are provided on top (optional). | Pagination UI needs the in-flight flag. |
| `mxcToHttp` | exported from `src/lib/matrix/client.ts` | Exported from `client.ts` **and** `src/lib/matrix/mxc.ts` (pure, no client needed) and `utils.ts`. Signature `(mxc, w?, h?, method?: 'scale' \| 'crop') => string` ('' for non-mxc input). | Usable before login (avatars in the login footer, tests). |
| `sendText` opts | `{ html?, replyTo?: MatrixEvent, mentions? }` | `replyTo` accepts `MatrixEvent \| string` (event id). | Convenience. |
| `createSpace` | `({ name })` | `({ name, topic? })`; still auto-creates `general`. | Superset. |
| Extra actions | - | `toggleReaction`, `markRoomRead`, `joinRoom`, `leaveRoom`, `loadMembers`, `fetchEvent`, `canRedactEvent`, `canEditEvent`, `myPowerLevel`, `findDmRoomId`, `getDirectMap`. | Needed by the placeholders / dialogs; documented below. |
| Feature components | navigation exports `SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel`; conversation exports `Conversation` | Exactly that, plus navigation exports `useNavUiStore` (member panel open/closed) which Dev A owns. `ChannelSidebar` renders `DmList` itself when `selectedSpaceId === 'home'`. | Matches TICKETS; the DM list is an internal component of Dev A's folder. |
| Rate limits | PLAN says `per_second: 1000, burst_count: 1000` | Exactly that, for `rc_message`, `rc_registration`, `rc_login.*`, `rc_joins.*`, `rc_joins_per_room`, `rc_invites.*`, `rc_presence`, `rc_media_create`, `rc_admin_redaction` **and `rc_room_creation`** (Synapse's separate room-creation limiter: default 10 rooms then 1/min per user; without relaxing it `createRoom` returns 429 once the suite has created ~10 rooms as alice). | - |
| Seed location | `seed/seed.ts`, output `seed/seed-output.json` | Same. The orchestrator brief said `scripts/seed.ts`; SEED_DATA.md wins. | - |
| Room version | not specified | `createChannel` / `createSpace` / `createDm` and the seed pin `room_version: "11"`. Synapse >= 1.162 defaults to v12, where the creator has "infinite" power and must not appear in `power_level_content_override.users`; v11 keeps alice at an explicit 100 (crown icon, `myPowerLevel()`), matching SEED_DATA.md. | Contract says alice = 100. |
| Redacted messages in the timeline | TICKETS DEV-B-1 renders them as "Message deleted" | `isDisplayableEvent()` **keeps** redacted `m.room.message` events so Dev B can render `message-redacted`. | - |
| Timestamps | AC-B1-8 | `formatTime(ts)` returns `HH:MM` for today and `DD/MM/YYYY HH:MM` otherwise. | - |

## Module map

```
src/
  main.tsx                     React root; imports styles/global.css
  app/                         (Principal) session gate + shell
    App.tsx                    status -> LoginScreen | LoadingScreen | Shell; boots initNative(); dev hooks
    LoginScreen.tsx            login/register form + Advanced > Homeserver URL (Phase 2)
    LoadingScreen.tsx          data-testid=app-loading until PREPARED
    Shell.tsx                  desktop: 72 | 240 | 1fr | auto grid; phone: full-screen column + two drawers (Phase 2)
    Drawer.tsx                 off-canvas drawer container (phone), data-testid nav-drawer / member-drawer
    UserFooter.tsx             bottom-left user pill + logout
    Toast.tsx                  global toasts
    devtools.ts                window.__matrixPoc in dev builds only
    theme.css                  design tokens (the only CSS variables features may use) incl. --safe-*, --tap-target, --vvh
  styles/global.css            reset, scrollbars, utilities (.u-avatar, .u-btn, .u-input, ...), 100dvh, phone-only rules
  lib/
    format.ts                  sanitizeHtml, linkify, formatTime, isSameDay, formatDayDivider, initialsOf, colorFor
    native.ts                  (Phase 2) isNativeApp, platform/getPlatform, initNative, tap/hapticTap, onAppStateChange
    audio/                     (Phase 2) voice-note primitives, no React, no Matrix
      encode.ts                Shared API: pickVoiceMimeType, encodeToOggOpus, decodeToPcm, computeWaveform, baseMimetype
      recording.ts             startRecording (getUserMedia + MediaRecorder lifecycle), createLevelMeter, pickRecordingMimeType
      analysis.ts              decodeAudio, analyzeAudio, waveformFromSamples, sanitizeWaveform, computeWaveformFromBlob, getAudioDuration
      mime.ts                  containerMimeType, extensionFor, voiceFileName, isAudioMimeType
      index.ts                 re-exports
    matrix/
      config.ts                getHsUrl/setHsUrl/hasHsUrlOverride/normalizeHsUrl, DEFAULT_HS_URL, storage keys, localpartOf, serverNameOf
      mxc.ts                   mxcToHttp (pure; resolves getHsUrl() per call)
      client.ts                getClient, login, register, logout, session persistence, startClient
      actions.ts               every write + a few aggregate readers (members, reactions); sendVoiceMessage (Phase 2)
      utils.ts                 read helpers over SDK objects (display names, avatars, getDisplayBody, getVoiceMessage, ...)
  store/
    session.ts                 useSessionStore
    rooms.ts                   useRoomStore + recomputeRooms + waitForRoom + onRoomSelected (Phase 2)
    layout.ts                  (Phase 2) useLayoutStore, useIsPhone, useViewport, detectIsPhone; stamps <html data-layout>, --vvh
    timeline.ts                useTimelineStore + refreshTimeline + setTypingForRoom
    bridge.ts                  bindClient/unbindClient: SDK events -> stores (debounced)
    hooks.ts                   useRoomTimeline, useTyping, useMembers, useRoomSummary, useSelectedRoom, useMyUserId (+ re-exports useIsPhone, useViewport)
    toast.ts                   useToastStore, showToast, withToast
    index.ts                   re-exports
  features/
    navigation/                (Dev A) index.ts exports SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel, useNavUiStore
    conversation/              (Dev B) index.ts exports Conversation
capacitor.config.ts            (Phase 2) appId com.acme.matrixpoc, webDir dist, androidScheme http + cleartext, Keyboard native, StatusBar dark
android/                       (Phase 2) generated by `cap add android` (Capacitor 7); committed minus build outputs; manifest has RECORD_AUDIO etc.
ios/                           (Phase 2) generated by `cap add ios`; Info.plist has NSMicrophoneUsageDescription + ATS exception; Pods/ not committed
seed/seed.ts                   fixture script (docs/SEED_DATA.md), writes seed/seed-output.json
scripts/hs.mjs                 homeserver wrapper: up/down/reset/logs/status over docker compose OR homeserver/wsl/hs.sh
scripts/lan-proxy.mjs          (Phase 2) 0.0.0.0:8009 -> 127.0.0.1:8008 HTTP pass-through; prints phone URLs (npm run hs:lan)
scripts/lib/lan.mjs            (Phase 2) lanIPv4Addresses, primaryLanIPv4, lanHomeserverUrl
scripts/toolchain.mjs          (Phase 2) find JDK 21 + Android SDK, --setx, ~/.gradle/gradle.properties (npm run toolchain)
scripts/cap-build-android.mjs  (Phase 2) vite build (VITE_HS_URL) + cap sync + gradlew assembleDebug -> APK path (npm run cap:build:android[:lan])
scripts/send-voice-sample.mjs  (Phase 2) post a contract-shaped voice message via the API, validate it (npm run voice:sample)
scripts/verify-phone-shell.mjs (Phase 2) Pixel 7 Playwright check + screenshots + voice round trip (npm run verify:phone)
scripts/verify-scaffold.mjs    throwaway Playwright smoke (login + screenshot)
homeserver/                    homeserver.yaml (single config, committed), docker-compose.yml, wsl/ (no-Docker fallback), data/* (ignored)
docs/MOBILE.md                 (Phase 2) phone browser path, toolchain, APK, LAN proxy, iOS handoff, troubleshooting
e2e/, playwright.config.ts     (QA)
```

## Ownership

| Owner | Owns | Must not edit |
|---|---|---|
| Principal | `src/app/**`, `src/store/**`, `src/lib/**` (incl. `audio/**`, `native.ts`), `src/styles/**`, `index.html`, `capacitor.config.ts`, `android/**`, `ios/**`, `seed/**`, `scripts/**`, `homeserver/**`, `package.json`, `.env.example`, `docs/ARCHITECTURE.md`, `docs/MOBILE.md`, root configs | - |
| Dev A | `src/features/navigation/**` | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:e2e*` script lines in `package.json` | anything else |

**Requesting a change to the core layer**: do not edit it. Put a block in your final report:
`Request to Principal: <file>, <function/hook>, <desired shape>, <why>`. The Principal implements it
(usually within the same wave) and updates this document. Small, additive requests (a new reader in
`actions.ts`, an extra field on `RoomSummary`) are cheap; changes to store shapes are not.

The shell mounts feature components and passes nothing but `roomId`:

```tsx
// desktop (useLayoutStore.isPhone === false) - unchanged from Phase 1
<SpaceRail />                       // column 1
<ChannelSidebar />  <UserFooter />  // column 2 (UserFooter is Principal's)
<ChannelHeader roomId={id} />       // column 3 top
<Conversation roomId={id} />        // column 3 rest
<MemberPanel roomId={id} />         // column 4; return null to hide (the grid column collapses)

// phone (isPhone === true) - Phase 2; app-shell[data-layout="phone"]
<main>  <ChannelHeader roomId={id} /> <Conversation roomId={id} />  </main>          // full screen
<div data-testid="drawer-backdrop" />                                                 // tap closes
<Drawer testId="nav-drawer">    <SpaceRail /> | <ChannelSidebar /> <UserFooter />  </Drawer>   // left, 85 % wide, rail 72 px
<Drawer testId="member-drawer"> <MemberPanel roomId={id} />                        </Drawer>   // right
```

Phone contract for features: `ChannelHeader` renders `header-menu` -> `useLayoutStore.openNav()` and, on phone,
`member-toggle` -> `useLayoutStore.openMembers()` (desktop keeps `useNavUiStore.toggleMembers()`); `MemberPanel`
renders its list on phone regardless of `useNavUiStore.membersOpen`; room taps call `selectRoom()` as today (the
layout store closes the drawer); space taps keep it open. Nothing phone-only exists in the desktop DOM.

## Runtime model

1. `App` mounts -> `useSessionStore.restore()`. If localStorage has a session (`matrix-poc.session`
   = `{ baseUrl, userId, accessToken, deviceId }`) the store starts in `'syncing'`; otherwise `'logged-out'`.
2. `login()`/`register()`/`restore()` -> `startClientFromSession()` creates the `MatrixClient`
   (`createClient` with `timelineSupport: true`, **no crypto**), calls
   `startClient({ initialSyncLimit: 30, lazyLoadMembers: true, pendingEventOrdering: 'chronological', threadSupport: false })`,
   then `bindClient()` subscribes the bridge, then `waitForPrepared()` resolves on `SyncState.Prepared`.
   Status becomes `'ready'` and the shell renders. The bridge does one full `recomputeRooms()` +
   `refreshTimelines(all rooms)` at PREPARED and again whenever the SDK goes ERROR -> SYNCING (catch-up).
3. From then on every SDK event lands in a store through the bridge with a 50 ms (rooms) / 30 ms
   (timelines) trailing debounce. React re-renders once per burst, never once per event.
4. `logout()` -> server logout (best effort), `stopClient()`, listeners removed, localStorage cleared,
   stores reset. Token revoked server-side (`HttpApiEvent.SessionLoggedOut`) triggers the same.

## Store / hook / action API

### `useSessionStore` (`src/store/session.ts`)

| Member | Type | Semantics |
|---|---|---|
| `status` | `'logged-out' \| 'logging-in' \| 'syncing' \| 'ready' \| 'error'` | See runtime model. `'error'` = last login/register failed; the login form shows `error`. |
| `userId` | `string \| null` | `@alice:localhost` |
| `displayName`, `avatarUrl` | `string \| null` | From `/profile` after PREPARED (`avatarUrl` is an mxc). |
| `error` | `string \| null` | Human-readable; also set while `'ready'` if sync errors (shell shows "Reconnecting"). |
| `syncState` | `SyncState \| null` | Raw SDK sync state. |
| `login(username, password)` | `Promise<void>` | Never throws; failure -> `status: 'error'` + `error`. |
| `register(username, password)` | `Promise<void>` | Open registration via `m.login.dummy`; logs in on success. |
| `logout()` | `Promise<void>` | Never throws. |
| `restore()` | `Promise<void>` | Page-load restore. Idempotent. |

`describeError(e)` maps `MatrixError`/network errors to friendly text.

### `useRoomStore` (`src/store/rooms.ts`)

| Member | Type | Semantics |
|---|---|---|
| `ready` | `boolean` | True after the first recompute post-PREPARED. |
| `spaces` | `RoomSummary[]` | Joined `m.space` rooms, sorted by name. |
| `channelsBySpace` | `Record<spaceId, RoomSummary[]>` | Joined child rooms per space, sorted by `m.space.child.order` then name. Children I have not joined are not listed (request `getRoomHierarchy` support if needed). |
| `dms` | `RoomSummary[]` | Rooms listed in my `m.direct` account data, newest activity first. |
| `orphanRooms` | `RoomSummary[]` | Joined rooms with no space and not DMs (shown under Home). |
| `invites` | `RoomSummary[]` | Rooms I am invited to. |
| `roomsById` | `Record<roomId, RoomSummary>` | Every joined/invited room. |
| `unreadByRoom`, `highlightByRoom` | `Record<roomId, number>` | From `room.getUnreadNotificationCount()` (server-computed; updates after receipts sync back). |
| `selectedSpaceId` | `string \| 'home'` | `'home'` = DM view. |
| `selectedRoomId` | `string \| null` | |
| `lastRoomBySpace` | `Record<spaceId \| 'home', roomId>` | Persisted with the selection under localStorage `nav.selection`. |
| `version` | `number` | Bumps on every recompute. Subscribe to it to re-read SDK objects (members, power levels). |
| `selectSpace(id)` | `void` | Switches space and selects its remembered or first channel (DMs for `'home'`). Persists. Kicks off `loadMembersIfNeeded`. |
| `selectRoom(roomId \| null)` | `void` | Selects a room and switches `selectedSpaceId` to its space (`'home'` for DMs/orphans). Persists. |
| `pendingRoomId`, `pendingSpaceId` | `string \| null` | Set when `selectRoom`/`selectSpace` is called with an id `/sync` has not delivered yet (right after `createChannel`/`createSpace`/`createDm`). The recompute leaves such a selection alone instead of falling back to the first channel, and switches to it the moment it arrives - so calling `selectRoom(newId)` before or after `waitForRoom` both work. |
| (invariant) | | Every recompute re-homes `selectedSpaceId` to the selected room's space (`'home'` for DMs) once that space is known, and `selectRoom()` on a room whose parent is not known yet keeps the current space. Needed because a just-created room can arrive in two `/sync` batches (see gotchas). |

Helpers: `recomputeRooms()` (bridge only), `resetRooms()`, `waitForRoom(roomId, timeoutMs=8000): Promise<boolean>`
(resolves once a freshly created room arrives via sync; use after `createChannel`/`createSpace`/`createDm` before selecting).

`RoomSummary`:
```ts
{ roomId, name, topic?, avatarUrl?, canonicalAlias?, isSpace, parentSpaceId?, order?, isDm, dmUserId?,
  joinRule, membership, lastActiveTs, memberCount, unread, highlight }
```
`name` is the bare room name (`general`, not `#general`); for DMs it is the other user's display name.

### `useLayoutStore` (`src/store/layout.ts`, Phase 2)

| Member | Type | Semantics |
|---|---|---|
| `isPhone` | `boolean` | `matchMedia('(max-width: 767px)')` **or** `'(pointer: coarse) and (max-width: 1023px)'`, live (AC-M1-3). Desktop Playwright 1280x720 is never a phone. Mirrored as `<html data-layout="phone\|desktop">` and on `app-shell[data-layout]`. |
| `navOpen`, `membersOpen` | `boolean` | Phone drawers (`nav-drawer`, `member-drawer`). Opening one closes the other. Leaving phone mode closes both. Desktop member panel visibility is still Dev A's `useNavUiStore.membersOpen`. |
| `openNav()`, `closeNav()`, `toggleNav()` | `void` | `header-menu` calls `openNav()`. |
| `openMembers()`, `closeMembers()`, `toggleMembers()` | `void` | `member-toggle` on phone calls `openMembers()`. |
| `closeDrawers()` / `closeAll()` | `() => boolean` | Close whichever is open (backdrop, Escape, Android back). True if one was open. |
| `keyboardHeight` | `number` | px from `@capacitor/keyboard` (0 in browsers / hidden). Also `--keyboard-height` on `:root` and `<html data-keyboard="open">`. |
| `viewportWidth`, `viewportHeight` | `number` | `window.visualViewport` in CSS px (fallback `innerWidth/Height`); `--vvh` on `:root` is the height in px. |
| `keyboardOpen` | `boolean` | `keyboardHeight > 0`, or the visual viewport is > 150 px shorter than the tallest seen at this width. |
| `setIsPhone`, `setKeyboardHeight`, `setViewport` | internal | Wiring (matchMedia, native.ts via App.tsx, visualViewport). Tests may call `setIsPhone`. |

Hooks: `useIsPhone(): boolean`; `useViewport(): { isPhone, isDesktop, layout, width, height, keyboardOpen, keyboardHeight }`
(both also re-exported from `hooks.ts` and `store/index.ts`). Helpers: `detectIsPhone()`, `PHONE_MEDIA_QUERY`,
`COARSE_PHONE_MEDIA_QUERY`.

**Drawer auto-close rule**: `useRoomStore.selectRoom(roomId)` fires `onRoomSelected(listener)` (rooms.ts); the layout
store closes the nav drawer on phone. `selectSpace()` and sync-driven recomputes do **not** fire it (AC-M2-4: a space
tap keeps the drawer open). Features never close the drawer themselves after a room tap.

### `useTimelineStore` (`src/store/timeline.ts`)

| Member | Type | Semantics |
|---|---|---|
| `eventsByRoom` | `Record<roomId, MatrixEvent[]>` | Copy of `room.getLiveTimeline().getEvents()`, oldest first, **unfiltered** (state events, reactions, edits, local echoes included). New array identity per change. |
| `canPaginateBack` | `Record<roomId, boolean>` | `false` once the room start is reached (no backward pagination token). Missing = unknown, treat as `true`. |
| `isPaginating` | `Record<roomId, boolean>` | |
| `typingByRoom` | `Record<roomId, string[]>` | User ids typing, excluding me. |
| `version` | `number` | Bumps on every timeline/typing commit. |
| `paginateBack(roomId, limit=30)` | `Promise<void>` | `client.paginateEventTimeline(liveTimeline, { backwards: true, limit })`, then refreshes the snapshot. No-op while in flight or at the start. |

Helpers: `refreshTimeline(roomId)`, `refreshTimelines(ids)`, `ensureTimeline(roomId)`, `setTypingForRoom`, `resetTimelines`.

### Hooks (`src/store/hooks.ts`)

| Hook | Returns | Notes |
|---|---|---|
| `useRoomTimeline(roomId)` | `{ events, allEvents, hasMore, isPaginating, version, paginateBack(limit?) }` | `events` = `allEvents.filter(isDisplayableEvent)` (messages + stickers, incl. redacted; no reactions/edits/state). Calls `ensureTimeline`. |
| `useTyping(roomId)` | `string[]` | Display names of typing users (never me). |
| `useMembers(roomId)` | `{ joined: MemberInfo[], invited: MemberInfo[] }` | Sorted by power level desc then name; triggers `loadMembers`. `MemberInfo = { userId, name, avatarUrl, powerLevel, membership, presence }`. |
| `useRoomSummary(roomId)` | `RoomSummary \| undefined` | |
| `useSelectedRoom()` | `RoomSummary \| undefined` | |
| `useMyUserId()` | `string \| null` | |

### Actions (`src/lib/matrix/actions.ts`)

| Function | Signature | Semantics |
|---|---|---|
| `sendText` | `(roomId, body, opts?: { html?, replyTo?: MatrixEvent \| string, mentions?: string[] }) => Promise<eventId>` | `m.text`; `html` -> `formatted_body`; `replyTo` -> `m.relates_to.m.in_reply_to`; `mentions` -> `m.mentions.user_ids`. Local echo appears immediately. |
| `editText` | `(roomId, targetEventId, body, html?) => Promise<eventId>` | Sends `m.replace` with `m.new_content` and `* ` fallback body. |
| `redactEvent` | `(roomId, eventId, reason?) => Promise<void>` | Messages, reactions, anything. |
| `sendReaction` | `(roomId, targetEventId, key) => Promise<eventId>` | `m.reaction` / `m.annotation`. |
| `toggleReaction` | `(roomId, targetEventId, key) => Promise<void>` | Adds, or redacts my existing reaction with that key. |
| `uploadFile` | `(file: File) => Promise<{ mxc, mimetype, size, name, w?, h? }>` | Media upload; image dimensions measured in the browser. |
| `sendFile` | `(roomId, file) => Promise<eventId>` | `m.image` for `image/*` (with `info.w/h`), else `m.file`. |
| `sendTyping` | `(roomId, typing, timeoutMs=5000) => Promise<void>` | |
| `sendReadReceipt` | `(roomId, event: MatrixEvent \| eventId) => Promise<void>` | `m.read`. Skips local echoes. |
| `markRoomRead` | `(roomId) => Promise<void>` | Receipt for the newest sent event in the live timeline. |
| `createChannel` | `({ spaceId, name, topic? }) => Promise<roomId>` | `preset: public_chat`, `visibility: private`, unencrypted, `m.space.parent` on the room, `m.space.child` (next `order`) on the space. |
| `createSpace` | `({ name, topic? }) => Promise<spaceId>` | `m.space`, public preset, then `createChannel({ name: 'general' })`. |
| `inviteUser` | `(roomId, userId) => Promise<void>` | Throws `MatrixError` (e.g. unknown user). |
| `createDm` | `(userId) => Promise<roomId>` | Reuses a joined room from `m.direct`; else `is_direct` + `trusted_private_chat` + invite, and updates `m.direct`. |
| `findDmRoomId`, `getDirectMap` | sync | `m.direct` readers. |
| `joinRoom` | `(roomIdOrAlias) => Promise<roomId>` | |
| `leaveRoom` | `(roomId) => Promise<void>` | |
| `getJoinedMembers`, `getInvitedMembers` | `(roomId) => RoomMember[]` | Sync readers (lazy-loaded; see `loadMembers`). |
| `loadMembers` | `(roomId) => Promise<void>` | `room.loadMembersIfNeeded()`; the store `version` bumps when they arrive. |
| `getReactions` | `(roomId, eventId) => { key, count, mine, senders, myEventId? }[]` | From `timelineSet.relations`; safe in render. |
| `fetchEvent` | `(roomId, eventId) => Promise<MatrixEvent \| undefined>` | Local timeline first, then `/rooms/{id}/event/{eventId}`. For reply quotes whose target is not loaded. |
| `canRedactEvent` | `(roomId, event) => boolean` | `room.currentState.maySendRedactionForEvent`. |
| `canEditEvent` | `(event) => boolean` | Own, non-redacted `m.room.message`. |
| `myPowerLevel` | `(roomId) => number` | |
| `retryOnRateLimit` | `(fn: () => Promise<T>, label?) => Promise<T>` | Retries `fn` on 429 honouring `retry_after_ms` up to 30 s total, then throws `RateLimitedError` (`.retryAfterMs`, readable `.message`). Already applied inside `createChannel`, `createSpace`, `createDm`, `inviteUser`, `joinRoom`. |
| `sendVoiceMessage` (Phase 2) | `(roomId, blob: Blob, { durationMs: number, waveform: number[], mimetype: string }) => Promise<eventId>` | `uploadContent(blob, { name: 'Voice message.<ext>', type, includeFilename: true })` then sends **exactly** the contract content below. `mimetype` is reduced to its base type; `waveform` is sanitised (ints 0..1024, resampled to 100 when > 120); `durationMs` rounded. Throws on upload/send failure (Dev B shows `recording-error`). |

Voice message content (docs/PHASE2_ACCEPTANCE.md; Element-compatible):

```json
{ "msgtype": "m.audio", "body": "Voice message", "url": "mxc://localhost/x",
  "info": { "duration": 3120, "mimetype": "audio/webm", "size": 14023 },
  "org.matrix.msc1767.text": "Voice message",
  "org.matrix.msc1767.file": { "url": "mxc://localhost/x", "name": "Voice message.webm", "mimetype": "audio/webm", "size": 14023 },
  "org.matrix.msc1767.audio": { "duration": 3120, "waveform": [0, 12, 310, 1024, 540] },
  "org.matrix.msc3245.voice": {} }
```
`duration` is integer ms (same in both places); `waveform` ~100 ints 0..1024 (peak per bucket, loudest = 1024);
`mimetype` is the real base container type (`audio/webm` on Android/Chromium, `audio/mp4` on iOS, `audio/ogg` on
Firefox, `audio/wav` for the QA fixture); extension follows it (`.webm` / `.m4a` / `.ogg` / `.wav`). No encryption.
`scripts/send-voice-sample.mjs` posts one through the raw API and validates every field.

### Read helpers (`src/lib/matrix/utils.ts`)

`displayNameOf(room, userId)`, `avatarUrlOf(room, userId, size=40)`, `memberAvatarUrl(member, size)`,
`roomAvatarUrl(room, size)`, `roomTopic(room)`, `isEditEvent(e)`, `isReactionEvent(e)`, `isDisplayableEvent(e)`,
`getReplyTargetId(e)`, `stripReplyFallback(body)`, `stripHtmlReplyFallback(html)`, `previewText(e, max)`,
`isPendingEvent(e)`, and

```ts
getDisplayBody(event) => { text, html?, msgtype, isEdited, isRedacted, replyTo?, url?, info?, mentions, voice? }
```
`text`/`html` already reflect the latest edit (the SDK swaps `getContent()` when the `m.replace` arrives) and have
legacy reply fallbacks stripped. Sanitise `html` with `sanitizeHtml()` from `src/lib/format.ts` before rendering.
`voice` (Phase 2) is `getVoiceMessage(event) ?? undefined` for `m.audio` events.

```ts
getVoiceMessage(event) => { url (http via mxcToHttp), mxc, durationMs, waveform: number[], mimetype, size?, isVoice, name } | null
formatDuration(ms) => 'm:ss'    // 3120 -> "0:03"
```
Non-null for any non-redacted `m.room.message` that is `m.audio`, or carries `org.matrix.msc3245.voice`, or has an
`audio/*` mimetype, **and** has an `mxc://` url (`url`, else `msc1767.file.url`). `isVoice` = msc3245 key present;
`durationMs` = `msc1767.audio.duration` -> `info.duration` -> `0` (player then reads `<audio>` metadata);
`waveform` = sanitised `msc1767.audio.waveform` or `[]` (render flat bars). `isDisplayableEvent` already keeps
`m.audio` rows; redacted ones render `message-redacted` (`getVoiceMessage` returns null for them).
`previewText` gives `[voice message]` for voice notes and `[audio] <body>` for plain audio files.

### Audio primitives (`src/lib/audio/`, Phase 2; no React, no Matrix)

| Export | Signature | Notes |
|---|---|---|
| `pickVoiceMimeType` | `() => string` | First `MediaRecorder.isTypeSupported` of `audio/ogg;codecs=opus`, `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/ogg`; `''` when unavailable. `pickRecordingMimeType()` is the same with `null`. |
| `encodeToOggOpus` | `(blob, fallbackMimetype?) => Promise<{ blob, mimetype }>` | **Identity in the POC** (no transcoding; decision above). `mimetype` = base type of `blob.type`, else the fallback, else `audio/webm`. Never rejects for format reasons. The P1 seam. |
| `decodeToPcm` | `(blob) => Promise<AudioBuffer>` | `OfflineAudioContext.decodeAudioData` (fallback `AudioContext`); rejects when undecodable. |
| `computeWaveform` | `(src: AudioBuffer \| Float32Array, samples = 100) => number[]` | Peak per bucket, normalised so the loudest bucket is 1024. |
| `baseMimetype` / `containerMimeType` | `(mime) => string` | `'audio/webm;codecs=opus' -> 'audio/webm'`. |
| `extensionFor`, `voiceFileName`, `isAudioMimeType` | | `audio/mp4 -> m4a`; `Voice message.<ext>`. |
| `analyzeAudio` | `(blob, samples = 100, { normalize? }) => Promise<{ durationMs, waveform, decoded, sampleRate?, channels? }>` | **One decode** for both numbers; never throws (`decoded: false`, `durationMs: 0`, flat zeros). Prefer this over calling `decodeToPcm` + `computeWaveform` separately. |
| `computeWaveformFromBlob`, `getAudioDuration` | `(blob) => Promise<number[]>`, `(blob) => Promise<ms>` | The brief's blob-based helpers; thin wrappers over `analyzeAudio`. |
| `sanitizeWaveform` | `(unknown) => number[]` | Clamp to ints 0..1024, drop junk, peak-resample to 100 when longer than 120. |
| `startRecording` | `(opts?: { timesliceMs?, maxDurationMs?, onAutoStop?, audio? }) => Promise<RecordingHandle>` | `getUserMedia` (echo/noise/AGC on) + `MediaRecorder(pickRecordingMimeType())`, `start(250)`. Rejects with the getUserMedia error (`NotAllowedError`, `NotFoundError`) or an `Error` when unsupported. Handle: `{ mimeType, stream, startedAt, stop(): Promise<{ blob, mimetype, durationMs }>, cancel() }`; both release the mic. `durationMs` is wall-clock; use `analyzeAudio` for the real one. |
| `createLevelMeter` | `(stream) => { read(): 0..100, close() }` | AnalyserNode RMS, perceptually scaled, for `recording-level`. |
| `isRecordingSupported` | `() => boolean` | MediaRecorder + getUserMedia present (secure context). |

Dev B's send flow: `startRecording` -> `createLevelMeter` -> `stop()` -> `analyzeAudio(blob)` -> `encodeToOggOpus(blob)`
-> `sendVoiceMessage(roomId, out.blob, { durationMs: decoded ? durationMs : timed, waveform, mimetype: out.mimetype })`.

### Native integration (`src/lib/native.ts`, Phase 2; every export is a no-op on the web)

| Export | Signature | Notes |
|---|---|---|
| `isNativeApp` | `() => boolean` | `Capacitor.isNativePlatform()`. |
| `platform` / `getPlatform` | `() => 'android' \| 'ios' \| 'web'` | |
| `initNative` | `(opts?: { onKeyboard?(px), onBackButton?(): boolean }) => Promise<void>` | Called once by `App.tsx`: status bar (`overlaysWebView: false`, dark style, `#1e1f22`), keyboard listeners (`--keyboard-height`, `<html data-keyboard>`), Android back (handler returns true when it consumed it, else `minimizeApp()`). Idempotent. |
| `tap` / `hapticTap` | `(style?: 'light' \| 'medium' \| 'heavy') => Promise<void>` / `() => void` | `Haptics.impact`. |
| `onAppStateChange` | `(cb: (active: boolean) => void) => unsubscribe` | Foreground/background. |
| `STATUS_BAR_COLOR` | `'#1e1f22'` | = `--bg-rail`. |

Mic permission needs no code: `AndroidManifest.xml` declares `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` and
Capacitor's `BridgeWebChromeClient.onPermissionRequest` turns the WebView's `AUDIO_CAPTURE` request into the runtime
prompt. iOS: `NSMicrophoneUsageDescription` in `Info.plist`.

### Homeserver URL (`src/lib/matrix/config.ts`, Phase 2)

`getHsUrl()` = localStorage `matrix-poc.hsUrl` (login screen > Advanced) -> `VITE_HS_URL` (build time; the LAN APK bakes
`http://<pc-ip>:8009`) -> `http://localhost:8008`. `setHsUrl(input)` normalises (`192.168.1.2:8009` -> `http://192.168.1.2:8009`,
trailing slash dropped; empty or equal to the default removes the override), `hasHsUrlOverride()`, `DEFAULT_HS_URL`,
`normalizeHsUrl()`. Read it per call; the `HS_URL` constant is deprecated (build-time default only). The persisted
session keeps its own `baseUrl`, so a restored session keeps talking to the server it logged into.

### CSS contract (Phase 2)

`theme.css`: `--safe-top/right/bottom/left` (`env(safe-area-inset-*, 0px)`; 0 on desktop and inside the Capacitor
app since the status bar is outside the WebView; the iPhone home indicator and phone browsers give real values),
`--tap-target: 44px`, `--phone-header-h: 56px`, `--drawer-w: 85%`, `--keyboard-height` (native), `--vvh` (visual
viewport height in px). `global.css`: `#root` is `100dvh` (fallback `100vh`), `overscroll-behavior: none`, phone-only
(`:root[data-layout='phone']`) rules: transparent tap highlight, `touch-action: manipulation`, hidden scrollbars, and
**`font-size: max(16px, 1em) !important` on every input/textarea/select** (iOS focus zoom) - do not fight it.
`index.html` viewport: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`.
Features use `@media (hover: none)` or `:root[data-layout='phone']` for touch styling; the composer owns
`padding-bottom: var(--safe-bottom)` (the shell does not pad the bottom, so `composer`'s bottom edge is the shell's).

### Formatting (`src/lib/format.ts`)

`sanitizeHtml(html)` (DOMPurify, Matrix allowlist, `<a target=_blank rel=noopener noreferrer>`, `<img>` only from mxc),
`linkify(text) => ({ kind: 'text' } | { kind: 'link', href })[]`, `escapeHtml`, `formatTime(ts)`, `formatFullTime(ts)`,
`formatDayDivider(ts)`, `isSameDay(a, b)`, `initialsOf(name)`, `colorFor(id)`.

### Client (`src/lib/matrix/client.ts`)

`getClient()` (throws when logged out), `getClientOrNull()`, `loadSession/saveSession/clearSession`,
`login`, `register`, `startClientFromSession`, `waitForPrepared`, `logout`, `mxcToHttp` (re-export).
`HS_URL` comes from `VITE_HS_URL` (default `http://localhost:8008`).

## data-testid convention

`data-testid`, kebab-case, `{area}-{element}`; dynamic suffix is the raw Matrix id (`channel-item-!abc:localhost`,
`message-$xyz`, `member-item-@bob:localhost`, `reaction-👍`). Helper attributes: `data-name` (room/user display name),
`data-sender`, `data-count`, `data-mine`, `data-selected`. The full registry is `docs/ACCEPTANCE.md` (+
`docs/PHASE2_ACCEPTANCE.md`); the Principal-owned ids are `login-form`, `login-username`, `login-password`,
`login-submit`, `login-register-toggle`, `login-error`, `app-loading`, `app-shell` (+ `data-layout`), `current-user`,
`logout-button`, `toast`, `empty-state`, and since Phase 2 `login-advanced-toggle`, `login-hs-url`, `login-hs-url-reset`,
`login-hs-url-effective`, `nav-drawer` (+ `data-open`), `member-drawer` (+ `data-open`), `drawer-backdrop` (+ `data-open`).
App-owned localStorage keys: `matrix-poc.session`, `nav.selection`, `matrix-poc.hsUrl` (Phase 2).
The placeholder feature components already use the registry ids (`space-rail`, `channel-item-*`,
`message-list`, `composer-input`, ...); keep them when replacing internals.

## How to run everything

```
npm install            # + Playwright chromium (postinstall)
npm run hs:up          # Synapse on :8008 (Docker if available, else the WSL1 fallback; see homeserver/README.md)
npm run seed           # fixture data; idempotent guard on #acme-hq:localhost; writes seed/seed-output.json
npm run dev            # Vite on :5173
npm run typecheck      # tsc --noEmit
npm run build          # tsc + vite build
npm run test:e2e       # Playwright (starts the dev server if needed)
npm run seed:reset     # wipe the homeserver data and reseed
node scripts/verify-scaffold.mjs   # login as alice + screenshot to docs/screenshots/scaffold.png
```

`.env` (optional): `VITE_HS_URL=http://localhost:8008`. The seed and scripts read `HS_URL`. Nothing in the client,
seed or tests depends on how the homeserver is hosted - only on that URL.

Phase 2 (details in `docs/MOBILE.md`):

```
npm run hs:lan                     # LAN proxy 0.0.0.0:8009 -> 127.0.0.1:8008, prints the phone URLs (firewall prompt once)
npm run dev:lan                    # Vite on 0.0.0.0:5173 for a phone browser (look & feel; no mic: insecure context)
npm run toolchain [-- --setx]      # find JDK 21 + Android SDK; --setx persists JAVA_HOME/ANDROID_HOME + ~/.gradle java home
npm run cap:build:android:lan      # vite build (VITE_HS_URL=http://<lan-ip>:8009) + cap sync + gradlew assembleDebug -> APK
npm run cap:build:android          # same with VITE_HS_URL from the env (web default otherwise)
npm run cap:sync | cap:copy:ios | cap:open:android | cap:open:ios
npm run voice:sample               # bob posts a contract-shaped voice note to #dev via the API and validates it
npm run dev -- --port 5183 && npm run verify:phone     # Pixel 7 Playwright check + docs/screenshots/phase2-shell-phone*.png
```

## matrix-js-sdk gotchas (v43) you must know

- **Edits**: the `m.replace` event is in the timeline too. Never render it as a row (`isDisplayableEvent` drops it).
  The target's `getContent()` already returns `m.new_content`; `event.replacingEvent()` is non-null when edited.
  The target object is mutated in place, so a memoised row keyed only on `event.getId()` will not re-render:
  include `useRoomTimeline().version` (or `event.replacingEventId()`) in your memo deps.
- **Reactions**: also timeline events; aggregated in `room.getUnfilteredTimelineSet().relations`. Use
  `getReactions(roomId, eventId)`; it re-reads on every render, and the list re-renders on `version`.
- **Redactions**: the event stays in the timeline with empty content, `event.isRedacted()` true. Redacted
  reactions disappear from `getReactions`.
- **Local echo**: `sendText` puts a pending event (id `~...`, `event.status !== null`) in the live timeline
  immediately; when the server acks, `Room.localEchoUpdated` fires and the id changes to `$...`. Key rows by
  `event.getId()` and expect one re-render with a new key. Do not send receipts for `~` ids (`sendReadReceipt` guards).
- **Ordering / pagination**: `paginateBack` prepends into the same live `EventTimeline`; the snapshot is
  replaced wholesale (oldest first). Pin the scroll position around it (DEV-B-3). A `Room.timelineReset`
  (sync gap) replaces the array too; treat every commit as "re-render from the array", never diff manually.
- **Lazy members**: only senders are known after the initial sync. `useMembers`/`selectRoom` call
  `loadMembersIfNeeded`; the member list fills in on the next `version` bump. Typing users are read from the
  `m.typing` event's `user_ids`, so unknown members still show (as their localpart until loaded).
- **Unread counts** are server-side (`unread_notifications`). After `sendReadReceipt` the badge clears when the
  next `/sync` echoes the receipt (usually < 1 s). The seed leaves #random at 3 and #lobby at 2 for alice.
- **Media**: the homeserver runs with `enable_authenticated_media: false`, so `mxcToHttp()` returns plain
  `/_matrix/media/v3/{download,thumbnail}` URLs that work in `<img>` without headers. Do not switch this on.
- **No crypto**: never call `initRustCrypto`; rooms are created without `m.room.encryption`. Encrypted rooms from
  other clients would show as undecryptable - out of scope.
- **Sync loop errors**: the SDK retries forever; `useSessionStore.error` carries the message while `status`
  stays `'ready'`. `UserFooter` shows "Reconnecting...".
- `MatrixError` (from `matrix-js-sdk`) has `errcode` and `httpStatus`; `describeError()` gives user text.
- **Expected console 404 on startup**: the SDK probes `/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`
  (MatrixRTC) once per `startClient`; Synapse answers 404. Harmless, ignore it in QA console checks.
- **Initial window**: `initialSyncLimit: 30` counts every event (reactions, edits, state), so #general shows ~25
  message rows before the first `paginateBack`; `general.first` is not in the DOM until you paginate (AC-B3-1).
- **A just-created room arrives in two `/sync` batches.** Synapse persists `createRoom`'s events one by one and
  wakes the client's in-flight long-poll on the first of them, so the first batch often carries only
  `m.room.create` + your join; `m.room.name`, `m.room.topic` and `m.space.parent` follow in the next `/sync`
  (the gap grows when SQLite is busy). Consequences: `waitForRoom()` resolves on the first batch, `RoomSummary.name`
  and `parentSpaceId` can be wrong/undefined for a few hundred ms, and `useRoomStore.version` bumps again when the
  rest lands. The store's selection logic is written for this (see the invariant above); feature code should
  never cache a `RoomSummary` of a room it just created - re-read it from `roomsById` on each render.
- **Room creation is rate limited separately** (`rc_room_creation`, default burst 10 then one room per ~62 s per
  user) and the SDK does **not** retry `createRoom` on 429 (only `m.room.message` sends go through its retrying
  scheduler). `createChannel` / `createSpace` / `createDm` / `inviteUser` / `joinRoom` therefore go through
  `retryOnRateLimit` (waits `retry_after_ms`, up to 30 s, else `RateLimitedError`). A homeserver whose config
  lacks the `rc_room_creation` override will still fail dialogs after ~10 room creations by the same user until the
  bucket refills - if a create-channel/space/DM test fails with a 429 in the toast/dialog, that is the cause.

## Mobile / voice gotchas (Phase 2)

- **MediaRecorder WebM blobs have no duration header**: `<audio>.duration` is `Infinity` and `loadedmetadata` lies.
  Use `analyzeAudio(blob).durationMs` (decode) or the recorder's wall-clock `durationMs`; the event carries the number
  so players never need to compute it. Received notes from other clients might still lack it -> `durationMs: 0`, read
  `<audio>` metadata then (works for Ogg/MP4/WAV).
- **Secure context**: `getUserMedia` exists only on https, `http://localhost`, and inside the app (`http://localhost`
  origin). `http://192.168.x.x:5173` in a phone browser has no `navigator.mediaDevices` - `isRecordingSupported()`
  is false; show the mic button disabled with a hint, do not crash. Never set Capacitor `server.url` to a LAN IP.
- **Mixed content**: the app origin is `http://localhost` (not https) precisely so plain-http XHR/media to the LAN
  proxy is allowed. Do not switch `androidScheme` back to `https` without TLS on the proxy.
- **`decodeAudioData` and iOS**: use `OfflineAudioContext` (done in `decodeAudio`); a fresh `AudioContext` created
  outside a user gesture stays suspended on iOS and some decodes never resolve. Playback with `<audio>` is fine;
  autoplay still needs the tap that pressed play.
- **Format per platform**: Chromium/Android WebView record `audio/webm;codecs=opus`, Safari/WKWebView `audio/mp4`
  (AAC), Firefox `audio/ogg;codecs=opus`. Everything Chromium-based plays all three; WKWebView may refuse WebM
  (`voice-error` + download link). Element plays all of them.
- **Waveform normalisation**: `computeWaveform` scales the loudest bucket to 1024, so a quiet recording still shows
  bars; silence stays all zeros. QA fixtures from `scripts/send-voice-sample.mjs` use the same algorithm.
- **Release the mic**: always `stop()`/`cancel()` the `RecordingHandle` (and `close()` the level meter) on room
  switch / unmount, or Android keeps the recording indicator on. `startRecording` stops all tracks in both paths.
- **`isPhone` is not `(hover: none)`**: the store uses width (<= 767) or coarse pointer up to 1023 px; CSS may use
  `@media (hover: none)` for touch affordances. A desktop window narrowed under 768 px *is* a phone layout (by design).
- **Drawers and `selectSpace`**: `selectSpace()` changes `selectedRoomId` too; do not subscribe to `selectedRoomId` to
  close the drawer (it would close on a space tap). Use `onRoomSelected()` or just let the layout store do it.
- **Space switch inside the drawer** is instant; room arrival after `createChannel` still comes in two `/sync`
  batches (see above) - `selectRoom(newId)` from a dialog closes the drawer immediately and the room fills in.
- **`cap sync` copies `dist/`**: a stale `dist/` means a stale APK. Always build through `cap:build:android*` (it runs
  `vite build` first) or `npm run cap:sync`.
- **Capacitor 7 + Java**: Java 8 is first on PATH on this machine. Anything that runs Gradle outside the scripts needs
  `JAVA_HOME` = JDK 21 or the `org.gradle.java.home` line the scripts write to `~/.gradle/gradle.properties`.
- **Edge-to-edge (Android 15, targetSdk 35)**: Capacitor 7 handles system-bar insets natively (`SystemBars`);
  `env(safe-area-inset-*)` is 0 inside the WebView with `overlaysWebView: false`, so the CSS fallbacks must look
  right - they do (the status bar is painted by the OS in `#1e1f22`).
