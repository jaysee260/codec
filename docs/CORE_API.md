# Core API reference

Every store, hook, action, helper and wire shape in the shared layer (`src/lib`, `src/store`, `src/app`), grouped by
module. This is the file you copy signatures from. For how the pieces fit together read `docs/ARCHITECTURE.md` first;
for the traps, `docs/GOTCHAS.md`.

**Precedence**: where this file differs from a plan, ticket or acceptance doc under `docs/archive/`, **this file wins**.

How entries are written: a signature in code, then one plain line saying what it is for, then bullets with rules and
defaults. Type shapes that you would copy-paste stay in `ts` blocks.

Contents: [Module map](#module-map) · [Session store](#session-store) · [Room store](#room-store) ·
[Layout store](#layout-store) · [Timeline store](#timeline-store) · [Hooks](#hooks) · [Actions](#actions) ·
[Read helpers](#read-helpers) · [Audio primitives](#audio-primitives) · [Native integration](#native-integration) ·
[Homeserver URL](#homeserver-url) · [CSS contract](#css-contract) · [Formatting](#formatting) · [Client](#client) ·
[Threads](#threads) · [GIFs](#gifs) · [Link previews](#link-previews) · [Read receipts](#read-receipts) ·
[Encryption](#encryption) · [Voice calls](#voice-calls) · [Dev hooks](#dev-hooks)

## Module map

```
src/
  main.tsx                     React root; imports styles/global.css
  app/                         (Principal) session gate + shell
    App.tsx                    status -> LoginScreen | LoadingScreen | Shell; boots initNative(); dev hooks
    LoginScreen.tsx            login/register form + Advanced > Homeserver URL
    LoadingScreen.tsx          data-testid=app-loading until PREPARED; data-stage=crypto|sync
    Shell.tsx                  desktop: 72 | 240 | 1fr | auto grid; phone: full-screen column + two drawers; security hosts
    Drawer.tsx                 off-canvas drawer container (phone), data-testid nav-drawer / member-drawer
    UserFooter.tsx             bottom-left user pill + logout; data-verified + "Verified" line
    Toast.tsx                  global toasts
    devtools.ts                window.__matrixPoc in dev builds only
    theme.css                  design tokens (the only CSS variables features may use) incl. --safe-*, --tap-target, --vvh
  styles/global.css            reset, scrollbars, utilities (.u-avatar, .u-btn, .u-input, ...), 100dvh, phone-only rules
  lib/
    format.ts                  sanitizeHtml, linkify, formatTime, isSameDay, formatDayDivider, initialsOf, colorFor; formatRelative
    native.ts                  isNativeApp, platform/getPlatform, initNative, tap/hapticTap, onAppStateChange
    gif/                       GIF picker backend, no React, no Matrix; all but provider.ts are Node-loadable
      types.ts                 GifResult, GifPage, GifProvider, GifQueryOptions, GifMessage, GifProviderError
      config.ts                GIF_CONTENT_RATING, GIF_SEND_VARIANT, GIF_IMAGE_HOSTS, GIF_MAX_DIMENSION, KLIPY_DEFAULT_BASE, storage keys
      message.ts               buildGifContent (the wire shape), parseGifContent / isAllowedGifUrl (host allow list), GIF_CONTENT_KEY
      mock-fixtures.ts         MOCK_FIXTURES catalogue (ids, titles, dimensions), MOCK_EMPTY_QUERIES, MOCK_ERROR_QUERY
      mock.ts                  createMockProvider, mockGifResults (own-origin /gif-fixtures/*.gif + .png)
      klipy.ts                 createKlipyProvider, mapKlipyItem, klipyRequestUrl, parseRetryAfter, RATING_TO_CONTENT_FILTER
      provider.ts              getGifProvider / gifProviderName / searchGifs / trendingGifs, key + provider overrides (env + localStorage)
      index.ts                 barrel ('@/lib/gif')
    audio/                     voice-note primitives, no React, no Matrix
      encode.ts                Shared API: pickVoiceMimeType, encodeToOggOpus, decodeToPcm, computeWaveform, baseMimetype
      recording.ts             startRecording (getUserMedia + MediaRecorder lifecycle), createLevelMeter, pickRecordingMimeType
      analysis.ts              decodeAudio, analyzeAudio, waveformFromSamples, sanitizeWaveform, computeWaveformFromBlob, getAudioDuration
      mime.ts                  containerMimeType, extensionFor, voiceFileName, isAudioMimeType
      ogg.ts                   remuxWebmOpusToOgg (pure TS, lossless), parseOggPages, isWebmBytes/isOggBytes
      wav.ts                   encodeWav: PCM -> 16-bit WAV bytes
      softdecode.ts            canPlayNatively, decodeToWavBlob (lazy ogg-opus-decoder), SoftDecodeError
      index.ts                 re-exports (full API list in its header)
    matrix/
      config.ts                getHsUrl/setHsUrl/hasHsUrlOverride/normalizeHsUrl, DEFAULT_HS_URL, storage keys, localpartOf, serverNameOf
      mxc.ts                   mxcToHttp (pure; resolves getHsUrl() per call)
      client.ts                getClient, login, register, logout, session persistence, startClient; initCrypto before startClient, wipe on logout
      crypto.ts                engine lifecycle: cryptoDatabasePrefix, initCrypto, wipeCryptoStore, cryptoCallbacks, secret-storage key cache
      security.ts              CryptoApi wrappers: status, SAS verification, UIA (password / SSO fallback), recovery key, backup
      attachment-crypto.ts     pure AES-256-CTR + SHA-256 attachment scheme (WebCrypto); Node-loadable
      attachments.ts           EncryptedFile, encrypt/decryptAttachment (re-exported), fetchDecryptedMedia -> blob: URL cache
      media.ts                 authenticated media (service worker); MediaSource, mediaSourceOf, encrypted openMedia / downloadMedia
      actions.ts               every write + a few aggregate readers (members, reactions); sendVoiceMessage; sendGif; encrypted uploads, encrypted-by-default rooms
      utils.ts                 read helpers over SDK objects (display names, avatars, getDisplayBody, getVoiceMessage, getGifContent, ...); isRoomEncrypted, getDecryptionState
    rtc/                       index.ts barrel; session.ts CallSession (MatrixRTC membership + LiveKit room + E2EE keys); ringing.ts (Codec ring/decline + watcher);
                               focus.ts, token.ts, key-provider.ts, e2ee-worker.ts, participants.ts, permissions.ts, timeline.ts, history.ts, livekit-token.ts (pure, shared with scripts), types.ts, constants.ts
  store/
    session.ts                 useSessionStore; loadingStage, binds/unbinds the security store
    security.ts                useSecurityStore: status, hint, verification flow, recovery, prompts; bindSecurity/unbindSecurity/resetSecurity
    call.ts                    useCallStore: activeCall, incoming, history, liveSessions; canCall, enableCallsInRoom, bindCalls/unbindCalls/resetCalls; call hooks
    rooms.ts                   useRoomStore + recomputeRooms + waitForRoom + onRoomSelected; RoomSummary.encrypted
    layout.ts                  useLayoutStore, useIsPhone, useViewport, detectIsPhone; stamps <html data-layout>, --vvh; registerBackHandler, runBackHandlers
    timeline.ts                useTimelineStore + refreshTimeline + setTypingForRoom; TimelineSource, thread snapshots, paginateBack(source), ensureThreadTimeline
    threads.ts                 useThreadStore (open thread), useThreadSummary, useThreadRoot, useRoomThreads, useThreadUnread, useOpenThread(RootId)
    thread.ts                  re-export of threads.ts (docs/PHASE3_TICKETS.md name)
    bridge.ts                  bindClient/unbindClient: SDK events -> stores (debounced); thread timeline sets, per-room ThreadEvent.*, thread local echo; MatrixEventEvent.Decrypted
    hooks.ts                   useRoomTimeline, useTyping, useMembers, useRoomSummary, useSelectedRoom, useMyUserId (+ re-exports useIsPhone, useViewport); useTimeline(source) + thread hooks re-exported; useRoomEncrypted, useDecryptionState, useDecryptedMediaUrl (= useMediaObjectUrl), security hooks re-exported
    toast.ts                   useToastStore, showToast, withToast
    index.ts                   re-exports
  features/
    navigation/                (Dev A) index.ts exports SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel, useNavUiStore
    conversation/              (Dev B) index.ts exports Conversation and ThreadView (placeholder by the Principal; Dev B replaces the internals)
    gif/                       (Dev A) GifPicker (search, trending, grid, keyboard, sheet variant)
    security/                  (Dev A) index.ts exports SecurityBanner, SecurityDialogs (the Shell resolves it lazily; absent = renders nothing)
public/gif-fixtures/           mock-1..8.gif (animated GIF89a) + mock-1..8.png stills, generated by scripts/make-gif-fixtures.mjs
capacitor.config.ts            appId com.acme.matrixpoc, webDir dist, androidScheme http + cleartext, Keyboard native, StatusBar dark
android/                       generated by `cap add android` (Capacitor 7); committed minus build outputs; manifest has RECORD_AUDIO etc.
ios/                           generated by `cap add ios`; Info.plist has NSMicrophoneUsageDescription + ATS exception; Pods/ not committed
seed/seed.ts                   fixture script (docs/SEED_DATA.md), writes seed/seed-output.json
scripts/hs.mjs                 homeserver wrapper: up/down/reset/logs/status over docker compose OR homeserver/wsl/hs.sh
scripts/lan-proxy.mjs          0.0.0.0:8009 -> 127.0.0.1:8008 HTTP pass-through; prints phone URLs (npm run hs:lan)
scripts/lib/lan.mjs            lanIPv4Addresses, primaryLanIPv4, lanHomeserverUrl
scripts/toolchain.mjs          find JDK 21 + Android SDK, --setx, ~/.gradle/gradle.properties (npm run toolchain)
scripts/cap-build-android.mjs  vite build (VITE_HS_URL) + cap sync + gradlew assembleDebug -> APK path (npm run cap:build:android[:lan])
scripts/send-voice-sample.mjs  post a contract-shaped voice message via the API, validate it (npm run voice:sample)
scripts/verify-phone-shell.mjs Pixel 7 Playwright check + screenshots + voice round trip (npm run verify:phone)
scripts/send-thread-sample.mjs post a thread (root + replies, exact wire shape) via the API, validate the server bundle (npm run thread:sample)
src/lib/matrix/receipts-core.ts pure: SendStatus, Reader, mapReadPointsToRows, pickLatestOwnSentId, setting merge (Node-loadable, unit-tested)
src/lib/matrix/receipts.ts     SDK-bound: getReceiptHolder, buildReadPoints, getSeenBy, get/setSendReadReceipts
src/store/receipts.ts          receiptVersion[roomId] + settingsVersion, useReadPoints / useLatestOwnSentId / useSendStatus / useSeenBy / useSendReadReceiptsSetting
e2e/receipts.spec.ts, e2e/mobile-receipts.spec.ts   (QA) placeholders until QA-R2/R3 land
scripts/send-encrypted-sample.mjs bob posts encrypted texts + an encrypted PNG into #vault with the Node crypto engine, exports keys (npm run e2ee:sample)
scripts/verify-e2ee.mjs        attachment round trip, room state, wire shape, decrypt with seed/e2ee-keys.json, ciphertext on the server (npm run verify:e2ee)
scripts/lib/e2ee-api.mjs       Node crypto client helpers, loginWithDevice, downloadMedia, mergeRoomKeys, quietLogger
scripts/rtc.mjs                fetch/up/down/status of the single dev call stack (LiveKit :7880 + lk-jwt :7980); chained into hs:up / hs:down
scripts/rtc-probe.mjs          no-browser proof of the call chain: well-known -> jwt -> /sfu/get -> JWT -> SFU -> membership on the wire (npm run rtc:probe)
scripts/lib/rtc-stack.mjs      pinned livekit-server download, config rendering, start/stop/status of one stack per Synapse (used by rtc.mjs and hs-pool.mjs)
scripts/lib/lk-jwt.mjs         Node port of lk-jwt-service (/sfu/get, /get_token, /healthz) verifying OpenID tokens against a local Synapse
scripts/verify-thread-shell.mjs desktop + Pixel 7 Playwright check of the thread core on :5183 + screenshots (npm run verify:threads)
scripts/make-gif-fixtures.mjs  pure-Node GIF89a + PNG encoder rendering the MOCK_FIXTURES catalogue into public/gif-fixtures (npm run gif:fixtures)
scripts/send-gif-sample.mjs    bob posts a contract GIF message to #dev via the API using the client's buildGifContent (npm run gif:sample)
scripts/verify-gif.mjs         no-browser check of the gif core: mock contract, fixtures, wire shape, Klipy mapping, live round trip to #dev, optional real Klipy search (npm run verify:gif)
scripts/lib/gif-api.mjs        raw API helpers + type-stripped import of src/lib/gif for the two scripts above
scripts/verify-scaffold.mjs    throwaway Playwright smoke (login + screenshot)
homeserver/                    homeserver.yaml (single config, committed), docker-compose.yml, wsl/ (no-Docker fallback), data/* (ignored)
docs/MOBILE.md                 phone browser path, toolchain, APK, LAN proxy, iOS handoff, troubleshooting
e2e/, playwright.config.ts     (QA)
```

## Session store

`useSessionStore` lives in `src/store/session.ts`. It owns who is logged in and which screen shows.

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

## Room store

`useRoomStore` lives in `src/store/rooms.ts`. It owns the sidebar: spaces, channels, DMs, unread counts and the selection.

| Member | Type | Semantics |
|---|---|---|
| `ready` | `boolean` | True after the first recompute post-PREPARED. |
| `spaces` | `RoomSummary[]` | Joined `m.space` rooms, sorted by name. |
| `channelsBySpace` | `Record<spaceId, RoomSummary[]>` | Joined child rooms per space, sorted by `m.space.child.order` then name. Children I have not joined are not listed (request `getRoomHierarchy` support if needed). |
| `dms` | `RoomSummary[]` | Rooms listed in my `m.direct` account data, newest activity first. |
| `orphanRooms` | `RoomSummary[]` | Joined rooms with no space and not DMs (shown under Home). |
| `invites` | `RoomSummary[]` | Rooms I am invited to. |
| `roomsById` | `Record<roomId, RoomSummary>` | Every joined/invited room. |
| `unreadByRoom`, `highlightByRoom` | `Record<roomId, number>` | From `room.getRoomUnreadNotificationCount()` - the **main timeline only** since Phase 3 (server-computed; updates after receipts sync back). Thread replies never count here. |
| `threadUnreadByRoom` | `Record<roomId, boolean>` | `room.hasThreadUnreadNotification()`: some thread in the room has unread notifications (server `unread_thread_notifications`, cleared by threaded receipts). The header "Threads" dot. Same value as `useThreadUnread(roomId)`. |
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
  joinRule, membership, lastActiveTs, memberCount, unread, highlight, threadUnread }
```
`name` is the bare room name (`general`, not `#general`); for DMs it is the other user's display name.

## Layout store

`useLayoutStore` lives in `src/store/layout.ts`. It owns phone-vs-desktop, the drawers, the keyboard and the viewport.

| Member | Type | Semantics |
|---|---|---|
| `isPhone` | `boolean` | `matchMedia('(max-width: 767px)')` **or** `'(pointer: coarse) and (max-width: 1023px)'`, live (AC-M1-3). Desktop Playwright 1280x720 is never a phone. Mirrored as `<html data-layout="phone\|desktop">` and on `app-shell[data-layout]`. |
| `navOpen`, `membersOpen` | `boolean` | Phone drawers (`nav-drawer`, `member-drawer`). Opening one closes the other. Leaving phone mode closes both. Desktop member panel visibility is still Dev A's `useNavUiStore.membersOpen`. |
| `openNav()`, `closeNav()`, `toggleNav()` | `void` | `header-menu` calls `openNav()`. |
| `openMembers()`, `closeMembers()`, `toggleMembers()` | `void` | `member-toggle` on phone calls `openMembers()`. |
| `closeDrawers()` / `closeAll()` | `() => boolean` | Close whichever is open (backdrop, Escape, Android back). True if one was open. |
| `registerBackHandler(fn)` (module export) | `(fn: () => boolean) => () => void` | Android back: handlers run newest first; return true to consume the press (close your sheet). Returns the unregister function. `App.tsx` runs `runBackHandlers() \|\| closeThread() \|\| closeDrawers()` then minimises the app. |
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

## Timeline store

`useTimelineStore` lives in `src/store/timeline.ts`. It holds a copy of every loaded room and thread timeline.

| Member | Type | Semantics |
|---|---|---|
| `eventsByRoom` | `Record<roomId, MatrixEvent[]>` | Copy of `room.getLiveTimeline().getEvents()`, oldest first, **unfiltered** (state events, reactions, edits, local echoes included). New array identity per change. |
| `canPaginateBack` | `Record<roomId, boolean>` | `false` once the room start is reached (no backward pagination token). Missing = unknown, treat as `true`. |
| `isPaginating` | `Record<roomId, boolean>` | |
| `typingByRoom` | `Record<roomId, string[]>` | User ids typing, excluding me. |
| `version` | `number` | Bumps on every timeline/typing commit (and on thread commits). |
| `threadVersion` | `number` | Bumps on thread snapshot commits and Thread model changes (`ThreadEvent.New/Update/Delete`). |
| `eventsByThread` | `Record<threadKey, MatrixEvent[]>` | Copy of `room.getThread(rootId).liveTimeline.getEvents()`, oldest first, unfiltered (reactions/edits to replies included; the root is included once the start of the thread is reached). Key = `threadKey(roomId, rootId)` = `` `${roomId}|${rootId}` ``. |
| `canPaginateBackThread`, `isPaginatingThread` | `Record<threadKey, boolean>` | As the main ones; `canPaginateBackThread` is `true` (unknown) until the Thread's initial `/relations` fetch has run. |
| `paginateBack(roomId \| source, limit=30)` | `Promise<void>` | Main: `client.paginateEventTimeline(liveTimeline, { backwards: true, limit })`, then refreshes the snapshot. Thread source: `paginateEventTimeline(thread.liveTimeline, ...)` = `/relations/{root}/m.thread?dir=b&recurse=true`. No-op while in flight or at the start. |
| `paginateBackThread(roomId, rootId, limit=30)` | `Promise<void>` | The thread branch, callable directly. |

Helpers: `refreshTimeline(roomId)`, `refreshTimelines(ids)`, `ensureTimeline(roomId)`, `setTypingForRoom`, `resetTimelines`;
`paginateBack(source, limit?)` (module export), `refreshThread(roomId, rootId)`, `refreshThreads(roomId, rootIds)`,
`ensureThreadTimeline(roomId, rootId): Promise<Thread | null>` (get-or-create the SDK Thread, wait for its initial fetch, top the
first page up to >= 20 visible replies), `bumpThreadVersion()`, `threadKey(roomId, rootId)`, `sourceKey(source)` = `threadRootId ?? roomId`.
`type TimelineSource = { roomId: string; threadRootId?: string }`.

## Hooks

All in `src/store/hooks.ts`. Components read state only through these.

| Hook | Returns | Notes |
|---|---|---|
| `useTimeline(source)` | `{ events, allEvents, hasMore, isPaginating, version, paginateBack(limit?) }` | `{ roomId }` = main timeline: `events` = `allEvents.filter(isMainTimelineEvent)` (messages + stickers, incl. redacted; no reactions/edits/state/**thread replies**). `{ roomId, threadRootId }` = that thread: `events` = the replies (`isDisplayableEvent`, root excluded), oldest first; mounting it calls `ensureThreadTimeline`. Same shape either way (`type Timeline = RoomTimeline`). |
| `useRoomTimeline(roomId)` | same | Phase 1 name = `useTimeline({ roomId })`. Calls `ensureTimeline`. |
| `useTyping(roomId \| source)` | `string[]` | Display names of typing users (never me). Room-wide for a thread source too (Matrix has no thread typing). |
| `useThreadSummary(event)` | `ThreadSummary \| null` | Summary row data for a root; `null` for messages without a thread. See "Threads". |
| `useThreadRoot(roomId, rootId)` | `MatrixEvent \| undefined` | Loaded timeline -> Thread model -> `/event`. |
| `useRoomThreads(roomId)` | `{ threads, loading, error, refresh(), hasMore, loadMore() }` | Thread list, newest activity first. |
| `useThreadUnread(roomId)` | `boolean` | = `threadUnreadByRoom[roomId]`. |
| `useOpenThread()`, `useOpenThreadRootId()` | `{ roomId, threadRootId } \| null`, `string \| null` | Selectors over `useThreadStore`. |
| `useMembers(roomId)` | `{ joined: MemberInfo[], invited: MemberInfo[] }` | Sorted by power level desc then name; triggers `loadMembers`. `MemberInfo = { userId, name, avatarUrl, powerLevel, membership, presence }`. |
| `useRoomSummary(roomId)` | `RoomSummary \| undefined` | |
| `useSelectedRoom()` | `RoomSummary \| undefined` | |
| `useMyUserId()` | `string \| null` | |

## Actions

All in `src/lib/matrix/actions.ts`. Every write to the homeserver goes through one of these.

| Function | Signature | Semantics |
|---|---|---|
| `sendText` | `(roomId, body, opts?: { html?, replyTo?: MatrixEvent \| string, mentions?: string[], threadRoot?: string }) => Promise<eventId>` | `m.text`; `html` -> `formatted_body`; `replyTo` -> `m.relates_to.m.in_reply_to`; `mentions` -> `m.mentions.user_ids`. Local echo appears immediately. `threadRoot` sends into that thread with the wire shape below (local echo in the thread, never in the main list); `replyTo` + `threadRoot` **throws `ThreadReplyConflictError`** before sending (AC-T2-3). |
| `sendHtml` | `(roomId, body, html, opts?) => Promise<eventId>` | `sendText` with `html`. |
| `editText` | `(roomId, targetEventId, body, html?, opts?: { threadRoot? }) => Promise<eventId>` | Sends `m.replace` with `m.new_content` and `* ` fallback body. A thread reply's edit is routed through its thread (derived from the target when omitted). |
| `redactEvent` | `(roomId, eventId, reason?) => Promise<void>` | Messages, reactions, anything. Thread replies are redacted through their thread (derived). |
| `sendReaction` | `(roomId, targetEventId, key, opts?: { threadRoot? }) => Promise<eventId>` | `m.reaction` / `m.annotation`. Thread derived from the target when omitted. |
| `toggleReaction` | `(roomId, targetEventId, key, opts?) => Promise<void>` | Adds, or redacts my existing reaction with that key. |
| `uploadFile` | `(file: File) => Promise<{ mxc, mimetype, size, name, w?, h? }>` | Media upload; image dimensions measured in the browser. |
| `sendFile` | `(roomId, file, opts?: { threadRoot? }) => Promise<eventId>` | `m.image` for `image/*` (with `info.w/h`), else `m.file`. |
| `sendTyping` | `(roomId, typing, timeoutMs=5000, opts?: { threadRoot? }) => Promise<void>` | Room-wide; `threadRoot` is accepted and ignored (no thread typing in Matrix). |
| `sendReadReceipt` | `(roomId, event: MatrixEvent \| eventId, opts?: { threadId? }) => Promise<void>` | `m.read`. Skips local echoes. carries `thread_id`: `'main'` for main-timeline events and thread roots, the root id for thread replies - derived from the event by the SDK; `threadId` is only used when the event is an id that is not loaded. |
| `markRoomRead` | `(roomId) => Promise<void>` | Receipt for the newest sent event in the main live timeline (threads keep their own). |
| `markThreadRead` | `(roomId, rootId) => Promise<void>` | Threaded receipt on the newest loaded reply; clears that thread's unread count. |
| `resolveThreadRoot` | `(roomId, eventId) => string` | Reply id -> its root; roots / plain ids unchanged (threads never nest). |
| `threadRootOf` | `(roomId, eventId) => string \| undefined` | Root of a *reply* (wire relation), undefined for roots and plain messages. |
| `ensureThread` | `(roomId, rootId) => Promise<Thread \| null>` | Get-or-create the SDK `Thread` (fetches the root when not loaded; triggers its initial `/relations` fetch). |
| `fetchRoomThreads` | `(roomId) => Promise<void>` | `createThreadsTimelineSets()` + `fetchRoomThreads()` = `GET /v1/rooms/{id}/threads?include=all|participated` (newest 30), once per room. |
| `hasMoreRoomThreads`, `loadMoreRoomThreads` | `(roomId) => boolean`, `(roomId, limit=30) => Promise<boolean>` | Thread-list paging. |
| `createChannel` | `({ spaceId, name, topic?, encrypted? }) => Promise<roomId>` | `preset: public_chat`, `visibility: private`, encrypted unless `encrypted: false`, `m.space.parent` on the room, `m.space.child` (next `order`) on the space. |
| `createSpace` | `({ name, topic? }) => Promise<spaceId>` | `m.space`, public preset, then `createChannel({ name: 'general' })`. |
| `inviteUser` | `(roomId, userId) => Promise<void>` | Throws `MatrixError` (e.g. unknown user). |
| `createDm` | `(userId, { encrypted? }) => Promise<roomId>` | Encrypted unless `encrypted: false`. Reuses a joined room from `m.direct`; else `is_direct` + `trusted_private_chat` + invite, and updates `m.direct`. |
| `findDmRoomId`, `getDirectMap` | sync | `m.direct` readers. |
| `joinRoom` | `(roomIdOrAlias) => Promise<roomId>` | |
| `leaveRoom` | `(roomId) => Promise<void>` | |
| `getJoinedMembers`, `getInvitedMembers` | `(roomId) => RoomMember[]` | Sync readers (lazy-loaded; see `loadMembers`). |
| `loadMembers` | `(roomId) => Promise<void>` | `room.loadMembersIfNeeded()`; the store `version` bumps when they arrive. |
| `getReactions` | `(roomId, eventId) => { key, count, mine, senders, myEventId? }[]` | From `timelineSet.relations`; safe in render. Reads the thread's relations when the target is a thread reply, so one call works in both panels. |
| `fetchEvent` | `(roomId, eventId) => Promise<MatrixEvent \| undefined>` | Local timelines (main and threads) first, then `/rooms/{id}/event/{eventId}` (through the SDK event mapper). For reply quotes whose target is not loaded. |
| `canRedactEvent` | `(roomId, event) => boolean` | `room.currentState.maySendRedactionForEvent`. |
| `canEditEvent` | `(event) => boolean` | Own, non-redacted `m.room.message`; false for GIF messages. |
| `myPowerLevel` | `(roomId) => number` | |
| `retryOnRateLimit` | `(fn: () => Promise<T>, label?) => Promise<T>` | Retries `fn` on 429 honouring `retry_after_ms` up to 30 s total, then throws `RateLimitedError` (`.retryAfterMs`, readable `.message`). Already applied inside `createChannel`, `createSpace`, `createDm`, `inviteUser`, `joinRoom`. |
| `sendVoiceMessage` | `(roomId, blob: Blob, { durationMs: number, waveform: number[], mimetype: string }) => Promise<eventId>` | `uploadContent(blob, { name: 'Voice message.<ext>', type, includeFilename: true })` then sends **exactly** the contract content below. `mimetype` is reduced to its base type; `waveform` is sanitised (ints 0..1024, resampled to 100 when > 120); `durationMs` rounded. Throws on upload/send failure (Dev B shows `recording-error`). |
| `sendGif` | `(roomId, gif: GifResult, opts?: { threadRoot? }) => Promise<eventId>` | `m.text` with `body: "<title> <url>"` + `dev.matrixpoc.gif` (`buildGifContent(gif)`, shape in "GIFs"); **nothing is uploaded**. `threadRoot` adds the Phase 3 relation. Local echo appears immediately; throws on send failure (Dev B shows the `Could not send GIF` toast). |

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
`mimetype` is the real base container type of the uploaded bytes: `audio/ogg` from Android/Chromium/Firefox (WebM/Opus
is remuxed to Ogg before upload, file `Voice message.ogg`), `audio/mp4` on iOS, `audio/webm` only when the remux failed
(or for pre-format notes), `audio/wav` for the QA fixture; extension follows it (`.ogg` / `.m4a` / `.webm` / `.wav`). No encryption.
`scripts/send-voice-sample.mjs` posts one through the raw API and validates every field.

## Read helpers

All in `src/lib/matrix/utils.ts`: read-only helpers over SDK objects.

`displayNameOf(room, userId)`, `avatarUrlOf(room, userId, size=40)`, `memberAvatarUrl(member, size)`,
`roomAvatarUrl(room, size)`, `roomTopic(room)`, `isEditEvent(e)`, `isReactionEvent(e)`, `isDisplayableEvent(e)`,
`getReplyTargetId(e)`, `stripReplyFallback(body)`, `stripHtmlReplyFallback(html)`, `previewText(e, max)`,
`isPendingEvent(e)`, `isThreadReply(e)`, `isThreadRoot(e)`, `getThreadRootId(e)`, `getThreadRelation(e)`,
`getThreadServerSummary(e) => { count, latestEvent?, participated } | null`, `isMainTimelineEvent(e)`, `formatRelative(ts)`, and

```ts
getDisplayBody(event) => { text, html?, msgtype, isEdited, isRedacted, replyTo?, url?, info?, mentions, voice?, threadRoot?, gif? }
```
`replyTo` is **undefined for the thread fallback** (`m.in_reply_to` with `is_falling_back: true` - the previous reply, not a
quote); `threadRoot` is set for thread replies.
`text`/`html` already reflect the latest edit (the SDK swaps `getContent()` when the `m.replace` arrives) and have
legacy reply fallbacks stripped. Sanitise `html` with `sanitizeHtml()` from `src/lib/format.ts` before rendering.
`voice` is `getVoiceMessage(event) ?? undefined` for `m.audio` events.
`gif` is `getGifContent(event) ?? undefined`: present only for `m.text` events whose `dev.matrixpoc.gif` validates (see "GIFs");
render it **before** the text branch (otherwise `linkify` shows "<title> <url>"). `previewText` gives `[gif] <title>`.

```ts
getGifContent(event) => { provider, id, title, url, w, h, previewUrl?, previewW?, previewH?, stillUrl? } | null   // GifMessage
isGifEvent(event) => boolean
```

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

## Audio primitives

All in `src/lib/audio/`. No React, no Matrix.

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

## Native integration

All in `src/lib/native.ts`. Every export is a no-op on the web.

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

## Homeserver URL

`src/lib/matrix/config.ts`.

`getHsUrl()` = localStorage `matrix-poc.hsUrl` (login screen > Advanced) -> `VITE_HS_URL` (build time; the LAN APK bakes
`http://<pc-ip>:8009`) -> `http://localhost:8008`. `setHsUrl(input)` normalises (`192.168.1.2:8009` -> `http://192.168.1.2:8009`,
trailing slash dropped; empty or equal to the default removes the override), `hasHsUrlOverride()`, `DEFAULT_HS_URL`,
`normalizeHsUrl()`. Read it per call; the `HS_URL` constant is deprecated (build-time default only). The persisted
session keeps its own `baseUrl`, so a restored session keeps talking to the server it logged into.

## CSS contract

`theme.css`: `--safe-top/right/bottom/left` (`env(safe-area-inset-*, 0px)`; 0 on desktop and inside the Capacitor
app since the status bar is outside the WebView; the iPhone home indicator and phone browsers give real values),
`--tap-target: 44px`, `--phone-header-h: 56px`, `--drawer-w: 85%`, `--keyboard-height` (native), `--vvh` (visual
viewport height in px). `global.css`: `#root` is `100dvh` (fallback `100vh`), `overscroll-behavior: none`, phone-only
(`:root[data-layout='phone']`) rules: transparent tap highlight, `touch-action: manipulation`, hidden scrollbars, and
**`font-size: max(16px, 1em) !important` on every input/textarea/select** (iOS focus zoom) - do not fight it.
`index.html` viewport: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`.
Features use `@media (hover: none)` or `:root[data-layout='phone']` for touch styling; the composer owns
`padding-bottom: var(--safe-bottom)` (the shell does not pad the bottom, so `composer`'s bottom edge is the shell's).

## Formatting

`src/lib/format.ts`.

`sanitizeHtml(html)` (DOMPurify, Matrix allowlist, `<a target=_blank rel=noopener noreferrer>`, `<img>` only from mxc),
`linkify(text) => ({ kind: 'text' } | { kind: 'link', href })[]`, `escapeHtml`, `formatTime(ts)`, `formatFullTime(ts)`,
`formatDayDivider(ts)`, `isSameDay(a, b)`, `initialsOf(name)`, `colorFor(id)`.

## Client

`src/lib/matrix/client.ts`.

`getClient()` (throws when logged out), `getClientOrNull()`, `loadSession/saveSession/clearSession`,
`login`, `register`, `startClientFromSession`, `waitForPrepared`, `logout`, `mxcToHttp` (re-export).
`HS_URL` comes from `VITE_HS_URL` (default `http://localhost:8008`).

**How the client is started** (`startClientFromSession`): `createClient` with `timelineSupport: true`, then `initCrypto`,
then `startClient({ initialSyncLimit: 30, lazyLoadMembers: true, pendingEventOrdering: 'chronological', threadSupport: true })`.
`threadSupport` makes the SDK partition `m.thread` replies into `Thread` models, add `thread_id` to receipts and request
`unread_thread_notifications`. Never switch to `pendingEventOrdering: 'detached'`: local echo rows would vanish from
`getLiveTimeline()`.

## Threads

Threads use the Matrix `m.thread` relation with Slack/Element behaviour and Discord presentation.

Semantics: Matrix `m.thread` relation, Slack/Element behaviour, Discord presentation. Threads **do not nest**
(every API collapses a reply id to its root), thread replies **never** appear in the main timeline (the SDK partitions
them with `threadSupport: true`; `useRoomTimeline` filters again), the root stays in both. Typing is room-wide.

### `useThreadStore` (`src/store/threads.ts`, also `src/store/thread.ts`)

| Member | Type | Semantics |
|---|---|---|
| `open` | `{ roomId, rootId } \| null` | The open thread. |
| `openThreadRootId`, `openThreadRoomId` | `string \| null` | Same, flattened. |
| `version` | `number` | Bumps on every Thread model change (mirrors `useTimelineStore.threadVersion`). |
| `openThread(rootId, roomId?)` | `void` | Collapses a reply id to its root, get-or-creates the SDK Thread (root fetched if needed), closes phone drawers, opens the panel. `roomId` defaults to the selected room. |
| `closeThread()` | `boolean` | True when a thread was open. The store also closes on `selectedRoomId` change and on logout (`resetThreads`). |

The shell reads it: desktop renders `<ThreadView roomId rootId />` in a 400 px (`--thread-w`) right column
(`thread-panel-container`) **instead of** the member panel, which comes back on close; phone stacks it over the
conversation below the channel header (the conversation stays mounted, `inert` + `aria-hidden`; drawers open on top).
`app-shell[data-thread-open="true|false"]`. Android back: thread -> drawers -> minimise. `ThreadView` comes from
`@/features/conversation` (Dev B owns it; the shell passes nothing but `roomId` and `rootId`). Testids are Dev B's per
docs/PHASE3_ACCEPTANCE.md (`thread-panel`, `thread-root`, `thread-close` on desktop only, `thread-replies-divider`,
`thread-message-list`, `thread-typing`, `thread-composer-input`, ...); reply rows inside the panel are `message-<id>` like
main rows, so scope selectors to `thread-message-list`.

### `ThreadSummary` (`useThreadSummary(event)`, `useRoomThreads(roomId).threads[]`, `getThreadSummary(roomId, rootId)`)

```ts
{ rootId, roomId, count, latestTs, latestEvent?, participants: string[], participated, hasUnread, rootEvent?, root? }
```
`count` = `max(thread.length, server count)` (the SDK counts my pending replies; only a redaction lowers it); `latestEvent` =
the SDK's `replyToEvent` (last loaded reply, else the server bundle's `latest_event`); `participants` = distinct reply senders
**newest first, max 5**, from the loaded replies (just `[latest sender]` before the thread is loaded); `participated` =
`current_user_participated` latched on my own replies (true for the root author too); `hasUnread` =
`room.getThreadUnreadNotificationCount(rootId) > 0`. `null` when the event has no thread (no SDK Thread and no
`unsigned.m.relations.m.thread`), when `count` is 0 or the root is redacted. Re-renders on `threadVersion`, `version` and the room
`version` (receipts).

### Wire shapes

Thread reply (`sendText/sendHtml/sendFile/sendVoiceMessage(..., { threadRoot })`; identical to Element):
```json
{ "msgtype": "m.text", "body": "...",
  "m.relates_to": { "rel_type": "m.thread", "event_id": "$root", "is_falling_back": true,
                    "m.in_reply_to": { "event_id": "$latest-sent-reply-or-root" } } }
```
There is no other thread shape: `replyTo` + `threadRoot` is rejected (`ThreadReplyConflictError`, AC-T2-3). Reactions and
edits relate to their target as before (`m.annotation` / `m.replace`), sent with the SDK `threadId` so the echo lands in the thread.
Read receipt: `POST /rooms/{id}/receipt/m.read/{eventId}` with body `{ "thread_id": "main" }` or `{ "thread_id": "$root" }` (the
SDK derives it). Server bundle on a root (`/sync`, `/messages`, `/threads`, `/event`): `unsigned.m.relations.m.thread =
{ count, current_user_participated, latest_event }`.

### Scripts

`npm run thread:sample [-- --room '#general:localhost' --replies 3 --as bob,carol --root $id]` posts a root (alice) + replies with
the exact wire shape through the raw API, validates the bundle and `/threads`, writes `seed/thread-sample.json`.
`npm run verify:threads` (dev server on :5183) posts a fresh thread and checks the whole core (partitioning, live replies, local
echo, wire shape, reactions/edits in threads, unread + threaded receipt, desktop column, phone layer, back order).

## GIFs

A Slack-style GIF picker backed by Klipy (Tenor is gone, Giphy is paid), with a keyless mock provider for development
and tests. The core is `src/lib/gif/`, `sendGif`, `getGifContent` and `public/gif-fixtures/`; the picker UI is
`src/features/gif/`; the composer and timeline side is in `src/features/conversation/`. Plan and acceptance:
`docs/archive/PHASE4_PLAN.md`, `docs/archive/PHASE4_ACCEPTANCE.md`.

### API (`src/lib/gif/index.ts`, import from `@/lib/gif`)

```ts
interface GifResult {                      // one search / trending hit; all URLs absolute, in the provider's order
  id: string;                              // 'mock-3' | Klipy slug ('hello-hi-662'; numeric ids exceed 2^53, BUG-9)
  title: string;
  previewUrl: string;                      // picker tile: sm.webp -> sm.mp4 -> sm.gif (xs.* last); the gif itself for mock
  previewMimetype: 'image/webp' | 'video/mp4' | 'image/gif';   // mp4 => <video muted autoPlay loop playsInline>
  previewW: number; previewH: number;
  fullUrl: string;                         // what gets sent: Klipy GIF_SEND_VARIANT gif (hd -> md -> sm); mock /gif-fixtures/<id>.gif
  fullW: number; fullH: number; fullSize?: number;
  stillUrl?: string;                       // paused frame: Klipy sm.jpg; mock /gif-fixtures/<id>.png
  mimetype: 'image/gif'; provider: 'klipy' | 'mock';
}
interface GifPage { results: GifResult[]; nextPage: string | number | null; hasNext: boolean }
interface GifQueryOptions { page?: string | number | null; limit?: number; rating?: 'g' | 'pg' | 'pg-13' | 'r'; signal?: AbortSignal }
interface GifProvider { name: 'klipy' | 'mock'; search(query, opts?): Promise<GifPage>; trending(opts?): Promise<GifPage> }
class GifProviderError extends Error { kind: 'auth' | 'rate-limit' | 'network' | 'bad-response' | 'aborted'; status?: number; retryAfterMs?: number }

```

`getGifProvider() => GifProvider`
Memoised per (provider, key, base). Re-reads localStorage on every call.

`gifProviderName() => 'klipy' | 'mock'`
The `matrix-poc.gifProvider` override wins; otherwise `klipy` when a key is present, else `mock`.

`searchGifs(q, opts?)`, `trendingGifs(opts?)`
One-liners over `getGifProvider()`.

`getGifApiKey()`, `setGifApiKey(key | null)`
The runtime key (localStorage `matrix-poc.gifApiKey`) over `VITE_GIF_API_KEY`.

`setGifProvider('klipy' | 'mock' | null)`
Forces a provider (alias `setGifProviderOverride`); `getGifProviderOverride()` reads it.

`buildGifContent(gif) => GifMessageContent`
The wire shape below. Pure.

`parseGifContent(content, { origin? }) => GifMessage | null`
The validator. Pure. `isAllowedGifUrl(url, { origin? })` is the host check.

`createKlipyProvider({ apiKey, baseUrl?, locale?, customerId?, contentFilter?, fetch? })`, `mapKlipyItem(item)`, `klipyRequestUrl(...)`, `parseRetryAfter(h)`

`getGifCustomerId()`
A random UUID in localStorage `matrix-poc.gifCustomerId`; `getGifProvider()` sends it as `customer_id`.

`createMockProvider({ baseUrl?, basePath?, delayMs? })`, `mockGifResults(opts)`, `MOCK_FIXTURES`, `MOCK_EMPTY_QUERIES`, `MOCK_ERROR_QUERY`

Constants: `GIF_CONTENT_RATING = 'medium'`, `GIF_SEND_VARIANT = 'hd'`, `GIF_IMAGE_HOSTS`, `GIF_MAX_DIMENSION = 2000`,
`GIF_CONTENT_KEY = 'dev.matrixpoc.gif'`.

Resolution: `localStorage['matrix-poc.gifProvider']` (`'klipy'` | `'mock'`, forces; `'klipy'` with no key -> every call rejects
`GifProviderError('auth')`) -> key present (`localStorage['matrix-poc.gifApiKey']` -> `VITE_GIF_API_KEY`) ? `klipy` : `mock`.
API origin: `VITE_GIF_API_BASE` -> `https://api.klipy.com`. The key is baked into the web bundle and the APK (extractable;
use a Testing key or one you can revoke). Errors: `'aborted'` = the caller's `AbortSignal` fired (ignore it); `'auth'` = no key
or Klipy's 404 "invalid key"; `'rate-limit'` = 429 after the one built-in retry; `'network'` = fetch failed or non-2xx;
`'bad-response'` = 2xx that is not the documented shape. Results are never filtered or re-sorted (Klipy rule).

Dev hook: `window.__matrixPoc.gif` is the whole module (dev builds), `window.__matrixPoc.runBackHandlers()` the back chain.

### The GIF message (wire; `sendGif` / `buildGifContent`)

```json
{ "msgtype": "m.text", "body": "Tacos dance https://static.klipy.com/ii/.../hd.gif",
  "dev.matrixpoc.gif": { "provider": "klipy", "id": "tacos-dance-123", "title": "Tacos dance",
                         "url": "https://static.klipy.com/ii/.../hd.gif", "w": 498, "h": 498,
                         "previewUrl": "https://static.klipy.com/ii/.../sm.webp", "previewW": 220, "previewH": 220,
                         "stillUrl": "https://static.klipy.com/ii/.../sm.jpg" } }
```
`body` = `"<title> <url>"` (title trimmed, `GIF` when empty; the URL is the last token so Element shows the link and the server's
URL preview unfurls it); no `format` / `formatted_body` / top-level `url` / `info`; `m.relates_to` (the thread relation) when
`threadRoot` is given. Mock: `url` = `<origin>/gif-fixtures/<id>.gif`, `previewUrl` = the same gif, `stillUrl` = `<id>.png`.

**Reading** (`getGifContent(event)` / `getDisplayBody(event).gif`): non-null only when the field is an object, `url` is
`https://` on `GIF_IMAGE_HOSTS` (`static.klipy.com`, `static1.klipy.com`, `static2.klipy.com`) **or** same-origin
`/gif-fixtures/<name>.gif|.png` (`location.origin`; scripts pass `{ origin }`), and `w`/`h` are integers 1..2000. Invalid
`previewUrl` / `stillUrl` are dropped, not fatal. Anything else is an ordinary `m.text` (forged fields cannot load arbitrary images).
Rendering rule: `<img src={gif.url} width={w} height={h} alt={title}>` straight from the host (there is no mxc, never
`mxcToHttp`); `stillUrl` for reduced motion. No CSP meta exists in `index.html`, `sanitizeHtml` is not on this path (structured
field, not HTML) and Capacitor needs nothing for https images: verified, nothing to allow.

### Klipy facts relied on

Verified 2026-10-09 by the Advisor agent and re-verified by the Principal. Sources: https://docs.klipy.com/llms-full.txt (the whole
docs site as text; sections "GIF - Search API", "GIF - Trending API", "GIF Format Sizes"), https://docs.klipy.com/gifs-api/gifs-search-api,
https://docs.klipy.com/gifs-api/gifs-trending-api, https://docs.klipy.com/integration-requirements, https://docs.klipy.com/network-requirements,
https://docs.klipy.com/getting-started, https://docs.klipy.com/attribution, and live `curl` against api.klipy.com / static.klipy.com.

| Fact | Value |
|---|---|
| Endpoints | `GET https://api.klipy.com/api/v1/{app_key}/gifs/search` and `.../gifs/trending`; the key is a **path segment** (no header, no query param) |
| Query params | `q` (search only), `page` (int >= 1, default 1), `per_page` (8..50, default 24), `content_filter` (`off` \| `low` \| `medium` \| `high`), `locale` (ISO 3166-1 alpha-2, not sent), `customer_id` (stable per-user id; sent = `getGifCustomerId()`), `format_filter` (omit) |
| Response | `{ result: true, data: { data: Item[], current_page, per_page, has_next } }`; Item `{ id: number, slug, title, type: 'gif', tags, blur_preview, file: { hd \| md \| sm \| xs: { gif \| webp \| jpg \| mp4 \| webm: { url, width, height, size } } } }`. Documented example: hd.gif 498x498 4.0 MB, md.gif 498x498 3.7 MB, sm.gif 220x220 315 KB, sm.webp 80 KB, sm.jpg 8.6 KB, sm.mp4 320x320 50 KB, xs.webp 90x90 25 KB |
| Errors | Invalid key: HTTP **404** `{ "result": false, "errors": { "message": ["The provided API key is invalid."] } }` -> `kind: 'auth'`. 429 shape and `Retry-After`: **undocumented** (needs a real key); handled defensively |
| Media hosts | `static.klipy.com`, `static1.klipy.com`, `static2.klipy.com` (https only); example `https://static.klipy.com/ii/<hash>/<a>/<b>/<name>.<ext>` |
| CORS | API: `access-control-allow-origin: *`, OPTIONS 200 with `access-control-allow-headers: *` / `-methods: *`. CDN GET: `access-control-allow-origin: *`, `cache-control: public, max-age=86400` (OPTIONS 403, irrelevant for simple GETs and `<img>`) |
| Quota | Testing key: 100 requests/hour; Production: unlimited (requested in https://partner.klipy.com/) |
| Attribution | "Incorporate KLIPY branding" (Drive folder linked from docs.klipy.com/attribution): search placeholder `Search KLIPY` required, `Powered by KLIPY` optional |
| Integration terms | Load media directly from the returned URLs; **do not store, mirror, re-host, proxy or cache** media; requests must originate from the end-user client; show results in the returned order, unfiltered; approval via developers@klipy.com. This is why GIFs are hot-linked, not uploaded |

### Synapse static-thumbnail gotcha (user-attached GIFs)

Synapse 1.162 (`docs/advisor/gif-thumb-probe.mjs`, 1313-frame GIF): `/_matrix/media/v3/download` returns the bytes unchanged
(`image/gif`); `/thumbnail?width&height&method` returns a **static PNG** (first frame) by default; `/thumbnail?...&animated=true`
(spec v1.11) returns an animated `image/webp`. No config knob; `m.upload.size` is 50 MB. `ImageAttachment` renders `m.image`
thumbnails, so a GIF file attached with the paperclip renders static; picked GIFs are unaffected (no mxc). Later fix if wanted:
`mxcToHttp(..., { animated: true })` or the full download URL when `info.mimetype === 'image/gif'`.

### Mock fixture contract (`src/lib/gif/mock-fixtures.ts`; files in `public/gif-fixtures/`, `npm run gif:fixtures`)

| id | title | w x h | frames | gif bytes | matches |
|---|---|---|---|---|---|
| `mock-1` | `Tacos dance` | 240 x 180 | 2 | 1219 | `tacos`, `taco`, `dance` |
| `mock-2` | `Tacos Tuesday` | 200 x 200 | 2 | 2253 | `tacos`, `taco`, `tuesday` |
| `mock-3` | `Tacos party` | 240 x 180 | 2 | 2251 | `tacos`, `taco`, `party` |
| `mock-4` | `Party popper` | 160 x 160 | 3 | 2108 | `party` |
| `mock-5` | `Cat typing` | 240 x 180 | 2 | 1135 | `cat` |
| `mock-6` | `Cat nope` | 200 x 150 | 3 | 1637 | `cat`, `nope` |
| `mock-7` | `Thumbs up` | 240 x 180 | 2 | 1204 | `thumbs` |
| `mock-8` | `Facepalm` | 240 x 180 | 2 | 2247 | `facepalm` |

Animated GIF89a (NETSCAPE loop, 8-colour palette, the fixture number drawn on every frame) + `<id>.png` still of the first frame
(indexed PNG, ~300 B). Served at `<origin>/gif-fixtures/<id>.gif`; `fullUrl === previewUrl`, `previewMimetype: 'image/gif'`.
`trending` = all 8 in this order; `search` = case-insensitive title substring in the same order, `''` = all; `nothing-here` /
`__empty__` -> `[]`; `__error__` -> rejects `GifProviderError('network', 'mock: simulated failure')`; `page > 1` -> `[]`;
`hasNext` false; resolves on the next microtask (`delayMs` option for loading states). The generator is deterministic
(re-running never dirties git); `.gitattributes` marks `*.gif binary`.

## Link previews

A message with http(s) links shows a card per link (site name, title, description, og:image), like Slack or Element.
The homeserver fetches the page (`/_matrix/client/v1/media/preview_url`, v3 fallback; the SDK picks) and re-hosts
og:image as an `mxc://` URI.

### API (`src/lib/preview/index.ts`, import from `@/lib/preview`)

```ts
interface LinkPreview { url: string; siteName?: string; title?: string; description?: string; image?: LinkPreviewImage }
interface LinkPreviewImage { mxc: string; width?: number; height?: number; mimetype?: string; size?: number }
// image.mxc is ALWAYS an mxc URI: render it via mxcToHttp(mxc, w, h)
interface LinkEmbed { provider: 'youtube' | 'spotify'; kind: 'video' | 'track' | 'album' | 'playlist' | 'episode'; id: string;
                      embedUrl: string; canonicalUrl: string; startSeconds?: number }
type LinkPreviewStatus = 'idle' | 'loading' | 'ready' | 'empty';
```

`getPreviewUrls(event: MatrixEvent, max = 3) => string[]`
The links that get a card, in message order, deduped (hash stripped).
- `[]` for GIF, redacted, undecrypted and media events.
- Skips `<pre>` / `<code>`, matrix.to links and the homeserver's media URLs.
- Ignores room encryption on purpose; `shouldAutoPreview` is the encryption rule.

`extractPreviewUrls(body: DisplayBody | PreviewSource | string, { max?, hsUrl? }) => string[]`
The pure core of the above.

`shouldAutoPreview(roomId, event?) => boolean`
**The encrypted-room rule.** False when the room has `m.room.encryption` (or the event is `m.room.encrypted`); render a
"Show preview" button instead.

`getLinkPreview(url, { signal?, ts? }) => Promise<LinkPreview | null>`
`client.getUrlPreview` plus an LRU cache (200 urls; hits 1 h, misses 5 min) and in-flight dedupe.
- `null` = no preview, blocked, or failed. Never throws; `AbortError` on signal.

`peekLinkPreview(url) => LinkPreview | null | undefined`
Synchronous cache read; `undefined` = unknown. Also `primeLinkPreview(url, p | null)` and `clearLinkPreviewCache()`.

`useLinkPreview(url, { enabled?, ts? }) => { status, preview }`
`enabled: false` gives `'idle'`, but a cached hit still renders. Unmount aborts the wait, not the request.

`useHiddenPreview(eventId, url) => { hidden, hide, unhide }`
The "x" on the card. Stored in localStorage `matrix-poc.hiddenPreviews` = `[`${eventId}|${url}`, ...]` (max 1000).
Non-hook forms: `isPreviewHidden`, `hidePreview`, `unhidePreview`, `clearHiddenPreviews`, `subscribeHiddenPreviews`.

`parseEmbed(url) => LinkEmbed | null`
- YouTube watch / youtu.be / shorts / embed / live (`t=` becomes `?start=N`) maps to `https://www.youtube-nocookie.com/embed/<id>`.
- Spotify track | album | playlist | episode (`intl-xx/` ok) maps to `https://open.spotify.com/embed/<kind>/<id>`.
- No network. The iframe loads only after the click.

`previewImageLayout(image, minWidth = 400) => 'large' | 'thumbnail' | 'none'`
`large` = width >= 400 and landscape; unknown dimensions = `thumbnail`.

`normalizePreview(url, rawOgObject) => LinkPreview | null`
Trims, drops a non-mxc og:image, null when there is no title, description or image.

Constants: `PREVIEW_MAX_LINKS = 3`, `PREVIEW_CACHE_MAX = 200`, `PREVIEW_CACHE_TTL_MS`, `PREVIEW_NEGATIVE_TTL_MS`,
`HIDDEN_PREVIEWS_STORAGE_KEY`.

**Module split**: `types.ts`, `extract.ts`, `embed.ts`, `normalize.ts`, `cache.ts`, `hidden.ts` are pure (no React, no
SDK, no `import.meta.env`; Node imports them with type stripping, like `src/lib/gif`). `fetch.ts` and `policy.ts` touch
the SDK. `hooks.ts` is the only React module. Dev hook: `window.__matrixPoc.preview` is the whole module.

**Wiring in the conversation feature**
- `const urls = useMemo(() => getPreviewUrls(event), [event, body])`.
- Per url, skip when `useHiddenPreview(event.getId()!, url).hidden`.
- `const auto = shouldAutoPreview(roomId, event)`; render the card with `useLinkPreview(url, { enabled: auto || clicked, ts: event.getTs() })`.
- In an encrypted room render the "Show preview" button until `clicked`, and the "No preview available" note when the
  answer is `'empty'`.
- `parseEmbed(url)` decides whether the card gets a play button.
- Reserve the image box from `image.width/height` before the bytes arrive (stick-to-bottom).

**Why these choices**
- **No automatic fetch in encrypted rooms** (`shouldAutoPreview`): the preview request hands the URL to the homeserver in
  clear, which defeats E2EE. Same posture as GIFs (AC-E6-5). A cached hit may still render there: the server has already seen it.
- **Own negative cache**: the SDK caches the *promise* per minute bucket, rejections included; without our 5-minute negative
  TTL a transient failure would be permanent for that minute and a retry impossible, and a success would never expire.
- **og:image must be mxc**: Synapse always re-hosts it; a server that returned a raw third-party URL would otherwise make
  every viewer's browser fetch from that host. `normalizePreview` drops anything that is not `mxc://`.
- **HTML scanning with regexes, not DOMParser**: keeps `extract.ts` Node-loadable; the tokeniser consumes tags whole so
  URLs in attributes (`<img src>`) are never previewed, only anchor hrefs and text URLs.

## Read receipts

Own messages show a send status (sending / sent / failed). Every message shows the avatars of the users whose latest
read point it is. A hover, tap or "Seen by" action lists who has and has not seen it. A "Send read receipts" setting
switches me to `m.read.private`. **Where this differs from `docs/archive/RECEIPTS_TICKETS.md`, this file wins.**

### Pure core (`src/lib/matrix/receipts-core.ts`)

No client, no React, no `@/` imports; Node-loadable and unit-tested.

```ts
type SendStatus = 'sending' | 'sent' | 'failed' | null;
interface Reader { userId: string; displayName: string; avatarUrl: string | null; ts: number }
// avatarUrl is ALREADY http (32 px crop), not mxc. ts = receipt ms, 0 if unknown.
```

`getSendStatus(event, myUserId) => SendStatus`
Null unless I sent it. Status null or `SENT` is `'sent'`; `NOT_SENT` or `CANCELLED` is `'failed'`; anything else is `'sending'`.

`mapReadPointsToRows(orderedIds, displayedIds, points: { userId, eventId }[]) => Map<rowId, userId[]>`
The hidden-event rule (below).

`pickLatestOwnSentId(displayedEvents, myUserId, readPoints) => string | null`
The single "sent" check (rule below).

`collectReadPoints(source: ReadPointSource, userIds, displayedIds) => { rows: Map<rowId, userId[]>; ts: Map<userId, number> }`
Read points to rows, over a holder adapter (`timelineIds` / `readUpTo` / `receiptTs` / `threadRootOf`). A read point
outside the holder's timeline is retried through `threadRootOf` (an unthreaded receipt on a thread reply maps to the
root's main row), else dropped.

`latestReceiptTs(holderTs, unthreadedTs) => number`
The max of the two (0 when unknown): the ts to show for a read point on a holder.

`class ReaderCache { get(userId, displayName, avatarUrl, ts): Reader }`
Per room. Two slots per user (ts 0 and latest ts) so identities are reused.

`readSendReadReceipts(content) => boolean`
The STORED value. Default ON; only `sendReadReceipts: false` is OFF.

`resolveSendReadReceipts(content) => boolean`
The EFFECTIVE value: the in-flight override, else the stored value. This is what `getSendReadReceipts` returns.

`withPendingSendReadReceipts(on, write) => Promise<void>`
Sets the override, runs the PUT, clears the override when the newest write settles.

`getPendingSendReadReceipts() => boolean | null`, `clearPendingSendReadReceipts()`
The override itself (null = none). Logout clears it.

`mergeSendReadReceipts(content, on) => object`
`{ ...content, sendReadReceipts: on }`. Merge, never clobber.

Constants: `RECEIPT_SETTINGS_EVENT_TYPE = 'im.vector.web.settings'`, `SEND_READ_RECEIPTS_KEY = 'sendReadReceipts'`,
`compareReaders`, `sameReaders`.

### SDK-bound (`src/lib/matrix/receipts.ts`)

Re-exports everything above.

`type ReceiptHolder = Room | Thread`

`getReceiptHolder(room, threadRootId?) => ReceiptHolder | null`
Main timeline: the `Room`. Thread: `room.getThread(root)`, or null until the SDK has it.

`buildReadPoints(holder, displayedEvents: MatrixEvent[], myUserId, { previous? }) => Map<rowEventId, Reader[]>`

`buildReadPointsSnapshot(holder, displayedEvents, myUserId, opts?) => { readPoints, latestOwnSentId }`

`getSeenBy(holder, event | eventId, myUserId) => SeenBy`
`SeenBy = { seen: Reader[]; notSeen: Reader[]; notSeenCount: number; truncated: boolean }`.

`otherJoinedMembers(room, myUserId, exceptUserId?) => RoomMember[]`
The member snapshot the two above use.

`isUnsentLocalEcho(event) => boolean`
A `~` id, or status before `SENT`.

`getSendReadReceipts(client) => boolean`, `setSendReadReceipts(client, on) => Promise<void>`
The new value is effective synchronously (the override). Resolves after the `/sync` echo; rejects and reverts on failure.

Constants: `SEEN_BY_MEMBER_LIMIT = 50`, `READER_AVATAR_SIZE = 32`.

### Sending (`src/lib/matrix/actions.ts`)

`sendReadReceipt(roomId, event | eventId, { threadId? })`
Unchanged signature. Sends `m.read.private` when the setting is OFF.

### Store (`src/store/receipts.ts`, re-exported from `@/store/hooks` and `@/store`)

`useReadPointsResult(source: TimelineSource | null, displayedEvents) => { readPoints: Map<string, Reader[]>; latestOwnSentId: string | null }`
`useReadPoints(source, displayedEvents) => Map<string, Reader[]>` is `.readPoints`.
`useLatestOwnSentId(source, displayedEvents) => string | null` is `.latestOwnSentId`. Note it takes `displayedEvents` too.
`useSendStatus(event) => SendStatus`
`useSeenBy(source, eventId | null) => SeenBy`. Pass null while the list is closed.
`useSendReadReceiptsSetting() => [on: boolean, setOn: (on: boolean) => Promise<void>]`
`useReceiptVersion(roomId) => number`; `useReceiptStore` holds `{ receiptVersion: Record<roomId, number>; settingsVersion: number }`.
`bumpReceiptVersion(roomIds)`, `bumpReceiptSettingsVersion()`, `resetReceipts()` are for the bridge and the session only.

### Dev hook (`src/app/devtools.ts`, DEV only)

`__matrixPoc.receipts` = the `receipts.ts` module plus `store`, `getReadPoints(roomId, threadRootId?) -> { [rowId]: Reader[] }`,
`getLatestOwnSentId(roomId, threadRootId?)`, `getSeenBy(roomId, eventId, threadRootId?)`, `getSendStatus(roomId, eventId)`,
`getSendReadReceipts()`, `setSendReadReceipts(on)`, `markRead(roomId, eventId?, threadRootId?)`.

**Rules the core implements** (settled; decisions in `docs/archive/RECEIPTS_PLAN.md`)

- **Holders are never mixed.** A *holder* is the object that owns a set of receipts: the `Room` for the main timeline
  (`thread_id: 'main'` plus unthreaded receipts) or a `Thread` for its replies (`thread_id: <root>`). Main rows read the
  room's receipts, thread rows the thread's.
- A read point is `holder.getEventReadUpTo(userId)`, synthetic receipts included. It is `null` when the receipt's event
  is not loaded (older than the window, or a thread whose `/relations` fetch has not landed), and then that user gets no
  avatar. `getSeenBy` returns the empty result when `holder.findEventById(eventId)` is null.
- **The thread root row** inside the thread panel shows **no** avatars and no send status. Its avatars live on its
  main-timeline row, because thread receipts point at replies. `useTimeline(thread).events` already excludes the root.
- **Hidden-event rule**: a read point is attached to the nearest *displayed* row at or before it in the holder's
  unfiltered timeline (`holder.timeline`). `displayedEvents` must be the exact array the list renders.
- **Synthetic receipts are embraced.** The SDK synthesises an `m.read` for the sender of every live event, and
  `hasUserReadEvent` also counts "sent an event at or after it" and "replied in that thread" (root). So a sender's avatar
  sits on their own newest message, and someone who posts after my message counts as having seen it. Element behaves
  the same. The sender is excluded from `getSeenBy` (both lists); I am excluded everywhere.
- **Sent check** (`pickLatestOwnSentId`): the newest displayed row, when it is mine, has a `$` id, `getSendStatus` is
  `'sent'`, and `readPoints.get(id)` is empty. Otherwise null. In practice: a sending indicator while the id is `~txn`,
  avatars once read, nothing once someone else posted after it.
- **Send status** follows `event.status` through the E2EE chain `ENCRYPTING -> QUEUED/SENDING -> SENT -> null`. The id
  swaps `~txn -> $id` at `SENT`. `receiptVersion[roomId]` bumps on `Room.localEchoUpdated`, so `useSendStatus` re-reads.
- **Members**: `otherJoinedMembers` = `room.getJoinedMembers()` minus me (minus the sender for seen-by). Lazy loading
  means only senders are known until `loadMembers`; `useReadPoints` / `useSeenBy` call it and re-run on
  `useRoomStore.version`. Rooms with more than 50 others: `truncated: true`, `notSeen: []`, `notSeenCount` set.
- **Re-render triggers**: `receiptVersion[roomId]` (the bridge bumps it on `RoomEvent.Receipt`, `Room.localEchoUpdated`
  and `ThreadEvent.New/Update`, because a Thread created later takes over the receipts the room cached for it), the
  displayed events' array identity, `useRoomStore.version` (members), and `threadVersion` for thread sources.
- **Cost**: one O(members + rows) pass per rebuild. A row's `Reader[]` keeps its identity when unchanged (`previous` +
  `sameReaders`), and `Reader` objects are cached per room and user.
- **Private receipts**: `sendReadReceipt` is the only sender; with the setting OFF it sends `ReceiptType.ReadPrivate`.
  Verified in the SDK: `sendReceipt` derives `thread_id` from the event for either type, adds the local-echo receipt, and
  `clearNotificationsOnReceipt` / `isSupportedReceiptType` accept `m.read.private`, so my unread counts clear exactly as
  with `m.read` (Synapse clears on both). My own private receipt comes back in `/sync`; others never see it.
- The setting is read live from account data (`ClientEvent.AccountData` bumps `settingsVersion`), so a change made in
  Element flips the toggle without a reload. `setSendReadReceipts` spreads the existing `im.vector.web.settings` content.
- **Optimistic override**: `setSendReadReceipts` sets a module-level in-flight value before the PUT. `getSendReadReceipts`
  (and so `sendReadReceipt` and the toggle, one source) returns it until the `/sync` echo lands or the write fails
  (revert). With overlapping writes, only the newest one's completion clears it. No `m.read` can leak after the user
  toggled OFF.
- **Receipt ts on a holder** is `max(holder receipt ts, room.getLastUnthreadedReceiptFor(u).ts)`, because
  `Thread.getEventReadUpTo` honours the room's unthreaded receipt while the thread's own receipt may be null or stale.
- **Unthreaded receipt on a thread reply**: the main list maps it to `room.findEventById(id).threadRootId` (the root's
  row) instead of dropping it.

**Wiring in the conversation feature**
- Once per list: `const { readPoints, latestOwnSentId } = useReadPointsResult(source, events)` with `events` from
  `useTimeline(source)`.
- Per row: `const status = useSendStatus(event)`. Render `SendStatus` when `status === 'sending' || status === 'failed'
  || event.getId() === latestOwnSentId`, and `ReadAvatars` with `readPoints.get(event.getId()!)` when present.
- The seen-by list reads `useSeenBy(source, openEventId)` (null when closed).

## Encryption

**Boot order**: `startClientFromSession(session, { onSyncState?, onCryptoLoading? })` calls, in order,
`createClient({ ..., cryptoCallbacks, verificationMethods: ['m.sas.v1'] })`, `initCrypto`, `startClient`, `bindClient`,
`bindSecurity`, then waits for `Prepared`.
**Logout order**: `unbindSecurity`, `unbindClient`, `logout()` (stop, wipe), then the `reset*` store calls.

### `src/lib/matrix/crypto.ts` (engine lifecycle; features never import it)

Importable from plain Node (no `@/`, no runtime `client.ts` import).

- `CRYPTO_DB_PREFIX`, `cryptoDatabasePrefix({ userId, deviceId })`, `VERIFICATION_METHODS`.
- `initCrypto(client, session): Promise<boolean>`, `getCryptoError(): string | null`, `wipeCryptoStore(client, session)`.
- `cryptoCallbacks.getSecretStorageKey({ keys }, name)` answers, in order: a cached key by id, then a cached key by value
  (`findCachedSecretStorageKey(keys, cached, checkKey)`, pure, unit-tested), else the registered prompt for the default
  key id if one is offered. A typed key is validated with `secretStorageKeyMatches` before caching.
- `setSecretStorageKeyPrompt(fn | null, { defaultKeyId? })` registers that prompt; `fn(keyInfo, keyId, { secretName?, differentKey })`.
- `SecretStorageKeyMissError { reason: 'cancelled' | 'wrong-key' | 'no-key' }`: the callback throws it instead of
  answering null, and the SDK propagates it. A typed key is cached only when the key description has a MAC.
- `cacheSecretStorageKey`, `hasCachedSecretStorageKey`, `clearSecretStorageKeyCache`.
- `resolveRecoveryInput(input, keyInfo)` turns a recovery key or passphrase into the raw key, checked against the description.
### `src/lib/matrix/security.ts` (CryptoApi wrappers; the store calls these)

**Status**
- `getCryptoApi()`, `isCryptoReady()`, `getOwnDeviceStatus(): Promise<OwnDeviceStatus>`, `getKeyBackupSummary()`,
  `getEventEncryptionInfo(event)`.
- `OwnDeviceStatus` = `{ userId, deviceId, otherVerifiedDevices, verified, hasCrossSigningKeys, crossSigningReady,
  secretStorageReady, defaultKeyId, backup: KeyBackupSummary }` with `KeyBackupSummary = { version: string | null,
  trusted, keyCached, enabled }`.
- `hasCrossSigningKeys` is downloaded, not read from the empty local list of a fresh device. A failed query counts as
  "exists", so setup is never offered on a guess.

**Verification**: `requestOwnUserVerification()`, `requestDeviceVerification(userId, deviceId)`,
`onVerificationRequestReceived(listener) => off`, `startSas(request)`.

**UIA** (user-interactive auth): `UiaOptions { password?: () => Promise<string | null>; sso?: (url, popupBlocked) => Promise<void> }`,
`makeUiaCallback(opts)`, `ssoFallbackUrl(session)`.

**Recovery**

`RecoveryKeyError { kind: 'none' | 'invalid' | 'wrong' | 'unusable' }`
`unusable` means the identity exists but its private keys are neither on the device nor under the default 4S key. It is
thrown before `bootstrapCrossSigning`, which would otherwise fail with "Content is not encrypted!" or, with the secrets
missing altogether, create a new identity.

`checkRecoveryKey(input) => { keyId, key }`

`unlockWithRecoveryKey(input, { uia?, onProgress? }) => UnlockResult`
`UnlockResult = { verified: true, restore: KeyBackupRestoreResult | null, restoreError?: { reason: RestoreFailureReason, message } }`.
- Verification is the success condition; the restore is best effort.
- An already verified device skips the identity step and only restores.
- `RestoreFailureReason = 'cancelled' | 'wrong-key' | 'no-key' | 'failed'`.

`attemptRestoreFromBackup(onProgress?)` is the same restore, classified instead of thrown.
`restoreFromBackup(onProgress?)` returns `{ total: 0, imported: 0 }` when there is no backup.

`syncSecretsToDefaultKey() => HealedSecret[]`
A silent self-heal. When the device is verified, the default 4S key is cached, and a locally held secret is missing under
the default key, it calls `bootstrapSecretStorage({})`. That never creates a key without `createSecretStorageKey` and
never resets.

`isBackupSecretOnDefaultKey()` is true when the backup key's 4S copy is under the default key, or there is no backup.

`importRoomKeysFromFile(fileText, passphrase, onProgress?) => { imported, total }`
Imports an Element key export. Throws `KeyExportError { kind: 'passphrase' | 'format' }` from `key-export.ts`, which also
has `decryptMegolmKeyExport` / `encryptMegolmKeyExport`.

`assertIdentityRecoverable(crypto, message)`
Downloads the identity with `userHasCrossSigningKeys(userId, true)`. If it exists but its private keys are neither local
nor under the default 4S key, throws `RecoveryKeyError('unusable')`. It guards unlock and non-reset setup, because
`bootstrapCrossSigning({ setupNewCrossSigning: false })` falls into `resetCrossSigning` when the 4S secrets are missing
(`CrossSigningIdentity.js:86-88`).

`setupRecovery({ passphrase?, reset?, uia? }) => recoveryKey`
- Without `reset`: never a new identity over an existing one, and `setupNewKeyBackup` only when the server has no backup
  at all, since it deletes every backup version.
- Order: cross-signing first, then secret storage and backup.
- Throws when secret storage already exists and `reset` is not set.

### `useSecurityStore` (`src/store/security.ts`; re-exported from `@/store`)

The store watches the crypto engine and tells the banner and dialogs what to show.

**State**
```ts
{ cryptoReady, cryptoError, status: OwnDeviceStatus | null, hint: 'setup' | 'verify' | 'unlock' | null,
  verification: VerificationFlow | null, recovery: RecoveryState, prompt: PendingPrompt | null,
  newRecoveryKey: string | null, backupRemaining: number | null, historyUnavailable, historyChecked, keysImported, version }
```
- `backupRemaining` = keys still to upload, from `CryptoEvent.KeyBackupSessionsRemaining`. Show "Backing up N keys" while > 0.
- `keysImported` = a key file was imported this session.

**`VerificationFlow`** = `{ stage: 'requested' | 'ready' | 'started' | 'sas' | 'done' | 'cancelled', initiatedByMe, isSelf,
otherUserId, otherDeviceId?, sas: { emoji: [symbol, name][] (7), decimal? } | null, error }`.
- One flow at a time. The SAS starts by itself once both sides are ready. Verified means both sides called `confirmSas()`.
- Incoming requests: `bindSecurity` tracks every live `VerificationRequestReceived`. A finished flow (`done` / `cancelled`)
  is replaced; an active one is cancelled (`request.cancel()`) so the newest request wins (AC-E4-7).
- Engine rule (verified, Rust crypto 18.9): a second concurrent request from the *same user* is refused. It arrives
  already cancelled (`m.user`) and the engine cancels the first one with `m.user` too. The store then shows the active
  flow as `cancelled` ("Cancelled (m.user)") and ignores the dead newcomer; the other device simply requests again, and
  that request is tracked. Replace-on-arrival applies to requests the engine lets through (another user, or after the
  earlier flow ended).

**`historyUnavailable`** is true when all of these hold: the device is verified, the server has a backup, this device has
no backup key, `GOSSIP_GRACE_MS` (10 s) has passed since a verification completed on this page (no grace when the device
was already verified at page load), and `isBackupSecretOnDefaultKey()` is false.
- `historyChecked` = that check has resolved. Until then a verified device's `unlock` banner is suppressed, so nothing
  flashes before E2 or before a gossiped key lands.
- The emoji dialog's Done only closes; it has no "Unlock history" button.
- Banner need `unavailable` shows "Older messages are locked · Fix" (also while `recovery.backupLocked`). Dismissing it
  persists per device in localStorage `matrix-poc.historyUnavailableDismissed:<userId>:<deviceId>` = `'1'` (a flag only).
- The recovery dialog's E2 screen has `data-phase` `locked` when `backupLocked`, else `unavailable`. One screen.
- `healKeyStorage()` (internal) runs `syncSecretsToDefaultKey` after an unlock, a completed SAS, a successful restore and
  a successful import.

**`RecoveryState`** = `{ busy: 'unlock' | 'restore' | 'setup' | 'import' | null, progress: { imported, total } | null,
lastRestore: { imported, total } | null, error, errorKind?: 'none' | 'invalid' | 'wrong' | 'unusable',
backupLocked: { reason: RestoreFailureReason, message } | null }`.
- `backupLocked` = verified, but the backup stayed locked. Set by an unlock whose restore failed, or a restore that
  failed on the key. Cleared by a successful restore, `setupRecovery`, or a new unlock. Shown as the recovery dialog's E2
  with `data-phase="locked"`.
- `errorKind` = `RecoveryKeyError.kind` when the key itself failed: no recovery key on the account (`none`), not a key or
  passphrase (`invalid`), does not open secret storage (`wrong`), or opens it but the identity keys are not stored under
  it (`unusable`: "This recovery key can't verify this device. Verify it from your other device instead.", and the form
  offers emoji verification). Absent for other failures. **Match on `errorKind`, never on the `error` text.**

**`PendingPrompt`** = `{ kind: 'password' | 'recovery-key' | 'sso', message, secretName?, differentKey?, url?, popupBlocked? }`.
- Render it while non-null (busy or not). Answer with `answerPrompt(value | null)`; `'done'` for `sso`; null cancels.
- Closing a dialog never answers a prompt. Only an explicit Cancel does.
- **One ask only** (`recovery-ux/DESIGN.md`): the `recovery-key` prompt is registered with `crypto.ts` only inside
  `restoreWithDifferentKey()` (E2's "I have a different recovery key"). Everywhere else `getSecretStorageKey`
  value-matches cached keys and otherwise throws `SecretStorageKeyMissError('no-key')`, which lands on `backupLocked`.
  So a normal unlock or restore never shows a prompt.

**Actions**: `refresh()`, `startSelfVerification()`, `acceptVerification()`, `cancelVerification()`, `confirmSas()`,
`mismatchSas()`, `dismissVerification()`, `unlockWithRecoveryKey(input): Promise<boolean>`, `restoreFromBackup()` (asks
nobody), `restoreWithDifferentKey()` (the only prompting path), `importKeysFromFile(fileText, passphrase): Promise<boolean>`,
`setupRecovery({ passphrase?, reset? }): Promise<string | null>` (the key is also in `newRecoveryKey` until
`dismissRecoveryKey()`), `answerPrompt(value)`.

**Wiring**: `securityHint(status)`, `useSecurityHint()`; `bindSecurity(client)` / `unbindSecurity()` / `resetSecurity()`
are called by the session store.

### Timeline (`src/lib/matrix/utils.ts`, `src/store/hooks.ts`)
`MEGOLM_ALGORITHM`, `isRoomEncrypted(roomId)`, `useRoomEncrypted(roomId)`, `getDecryptionState(event): DecryptionState { status: 'none' | 'decrypting' | 'decrypted' | 'failed', code?: DecryptionFailureCode, message?, historical? }`, `useDecryptionState(event)`, `describeDecryptionFailure(code)`:

| `code` | `message` | `historical` |
|---|---|---|
| `HISTORICAL_MESSAGE_NO_KEY_BACKUP` | Sent before you signed in here, and this account has no key backup | yes |
| `HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED` | Sent before you signed in here. Enter your recovery key to read it | yes |
| `HISTORICAL_MESSAGE_WORKING_BACKUP` | Sent before you signed in here. Restoring from backup... | yes |
| `HISTORICAL_MESSAGE_USER_NOT_JOINED` | You weren't in the room when this was sent | yes |
| `MEGOLM_UNKNOWN_INBOUND_SESSION_ID`, `OLM_UNKNOWN_MESSAGE_INDEX` | Waiting for this message's key | no |
| `MEGOLM_KEY_WITHHELD` | The sender withheld the key for this message | no |
| `MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE` | The sender only shares keys with verified sessions. Verify this session | no |
| `SENDER_IDENTITY_PREVIOUSLY_VERIFIED` | The sender's verified identity has changed | no |
| `UNSIGNED_SENDER_DEVICE`, `UNKNOWN_SENDER_DEVICE` | Sent from an unverified or unknown device | no |
| anything else (`UNKNOWN_ENCRYPTION_ALGORITHM`, `UNKNOWN_ERROR`, ...) | Unable to decrypt this message | no |

### Attachments (`src/lib/matrix/attachments.ts`, `attachment-crypto.ts`, `media.ts`)
`EncryptedFile { url, key: { kty: 'oct', alg: 'A256CTR', ext: true, key_ops, k (base64url, unpadded) }, iv (base64, 8 random + 8 zero bytes), hashes: { sha256 (unpadded base64 of the ciphertext) }, v: 'v2' }`; `EncryptedFileInfo = Omit<EncryptedFile, 'url'>`.
`encryptAttachment(ArrayBuffer) => { data, info }`, `decryptAttachment(ciphertext, file)` (hash checked first, throws on mismatch), `isEncryptedFile(v)`,
`fetchDecryptedMedia(file, mimetype?) => Promise<blob: URL>` (cached per mxc url + type for the session; never revoke it yourself), `fetchDecryptedBlob`, `releaseDecryptedMedia(file)`,
`useDecryptedMediaUrl(file | null, mimetype?) => { url, loading, error }` (= `useMediaObjectUrl`), `MediaSource = string | EncryptedFile`, `mediaSourceOf(body)`, `fetchMediaBlob(source, mimetype?)`, `openMedia(e, source, name?, mimetype?)`, `downloadMedia(e, source, name, mimetype?)`.
Sending (`actions.ts`): `uploadEncryptedMedia(blob) => EncryptedFile` (uploads `application/octet-stream`, filename `encrypted`), `uploadFile(file, { encrypt?, roomId? })`, `sendFile` / `sendVoiceMessage` put `file` instead of `url` in encrypted rooms; no server thumbnails for encrypted media (`info.thumbnail_file` only when the sender made one). SVG / HTML / XML / JS mimetypes are neutralised to `application/octet-stream` on the decrypted blob.

### Scripts
`npm run e2ee:sample` (bob -> `#vault`, 3 texts + 1 encrypted PNG, keys -> `seed/e2ee-keys.json`), `npm run verify:e2ee`; both honour `HS_URL` / `PASSWORD` and use the Node crypto engine in memory (`initRustCrypto({ useIndexedDB: false })`). In the browser: `__matrixPoc.security.importRoomKeys(json)` decrypts the sample history at once.

## Voice calls

### Store (`src/store/call.ts`, re-exported from `@/store`)

```ts
useCallStore: {
  activeCall: ActiveCall | null         // = CallSessionSnapshot, below; null when not in / starting a call
  incoming: IncomingCall[]              // rings on this device, oldest first (one per room)
  history: CallHistoryEntry[]           // newest first, max 200, localStorage 'matrix-poc.callHistory' (cleared on logout)
  liveSessions: Record<roomId, { userIds: string[]; deviceCount: number }>   // every room with a live call (for chips)
  lastError: { code: CallErrorCode; message: string } | null
  speaker: 'earpiece' | 'speaker'       // phone audio route ; reset per call
  startCall(roomId, { ring? }), joinCall(roomId), acceptCall(roomId), declineCall(roomId), dismissIncoming(roomId),
  leaveCall(), toggleMute(), setMuted(bool), setSpeaker(mode), setAudioOutput(deviceId | null), resumeAudio(), clearError()
}
canCall(roomId): CallAvailability                          // pure over the SDK room; call before showing the button
ringPolicy(roomId): 'ring' | 'drop-in'                     // what startCall does by default
enableCallsInRoom(roomId): Promise<boolean>                // admin: grants the call power levels in a public-preset room
activeCallStats(): Promise<{ identity, bytesReceived, packetsReceived, decrypting }[]>   // per remote participant
// hooks
useActiveCall(), useIncomingCall() /* first */, useIncomingCalls(), useCallError(), useCallSpeaker(), useCallAvailability(roomId),
useRoomCallSummary(roomId): { live, userIds, deviceCount, joined, ringing }, useCallHistory(roomId?)

interface CallSessionSnapshot {           // ActiveCall
  roomId; state: 'connecting' | 'ringing' | 'connected' | 'reconnecting' | 'ended';
  participants: CallParticipant[];        // self first; { userId, deviceId, identity: 'user:device', isSelf, connected,
                                          //   speaking, muted, hasKey, keyState: 'ok' | 'pending' | 'missing' }
  muted; audioOutput: string | null; startedAt; connectedAt: number | null; ringing;
  endReason: 'hangup' | 'remote-hangup' | 'declined' | 'no-answer' | 'busy' | 'answered-elsewhere' | 'error' | null;
  error: { code, message } | null; encrypted: true; audioBlocked: boolean   // audioBlocked: call resumeAudio() from a click
  callId: string | null; lastToLeave: boolean; rang: string[]              // what the store's end lines are built from
}
interface IncomingCall { roomId; notifyEventId; from; slotId; expiresAt; receivedAt }
interface CallHistoryEntry { id; roomId; direction: 'outgoing' | 'incoming'; outcome: 'completed' | 'missed' | 'declined' |
  'busy' | 'no-answer' | 'failed' | 'cancelled'; peerUserId: string | null; startedAt; endedAt; durationMs }
type CallErrorCode = 'unencrypted' | 'bridged-dm' | 'crypto-unavailable' | 'not-allowed' | 'no-focus' | 'token' | 'mic-denied' |
  'mic-missing' | 'mic-busy' | 'media-unsupported' | 'connect' | 'busy' | 'membership' | 'unknown'
```

**Call states**, in order: `startCall` moves to `connecting` (preflight, mic, focus, membership), then to `ringing`
(we rang, nobody else yet) or `connected`, then possibly `reconnecting` (LiveKit signal lost), and finally `ended` with
an `endReason`.

- A `startCall` that fails before it is a call (refused room, mic, focus, token, SFU) rejects with a `CallError`, sets
  `lastError`, and leaves `activeCall` null.
- After `ended` the snapshot stays until the next call starts. The UI shows "Call ended" for 3 s, then clears it.
- A ring for another room while in a call is auto-declined with reason `busy` and logged as `missed`. It is never shown.
- Two devices of one user: the one that accepts wins. The other's `incoming` entry drops (`answeredElsewhere`).

### Pure helpers (`src/lib/rtc/index.ts`, import from `@/lib/rtc`)

`describeCallEvent(event, { displayName, myUserId?, nameOf? }) => { kind, userId, text, notifyEventId, callId, durationMs?, participants?, missedByMe, previewText } | null`
Turns a call event into a chat row. `kind` is `'started' | 'declined' | 'busy' | 'ended' | 'missed'`.
- `null` means "not a row" (a malformed line, or another membership state).
- `text` examples: "X started a call", "X declined" / "X declined (busy)", "Call ended, 12 min" ("< 1 min"),
  "Missed call from X" (when `missedByMe`) / "No answer from Y and Z".

`isCallTimelineEvent(event)` is true for the ring, the decline, `dev.matrixpoc.call` and the opening membership: a grey row.
`isCallEvent(event)` is true for any call event type: never a message row.

`lines.ts`: `CALL_LINE_TYPE`, `getCallLine(event): CallLine | null`, `formatCallLine(line, viewerId, nameOf)`,
`callLinePreviewText(line, viewerId)`, `formatCallLineDuration(ms)`, `isMissedForViewer(line, viewerId)`,
`buildCallLineContent(...)`, `isCallOpeningMembership(event, timeline)`.

`policy.ts`: `CALL_RING_MAX_MEMBERS`, `ringPolicyFor(room, me, { isDm })`, `ringTargets`, `isBridgedRoom`, `isBridgeGhost`,
`bridgeGhostPrefixes`, `bridgeGhostOnly`, `hasBridgeGhost`, `splitMembers`. All are pure over a Room-like object; the store
wraps them as `ringPolicy(roomId)` / `canCall`.

`formatCallDuration(ms)` gives `'45 s' | '12 min' | '1 h 05 min'` for history entries. The chat line uses `formatCallLineDuration`.

Constants: `CALL_NOTIFICATION_TYPE = 'org.matrix.msc4075.rtc.notification'`, `CALL_DECLINE_TYPE = 'org.matrix.msc4310.rtc.decline'`,
`CALL_MEMBER_TYPE = 'org.matrix.msc3401.call.member'`, `CALL_POWER_LEVELS`, `RING_TIMEOUT_MS = 60_000`, `CALL_KEYS_TIMEOUT_MS = 5_000`.

`setFocusOverride(url | null)` writes localStorage `matrix-poc.rtcFocusUrl` (or use `VITE_RTC_FOCUS_URL`). For QA and for
pointing a dev build at the homelab.
### Wire shapes and the protocol choices
- **Membership**: `org.matrix.msc3401.call.member` state events (`EventType.GroupCallMemberPrefix`), state key
  `_${userId}_${deviceId}_m.call` on Synapse's default room version (no owned state keys), content `{ application: 'm.call', call_id: '',
  device_id, membershipID: 'user:device', foci_preferred: [{ type: 'livekit', livekit_service_url }], expires, ... }`,
  sent by the SDK via `joinRTCSession({ userId, deviceId, memberId }, [focus], undefined, { manageMediaKeys: true,
  callIntent: 'audio', delayedLeaveEventDelayMs: 8000, useKeyDelay: 250 })`. Leaving = `leaveRoomSession(5000)`; a
  tab that dies is cleaned by the **delayed leave** (MSC4140: the SDK re-arms an 8 s delayed empty state event every
  5 s). `joinRoomSession` is deprecated in 43 and gone in 44: not used. Not used either: sticky events (MSC4354) and
  `org.matrix.msc4143.rtc.slot` (`ensureRtcSlotOpen`); nothing in Codec needs a slot.
- **Ring** (Codec-built, `ringing.ts`): `client.sendEvent(roomId, 'org.matrix.msc4075.rtc.notification', { slot_id:
  'm.call#ROOM', notification_type: 'ring', 'm.call.intent': 'audio', 'm.mentions': { user_ids: [...] }, 'm.relates_to':
  { rel_type: 'm.reference', event_id: <own membership event> }, sender_ts, lifetime: 60000 })`, sent once the own
  membership is on the wire. Encrypted like any room event (the relation stays cleartext). The SDK's `sendCallNotify`
  hardcodes `m.mentions.room: true` (PL 50) and its parser requires an open slot, so Codec parses too: ignore self,
  malformed, expired (`origin_server_ts + min(lifetime, 60 s)`; `sender_ts` is not trusted), not mentioned (`@room` only
  when the sender may `@room`), own membership already in the session, caller's membership gone.
- **Decline**: `org.matrix.msc4310.rtc.decline` `{ 'm.relates_to': { rel_type: 'm.reference', event_id: <ring> },
  msc4354_sticky_key: <ring>, 'io.codec.decline_reason'?: 'busy' }`, sticky when the server supports it, plain
  `sendEvent` otherwise (Synapse 1.163: plain). Only the caller's DM ends on it (room calls keep ringing others).
- **Lines**: `dev.matrixpoc.call` (shape in `docs/archive/DECISIONS.md`, "Voice calls", and in "Pure helpers" above); sent from the store's `onChange` when the snapshot
  reaches `ended` (`sendEndLines`): `missed` on `endReason: 'no-answer'` with `rang` non-empty, `ended` when
  `lastToLeave` (computed in the session's teardown from the memberships left after ours) and the call had
  `connectedAt`. A failed send is logged, never shown. QA reads them via the API (`kind`, `duration_ms` +/- 2 s).
- **Media keys**: the SDK's `ToDeviceKeyTransport` sends `io.element.call.encryption_keys` as Olm to-device messages to
  every device of every member, **verified or not** (no trust check on that path); `EncryptionKeyChanged(key, index,
  membership)` -> `MatrixKeyProvider.setParticipantKey(key, 'user:device', index)` (HKDF-imported, per-participant,
  `ratchetWindowSize: 0`). A device with no key 5 s after it appeared is `keyState: 'missing'` ("No call keys from X
  yet"): device list not downloaded, to-device send failed, receiver crypto not ready. Verification is not a call
  prerequisite; the lock means "E2EE to the SFU".
- **Token**: `POST <livekit_service_url>/sfu/get { room, openid_token, device_id }` (lk-jwt-service's legacy route,
  still served by 0.8 / 0.9) -> `{ url, jwt }` with identity `user:device` = the SDK's `rtcBackendIdentity`, so keys map
  to LiveKit participants without MSC4195 hashing. The 44 bump (`/get_token`, hashed identities, `m.rtc.member`) is
  mechanical later; nothing in 43 was missing for this phase.
- **Focus discovery** (`focus.ts`, cached per homeserver): override (`localStorage` / `VITE_RTC_FOCUS_URL`) ->
  `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports` (authed) -> `<baseUrl>/.well-known/matrix/client`
  `org.matrix.msc4143.rtc_foci` -> `https://<server name>/.well-known/matrix/client` (skipped for localhost) ->
  `CallError('no-focus')`. A token failure re-discovers once (`fresh: true`) before giving up.
- **Power levels**: the public-channel preset has `state_default: 50`, so members could not publish a membership.
  `createChannel` now sets `CALL_POWER_LEVELS` (member, notification, decline, `io.element.call.encryption_keys` -> 0)
  in `power_level_content_override`; older rooms are patched lazily by `ensureCallPowerLevels` when the caller is an
  admin (`enableCallsInRoom` for a button), otherwise `canCall` says `not-allowed`. DMs (`trusted_private_chat`) are fine.
- **Unencrypted rooms are refused** (`canCall` -> `unencrypted`, `startCall` throws before touching the network).

### Local call stack (`scripts/lib/rtc-stack.mjs`, `scripts/rtc.mjs`, `scripts/lib/lk-jwt.mjs`)

One LiveKit SFU and one auth service run next to each Synapse, without Docker.

**Starting it**
- `npm run hs:up` also runs `node scripts/rtc.mjs up`: LiveKit on `ws://localhost:7880`, lk-jwt on
  `http://localhost:7980`, logs and config under `homeserver/.rtc/stack-0/`.
- `scripts/hs-pool.mjs up` starts one stack per Synapse instance: ports `7880+i` (signalling), `7920+i` (tcp),
  `7940+i` (udp), `7980+i` (jwt). Logs go to `homeserver/data/pool/hs-<i>/livekit.log` and `lk-jwt.log`. Each
  instance's well-known is rewritten to point at its own jwt URL.
- `E2E_NO_RTC=1` skips the call stacks.

**The binaries**
- `livekit-server` **1.13.10** (the homelab pin; lk-jwt-service there is **0.9.0**) is downloaded once from GitHub
  releases into the gitignored `homeserver/.rtc/` by `npm run rtc:fetch`. `LIVEKIT_SERVER_BIN` points at another binary.
  CI caches the download by version.
- Signalling binds `127.0.0.1`. ICE candidates advertise the machine's interface address (`LIVEKIT_NODE_IP` overrides it),
  because **Chromium cannot pair a loopback candidate** without `--allow-loopback-in-peer-connection`. With
  `node_ip: 127.0.0.1` the call fails with "could not establish pc connection".
- The auth service is a Node port of lk-jwt-service (`/sfu/get`, `/get_token` on the pre-0.8 body shape, `/healthz`,
  CORS `*`). The real one resolves the homeserver by federation discovery of the server name, so it can never reach a
  plain-HTTP `localhost:8008+i`. The port verifies the OpenID token the same way (`GET
  /_matrix/federation/v1/openid/userinfo`) and derives the same room name (`sha256([roomId, 'm.call#ROOM'])`, unpadded
  base64) and identity. That code is `src/lib/rtc/livekit-token.ts`, shared with the browser and unit-tested.

**Synapse settings** (`homeserver/homeserver.yaml`)
- `experimental_features`: msc3266, msc4140, msc4222, msc4143, msc4075.
- `max_event_delay_duration: 24h`; `rc_delayed_event_mgmt` raised (one delayed-event restart per 5 s per device).
- `extra_well_known_client_content` with `org.matrix.msc4143.rtc_foci`.

**Limits**
- Phones on the LAN cannot use the local stack, because signalling is loopback. Phones use the homelab stack.
- `npm run rtc:probe` proves the whole chain without a browser: well-known, healthz, OpenID, `/sfu/get`, JWT claims and
  signature, a forged token refused, SFU up, and a Node crypto client's membership on the wire.

### Tests

**Unit** (`npm run test:unit`) covers `livekit-token`, `focus`, `participants`, `ringing` (wire shape, receive rules,
expiry caps), `timeline`, `history`, `permissions`, `token`, `lines` (the `dev.matrixpoc.call` parser, row texts per
viewer, preview text, the opening-membership rule) and `policy` (ring rule, ghost prefixes, bridged DM vs group).

**End to end** (`npm run test:e2e:calls` = `e2e/calls-core.spec.ts`, desktop) runs two browser contexts in `dm-alice-dave`:

1. Ring, incoming card, accept. Both sides reach `connected` with keys and **bytes received** from each other (the E2EE
   decryptor is attached).
2. Mute is visible remotely.
3. Hang up: the other side sees `remote-hangup` and a history entry.
4. Decline.
5. A call is refused in `dm-alice-bob`.
6. The "No call keys" case: dave's `PUT /sendToDevice/m.room.encrypted/*` is swallowed with `page.route`, and alice shows
   `keyState: 'missing'`.

Only the ring, decline and membership events are checked through the raw API.

## Dev hooks

In dev builds only (`import.meta.env.DEV`, `src/app/devtools.ts`) the app exposes `window.__matrixPoc`. QA and the
`scripts/verify-*.mjs` checks use it.

| Hook | What it is |
|---|---|
| `__matrixPoc` | stores, `getClient`, `getVoiceMessage`, `getDisplayBody`, `analyzeAudio`, `runBackHandlers()`, ... |
| `__matrixPoc.receipts` | the receipts module plus `getReadPoints`, `getSeenBy`, `getSendStatus`, `markRead`, ... (see Read receipts) |
| `__matrixPoc.call` | the call store plus `canCall`, `ringPolicy`, `startCall` ... (see Voice calls); `__matrixPoc.calls` is an alias, `__matrixPoc.rtc` the barrel |
| `__matrixPoc.security` / `__matrixPoc.crypto` | the `security.ts` module plus `store`, `cryptoDatabasePrefix`, `getCryptoError`, `importRoomKeys(json)`, `exportRoomKeys()`; also `securityStore`, `attachments`, `cryptoLifecycle` |
| `__matrixPoc.gif` | the whole `src/lib/gif` module |
| `__matrixPoc.preview` | the whole `src/lib/preview` module |
| `__matrixPoc.voice` | `{ forceRemuxFailure, encodeToOggOpus }` for the voice-format tests |
