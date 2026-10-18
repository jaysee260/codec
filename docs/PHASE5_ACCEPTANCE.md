# Phase 5 Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md and the Phase 2-4 acceptance docs (conventions, registries and criteria stay in force). Numbering `AC-E<group>-<n>`; each group names its tickets (docs/PHASE5_TICKETS.md). Every criterion carries a priority: **P0** = the desktop demo script in docs/PHASE5_PLAN.md breaks without it, P1 = noticeably better, P2 = polish. "desktop" = the `desktop` Playwright project, "phone" = `mobile`. **Two contexts**: "A" and "B" are two Playwright browser contexts in one spec (separate IndexedDB, so separate devices); "alice-A", "alice-B", "bob-B" say who is logged in where. A second login of the same user is always a **new device**. "`#vault`" = the seeded encrypted channel `#vault:localhost`. "on the wire" = the event fetched through the API (`getEvent`) as any member; it is `m.room.encrypted` and carries no plaintext. API names below follow docs/PHASE5_TICKETS.md "Shared API"; the Principal's docs/ARCHITECTURE.md "Phase 5 deltas" wins on names, never on wire shapes or behaviour.

## Wire shapes (the contract Principal, Dev B and QA code against)

**Encrypted event on the wire** (every send in an encrypted room): `type: "m.room.encrypted"`, `content: { algorithm: "m.megolm.v1.aes-sha2", sender_key, session_id, device_id, ciphertext }`, plus a cleartext `m.relates_to` when the message is a reply, thread reply, edit or reaction (the spec requires relations outside the ciphertext). No `body`, `msgtype`, `url` or `file` is visible on the wire. Decrypted, `event.getType()` / `getContent()` are the clear ones.

**Encrypted attachment** (`m.image`, `m.file`, `m.audio` in encrypted rooms; Element's `matrix-encrypt-attachment` v2):
```json
{
  "msgtype": "m.image",
  "body": "photo.png",
  "info": { "mimetype": "image/png", "size": 12345, "w": 640, "h": 480 },
  "file": {
    "url": "mxc://localhost/abc",
    "v": "v2",
    "key": { "alg": "A256CTR", "ext": true, "k": "<base64url, no padding>", "key_ops": ["encrypt", "decrypt"], "kty": "oct" },
    "iv": "<base64, 16 bytes, low 8 bytes zero>",
    "hashes": { "sha256": "<base64 of the ciphertext hash>" }
  }
}
```
Rules: no top-level `url`; no `info.thumbnail_url` / `thumbnail_file` (codec never sends thumbnails for encrypted media); the upload is `application/octet-stream` and the bytes stored on the media repo are the ciphertext (their first bytes are not the file's magic bytes). Voice notes keep the Phase 2 shape with `file` replacing `url` at the top level **and** inside `org.matrix.msc1767.file` (`{ file, name, mimetype, size }`). Reading tolerates both `url` (plain room) and `file` (encrypted), and Element's `thumbnail_file` when present.

**`m.room.encryption`** on rooms codec creates: `{ "algorithm": "m.megolm.v1.aes-sha2" }`, in `initial_state` of `createRoom` for channels and DMs; never for spaces.

## Test ID registry (additions)
### Shell and core (Principal, `src/app/**`, `src/store/**`)
| testid | Element |
|---|---|
| `app-loading` (+`data-stage="sync\|crypto"`) | Loading screen; `crypto` while `initRustCrypto` runs ("Setting up encryption") |
| `current-user` (+`data-verified="true\|false\|unknown"`) | User pill mirrors `useSecurityStore.status.verified`; shows "Verified" under the user id when true |
| `security-banner-host`, `security-dialogs-host` | Where the Shell mounts Dev A's `SecurityBanner` / `SecurityDialogs` (both layouts; the banner sits above `channel-header`) |
| `window.__matrixPoc.security` (or `.crypto`; ARCHITECTURE names it) | Dev hook: `{ store: useSecurityStore, getCryptoApi, getOwnDeviceStatus, cryptoDatabasePrefix, importRoomKeys(json), exportRoomKeys() }` |

### Security (Dev A, `src/features/security/**`)
| testid | Element |
|---|---|
| `security-banner` (+`data-need="setup\|verify\|unlock\|restoring"`) | One banner at a time: "Set up encryption for this account" / "Verify this session" / "Unlock your message history" / "Restoring keys..." |
| `security-banner-action`, `security-banner-dismiss` | Primary button (opens the matching dialog); dismiss hides the banner for this page load only (`restoring` has no dismiss) |
| `verify-dialog` (+`data-phase="choose\|requested\|incoming\|sas\|confirming\|done\|cancelled\|error"`, `data-direction="outgoing\|incoming"`) | Verification dialog root, `role="dialog"` |
| `verify-use-device`, `verify-use-recovery` | Phase `choose` (outgoing): start SAS with another device / open `recovery-dialog` instead |
| `verify-accept`, `verify-decline` | Phase `incoming`: the other device asked to verify us |
| `verify-waiting` | Phase `requested`: "Accept the request on your other device" |
| `verify-emoji`, `verify-emoji-item` (x7, text = emoji, `data-name` = the SAS name) | Phase `sas` |
| `verify-match`, `verify-mismatch`, `verify-cancel` | Phase `sas` / everywhere; mismatch cancels with `m.mismatched_sas` |
| `verify-done`, `verify-error`, `verify-close` | "Verified" state; error text; close |
| `recovery-dialog`, `recovery-input`, `recovery-submit`, `recovery-error`, `recovery-progress` (+`data-restored`, `data-total`), `recovery-done`, `recovery-close` | Unlock dialog: one input (key or passphrase), submit, error ("That key is not correct"), restore progress, done |
| `setup-dialog` (+`data-phase="intro\|auth\|working\|key\|done\|error"`), `setup-start`, `setup-password`, `setup-password-submit`, `setup-sso-hint`, `setup-key`, `setup-copy`, `setup-confirm`, `setup-error`, `setup-close` | New-account setup: intro -> UIA (`setup-password` locally; `setup-sso-hint` + popup on SSO servers) -> working -> key shown once (`setup-key` text is the base58 key) -> confirm |

### Navigation (Dev A, `src/features/navigation/**`)
| testid | Element |
|---|---|
| `channel-header-lock` | Lock icon after the room name, `title="End-to-end encrypted"`; absent in plain rooms |
| `channel-item-{roomId}` / `dm-item-{roomId}` (+`data-encrypted="true\|false"`) | Helper attribute on existing items |
| `create-channel-encrypted-note`, `new-dm-encrypted-note` | "This channel/DM will be end-to-end encrypted" line in the dialogs (no toggle) |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `message-undecryptable` (+`data-reason="locked-backup\|no-backup\|restoring\|unverified\|not-joined\|unknown"`) | Placeholder body for an `m.room.encrypted` event that failed to decrypt; replaces `message-body`; row ids, avatar, timestamp unchanged |
| `message-undecryptable-action` | "Unlock" (`locked-backup`) or "Verify" (`unverified`) link, calls `openSecurityDialog('unlock' \| 'verify')`; absent for the other reasons |
| `message-decrypting` | Body shown while `event.isBeingDecrypted()` (brief) |
| `message-image` (+`data-encrypted="true"`, `data-state="loading\|ready\|error"`) | Encrypted image: placeholder sized from `info.w/h` while loading, `<img src="blob:...">` when ready |
| `message-image-error` | "Could not decrypt image" with a retry |
| `message-file` (+`data-encrypted="true"`) | Download decrypts and saves (never a raw media link) |
| `voice-message` (+`data-encrypted="true"`) | Playback from the decrypted blob |
| `composer` (+`data-encrypted="true\|false"`) | Placeholder reads `Message #vault (encrypted)` when true; prefix rule applies (`thread-composer`) |
| `message-gif-load` | Click-to-load control replacing the GIF `<img>` in encrypted rooms (state `data-state="click-to-load"` on `message-gif`) |

## Criteria

### AC-E1 Crypto boot, persistence, wipe (PRIN-17)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E1-1 | P0 | Given alice logs in (password), then `app-loading[data-stage="crypto"]` is shown at some point, the shell appears within the AC-SH-2 budget, and the dev hook (`__matrixPoc.security`, name per ARCHITECTURE) reports `cryptoReady: true`, `cryptoError: null` and `status.deviceId` equal to the session's `deviceId`; `getCryptoApi().getOwnDeviceKeys()` resolves (keys uploaded). |
| AC-E1-2 | P0 | Given alice-A logged in, then `indexedDB.databases()` lists a database whose name starts with `matrix-poc-crypto:@alice:localhost:<deviceId>`; when the page reloads, then the session restores with the **same** `deviceId`, `status: 'ready'`, no new device appears in `GET /devices`, and any verification / backup state from before the reload is unchanged (used by AC-E4-6, AC-E5-6). |
| AC-E1-3 | P0 | When alice logs out (`logout-button`), then `login-form` shows and `indexedDB.databases()` lists **no** database with the `matrix-poc-crypto:` prefix; `matrix-poc.session` is gone (AC-SH-4). Logging in again is a new device (`deviceId` differs) and `security-banner` is back. |
| AC-E1-4 | P1 | Given the server rejects the token (QA: `DELETE /devices` for that device as alice via API, or `M_UNKNOWN_TOKEN` stub), then the same wipe as AC-E1-3 happens (`stopClient()` before `clearStores()`), the login form shows "Session expired". |
| AC-E1-5 | P1 | Given `npm run build`, then the wasm chunk is emitted once (`dist/assets/*.wasm`), `npx vite` dev serves it (no `optimizeDeps` error in the console), and the main JS chunk does not inline it. |

### AC-E2 Decrypting the timeline (PRIN-18, DEV-B-27, DEV-B-30)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E2-1 | P0 | Given alice-A and bob-B both in `#vault`, when bob sends "hi alice" from `composer-input`, then on the wire the event is `m.room.encrypted` with `algorithm: m.megolm.v1.aes-sha2` and no `body`; A shows a row with `message-body` "hi alice" within 5 s, `data-sender` bob; `getEncryptionInfoForEvent` is non-null. |
| AC-E2-2 | P0 | Given an `m.room.encrypted` event alice's device cannot decrypt (QA: send from a context that was **closed** before A logged in, i.e. keys never shared with A's device; or the `#vault` sample history without the key import), then the row renders `message-undecryptable` with `data-reason` from the table (`no-backup` when the account has no key backup, `locked-backup` when a backup exists but is locked, `unknown` otherwise), the avatar / author / timestamp as usual, and `message-body` absent; `previewText` of that event is `Unable to decrypt` (reply quotes, thread list, DM previews). |
| AC-E2-3 | P0 | Given a `locked-backup` placeholder, then `message-undecryptable-action` reads `Unlock` and opens `recovery-dialog`; given `unverified`, it reads `Verify` and opens `verify-dialog`; given `no-backup`, `not-joined`, `restoring` or `unknown`, there is no action. Copy per reason: `locked-backup` "Unlock with your recovery key to read older messages", `no-backup` "This session can't read older messages (no key backup)", `restoring` "Restoring from backup...", `unverified` "The sender's device withheld the key. Verify this session.", `not-joined` "Sent before you joined", `unknown` "Unable to decrypt". |
| AC-E2-4 | P0 | Given a redacted encrypted event, then the row shows `message-redacted` ("Message deleted"), never `message-undecryptable`, whether or not it was decryptable. |
| AC-E2-5 | P0 | Given alice-A and bob-B in `#vault`, when bob **edits** an encrypted message, **replies** to one, **reacts** 👍 to one, replies **in thread** to one and **deletes** one (all from B's UI), then A shows: the edited text with `message-edited`; the reply with `message-reply-quote` quoting the decrypted text; `reaction-👍` on the target with `data-count` 1; `thread-summary` on the root with "1 reply" and the panel showing the decrypted reply; `message-redacted` for the deleted one. Every relation is cleartext `m.relates_to` on the wire (AC-T2-1 shape for the thread reply); the edit, the reply and the thread reply are `m.room.encrypted` on the wire; the **reaction is sent in the clear** (`m.reaction`, as in Element: matrix-js-sdk never encrypts reactions). |
| AC-E2-6 | P0 | Given alice-B shows `locked-backup` placeholders for `#vault` history, when alice-B unlocks (AC-E5-2) **without reloading**, then within 10 s every such row has `message-body` with the decrypted text and no `message-undecryptable` remains (late decryption via `MatrixEventEvent.Decrypted` -> store refresh); the same holds for a thread panel that is open at the time. |
| AC-E2-7 | P1 | Given a thread whose root is undecryptable, then `thread-summary` still shows the reply count and opening the panel works (relations are cleartext); the `thread-root` renders the placeholder. |
| AC-E2-8 | P1 | Given an encrypted event that takes time to decrypt (`event.isBeingDecrypted()` true during the first paint), then the row shows `message-decrypting` and settles into `message-body` or `message-undecryptable` with no layout jump larger than one row. |

### AC-E3 Encrypted attachments (PRIN-19, DEV-B-28)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E3-1 | P0 | Given alice-A in `#vault`, when she attaches `e2e/fixtures/test-image.png` via `composer-attach`, then the decrypted content matches the attachment shape above (`msgtype` `m.image`, `file.v` `v2`, `file.key.alg` `A256CTR`, `hashes.sha256`, `info.w/h/mimetype/size`, no `url`, no thumbnail fields), and `getMedia(file.url)` via API returns bytes whose first 8 bytes are **not** the PNG signature and whose SHA-256 (base64) equals `file.hashes.sha256`. |
| AC-E3-2 | P0 | Given that image, then A shows `message-image[data-encrypted="true"]` with `data-state` going `loading` -> `ready`, an `<img>` whose `src` starts with `blob:` and whose natural size is the fixture's; bob-B shows the same image within 10 s; clicking it opens the decrypted image (AC-B4 behaviour via `openMedia` with the file source), never the raw mxc URL. |
| AC-E3-3 | P0 | When alice-A attaches `e2e/fixtures/test-file.txt`, then the event is `m.file` with `file` (no `url`) and B shows `message-file[data-encrypted="true"]`; clicking it downloads (QA: `page.waitForEvent('download')`) a file whose bytes equal the fixture. |
| AC-E3-4 | P0 | When alice-A records and sends a voice note in `#vault` (AC-V2 flow), then the content keeps the Phase 2 shape with `file` at the top level and inside `org.matrix.msc1767.file`, the media bytes are ciphertext, and B shows `voice-message[data-encrypted="true"]` that plays (`voice-play` -> `voice-pause`, `voice-progress` advances) from a decrypted blob. |
| AC-E3-5 | P0 | Given an encrypted image whose `hashes.sha256` does not match (QA: send a forged event via API with a wrong hash, or a `file` whose key is wrong), then the row shows `message-image-error` and nothing is rendered from the bytes. |
| AC-E3-6 | P1 | Given an encrypted image row scrolled out of view before it loaded (20 texts after it), then no media download happens until it comes into view; coming back shows `ready` with no layout shift (the placeholder has the `info.w/h` size scaled by the AC-B4 rule). |
| AC-E3-7 | P1 | Given an Element-sent encrypted image with `info.thumbnail_file`, then codec renders it (full `file` is acceptable; `thumbnail_file` may be used), and an Element-sent encrypted voice note plays. **Manual, 704.chat.** |

### AC-E4 Verification and cross-signing (PRIN-20, DEV-A-24, DEV-A-25)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E4-1 | P0 | Given a user whose account has **no** cross-signing keys (QA: a freshly registered user, `register` via API), when they log in, then `security-banner[data-need="setup"]` shows with `security-banner-action` "Set up"; `current-user[data-verified="unknown"]`. Given alice-B logging in after alice-A completed setup, then `data-need="verify"`. Given a verified session with a locked backup, `data-need="unlock"`. No banner when verified and the backup is unlocked. |
| AC-E4-2 | P0 | Given `setup`, when the user clicks the action, enters their password in `setup-password` and submits, then `setup-dialog` goes `auth` -> `working` -> `key`, `setup-key` shows a base58 key of 48 chars (groups of 4 separated by spaces, Element format), `setup-copy` puts it on the clipboard, `setup-confirm` closes the dialog; afterwards `isCrossSigningReady()` and `isSecretStorageReady()` are true, `getKeyBackupInfo()` is non-null and `getActiveSessionBackupVersion()` equals its version, `current-user[data-verified="true"]`, no banner. A wrong password shows `setup-error` and stays in `auth`. |
| AC-E4-3 | P0 | Given alice-A verified and alice-B unverified, when B clicks `security-banner-action` then `verify-use-device`, then B shows `verify-dialog[data-phase="requested"]` and A shows `verify-dialog[data-direction="incoming"][data-phase="incoming"]` within 5 s; when A clicks `verify-accept`, both reach `data-phase="sas"` with 7 `verify-emoji-item` whose texts are **identical** in A and B. |
| AC-E4-4 | P0 | Given both in `sas`, when both click `verify-match`, then both reach `done`; B's `current-user[data-verified="true"]`, `getDeviceVerificationStatus(alice, B.deviceId).crossSigningVerified` is true from A's point of view, and B's banner becomes `unlock` (backup exists) or disappears. |
| AC-E4-5 | P0 | Given `sas`, when either side clicks `verify-mismatch` or `verify-cancel`, then both show `cancelled` with a reason text and B stays unverified; when A clicks `verify-decline`, B shows `cancelled`. Closing the dialog leaves the banner as it was. |
| AC-E4-6 | P1 | Given B verified in AC-E4-4, when B reloads, then `data-verified="true"` persists with no dialog (AC-E1-2). |
| AC-E4-7 | P1 | Given an incoming request while a dialog is already open, or in a room with the thread panel open, then the incoming dialog still appears (one `verify-dialog` at a time; the newer request wins and the older is cancelled). |
| AC-E4-8 | P0 | **Manual, 704.chat**: codec verifies against Element (both directions) and Element lists the codec session as verified (green shield); a brand-new SSO account completes `setup` through the `m.login.sso` UIA fallback popup (`setup-sso-hint` shown, polling completes once the popup finishes). |

### AC-E5 Recovery key and key backup (PRIN-21, DEV-A-26)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E5-1 | P0 | Given alice-B logged in while alice's account has secret storage and a backup (from AC-E4-2), then `security-banner[data-need="verify"]` (unverified) offers `verify-use-recovery` inside the dialog, and `#vault` history shows `locked-backup` placeholders. |
| AC-E5-2 | P0 | When alice-B pastes the recovery key (with or without spaces) into `recovery-input` and submits, then `recovery-progress` shows `data-restored` / `data-total` climbing, `recovery-done` appears, the session is **verified** (`current-user[data-verified="true"]`, `isCrossSigningReady()` true on B), `getActiveSessionBackupVersion()` is non-null on B, and AC-E2-6 follows: the placeholders decrypt without reload. The key is not written to localStorage or IndexedDB outside the SDK's own store. |
| AC-E5-3 | P0 | Given a wrong key (any 48 valid base58 chars) or a random string, then `recovery-error` reads `That recovery key is not correct` (or `Not a recovery key`), nothing is restored, the dialog stays open for another try. |
| AC-E5-4 | P1 | Given secret storage whose default key has a `passphrase` description (QA: create it with `createRecoveryKeyFromPassphrase('correct horse')` through the dev hook on A), when B types the passphrase into the same `recovery-input`, then AC-E5-2 holds (`deriveRecoveryKeyFromPassphrase` path). |
| AC-E5-5 | P0 | Given an account that already has secret storage (the testers' Element setup; QA: after AC-E4-2), then **no** path offers to create a new recovery key: `security-banner` never shows `setup`, `setup-dialog` is unreachable, and `getSecretStorageStatus().defaultKeyId` is unchanged after any flow. |
| AC-E5-6 | P0 | Given alice-A verified with the backup active, when she sends 3 messages in `#vault`, then `getKeyBackupInfo().count` grows (keys uploaded) and a **new** alice-C that unlocks with the key reads all three; after a reload of A the backup stays active (`getActiveSessionBackupVersion()` same version). |
| AC-E5-7 | P1 | Given `restoring` in progress (QA: a backup with 50+ keys), then `security-banner[data-need="restoring"]` shows while keys arrive and rows flip from `restoring` placeholders as they decrypt. |
| AC-E5-8 | P0 | **Manual, 704.chat**: JC, Charlie and Juanjo unlock codec with the recovery key (or passphrase) they already have in Element and read the history of the 6 encrypted rooms; Element continues to work with the same key afterwards. |

### AC-E6 Encrypted by default (PRIN-22, DEV-A-27, DEV-B-29, DEV-B-31)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E6-1 | P0 | When alice creates a channel via `create-channel-dialog`, then the room's `m.room.encryption` state is `{ algorithm: 'm.megolm.v1.aes-sha2' }` (API `stateEvent`), the dialog showed `create-channel-encrypted-note`, the header shows `channel-header-lock`, `channel-item-{roomId}[data-encrypted="true"]`, and the first message sent there is `m.room.encrypted` on the wire. Same for `new-dm-dialog` (`new-dm-encrypted-note`, `dm-item-*`). `create-space-dialog` creates **no** `m.room.encryption`. |
| AC-E6-2 | P0 | Given `#vault`, then `channel-header-lock` is present with `title="End-to-end encrypted"`; given `#general`, it is absent and `data-encrypted="false"`. |
| AC-E6-3 | P0 | Given `#vault`, then `composer[data-encrypted="true"]` and the placeholder reads `Message #vault (encrypted)`; focusing `composer-input` calls `prepareToEncrypt` (QA: a `/keys/claim` or `/keys/query` request observed on focus, before the first send); `#general`'s composer is unchanged. |
| AC-E6-4 | P0 | Given any encrypted room, then no request to `/_matrix/client/*/preview_url` or `/_matrix/media/*/preview_url` is made while viewing it or sending links in it (`page.route` catch-all fails the test). |
| AC-E6-5 | P1 | Given a GIF message (Phase 4 contract) in `#vault`, then the row shows `message-gif[data-state="click-to-load"]` with `message-gif-load` and **no** request to the GIF host until clicked; clicking loads it (`playing`); in `#general` the Phase 4 behaviour is unchanged. The picker still works in `#vault` (sending a GIF is `m.room.encrypted` on the wire). |
| AC-E6-6 | P1 | Given a room that turns encrypted while open (QA: bob sets `m.room.encryption` via API on a fresh room alice is in), then the lock appears, the composer flips to encrypted, and the next send is encrypted; the room never flips back (the SDK ignores encryption removal). |

### AC-E7 Seed, scripts, docs (PRIN-22, PRIN-23)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E7-1 | P0 | Given `npm run seed` on the existing homeserver, then `#vault:localhost` exists in Acme HQ (order `04`, topic "Encrypted. Say it here.", members alice, bob, dave, power levels as docs/SEED_DATA.md) with the `m.room.encryption` state above and is recorded as `rooms.vault` in `seed/seed-output.json`; re-running is a no-op; `#general`'s history is untouched. |
| AC-E7-2 | P1 | Given `npm run e2ee:sample -- --count 3` (default room `#vault`), then bob posts 3 encrypted texts ("vault sample 1..3") and one encrypted image (`e2e/fixtures/test-image.png`), each `m.room.encrypted` on the wire (the script asserts this before exiting, after waiting for Prepared), prints `{ roomId, eventIds }`, appends the session keys to `seed/e2ee-keys.json` (merged), and logs its device out (`GET /devices` as bob shows no extra device). |
| AC-E7-3 | P1 | Given `seed/e2ee-keys.json` and a fresh alice context, when `__matrixPoc.security.importRoomKeys(json)` is called, then the sample rows decrypt within 10 s without reload. |
| AC-E7-4 | P1 | Given `npm run verify:e2ee` (no browser), then it checks: `#vault` has the encryption state, the latest sample events are `m.room.encrypted`, the sample image bytes are ciphertext with a matching hash, and `attachments.ts` round-trips a buffer (encrypt -> decrypt -> equal) under Node's WebCrypto; exit 0. |
| AC-E7-5 | P0 | docs/ARCHITECTURE.md has a "Phase 5 deltas" section listing every name that differs from the Shared API table, the crypto boot order, the wipe rule, the UTD reason mapping, the attachment scheme and the "plaintext-if-room-unknown" gotcha; docs/MOBILE.md notes the secure-context requirement; `npm run typecheck` and `npm run build` pass. |

### AC-E8 Suites, demo walkthrough, regression, manual pass (QA-24..29)
| ID | P | Given / When / Then |
|---|---|---|
| AC-E8-1 | P0 | `e2e/e2ee-core.spec.ts` (AC-E1, AC-E2, AC-E6), `e2e/e2ee-media.spec.ts` (AC-E3) and `e2e/e2ee-security.spec.ts` (AC-E4, AC-E5) run in `desktop`, serial, at most two contexts open at once, every context logged out in `afterAll`; `npm run test:e2e:e2ee` runs the three. |
| AC-E8-2 | P0 | `e2e/smoke.spec.ts` step 13 walks desktop demo steps 1-11 (window 3 = a second context; the clipboard key read via `page.evaluate`) with a screenshot per sub-step in `e2e/results/demo/13-*`. |
| AC-E8-3 | P0 | Both projects green at the end of Wave 14 (known fresh-seed skips only), recorded in docs/STATUS.md; the Phase 1-4 suites are unchanged in behaviour (plain rooms are not affected by crypto being on). |
| AC-E8-4 | P0 | docs/BUGS.md "Phase 5" has the manual 704.chat checklist (AC-E3-7, AC-E4-8, AC-E5-8, Element interop both ways, the 6 rooms, a Keycloak login + verify round trip, codec media decrypted by Element) with a result column for JC, Charlie and Juanjo. |
| AC-E8-5 | P1 | Every bug or review finding fixed in Wave 14/15 has a regression test in `e2e/` (JC's rule). |
