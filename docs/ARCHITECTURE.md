# Architecture

How Codec is built, in plain words. Read this before you change anything in `src/lib`, `src/store` or `src/app`.

This page explains behaviour and the rules the shared layer guarantees. Three companions hold the detail:

- `docs/CORE_API.md`: every store, hook, action and wire shape, with exact signatures.
- `docs/GOTCHAS.md`: the traps we hit in matrix-js-sdk, Synapse, phones and encryption.
- `docs/ARCHITECTURE_DIAGRAMS.md`: the same architecture as pictures.

**Precedence**: where this page or `docs/CORE_API.md` differs from any plan, ticket or acceptance doc under
`docs/archive/`, **these two files win**.

Contents

1. [The shape of the app](#1-the-shape-of-the-app)
2. [How it starts and runs](#2-how-it-starts-and-runs)
3. [Rules for feature code](#3-rules-for-feature-code)
4. [Who works on what](#4-who-works-on-what)
5. [Features: what the core guarantees](#5-features-what-the-core-guarantees)
6. [Glossary](#6-glossary)
7. [Where to look next](#7-where-to-look-next)

## 1. The shape of the app

Codec is a single-page React app. It runs in the browser, or inside a Capacitor shell on Android and iOS. It talks to
one Matrix homeserver (Synapse) through matrix-js-sdk, and the SDK's Rust engine does the encryption.

The code has four layers. **Imports only go downwards.**

| Layer | Folder | What lives there |
|---|---|---|
| Shell | `src/app/` | The login screen, the loading screen and the frame around everything (desktop grid or phone drawers). |
| Features | `src/features/` | What users see: navigation, conversation, GIF picker, link previews, security dialogs, calls, receipts. |
| Stores | `src/store/` | App state in Zustand stores, plus the *bridge* that copies SDK events into them. |
| Library | `src/lib/` | No React. The Matrix client, actions, crypto, media, audio, GIFs, previews, calls, formatting. |

Feature code never sends anything through matrix-js-sdk itself. It reads state through store hooks and changes things
through the action functions in `src/lib/matrix/actions.ts`. It may use the SDK's types and enums.

Around the app:

| Folder | What it is for |
|---|---|
| `homeserver/` | The local Synapse: one `homeserver.yaml`, a Docker compose file, and a WSL1 fallback for PCs without virtualisation. |
| `seed/` | The fixture script that creates the test users, rooms and messages (`docs/SEED_DATA.md`). |
| `scripts/` | Homeserver wrapper, LAN proxy, Android build, sample posters and no-browser verifiers. |
| `e2e/` | The Playwright suite. |
| `public/` | The media service worker and the mock GIF fixtures. |
| `android/`, `ios/` | The Capacitor projects. |

The full per-file map is in `docs/CORE_API.md` under "Module map".

## 2. How it starts and runs

1. The page loads. The browser registers the media service worker, then `App` mounts and calls `restore()` on the
   session store.
2. If localStorage has a session (`matrix-poc.session` = `{ baseUrl, userId, accessToken, deviceId }`), the status
   starts as `syncing`. If the URL carries an SSO `loginToken`, it is swapped for a new session first. Otherwise the
   status is `logged-out` and the login screen shows.
3. The client is created, the crypto engine starts (loading stage "crypto"), then the client starts syncing (loading
   stage "sync"). The bridge and the security store subscribe to the client.
4. When the first sync finishes (`Prepared`), the status becomes `ready` and the shell renders. The bridge does one
   full recompute of the room list and all loaded timelines at that moment, and again whenever the SDK recovers from a
   sync error.
5. From then on every SDK event lands in a store through the bridge. Bursts are batched: 50 ms for the room list,
   30 ms for timelines. React renders once per burst, never once per event.
6. Logging out stops the client, wipes this device's crypto store, clears localStorage and resets every store and cache.
   A token revoked by the server does the same, but lands on the login form with "Session expired".

The room list waits for `Prepared` on purpose. Before that fix, account-data and decryption events during a long first
sync recomputed the room list on a half-loaded world, and a fresh login landed on the wrong room.

Session status values are exactly `'logged-out' | 'logging-in' | 'syncing' | 'ready' | 'error'`. Diagram 4 in
`docs/ARCHITECTURE_DIAGRAMS.md` shows every transition.

## 3. Rules for feature code

**Reading and writing**

- Read through hooks (`useTimeline`, `useRoomSummary`, `useMembers`, ...). Never read SDK objects directly in render,
  except through the read helpers in `src/lib/matrix/utils.ts`.
- Write through actions (`sendText`, `createChannel`, `sendReadReceipt`, ...). Never call `client.send*` yourself.
- Re-render on the store's `version` counters, not by diffing SDK objects. The SDK mutates events in place (edits,
  decryption), so a row memoised only on `event.getId()` goes stale.

**What the shell mounts**

The shell passes nothing but `roomId` (and `rootId` for a thread) to feature components.

- Desktop: `SpaceRail` (column 1), `ChannelSidebar` + `UserFooter` (column 2), `ChannelHeader` and `Conversation`
  (column 3), `MemberPanel` or `ThreadView` (column 4). `MemberPanel` returns null to hide, and the column collapses.
- Phone: `ChannelHeader` + `Conversation` fill the screen. `SpaceRail` + `ChannelSidebar` + `UserFooter` live in the
  left drawer, `MemberPanel` in the right drawer. A thread stacks over the conversation below the header.
- Nothing phone-only exists in the desktop DOM, and both layouts mount the same feature components.

**Phone contract**

- `ChannelHeader` renders `header-menu`, which calls `useLayoutStore.openNav()`. On phone it also renders
  `member-toggle`, which calls `useLayoutStore.openMembers()`; desktop keeps `useNavUiStore.toggleMembers()`.
- `MemberPanel` renders its list on phone regardless of `useNavUiStore.membersOpen`.
- Room taps call `selectRoom()`. The layout store closes the drawer; features never close it themselves. Space taps keep
  the drawer open.
- Android back closes things in this order: a registered handler (an open sheet, a call card), then the open thread, then
  the drawers, then the app minimises. Register with `registerBackHandler(fn)`; handlers run newest first.

**Test ids**

`data-testid` is kebab-case, `{area}-{element}`. A dynamic suffix is the raw Matrix id (`channel-item-!abc:localhost`,
`message-$xyz`, `member-item-@bob:localhost`, `reaction-👍`). Helper attributes: `data-name`, `data-sender`,
`data-count`, `data-mine`, `data-selected`. The registry is `docs/ACCEPTANCE.md`. Placeholder components already use
the registry ids; keep them when replacing internals.

The shell owns these ids: `login-form`, `login-username`, `login-password`, `login-submit`, `login-register-toggle`,
`login-error`, `login-advanced-toggle`, `login-hs-url`, `login-hs-url-reset`, `login-hs-url-effective`, `app-loading`
(+ `data-stage`), `app-shell` (+ `data-layout`, `data-thread-open`, `data-in-call`), `current-user` (+ `data-verified`),
`logout-button`, `toast`, `empty-state`, `nav-drawer`, `member-drawer`, `drawer-backdrop` (each + `data-open`),
`thread-panel-container`, `security-banner-host`, `security-dialogs-host`, `call-host`.

**localStorage keys the app owns**

`matrix-poc.session`, `nav.selection` (no prefix), `matrix-poc.hsUrl`, `matrix-poc.callHistory`, `matrix-poc.rtcFocusUrl`,
`matrix-poc.hiddenPreviews`, `matrix-poc.gifApiKey`, `matrix-poc.gifProvider`, `matrix-poc.gifCustomerId`,
`matrix-poc.pendingCryptoWipes`, `matrix-poc.historyUnavailableDismissed:<userId>:<deviceId>`.

**CSS**

- Use only the design tokens in `src/app/theme.css`. Phone tokens: `--safe-top/right/bottom/left`, `--tap-target: 44px`,
  `--phone-header-h: 56px`, `--drawer-w: 85%`, `--keyboard-height`, `--vvh` (visual viewport height in px).
- Phone-only styling goes under `:root[data-layout='phone']` or `@media (hover: none)`.
- Every input, textarea and select gets `font-size: max(16px, 1em) !important` on phone (iOS focus zoom). Do not fight it.
- The composer owns `padding-bottom: var(--safe-bottom)`; the shell does not pad the bottom.

## 4. Who works on what

The project is built by a small team of agents with fixed roles. The names appear throughout the docs.

| Role | Owns | Must not edit |
|---|---|---|
| **Principal** (engineer) | `src/app/**`, `src/store/**`, `src/lib/**`, `public/**`, `src/styles/**`, `index.html`, `capacitor.config.ts`, `android/**`, `ios/**`, `seed/**`, `scripts/**`, `homeserver/**`, `package.json`, `.env.example`, `docs/ARCHITECTURE.md`, `docs/CORE_API.md`, `docs/GOTCHAS.md`, `docs/MOBILE.md`, root configs | - |
| **Dev A** (navigation) | `src/features/navigation/**`, `src/features/gif/**`, `src/features/security/**`, `src/features/link-preview/**`, `src/features/receipts/**` | anything else |
| **Dev B** (conversation) | `src/features/conversation/**`, `src/features/call/**` | anything else |
| **QA** | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:e2e*` script lines in `package.json` | anything else |
| **PM** | plans, acceptance criteria, tickets, `docs/STATUS.md`, demo scripts | code |

An **Advisor** answers hard questions on request and verifies claims against the real SDK and server. The
**orchestrator** (also called the coordinator) briefs everyone, rules on disputes and makes every commit. Work happens
in **waves**: plan and core first, features second, a fix wave third.

**Asking for a change in the core layer**: do not edit it. Put a block in your report:
`Request to Principal: <file>, <function/hook>, <desired shape>, <why>`. The Principal implements it, usually in the
same wave, and updates these docs. Small additive requests (a new reader, an extra field on `RoomSummary`) are cheap;
changes to store shapes are not.

## 5. Features: what the core guarantees

Each section says what the user sees, then the rules the shared layer implements. Signatures are in `docs/CORE_API.md`
and traps in `docs/GOTCHAS.md`, under the same heading.

### 5.1 Rooms, spaces and DMs

**What the user sees.** Spaces down the left, channels and DMs next to them, unread badges. The app remembers the last
channel per space and comes back to it.

**Rules the core implements**

- The room store auto-selects the first channel on a space change, remembers the last channel per space, and persists
  the selection in localStorage `nav.selection`. Features just call `selectSpace` / `selectRoom`.
- The first-ever load lands on the first space alphabetically and its first channel (Acme HQ / #general in the seed).
- A room you just created can arrive in two `/sync` batches, so its name and parent can be wrong for a few hundred ms.
  The store's selection logic handles it (`pendingRoomId`). Feature code must re-read a new room from `roomsById` on
  every render, never cache its summary.
- Unread counts are server-side and cover the **main timeline only**. Thread replies never count towards the channel
  badge; a separate flag (`threadUnread`) lights the header's "Threads" dot.
- Room creation is rate limited separately by Synapse. The create actions retry on 429 for up to 30 s, then throw
  `RateLimitedError`.
- New rooms pin `room_version: "11"` so the creator keeps an explicit power level of 100 (the crown icon). Synapse 1.162
  and later default to v12, where the creator's power is infinite and must not appear in the power-level override.
- New channels and DMs are **encrypted by default**. Spaces are not; they only hold the channel list.

### 5.2 Timeline and messages

**What the user sees.** Messages grouped by sender, replies, reactions, edits, "Message deleted" rows, a typing line,
and older messages loading when you scroll up. Your own message appears instantly.

**Rules the core implements**

- The timeline store holds an **unfiltered** copy of each room's live timeline, oldest first. `useTimeline` filters it to
  displayable main-timeline rows (messages and stickers, redacted ones included; no reactions, edits, state events or
  thread replies).
- A sent message shows at once as a *local echo* with a `~` id. When the server confirms, the id becomes `$...` and the
  row re-renders once with a new key. Receipts are never sent for `~` ids.
- Edits replace the target's content in place; the `m.replace` event itself is never a row. Reactions are aggregated
  with `getReactions(roomId, eventId)`. Redacted events stay in the timeline with empty content.
- Scrolling up calls `paginateBack`, which prepends into the same live timeline and replaces the snapshot wholesale.
  The conversation feature pins the scroll position around it.
- The first sync loads 30 events per room, and that count includes reactions, edits and state. #general shows about 25
  rows before the first pagination.
- Only senders are known after the first sync (lazy members). `useMembers` and `selectRoom` load the rest, and the list
  fills in on the next `version` bump.
- Timestamps: `formatTime` gives `HH:MM` today and `DD/MM/YYYY HH:MM` otherwise. `formatRelative` gives `just now`,
  `N min ago`, `N h ago`, `yesterday`, `N d ago`, else `DD/MM/YYYY`.

### 5.3 Threads

**What the user sees.** A reply "in thread" never shows in the channel. The root stays in the channel with a summary
row under it (reply count, who replied, when). Opening a thread shows a side panel on desktop (400 px, in place of the
member list) or a full-screen layer on phones. Threads do not nest.

**Rules the core implements**

- The SDK partitions `m.thread` replies into a `Thread` per root when `threadSupport: true` is passed to `startClient`.
  `useTimeline({ roomId })` filters again with `isMainTimelineEvent`, so no reply leaks.
- Every API collapses a reply id to its root. `replyTo` plus `threadRoot` on one message is rejected
  (`ThreadReplyConflictError`); the only thread shape is the Element-compatible fallback with `is_falling_back: true`.
- The `m.in_reply_to` on a thread reply is a fallback, not a quote. Replies render flat.
- The SDK's first fetch of a thread returns Synapse's default of 5 relation events, so the core tops a thread up to at
  least 20 visible replies on open. The SDK does not show a thread reply's local echo in v43; the bridge adds it.
- A thread has its own unread count, server-computed, cleared only by a receipt in that thread (`markThreadRead`).
- Typing is room-wide. Matrix has no thread-scoped typing, and the docs say so instead of faking it.
- A reply redacted in this session disappears correctly. A reply redacted **before** this session loaded shows as
  "Message deleted" in the channel after a reload. That is an SDK limitation until MSC3389.
- The shell renders `ThreadView` from `@/features/conversation`; Escape is not bound to the thread (the composer uses it).

### 5.4 Files, images and voice notes

**What the user sees.** Images and files upload behind an "Uploading..." bar. A voice note records with a level meter,
sends as Ogg/Opus, and plays with a waveform and scrubber. Images load even on servers that require authentication.

**Rules the core implements**

- Browsers cannot attach a token to an `<img>`, so a service worker (`public/media-sw.js`) adds the access token to media
  requests for the user's own homeserver. It never stores the token and only sends it to the session's homeserver.
  Without the worker (a plain-http LAN address) the app falls back to the legacy unauthenticated media URLs.
- Opening or downloading a file is a navigation the worker cannot see, so features use `openMedia()` / `downloadMedia()`
  and `fetchMedia()`, never a bare link or `fetch()`.
- Synapse ignores `Range` on media, so `<audio src=".../download">` cannot seek. Audio and video are fetched once and
  played from a `blob:` URL.
- Uploads go through `uploadMedia`, never `client.uploadContent` (which double-encodes the filename).
- Voice notes: the recorder produces WebM/Opus on Chromium and Android, which is **losslessly remuxed to Ogg/Opus** in
  the browser before upload (no re-encoding, no WASM on the send path). Safari's `audio/mp4` and Firefox's `audio/ogg`
  pass through. The message carries the duration and a 100-sample waveform (peak per bucket, loudest = 1024) so
  players never compute them. The content shape is Element's, field for field.
- Playback tries the native `<audio>` first. Only browsers that cannot play Ogg or WebM (iPhones before iOS 18.4) load
  a software decoder and play a WAV blob instead. MP4/AAC never takes that path.
- In encrypted rooms files are encrypted in the browser (AES-256-CTR, SHA-256 hash) before upload. The server only sees
  scrambled bytes and cannot make thumbnails, so the app downloads, checks and decrypts the file itself.

### 5.5 GIFs

**What the user sees.** A GIF picker with search and trending, backed by Klipy. Without an API key it shows eight
built-in mock GIFs so the feature still works.

**Rules the core implements**

- **Nothing is uploaded.** A GIF message is `m.text` with `body: "<title> <url>"` and a `dev.matrixpoc.gif` field, and
  the timeline hot-links the image from Klipy. Klipy's terms forbid storing, mirroring, proxying or re-hosting its media,
  and require results in the returned order, unfiltered.
- The URL is the last token of the body, so Element shows a link and its URL preview unfurls it.
- Readers accept the GIF field only when the URL is https on a Klipy host (or same-origin `/gif-fixtures/` for the
  mock) and the dimensions are integers 1..2000. Anything else is an ordinary text message, so forged fields cannot
  load arbitrary images.
- Provider choice: a localStorage override forces `klipy` or `mock`; otherwise a key (runtime or `VITE_GIF_API_KEY`)
  means Klipy. The key ships inside the bundle and APK, so use a Testing key or one you can revoke.
- A 429 from Klipy is retried once (honouring `Retry-After`), then surfaces as a rate-limit error. The Testing key allows
  100 requests per hour, so the picker debounces typing by at least 300 ms.
- A GIF **file** attached with the paperclip is a normal `m.image` and renders as a static first frame, because Synapse
  thumbnails are static PNGs unless `animated=true` is requested.

### 5.6 Encryption and device trust

**What the user sees.** New channels and DMs are encrypted. A banner asks for one of four things: set up encryption
(first device), verify this session (compare emoji with another device), unlock message history (enter the recovery
key), or wait while keys restore. Messages this device has no key for show an "unable to decrypt" row that says why and
offers a button when there is a fix.

**Rules the core implements**

- Encryption runs in matrix-js-sdk's Rust engine. Each sign-in is a new device with its own keys in IndexedDB, under
  the prefix `matrix-poc-crypto:<userId>:<deviceId>`. The crypto store is **not encrypted at rest**: the browser profile
  is the trust boundary, like the access token in localStorage.
- Crypto starts before the first sync. A crypto failure never blocks login: the app runs unencrypted, the security store
  reports `cryptoReady: false`, and sends into encrypted rooms throw.
- Logout wipes the device's crypto store. The wipe can lag a few seconds behind an in-flight backup upload; the prefix is
  remembered in `matrix-poc.pendingCryptoWipes` and deleted at the next boot at the latest.
- The banner's hint is decided in this order: `setup` (no identity and no secret storage), `unlock` (no identity but a
  recovery key exists), `verify` (identity exists, this device not signed), `unlock` (verified, a backup exists, its key
  not cached), else nothing. The status is `null` until the first sync and `/keys/query` finish.
- **One ask only.** A normal unlock or restore never prompts for a second key. If the backup sits under a key this
  device does not have, the dialog shows "older messages can't be unlocked yet" with three ways in: import an Element
  key file, verify from another device, or "I have a different recovery key" (the only prompting path). No reset is
  reachable from the unlock dialog.
- Verifying a device cross-signs it but does **not** hand it the backup key unless the other device has that key cached.
  When it arrives, the restore runs by itself.
- A new device cannot read messages sent before it existed until it restores the backup or imports keys. The first
  device of an account must set up recovery or nothing is ever backed up. Backup uploads start lazily (up to 10 s), so a
  logout before `backupRemaining` reaches 0 loses those keys.
- Failed decryptions are classified (`getDecryptionState`) into user-facing reasons such as "Sent before you signed in
  here" or "The sender only shares keys with verified sessions". Branch on the state, never on the body text.
- Encrypted relations (an edit, a reaction, a redaction of one) are never rows while undecrypted.
- The first cross-signing upload needs no password (spec v1.11); only a reset asks for a password or an SSO popup.
  **The SSO reset path has not been exercised on 704.chat.**
- Reactions are never encrypted. `npm run seed` is additive on a seeded server and never resets `#vault`.

### 5.7 Link previews

**What the user sees.** Up to three cards per message (site, title, description, image). In an encrypted room a "Show
preview" button appears instead, and nothing is fetched until it is clicked. YouTube and Spotify links get a player
that also loads only on click. Every card has a Hide button, and the choice is remembered.

**Rules the core implements**

- The homeserver fetches the page and re-hosts the image, so the user's IP never reaches the linked site.
- In an encrypted room, asking the server for a preview would reveal the link, so previews are opt-in per message.
  A preview already in the app's cache still shows; the server has already seen that URL.
- The image must be an `mxc://` URI. A raw third-party image URL is dropped.
- The app keeps its own cache: 200 URLs, hits for 1 h, misses for 5 min so a transient failure can retry.
- Links inside code blocks, matrix.to links and the homeserver's own media URLs never get a card.
- Hidden previews live in localStorage `matrix-poc.hiddenPreviews`, max 1000.

### 5.8 Read receipts

**What the user sees.** Your own newest message shows "sending", then "sent", then the avatars of people who have read
up to it. Hovering or tapping lists who has and has not seen a message. A "Send read receipts" setting makes your
receipts private.

**Rules the core implements**

- Receipts for the channel come from the `Room`; receipts for a thread come from that `Thread`. The two are never mixed.
  Inside the thread panel the root row shows no avatars.
- A read point attaches to the nearest **displayed** row at or before it, so hidden events never swallow an avatar.
- The SDK counts a sender as having read their own message, and anyone who posts after yours as having seen it. Element
  behaves the same.
- With the setting off, receipts go out as `m.read.private`. Your unread counts still clear; others never see them. The
  setting is stored in `im.vector.web.settings` (`sendReadReceipts`, default on) so Element and Codec agree, and a change
  made in Element flips the toggle without a reload. Element's per-room override is **not** honoured.
- The toggle takes effect immediately, before the server confirms, so no public receipt can leak after switching it off.
- Rooms with more than 50 other members show a truncated "Seen by" list.

### 5.9 Voice calls

**What the user sees.** A call button in encrypted DMs and channels. Rooms of five or fewer ring everyone; bigger rooms
are drop-in. An incoming card, an in-call screen with mute and speaker, and four kinds of grey chat line: started,
declined, ended (with duration), missed. On Android the call keeps running in the background with a notification.

**Rules the core implements**

- Calls are MatrixRTC (MSC4143) with a self-hosted LiveKit server. Membership is a `org.matrix.msc3401.call.member` state
  event; the ring is `org.matrix.msc4075.rtc.notification`; declines are `org.matrix.msc4310.rtc.decline`; "ended" and
  "missed" lines are Codec's own `dev.matrixpoc.call` event, encrypted like a message. All four are rendered the same on
  every device from the events, so the local history is only a cache.
- Audio is encrypted per participant before it reaches LiveKit; the server only forwards scrambled audio. Keys travel as
  Olm to-device messages to every device of every member, verified or not. Verification is not a prerequisite; the lock
  means "encrypted to the server".
- Codec finds the call server in the homeserver's well-known file (an override exists for QA), asks it for a ticket, and
  connects. Unencrypted rooms are refused before touching the network.
- A ring lasts 60 s. If nobody joins or declines, or the caller hangs up while still ringing, the caller posts a "missed"
  line naming who was rung. The last participant to leave posts the "ended" line.
- A ring in another room during a call is auto-declined with reason `busy` and never shown. When one user has two
  devices, the one that accepts wins.
- Public-preset rooms created before calls existed lack the power levels; an admin's `enableCallsInRoom` patches them.
  Rooms whose other members are all bridge ghosts are refused as `bridged-dm`.
- Locally, `npm run hs:up` also starts a LiveKit and token service. Phones on the LAN cannot use it (signalling is
  loopback); they use the homelab.

### 5.10 Phone layout and Android

**What the user sees.** Under 768 px wide (or a touch screen under 1024 px) the app becomes one full-screen conversation
with the navigation and member list in slide-in drawers. Edge swipes open them. The Android back button closes things
in order instead of leaving the app.

**Rules the core implements**

- `isPhone` is width-based, not `(hover: none)`. A desktop window narrowed under 768 px is a phone layout by design;
  the desktop Playwright project at 1280x720 never is.
- Opening one drawer closes the other. Leaving phone mode closes both. A room tap closes the nav drawer through
  `onRoomSelected`; a space tap does not.
- The keyboard height and the visual viewport are mirrored into CSS variables (`--keyboard-height`, `--vvh`) and
  `<html data-keyboard>`, because `100dvh` does not follow the iOS keyboard.
- The Capacitor app runs at `http://localhost` with cleartext allowed, so plain-http requests to the LAN proxy are not
  mixed content and `getUserMedia` still works. Never point `server.url` at a LAN IP.
- Recording needs a secure context. A phone browser on `http://192.168.x.x` cannot record; the mic button shows disabled
  with a hint.
- `docs/MOBILE.md` has the toolchain, the APK build and the phone walkthrough.

## 6. Glossary

| Term | Meaning |
|---|---|
| **homeserver** | The Matrix server (Synapse) the app talks to. Locally `http://localhost:8008`; the beta runs `matrix.704.chat`. |
| **bridge** | `src/store/bridge.ts`: the code that listens to matrix-js-sdk events and copies what the UI needs into the stores. |
| **snapshot** | A store's copy of an SDK list (events, rooms). Replaced wholesale on each change; never diffed by hand. |
| **local echo** | A message shown before the server confirms it. Its id starts with `~`; the confirmed id starts with `$`. |
| **source** | `{ roomId, threadRootId? }`: which timeline a hook is about. Without `threadRootId` it is the main timeline. |
| **holder** | The object that owns a set of receipts: the `Room` for the main timeline, a `Thread` for its replies. |
| **mxc URI** | `mxc://server/id`, Matrix's name for an uploaded file. `mxcToHttp` turns it into a URL. |
| **UTD** | "Unable to decrypt": a message this device has no key for. |
| **recovery key / 4S** | The key that unlocks *secret storage* (4S), where the cross-signing and backup keys are kept. Also accepts a passphrase. |
| **cross-signing / verified** | The account identity signs each trusted device. Verifying compares emoji (SAS) with another device. |
| **key backup** | Encrypted copy of message keys on the server, unlocked with the recovery key. |
| **UIA** | User-interactive auth: the server asking for a password or SSO step before a sensitive change. |
| **focus / SFU** | The call server (LiveKit) that forwards audio. A *call ticket* is the token that lets a client in. |
| **ghost** | A bridge's puppet user for someone on another network. Ghosts are not counted or rung for calls. |
| **drop-in call** | A call that rings nobody; people join from the chip in the sidebar. Rooms with more than 5 others. |
| **Prepared** | The SDK's "first sync done" state. The app shows the shell at that moment. |
| **wave** | One round of team work (plan + core, then features, then fixes). Phase docs are organised by wave. |
| **AC-, PRIN-, DEV-A-, DEV-B-, QA-** | Ids of acceptance criteria and tickets in the archived phase docs. BUG-N are rows in `docs/BUGS.md`. |
| **matrix-poc** | Codec's old working name. It survives in package ids, localStorage keys and the `__matrixPoc` dev hook. |
| **704.chat / homelab** | JC's self-hosted beta: Synapse, Keycloak SSO, Codec's files and LiveKit behind Nginx Proxy Manager and a Cloudflare tunnel. Diagram 11. |

## 7. Where to look next

- `docs/CORE_API.md`: exact signatures, store shapes, wire shapes, dev hooks.
- `docs/GOTCHAS.md`: the traps, grouped by area.
- `docs/ARCHITECTURE_DIAGRAMS.md`: pictures of the flows above.
- `docs/RUNBOOK.md`: every npm command, by task.
- `docs/MOBILE.md`: phones, the APK and iOS.
- `docs/README.md`: the index of every doc, including the archived phase records and the decision log.
