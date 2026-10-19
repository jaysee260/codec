# Phase 5 Tickets

Priorities: **P0** = the desktop demo script in docs/archive/PHASE5_PLAN.md breaks without it. P1 = demo noticeably better. P2 = polish. Work top-down inside your column. Estimates are focused hours. Numbering continues from Phase 4 (Principal resumes at 17, Dev A at 24, Dev B at 27, QA at 24). Waves 13-15.

## Ownership map (hard rule, as docs/archive/PHASE4_TICKETS.md)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Principal | `src/lib/**` (new `src/lib/matrix/attachments.ts`), `src/store/**` (new `src/store/security.ts`), `src/app/**`, `public/**`, `scripts/**`, `seed/**`, `package.json`, `vite.config.ts`, `docs/ARCHITECTURE.md`, `docs/MOBILE.md` | - |
| Dev A | `src/features/navigation/**`, `src/features/security/**` (new; exports from its `index.ts`) | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:*` script lines in `package.json` | anything else |

Shared-layer needs go in your report as **Request to Principal: file, function, shape, why**. Devs build against the table below from day 1; names are **subject to the Principal's ARCHITECTURE deltas** (docs/ARCHITECTURE.md "Phase 5 deltas" wins); wire shapes and behaviour in docs/archive/PHASE5_ACCEPTANCE.md are not. Rules this phase: never `initRustCrypto` outside `client.ts`; never read `event.getContent()` of an `m.room.encrypted` event for display (use `getDisplayBody` / `getDecryptionState`); never build a media URL from `file.url` (use the media helpers); two browser contexts max; never `seed:reset`.

## Shared API (Principal exposes; devs consume only)
Realigned 2026-10-17 to the Principal's in-progress core (`src/lib/matrix/crypto.ts`, `security.ts`, `attachments.ts`, `src/store/security.ts`; the code and docs/ARCHITECTURE.md "Phase 5 deltas" win on names). Behaviour and wire shapes are docs/archive/PHASE5_ACCEPTANCE.md's.

| Module | Export | Shape / rule |
|---|---|---|
| `src/lib/matrix/client.ts` | `startClientFromSession(session, { onSyncState?, onCryptoLoading? })` | `createClient({ ..., cryptoCallbacks, verificationMethods: VERIFICATION_METHODS })` -> `initCrypto` (`initRustCrypto` with `cryptoDatabasePrefix(session)` = per user + device) -> `startClient`. A crypto failure does not block login: `getCryptoError()` says why and the app runs unencrypted. `logout()` and the token-rejected path: `stopClient()` -> `wipeCryptoStore()` (never while running). `getCurrentSession()`. |
| `src/lib/matrix/crypto.ts` | `cryptoDatabasePrefix`, `VERIFICATION_METHODS` (`['m.sas.v1']`), `initCrypto`, `wipeCryptoStore`, `getCryptoError`, `cryptoCallbacks`, `setSecretStorageKeyPrompt`, `cacheSecretStorageKey`, `hasCachedSecretStorageKey`, `clearSecretStorageKeyCache`, `resolveRecoveryInput` | Engine boot and the secret-storage key cache (session only). Features never import this module; the store wraps it. |
| `src/lib/matrix/security.ts` | `getCryptoApi()`, `isCryptoReady()`, `getOwnDeviceStatus(): Promise<OwnDeviceStatus>`, `getKeyBackupSummary()`, `getEventEncryptionInfo(event)`, `requestOwnUserVerification()`, `requestDeviceVerification(userId, deviceId)`, `onVerificationRequestReceived(listener)`, `startSas(request)`, `makeUiaCallback({ passwordPrompt?, ... })`, `checkRecoveryKey(input)`, `unlockWithRecoveryKey(input, { uia?, onProgress? })`, `restoreFromBackup(onProgress?)`, `setupRecovery(opts)` | `OwnDeviceStatus { deviceId, verified, hasCrossSigningKeys, crossSigningReady, secretStorageReady, defaultKeyId, backup: KeyBackupSummary { version, trusted, keyCached, enabled } }`. QA asserts on these through the dev hook; features use the store actions. |
| `src/store/security.ts` | `useSecurityStore` | `{ cryptoReady, cryptoError, status: OwnDeviceStatus \| null, hint: SecurityHint ('setup' \| 'verify' \| 'unlock' \| null), verification: VerificationFlow \| null, recovery: RecoveryState, prompt: PendingPrompt \| null, newRecoveryKey: string \| null, version }`. `securityHint(status)` is the one shared rule (`setup` = no cross-signing keys and no secret storage; `verify` = device unverified; `unlock` = verified but the backup key is not cached; null otherwise). `useSecurityHint()` hook. Refreshed on the `CryptoEvent.*` changes by `bindSecurity(client)` (called from the session store). |
| | `VerificationFlow` | `{ stage: 'requested' \| 'ready' \| 'started' \| 'sas' \| 'done' \| 'cancelled', initiatedByMe, isSelf, otherUserId, sas: { emoji: [symbol, name][] (7) } \| null, error }`. One flow at a time. |
| | `RecoveryState`, `PendingPrompt` | `recovery { busy: 'unlock' \| 'restore' \| 'setup' \| null, progress: { imported, total } \| null, lastRestore, error }`. `prompt { kind: 'password' \| 'recovery-key', message }` is the SDK asking (UIA password for cross-signing bootstrap; the secret-storage key when a flow needs it): Dev A's dialogs render it and answer with `answerPrompt(value \| null)`. |
| | actions | `refresh()`, `startSelfVerification()` (outgoing, `requested` -> `ready` -> `started` -> `sas`), `acceptVerification()` (incoming), `cancelVerification()`, `confirmSas()`, `mismatchSas()`, `dismissVerification()`, `unlockWithRecoveryKey(input): Promise<boolean>` (key or passphrase; false + `recovery.error` on a wrong key; verifies the device and restores the backup with `recovery.progress`), `restoreFromBackup()`, `setupRecovery({ passphrase?, reset? }): Promise<string \| null>` (refuses unless `hint === 'setup'` or `reset`; cross-signing first, then secret storage + backup; the key lands in `newRecoveryKey` until `dismissRecoveryKey()`), `answerPrompt(value)`. On SSO-only servers the UIA opens the `m.login.sso` fallback page (`prompt.kind` to be added by the Principal after the 704.chat spike). |
| `src/lib/matrix/utils.ts` | `getDecryptionState(event): DecryptionState`, `describeDecryptionFailure(code)`, `isRoomEncrypted(roomId)`, `MEGOLM_ALGORITHM` | `DecryptionState { status: 'none' \| 'decrypting' \| 'decrypted' \| 'failed', code?: DecryptionFailureCode, message?: string, historical?: boolean }` (`historical` = a recovery key / backup is the fix). Dev B derives `data-reason` from `code`: `HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED` -> `locked-backup`, `HISTORICAL_MESSAGE_NO_KEY_BACKUP` -> `no-backup`, `HISTORICAL_MESSAGE_WORKING_BACKUP` -> `restoring`, `MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE` / `UNSIGNED_SENDER_DEVICE` / `UNKNOWN_SENDER_DEVICE` / `SENDER_IDENTITY_PREVIOUSLY_VERIFIED` -> `unverified`, `HISTORICAL_MESSAGE_USER_NOT_JOINED` -> `not-joined`, else `unknown`; row copy = `message`. `isDisplayableEvent` **keeps** `m.room.encrypted` rows; `getDisplayBody` gains `decryption` and `file?: EncryptedFile` (no `url` then); `VoiceMessageInfo` gains `file?`; `previewText` -> `Unable to decrypt` for `failed`. |
| `src/lib/matrix/attachments.ts` | `EncryptedFile`, `EncryptedFileInfo`, `encryptAttachment(plaintext: ArrayBuffer): Promise<{ data: ArrayBuffer; info: EncryptedFileInfo }>`, `decryptAttachment(ciphertext, file)`, `isEncryptedFile(v)`, `fetchDecryptedMedia(file, mimetype?): Promise<string>` (cached `blob:` URL), `fetchDecryptedBlob(file, mimetype?)`, `releaseDecryptedMedia(file)` | WebCrypto AES-256-CTR + SHA-256 (hash verified before returning), v2 JWK shape per the acceptance doc; pure and Node-loadable for `verify:e2ee`. Dev B calls `fetchDecryptedMedia` only for rows in view and `releaseDecryptedMedia` on unmount. |
| `src/lib/matrix/media.ts` | `openMedia(e, urlOrFile, name?)`, `downloadMedia(e, urlOrFile, name?)` | Accept an `EncryptedFile` as well as a URL: the encrypted branch decrypts first and never navigates to the raw mxc. |
| `src/lib/matrix/actions.ts` | `sendFile`, `sendVoiceMessage`, `prepareToEncrypt(roomId)`, `createChannel`, `createDm` | In encrypted rooms: `encryptAttachment` -> `uploadMedia(data, { type: 'application/octet-stream' })` -> content with `file` (voice: top level + `org.matrix.msc1767.file`), no thumbnails. `prepareToEncrypt` is a no-op in plain rooms. `createChannel` / `createDm` add `m.room.encryption` (`MEGOLM_ALGORITHM`); `createSpace` unchanged. |
| `src/store/rooms.ts`, `src/store/bridge.ts` | `RoomSummary.encrypted`, late decryption | `encrypted` from `hasEncryptionStateEvent()`, `version` bumps when the state arrives; the bridge subscribes to `MatrixEventEvent.Decrypted` and refreshes the room and thread snapshots (include `version` in row memo deps). |
| `src/app/Shell.tsx`, `UserFooter.tsx`, `LoadingScreen.tsx`, `devtools.ts` | mounts, `current-user[data-verified]`, `app-loading[data-stage]`, `window.__matrixPoc.security` | Shell mounts `<SecurityBanner />` in `security-banner-host` above `channel-header` (both layouts) and `<SecurityDialogs />` once per page; `UserFooter` reads `status.verified`; dev hook `{ store: useSecurityStore, getCryptoApi, getOwnDeviceStatus, cryptoDatabasePrefix, importRoomKeys(json), exportRoomKeys() }` (name subject to the deltas; the acceptance doc says `__matrixPoc.crypto`, either is fine for QA as long as ARCHITECTURE names it). |
| `@/features/security` (Dev A) | `SecurityBanner`, `SecurityDialogs`, `openSecurityDialog(kind: 'setup' \| 'verify' \| 'unlock')`, `useSecurityUiStore` | The banner renders from `useSecurityHint()`; `SecurityDialogs` hosts `verify-dialog`, `recovery-dialog`, `setup-dialog`, opens the incoming dialog when `verification && !verification.initiatedByMe`, and renders `prompt` (password / recovery key) inline in whichever dialog is open. Dev B calls `openSecurityDialog` from placeholder actions. |
| `seed/seed.ts`, `scripts/` | `#vault`, `npm run e2ee:sample`, `npm run verify:e2ee` | `rooms.vault` in `seed-output.json`; `scripts/send-encrypted-sample.mjs` (`--as bob --room '#vault:localhost' --count 3 [--no-image] [--keys seed/e2ee-keys.json]`, prints `{ roomId, eventIds }`); `scripts/verify-e2ee.mjs`. |

---

## Principal

| ID | P | Title | Est |
|---|---|---|---|
| PRIN-17 | P0 | Crypto boot, key store, wipe, `useSecurityStore` skeleton, loading stage, dev hook | 6h |
| PRIN-18 | P0 | Timeline decryption: bridge, `getDecryptionState`, display helpers, `prepareToEncrypt`, `isRoomEncrypted` | 5h |
| PRIN-19 | P0 | Encrypted attachments: `attachments.ts`, media helpers, `useMediaObjectUrl`, encrypted `sendFile` / `sendVoiceMessage` | 5h |
| PRIN-20 | P0 | Verification + cross-signing core (SAS both directions, bootstrap with UIA; SSO spike on 704.chat) | 6h |
| PRIN-21 | P0 | Recovery + backup core (unlock with key or passphrase, restore, setup with the SSSS guard, backup state) | 5h |
| PRIN-22 | P0 | Encrypted by default, `#vault` seed, `e2ee:sample`, `verify:e2ee` | 4h |
| PRIN-23 | P1 | Shell mounts, `UserFooter` verified state, ARCHITECTURE "Phase 5 deltas", MOBILE note, Vite build check | 2h |

**PRIN-17 Boot** - `client.ts`: `cryptoCallbacks` (`getSecretStorageKey` resolves from the store's cached key or asks the store to open `unlock`; `cacheSecretStorageKey` caches for the session), `verificationMethods`, `initRustCrypto` with the per-device prefix (Advisor risk 1), `clearStores` on logout and on the token-rejected `fail()` path (stop first). `vite.config.ts`: `optimizeDeps.exclude: ['@matrix-org/matrix-sdk-crypto-wasm']` and confirm the `.wasm` asset is emitted once. `src/store/security.ts` with the state table, `hint` rule, event subscriptions, `refresh()`; `LoadingScreen` `data-stage`; `window.__matrixPoc.security` incl. `importRoomKeys` / `exportRoomKeys` (`importRoomKeysAsJson` / `exportRoomKeysAsJson`). Verify with a probe: login, `indexedDB.databases()`, reload keeps the device, logout wipes. AC: AC-E1-1..5.

**PRIN-18 Timeline** - `utils.ts`: `getDecryptionState`, the `m.room.encrypted` branch in `isDisplayableEvent` / `getDisplayBody` / `previewText` (branch on `event.isDecryptionFailure()` and the `m.bad.encrypted` msgtype, Advisor risk 2); relation readers stay on `getWireContent()` so threads and replies work pre-decryption; `isRoomEncrypted`, `RoomSummary.encrypted`; `bridge.ts`: `MatrixEventEvent.Decrypted` -> schedule room + thread; `actions.ts`: `prepareToEncrypt`, `EncryptionNotReadyError`. Verify: bob (second context or the sample script) sends into `#vault`, alice's store shows the clear body; a locked history shows the right reasons. AC: AC-E2-1/2/4/5/6 (core half), AC-E6-3/6 (core half).

**PRIN-19 Attachments** - `attachments.ts` (AES-256-CTR via `crypto.subtle`, IV = 8 random bytes + 8 zero bytes, JWK `k` base64url unpadded, `hashes.sha256` base64 of the ciphertext; decrypt verifies the hash first), `media.ts` `MediaSource` + `fetchMediaBlob` + encrypted branches in `openMedia` / `downloadMedia` (never navigate to an encrypted mxc), `useMediaObjectUrl` in `hooks.ts`, `mediaSourceOf`; `sendFile` / `sendVoiceMessage` branches (upload as octet-stream, `file` shape, no thumbnails). Verify with `verify:e2ee`'s round trip plus a browser probe against `#vault`. AC: AC-E3-1/3/4 (core half), AC-E3-5.

**PRIN-20 Verification** - store actions over `requestOwnUserVerification` / `CryptoEvent.VerificationRequestReceived` / `VerificationRequestEvent.Change` / `startVerification('m.sas.v1')` / `VerifierEvent.ShowSas` (`sas.emoji` -> `{ symbol, name }[]`), confirm / mismatch / cancel, `getDeviceVerificationStatus` refresh; `setUpEncryption`'s `bootstrapCrossSigning({ authUploadDeviceSigningKeys })`: password UIA locally (`m.login.password` with the identifier), `m.login.sso` UIA on SSO-only servers via the fallback page `/_matrix/client/v3/auth/m.login.sso/fallback/web?session=` in a popup + retry loop (Advisor risk 5). **Spike the SSO UIA by hand on 704.chat with a throwaway account before building the UI contract**, and record the result in ARCHITECTURE. AC: AC-E4-2..5 (core half), AC-E4-8 (spike).

**PRIN-21 Recovery** - `unlockWithRecovery`: parse (`decodeRecoveryKey`, or `deriveRecoveryKeyFromPassphrase` when the default key description has `passphrase`), check against the key description (`RecoveryKeyError('wrong')`), cache, `loadSessionBackupPrivateKeyFromSecretStorage`, `restoreKeyBackup` with progress into `backup.restored/total`, `bootstrapCrossSigning()` (loads private keys from SSSS -> device verified), `checkKeyBackupAndEnable`. `setUpEncryption`: refuse when `isSecretStorageReady()` or `getSecretStorageStatus().defaultKeyId` (Advisor consult 3), cross-signing first, then `createRecoveryKeyFromPassphrase()` -> `bootstrapSecretStorage({ createSecretStorageKey: async () => key, setupNewKeyBackup: true })`, return `key.encodedPrivateKey`. `checkKeyBackupAndEnable` at `ready` and the `backup.state` rule (`none` no backup on the server, `locked` backup exists and no private key cached, `ready` active). AC: AC-E5-1..7 (core half).

**PRIN-22 Defaults, seed, scripts** - `createChannel` / `createDm` `initial_state` encryption; `seed.ts` adds `#vault` (idempotent per alias as today; run `npm run seed` once, never `seed:reset`; if the permission classifier blocks it, ask the orchestrator); `scripts/send-encrypted-sample.mjs`: Node matrix-js-sdk client, `initRustCrypto({ useIndexedDB: false })`, `startClient` + wait for Prepared, assert `room.hasEncryptionStateEvent()`, send texts + one encrypted image through the same `attachments.ts` (type-stripped import like `scripts/lib/gif-api.mjs`), fetch each event back and assert `m.room.encrypted`, `exportRoomKeysAsJson` merged into `seed/e2ee-keys.json`, `logout(true)` (Advisor consult 2); `scripts/verify-e2ee.mjs`; `e2ee:sample`, `verify:e2ee` in `package.json`. AC: AC-E6-1 (core), AC-E7-1..4.

**PRIN-23 Shell + docs** - `security-banner-host` / `security-dialogs-host` mounts on both layouts, `UserFooter` `data-verified` + "Verified" line, docs/ARCHITECTURE.md "Phase 5 deltas" (names, boot order, wipe, UTD mapping, attachment scheme, the plaintext-if-room-unknown gotcha, the SSO UIA spike result), docs/MOBILE.md secure-context note, `npm run build` size check. AC: AC-E7-5.

---

## Dev A - Security UI (`src/features/security/**`) and navigation

| ID | P | Title | Est |
|---|---|---|---|
| DEV-A-24 | P0 | `SecurityBanner` + `SecurityDialogs` host + `openSecurityDialog` | 3h |
| DEV-A-25 | P0 | `VerificationDialog` (outgoing + incoming, emoji, match / mismatch / cancel) | 4h |
| DEV-A-26 | P0 | `RecoveryDialog` and `SetupEncryptionDialog` | 4h |
| DEV-A-27 | P0 | Lock in the header, `data-encrypted` on items, notes in the create dialogs | 1h |
| DEV-A-28 | P1 | Phone variants (bottom sheets, 44 px, banner on phone) | 2h |
| DEV-A-29 | P2 | Sessions list (own devices with verified badges, sign out another session) | 2h |

**DEV-A-24 Banner + host** - `components/SecurityBanner.tsx` from `useSecurityStore.hint` (copy per `data-need` in the registry; `restoring` shows `recovery.progress`; dismiss is per page load, `useSecurityUiStore.dismissed`), `components/SecurityDialogs.tsx` (singleton host; opens on `openSecurityDialog(kind)` and automatically when `verification && !verification.initiatedByMe`), `index.ts` exports. Reuse `Dialog.tsx` from navigation (`dialog-close` stays). A `__dev__` harness with a stubbed store state is fine. AC: AC-E4-1, AC-E2-3 (open half), AC-E5-1.

**DEV-A-25 Verification** - `components/VerificationDialog.tsx` driven by `verification.stage` (+ `initiatedByMe`, `sas`): `choose` (`verify-use-device`, `verify-use-recovery` -> switch to the recovery dialog), `requested` (`verify-waiting`, spinner), `incoming` (`verify-accept` / `verify-decline`, show `otherDeviceId`), `sas` (7 `verify-emoji-item` with the symbol and the name under it, `verify-match` / `verify-mismatch`), `confirming`, `done` (`verify-done`), `cancelled` / `error` with the reason. Escape = `cancelVerification()` in `requested` / `sas`, close otherwise. AC: AC-E4-3..5, AC-E4-7.

**DEV-A-26 Recovery + setup** - `components/RecoveryDialog.tsx`: one `recovery-input` (monospace, accepts spaces, paste), `recovery-submit`, `recovery-error` from `recovery.error`, `recovery-progress` from `recovery.progress` while `recovery.busy`, `recovery-done`. `components/SetupEncryptionDialog.tsx`: `intro` (what a recovery key is, one paragraph) -> `auth` (`setup-password` + `setup-password-submit` answering `prompt.kind === 'password'` via `answerPrompt`, or `setup-sso-hint` "Finish signing in in the window that opened" on SSO servers) -> `working` -> `key` (`setup-key` in groups of 4, `setup-copy` via `navigator.clipboard`, `setup-confirm` enabled after copy or after 3 s) -> `done`; `setup-error` for UIA failures (stay in `auth`) and when `setupRecovery` returns null because secret storage exists (switch to the recovery dialog); the key comes from `newRecoveryKey`, `setup-confirm` calls `dismissRecoveryKey()`. AC: AC-E5-2..4, AC-E4-2, AC-E5-5 (UI half).

**DEV-A-27 Navigation** - `ChannelHeader`: `channel-header-lock` (lucide `Lock`, 14 px, after the name, both layouts) from `RoomSummary.encrypted`; `ChannelList` / `DmList` items `data-encrypted`; `CreateChannelDialog` / `NewDmDialog` one-line note (`create-channel-encrypted-note`, `new-dm-encrypted-note`); `CreateSpaceDialog` untouched. AC: AC-E6-1 (UI half), AC-E6-2, AC-E6-6 (UI half).

**DEV-A-28 Phone** - sheet variants of the three dialogs (fixed bottom, safe-area, 16 px inputs, 44 px buttons, `registerBackHandler` while open), banner in the phone `main` above the header. No new AC; AC-V6-1 rules apply.

**DEV-A-29 Sessions** - `sessions-dialog` from the user pill: `getUserDeviceInfo([me])`, verified badge per device, "Sign out" for other devices (`deleteMultipleDevices` with UIA). Unscheduled before the demo.

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-B-27 | P0 | Undecryptable / decrypting rows with reasons and actions; late decryption re-render | 3h |
| DEV-B-28 | P0 | Encrypted images, files and voice notes in rows | 4h |
| DEV-B-29 | P0 | Composer in encrypted rooms: `prepareToEncrypt`, placeholder, send errors | 2h |
| DEV-B-30 | P0 | Edits, replies, reactions, threads, redactions verified in encrypted rooms | 3h |
| DEV-B-31 | P1 | GIF click-to-load in encrypted rooms | 1h |

**DEV-B-27 Placeholders** - `MessageBody`: when `body.decryption.status === 'failed'` render `components/UndecryptableBody.tsx` (`message-undecryptable[data-reason]` from `decryption.code` per the Shared API mapping, copy = `decryption.message`, `message-undecryptable-action` -> `openSecurityDialog('unlock' \| 'verify')` from `@/features/security`), `status === 'decrypting'` -> `message-decrypting`; redacted wins. Rows must re-render on late decryption: add `useRoomTimeline().version` to `MessageRow` memo deps; reply quotes, thread summary previews and the Threads list use `previewText` (already). AC: AC-E2-2/3/4/8, AC-E2-6 (UI half), AC-E2-7.

**DEV-B-28 Media** - `ImageAttachment`: `fetchDecryptedMedia(body.file, info.mimetype)` only once in view (Phase 4 `useInView` gate; `releaseDecryptedMedia` on unmount; plain rooms keep `mxcToHttp`), `data-encrypted`, `data-state`, placeholder sized by the AC-B4 `fitted()` rule from `info.w/h`, `message-image-error` + retry; click -> `openMedia(e, body.file ?? url, name)`. File card: `downloadMedia(e, body.file ?? url, name)`, never an `href` to the mxc when `file` is set. `VoiceMessage`: play from `fetchDecryptedBlob(voice.file, voice.mimetype)` when `voice.file` is set (the Phase 2 player already fetches a blob; add the source), `data-encrypted`; `voice-error` + download on hash failure. AC: AC-E3-2/3/4 (UI half), AC-E3-5 (UI half), AC-E3-6.

**DEV-B-29 Composer** - `composer[data-encrypted]` from `isRoomEncrypted(roomId)` (re-read on `useRoomStore.version`), placeholder `Message #name (encrypted)`, `prepareToEncrypt(roomId)` on input focus and on room open (both composers through `tid`), encrypt failures (and `getCryptoError()` being set) -> `useToastStore` "Could not encrypt the message, try again" and the text stays in the input. AC: AC-E6-3, AC-E6-6 (UI half), AC-E6-4 (no preview code: assert nothing new calls it).

**DEV-B-30 Relations** - Walk the five paths in `#vault` with a second context and fix whatever reads undecrypted content: edit banner / `editText` on an encrypted event, reply quote text, reaction pills on an encrypted target, thread summary + panel for an encrypted root, delete -> `message-redacted`. Expect mostly verification, with fixes where `getContent()` is read directly. AC: AC-E2-5 (UI half).

**DEV-B-31 GIF policy** - `GifMessage` in an encrypted room starts in `data-state="click-to-load"` with `message-gif-load` (title + "Load GIF") and no `<img>` until clicked; plain rooms unchanged; the picker and `sendGif` untouched. AC: AC-E6-5.

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est |
|---|---|---|---|
| QA-24 | P0 | `e2e/fixtures/e2ee.ts`: second context, setup / verify / unlock helpers, wire and media checks, config | 4h |
| QA-25 | P0 | `e2e/e2ee-core.spec.ts` (AC-E1, AC-E2, AC-E6) | 5h |
| QA-26 | P0 | `e2e/e2ee-media.spec.ts` (AC-E3) | 3h |
| QA-27 | P0 | `e2e/e2ee-security.spec.ts` (AC-E4, AC-E5, two contexts) | 5h |
| QA-28 | P0 | Smoke step 13 (demo walkthrough) + regression runs | 3h |
| QA-29 | P1 | docs/BUGS.md Phase 5 + the 704.chat manual checklist | 1h |

**QA-24 Fixtures** - `e2e/fixtures/e2ee.ts`: `secondContext(browser, user, opts?)` (new context + `loginAs`, returns `{ page, close }` that logs out and closes; at most one extra context per spec), `freshUser()` (register a throwaway via API, for AC-E4-1 `setup`), `setUpEncryption(page) -> recoveryKey` (drives `setup-dialog`, reads `setup-key`), `verifyBetween(verifiedPage, newPage)` (drives both dialogs, asserts identical emoji), `unlockWith(page, keyOrPassphrase)`, `expectDecryptedRow(page, text)`, `expectUtd(page, eventId, reason)`, `cryptoState(page)` (the dev hook's `store.getState()`), `importSampleKeys(page)` (`seed/e2ee-keys.json`), `dbNames(page)` (`indexedDB.databases()`). `e2e/fixtures/matrix-api.ts`: `expectEncryptedOnWire(roomId, eventId)` (type + algorithm + no `body`), `rawMediaBytes(mxc)` + `sha256b64(bytes)`, `setRoomEncryption(roomId)` (bob via API, AC-E6-6), `devicesOf(user)`. `playwright.config.ts`: the three specs in `desktop` only; `test:e2e:e2ee` script line. `seed.ts` fixture: `roomId('vault')`.

**QA-25 Core** - serial, one spec: AC-E1-1..5 (AC-E1-4 via `DELETE /devices` as alice through the API), AC-E2-1..8 (the UTD for AC-E2-2 from a context closed **before** alice-A logs in, so A's device never received the key; AC-E2-6 through `unlockWith`), AC-E6-1..6 (catch-all `page.route` for `**/preview_url**` fails the test; the GIF host guard from Phase 4 for AC-E6-5). Note in the header which criteria need the sample keys (`importSampleKeys`) versus a live second context.

**QA-26 Media** - AC-E3-1..6 with `test-image.png`, `test-file.txt`, the fake-mic voice flow from `voice.spec.ts`; ciphertext check = first 8 bytes not the PNG signature and `sha256b64(bytes) === file.hashes.sha256`; AC-E3-5 via a forged `m.room.encrypted`? No: forge at the **decrypted** level by sending from B's UI then patching is impossible, so send a plain-room-style `m.image` with `file` and a wrong hash into `#vault` via the API as bob (it will be plaintext on the wire, which is fine for this one criterion) and assert `message-image-error`.

**QA-27 Security** - two contexts: `freshUser` setup (AC-E4-1/2, AC-E5-5), alice-A setup then alice-B verify (AC-E4-3..7), unlock with key and with a wrong key (AC-E5-1..3), passphrase (AC-E5-4 via the dev hook `getCrypto().bootstrapSecretStorage` on a fresh user), backup growth with a third **sequential** context (AC-E5-6: close B before opening C), restoring banner (AC-E5-7, P1, 50 keys via the sample script `--count 50`). Clipboard: read `setup-key` text instead of the clipboard.

**QA-28 Demo + runs** - `smoke.spec.ts` step 13 = desktop demo 1-11 (`stepShot(page, 13, ...)`, second context for bob and later for alice-B, `logout` + fresh context for step 10), then full `desktop` and `mobile` runs at the end of Wave 14 (AC-E8-3), results in docs/STATUS.md.

**QA-29 Bug log** - docs/BUGS.md "Phase 5": spec commands, severity rule (S1: plaintext reaches the wire in an encrypted room, a raw encrypted mxc is navigated to, keys survive logout, or setup offers a new key on an account with SSSS), and the **manual 704.chat checklist** with a result column per tester (AC-E8-4).

## P0 set (the demo script works with exactly these)
PRIN-17..22 · DEV-A-24..27 · DEV-B-27..30 · QA-24..28. Total **79 h** (Principal 31 h, A 12 h, B 12 h, QA 20 h). The Principal is the critical path: PRIN-17 + PRIN-18 land first (day 1-2) so Dev B and QA see decrypted rows; PRIN-20/21 next so Dev A has real flows; Dev A builds the dialogs against the `VerificationFlow` / `hint` shapes with a stubbed store meanwhile; QA writes the fixtures and the wire checks against `#vault` and the sample script before the UI exists. The SSO UIA spike (PRIN-20) runs early because it may change the setup dialog contract. P1 (phone variants, GIF policy, scripts' extras, bug log, Shell docs): 9 h. P2: 2 h.
