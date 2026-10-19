# Gotchas

Each bullet is a trap we hit for real, in matrix-js-sdk, Synapse, phones, encryption or the test setup. **Bold is the
symptom or the rule.** Read the group for the area you are touching before you change it. The API itself is in
`docs/CORE_API.md`; how the app is put together is in `docs/ARCHITECTURE.md`.

Versions these were found on: matrix-js-sdk 43, Synapse 1.162 / 1.163, Rust crypto 18.9, Capacitor 7.6.9.

Contents: [matrix-js-sdk, general](#matrix-js-sdk-v43-general) · [Phones and voice notes](#phones-and-voice-notes) ·
[Threads](#threads-matrix-js-sdk-v43--synapse-1162) · [Encryption](#encryption-matrix-js-sdk-v43--rust-crypto) ·
[Read receipts](#read-receipts-matrix-js-sdk-v43) · [Voice calls](#voice-calls) · [GIFs](#gifs) ·
[Link previews: the test homeserver](#link-previews-the-test-homeserver) · [Machine notes](#machine-notes)

## matrix-js-sdk (v43), general

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
- **Media** (authenticated media, `src/lib/matrix/media.ts`): `public/media-sw.js` is a service worker that adds
  the access token to `/_matrix/client/v1/media/{download,thumbnail}` requests, so `<img src>` works on servers
  with `enable_authenticated_media: true` (the Synapse default, and what real deployments run). `mxcToHttp()`
  returns v1 URLs when the server advertises v1.11 and the worker controls the page, else the legacy
  `/_matrix/media/v3` URLs (plain-http LAN dev has no service worker; those need the local server's
  `enable_authenticated_media: false`). Links to media are navigations the worker can't see: use
  `openMedia()` / `downloadMedia()` as the click handler, and `fetchMedia()` instead of `fetch()` for media.
  The worker never stores the token; it asks the page per request and only sends it to the session's homeserver.
- **Login methods**: the login screen asks `GET /login` and shows the password form and/or one "Continue with
  <provider>" button per SSO identity provider (e.g. Keycloak). SSO returns with `?loginToken=`, which
  `restore()` exchanges via `m.login.token`. The Register toggle only shows when `POST /register {}` answers
  401 (open); that probe logs one expected 401 in the console.
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
  rest lands. The store's selection logic is written for this (the `pendingRoomId` rule in `docs/CORE_API.md` "Room store"); feature code should
  never cache a `RoomSummary` of a room it just created - re-read it from `roomsById` on each render.
- **Room creation is rate limited separately** (`rc_room_creation`, default burst 10 then one room per ~62 s per
  user) and the SDK does **not** retry `createRoom` on 429 (only `m.room.message` sends go through its retrying
  scheduler). `createChannel` / `createSpace` / `createDm` / `inviteUser` / `joinRoom` therefore go through
  `retryOnRateLimit` (waits `retry_after_ms`, up to 30 s, else `RateLimitedError`). A homeserver whose config
  lacks the `rc_room_creation` override will still fail dialogs after ~10 room creations by the same user until the
  bucket refills - if a create-channel/space/DM test fails with a 429 in the toast/dialog, that is the cause.

## Phones and voice notes

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
  (AAC), Firefox `audio/ogg;codecs=opus`. Everything Chromium-based plays all three; WKWebView before iOS 18.4 plays
  neither WebM nor Ogg. Element plays all of them.
- **Lossless WebM -> Ogg remux on send** (`remuxWebmOpusToOgg`, `src/lib/audio/ogg.ts`): Opus packets are copied
  from the Matroska blocks into Ogg pages (OpusHead/OpusTags built from the track header), no decode, no WASM.
  `encodeToOggOpus` catches any remux error and returns the original blob with its own mimetype: sending never
  breaks on the format step. Duration and waveform are still computed from the original recording.
- **Software decode fallback on play** (`VoiceMessage.tsx` + `decodeToWavBlob`): native `<audio>` is always tried
  first. Only when `canPlayNatively(mimetype)` is false, or the element errors / `play()` rejects with a format
  error / neither plays nor errors within 4 s (WKWebView can stall silently), the note is decoded with the lazily
  imported `ogg-opus-decoder` (WebM is remuxed to Ogg in the browser first) and played as a 16-bit WAV blob through
  the same `<audio>` + blob: URL, so scrubber, seek, duration and one-at-a-time keep working. MP4/AAC never takes
  this path (`SoftDecodeError('unsupported')` -> `voice-error`). Browsers that play natively never load the decoder.
- **iOS gesture unlock**: the first tap on `voice-play` synchronously plays a 10 ms silent `data:audio/wav` clip so
  the element counts as user-activated; the real `play()` happens after the download/decode awaits, when the tap's
  activation would otherwise be gone (`NotAllowedError`). Media events from the unlock clip are ignored.
- **Observability**: `voice-message` carries `data-playback="native|fallback"` once a source is set; dev builds
  expose `window.__matrixPoc.voice = { forceRemuxFailure, encodeToOggOpus }` (`src/app/devtools.ts`) for the AC-F9
  / AC-F10 tests. Criteria: docs/VOICE_FORMAT_PLAN.md.
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
- **Edge-to-edge (Android 15, targetSdk 35)**: Capacitor 7 handles system-bar insets natively (`SystemBars`);
  `env(safe-area-inset-*)` is 0 inside the WebView with `overlaysWebView: false`, so the CSS fallbacks must look
  right - they do (the status bar is painted by the OS in `#1e1f22`).
- **Synapse media download ignores `Range`** (no `Accept-Ranges`; a ranged GET answers 200 with the full body), so
  an `<audio src=".../_matrix/media/v3/download/...">` is **unseekable**: `seekable` is `[0, 0]` and every
  `currentTime` assignment snaps back to 0. The conversation feature therefore `fetch()`es the media once and
  plays `URL.createObjectURL(blob)` (revoke it on unmount); any other media player (video, audio files) must do
  the same. Verified against this homeserver with `scripts`-style raw requests.
- **Upload filenames**: `client.uploadContent()` double-encodes `?filename=` in the browser (XHR branch:
  `encodeURIComponent` + `URLSearchParams`), so Synapse stored `Voice%20message.webm` / `my%20photo.png` in
  `Content-Disposition`. `uploadFile` and `sendVoiceMessage` now go through `uploadMedia(blob, { name, type })`
  (plain `fetch`, encoded once, `MatrixError` on failure, rate-limit retry). Do not call `uploadContent` directly.
- **Expected console 404 on every start** (also in the phone build and in the `mobile` Playwright project): the
  SDK probes `/_matrix/client/unstable/org.matrix.msc4143/rtc/transports` once per `startClient`; Synapse answers
  404 and Chromium logs "Failed to load resource: ... 404". QA's no-console-errors assertions must allow that
  one URL (`scripts/verify-phone-shell.mjs` shows how: record 404 responses and whitelist `msc4143`).

## Threads (matrix-js-sdk v43 + Synapse 1.162)

- **`threadSupport` changes every timeline.** `m.thread` replies are partitioned out of `room.getLiveTimeline()` into
  `room.getThread(rootId)` (a `Thread` with its own `EventTimelineSet`); reactions/edits/redactions follow their parent
  (a reaction to a reply lives in the thread set, a reaction to the root in the main set). `initialSyncLimit: 30` still
  counts the partitioned replies, so rooms with threads show fewer main rows before the first `paginateBack`.
- **Thread models appear lazily.** A root in the sync window with `unsigned.m.relations.m.thread` gets a `Thread`
  immediately (and an initial `/relations` fetch); a message nobody replied to has none until `ensureThread` /
  `openThread` creates it (`room.createThread`). `room.getThreads()` only lists instantiated threads; `fetchRoomThreads`
  (`/v1/rooms/{id}/threads`) instantiates the newest 30 by activity.
- **The initial thread fetch is tiny.** The SDK's first `/relations` request has no `limit`, Synapse defaults to **5
  relation events** (reactions and edits included) -> `ensureThreadTimeline` tops up to >= 20 visible replies. Until the
  fetch runs `thread.liveTimeline` is replaced (`resetLiveTimeline`), so never cache it; the store recomputes
  `canPaginateBackThread` on every refresh. The root is prepended to the thread timeline when the start is reached
  (`useTimeline` filters it out of `events`, it is still in `allEvents`).
- **Thread local echo is not the SDK's job in v43.** `Room.addPendingEvent` (chronological ordering) only offers pending
  events to the room's timeline sets, and the main set refuses thread replies (`canContain`), so a `~` reply would be
  invisible until the server echo. The bridge adds it to the thread on `LocalEchoUpdated`; `handleRemoteEcho` merges the
  `$` id (verified: one row, no duplicate). Do **not** switch to `pendingEventOrdering: Detached` (Phase 1 local echo
  rows would vanish from `getLiveTimeline()`).
- **Events.** The client re-emits `RoomEvent.Timeline` / `TimelineReset` from thread timeline sets
  (`data.timeline.getTimelineSet().thread` / the second argument's `.thread`), but **not** `ThreadEvent.*` - the bridge
  subscribes to `ThreadEvent.New/Update/Delete` on every `Room` (bind time + `ClientEvent.Room`). Sync adds replies
  with `emit=false` and one `ThreadEvent.Update`, so `NewReply` is not a reliable "new reply" signal.
- **Redacting a thread reply moves it into the main timeline** (`makeRedacted` -> `moveAllRelatedToMainTimeline`, thread
  markers stripped). `RoomEvent.Redaction` still carries the thread id, so the bridge records the id and the main snapshots
  skip it (`isRedactedThreadReply(roomId, id)`); session-only - replies redacted before this session loaded show as
  "Message deleted" in the channel after a reload.
- **`m.in_reply_to` on thread replies is a fallback**, not a quote (`is_falling_back: true`). `getReplyTargetId` /
  `getDisplayBody().replyTo` ignore it; render replies flat. The SDK's own `sendMessage(roomId, threadId, ...)` omits
  `m.in_reply_to` when it has no `Thread` yet, which is why `sendText` builds the relation itself after `ensureThread`.
- **Receipts and unread.** Every `m.read` now carries `thread_id` (`'main'` or the root). `room.getUnreadNotificationCount()`
  **sums thread counts** in v43 and a `main` receipt never clears those -> `unreadByRoom` uses
  `getRoomUnreadNotificationCount()`; threads use `getThreadUnreadNotificationCount(root)` / `hasThreadUnreadNotification()`
  (`unread_thread_notifications` in /sync, requested by the SDK's filter because Synapse advertises v1.4). An
  **unthreaded** receipt (no `thread_id`, e.g. the seed's) clears everything.
- **`current_user_participated` includes the root author** (spec), so alice "participated" in a thread under her own
  message with no reply of hers.
- **`/relations` order is newest first**; the SDK inserts by timestamp. A reply arriving while the initial fetch is in
  flight is replayed afterwards (`replayEvents`).
- **No thread-scoped typing** exists in Matrix/Synapse; `useTyping({ roomId, threadRootId })` is the room list.

## Encryption (matrix-js-sdk v43 + Rust crypto)

- **Plaintext if the room is unknown**: `sendMessage` only encrypts when the client's `Room` has the `m.room.encryption` state. A room created a moment ago (before `/sync` delivered it) or whose state is still lazy-loading sends **plaintext**. `createChannel` / `createDm` wait for the room; `prepareToEncrypt(roomId)` is a no-op until then; `sendRoomMessage` throws `EncryptionNotReadyError` when the room is encrypted and crypto is off.
- **Wipe can lag**: right after `setupRecovery` (backup upload in flight) the crypto IndexedDB can outlive the logout by 10-20 s (measured 17 s) until the engine's connection closes, and is deleted at the next boot at the latest; QA polls `indexedDB.databases()` for up to 30 s instead of reading it once (AC-E1-4).
- **`verified` can lag a tick after unlock / SAS**: the store refreshes right after the action and again on `UserTrustStatusChanged` / `KeysChanged`; assert with a poll, not a single read (seen once: `hint: 'verify'` for a moment after `unlockWithRecoveryKey` resolved true).
- **Status is late**: `useSecurityStore.status` is `null` until the first `/sync` and `/keys/query` finish; `current-user[data-verified]` is `"unknown"` meanwhile.
- **First upload needs no UIA**: Synapse (spec v1.11) lets the first `bootstrapCrossSigning` upload go without auth; only a *reset* (`setupRecovery({ reset: true })`) triggers `prompt.kind: 'password'` / `'sso'`.
- **Backup upload is lazy**: the SDK starts uploading keys up to 10 s after the backup is enabled (random start delay) and `backup.enabled` says nothing about progress; a logout before `backupRemaining` reaches 0 leaves those keys out of the backup for good. Verified: unlocking a new device right after a hasty logout restored `{ total: 0 }`.
- **New device = new keys**: a device cannot read messages sent before it existed unless it restores the backup (`unlockWithRecoveryKey`) or imports keys; the first device of an account must `setupRecovery()` or nothing is ever backed up. Verifying a device via SAS cross-signs it but does **not** hand it the backup key unless the verifying side has it cached (`KeyBackupDecryptionKeyCached` -> `restoreFromBackup()` runs by itself).
- **`m.bad.encrypted`**: a failed event's `getContent()` is `{ msgtype: 'm.bad.encrypted', body: '** Unable to decrypt ... **' }`; branch on `event.isDecryptionFailure()` / `getDecryptionState`, never on the body text. `event.getType()` becomes `m.room.message` once decrypted; relations stay on `getWireContent()`.
- **Node logger**: `createClient({ logger })` silences the client, not the Rust engine's own `WARN` lines or MatrixRTC; the scripts accept that.
- **Secure context**: `crypto.subtle` is missing on plain-http LAN origins (`http://192.168.x.x:5173`); encrypted attachments then reject with "Encrypted attachments need a secure context" (text still works). The APK (`http://localhost`) and `localhost` dev servers are fine.
- **Two secret-storage keys** (production hang, 2026-10-18): an account whose 4S was re-created by another client can keep `m.megolm_backup.v1` encrypted under an older, non-default key while the cross-signing keys sit under the default one. Unlock then verifies the device and *afterwards* the SDK asks `getSecretStorageKey` for the other key id. The callback matches cached keys by value too (one recovery key under two ids). Since "One ask only" it does not prompt during the unlock: the restore fails with `SecretStorageKeyMissError` and the dialog shows E2 (verified, older messages can't be unlocked yet: import a key file / another device / "I have a different recovery key", the only prompting path; the recovery dialog renders that prompt while busy, or the SDK would wait forever). No reset is reachable from the unlock dialog (design rule 2; "Start over" moves to Settings in a follow-up).
- **Backup locked for good** (prod 704.chat, 2026-10-18): when `m.megolm_backup.v1` sits under a 4S key the user no longer has, and the verifying device (Element) does not hold the backup key itself, nothing gossips it: the Rust engine already sends `m.secret.request` for missing secrets when a self-verification completes (`IdentitiesBeingVerified::request_missing_secrets`; `OlmMachine.requestMissingSecretsIfNeeded()` exists in the wasm but js-sdk 43 neither calls nor exposes it), a received key is only kept if it matches the *current* backup version, and then `KeyBackupDecryptionKeyCached` -> our auto-restore. The way in is then an Element key export: `importRoomKeysFromFile(text, passphrase)` (`key-export.ts`: armoured `MEGOLM SESSION DATA`, 0x01 | salt 16 | IV 16 | rounds u32 BE | AES-256-CTR (64-bit counter) | HMAC-SHA-256 32; PBKDF2-SHA-512 -> 32 B AES key + 32 B HMAC key) -> `importRoomKeysAsJson`; the recovery dialog's `import` phase.

## Read receipts (matrix-js-sdk v43)

- `Room.getEventReadUpTo(userId)` only knows main-timeline receipts (`thread_id: 'main'` or none); threaded ones are
  routed to the `Thread` at `Room.addReceipt` time (or cached in `cachedThreadReadReceipts` until the Thread exists). Ask the
  right holder, never the room for a thread row.
- `Room.hasUserReadEvent` logs a warning and returns false for an event id it cannot find; guard with `findEventById`.
- `getEventReadUpTo` returns null when the receipt's event is not loaded (`receiptPointsAtConsistentEvent`), so a user who
  read something older than the first paginated row simply has no avatar until that row is loaded.
- `getReadReceiptForUserId(userId)` defaults to `m.read` and prefers the synthetic receipt; the ts of a synthetic one is the
  event's `origin_server_ts` (`synthesizeReceipt`). Others' `m.read.private` never reach this client.
- The SDK synthesises `m.read` for every live event's sender (`Room.addLiveEvent` and `Thread.onTimelineEvent`, the latter
  for **every** sender, with the thread id), so a user's read point is at least their own last message.
- Local-echo receipt: `sendReceipt` adds my synthetic receipt immediately (either type); the real one echoes in the next
  `/sync` and replaces it. `receiptVersion` bumps for both.
- `client.setAccountData` waits for the `/sync` echo (v43) and `getAccountData` keeps the OLD content until then, so a
  receipt sent in that window would go out with the old type. `setSendReadReceipts` covers it with the optimistic override
  (`withPendingSendReadReceipts`); never read `readSendReadReceipts(getAccountData(...))` directly on the send path.
  `im.vector.web.settings` is not in the SDK's typed account-data map (`as never` casts).
- Element's **room-level** "Send read receipts" override (`im.vector.web.settings` per-room / `RoomSettings`) is **not
  honoured**: Codec reads only the account-level key. Out of scope (brief: no per-room receipt setting).
- `Thread.getReadReceiptForUserId` can be null (or stale) while `Thread.getEventReadUpTo` still returns a read point taken
  from the room's unthreaded receipt (`getLastUnthreadedReceiptFor`): take the max of the two ts, or the thread reader
  shows "0" / an old time. And an unthreaded receipt can point at a thread reply, which is not in `room.timeline`: resolve
  it to the reply's `threadRootId` before the row mapping, or the reader vanishes from the main list.
- `Reader` identity cache: `getSeenBy` builds "not seen" entries with ts 0 and `buildReadPoints` entries with the receipt
  ts for the same user; a single-slot per-user cache thrashes while a list is open (every rebuild new objects, memoised
  rows re-render). `ReaderCache` keeps two slots per user and `getSeenBy` does not cache its "not seen" entries at all.
- `sendReadReceipt(ev, ReceiptType.ReadPrivate)` throws for a pending event (`hasPendingEvent`); `actions.sendReadReceipt`
  still skips `~` ids first.
- `select-e2e`: `src/lib/matrix/receipts*.ts` is its own area (`receipts-core`) that runs the receipt specs **plus** CORE;
  without it a change there would walk up through `actions.ts`, hit more than half the suite and collapse to CORE only.

## Voice calls

- `matrix-js-sdk/lib/matrixrtc/index.js` is the import path for the MatrixRTC types (not re-exported from the main
  entry in 43). `client.matrixRTC` is created in the constructor and started by `startClient`.
- `joinRTCSession` wants the own membership identity `{ userId, deviceId, memberId: 'user:device' }`; passing the
  `rtcBackendIdentity` string form anywhere else breaks the key mapping.
- The LiveKit E2EE worker is `import E2EEWorker from 'livekit-client/e2ee-worker?worker'` (Vite bundles it, works from
  the APK's `http://localhost` origin); `isE2EESupported()` is false on browsers without insertable streams, and
  `canCall` reports `media-unsupported` there rather than falling back to plaintext media.
- A `MembershipsChanged` for the own membership is the trigger for the ring, never `JoinStateChanged` (the event id
  of the membership is only known once the state event echoes).
- `getJoinedMemberCount() <= 2` is the "DM" rule for decline / remote-hangup ending our call; a room call stays open.
- Unit tests under `src/**` must not import `session.ts` (the `?worker` import is not loadable in Node); constants
  live in `constants.ts` for that reason.

## GIFs

- Dev B: branch on `body.gif` **before** the plain-text branch, or `linkify` renders "Tacos dance http://...". Hide
  `message-action-edit` on GIF rows (edits are out of scope); reactions/replies/threads/delete need nothing special.
- Dev A: tiles may be `video/mp4` (`<video muted autoPlay loop playsInline>`); pass `signal` and debounce >= 300 ms (a
  Testing key is 100 requests/hour and every keystroke would be one); `'aborted'` errors are not errors.
- The mock `fullUrl` carries the **page origin** (`http://localhost:5173` in dev, the LAN IP on a phone, `http://localhost`
  in the APK): a mock GIF sent from one origin does not load on another. Klipy URLs are global. Fine for a POC.
- `getGifProvider()` is memoised per (provider, key, base) and reads localStorage each call: QA sets the keys before
  `page.goto`, or calls `setGifProvider()` / `setGifApiKey()` (both clear the memo); no reload needed.
- Node scripts import `src/lib/gif/*.ts` directly (type stripping): keep those modules free of `@/` aliases, enums and
  top-level `import.meta.env` reads (`provider.ts` reads it defensively).
- Klipy `hd.gif` is ~4 MB; a timeline full of them is heavy. Dev B unmounts offscreen rows; `GIF_SEND_VARIANT = 'md'` halves it.

### Synapse makes static thumbnails of GIF files

Synapse 1.162 (`docs/advisor/gif-thumb-probe.mjs`, 1313-frame GIF): `/_matrix/media/v3/download` returns the bytes unchanged
(`image/gif`); `/thumbnail?width&height&method` returns a **static PNG** (first frame) by default; `/thumbnail?...&animated=true`
(spec v1.11) returns an animated `image/webp`. No config knob; `m.upload.size` is 50 MB. `ImageAttachment` renders `m.image`
thumbnails, so a GIF file attached with the paperclip renders static; picked GIFs are unaffected (no mxc). Later fix if wanted:
`mxcToHttp(..., { animated: true })` or the full download URL when `info.mimetype === 'image/gif'`.

## Link previews: the test homeserver

- `homeserver/homeserver.yaml` and the `scripts/hs.mjs` overrides carry `url_preview_ip_range_whitelist: ['127.0.0.1/32', '::1/128']`
  so the test Synapse can fetch pages from a local Vite. The pool renders the committed yaml, so every pool instance has it
  (the snapshot hash changes: the first `hs-pool up` after this rebuilds, ~15 s). Other private ranges stay blocked
  (verified: `http://10.0.0.1/` -> `M_UNKNOWN "IP address blocked"`). The production homelab keeps its blacklist.
- Fixtures: `public/preview-fixtures/` — `article.html` (site name, title, description, 1200x630 `hero.png` -> `large`),
  `square.html` (128x128 `thumb.png` -> `thumbnail`), `title-only.html` (no og tags; Synapse synthesises title + description
  from the body), `empty.html` (`{"og:title": null, "og:description": null}` -> `null`), `long.html` (clamping), `noimage.html` (site name + title +
  description, no image), `nodims.html` (og:image without declared width/height; note Synapse measures the image anyway and
  returns 1200x630, so an "unknown dimensions" preview can only be produced by stubbing `**/preview_url**` with `page.route`). og:image is
  root-relative; Synapse rebases it against the page URL, so any Vite port works. PNGs: `npm run preview:fixtures`
  (`scripts/make-preview-fixtures.mjs`, deterministic).
- Verified round trip (Synapse 1.163 on 8030, Vite 5183): `GET /_matrix/client/v1/media/preview_url?url=http://localhost:5183/preview-fixtures/article.html`
  -> `og:title`, `og:description`, `og:image: mxc://localhost/...`, `og:image:width 1200`, `og:image:height 630`,
  `matrix:image:size 26127`; the mxc downloads (`/_matrix/media/v3/download`, 200 image/png) and thumbnails.
- `scripts/hs-pool.mjs`: the template build port moved 8030 -> 8040 (`HS_POOL_BUILD_PORT`) so a long-running dev
  homeserver on 8030 (`HS_POOL_BASE_PORT=8030 E2E_WORKERS=1 node scripts/hs-pool.mjs up`; seed files land in
  `homeserver/data/pool/base-8030/seed/`, `seed/` untouched) never collides with a snapshot rebuild.
- Dev use: `VITE_HS_URL=http://localhost:8030 npx vite --port 518x` (or the login screen's Advanced field), alice / password123.

## Machine notes

Facts about the development machines these docs were written on, not about the product.

- **JC's Windows PC**: Java 8 is first on PATH. Anything that runs Gradle outside the scripts needs `JAVA_HOME` = JDK 21 or
  the `org.gradle.java.home` line the scripts write to `~/.gradle/gradle.properties`.
- **Cloud dev containers**: the repo's Playwright 1.63 wants Chromium 1243; the box has 1194 under `/opt/pw-browsers`
  (`chromium.launch({ executablePath })`).
