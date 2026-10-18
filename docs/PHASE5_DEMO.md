# codec end-to-end encryption - Demo Handoff (Phase 5)

The Phase 1-4 client (docs/DEMO.md, docs/PHASE2_DEMO.md, docs/PHASE3_DEMO.md, docs/PHASE4_DEMO.md), now encrypted: the Rust engine Element uses (`matrix-js-sdk` `initRustCrypto`, WebAssembly) runs in codec, keys live in the browser's IndexedDB per session, and new channels and DMs are encrypted by default. Final test numbers: docs/STATUS.md "Phase 5".

## 1. The three things to know
1. **Every login is a new session** (device). A new session cannot read messages sent before it existed until it is **verified**: an emoji check against another session that is online, which also hands over the backup key, so old messages restore on their own. The **recovery key** (or passphrase) is only needed when there is no other session to verify with; entering it verifies the session and restores history in one step. Codec shows one banner at a time telling you which you need. Logging out wipes the session's keys; the next login starts over.
2. **Testers keep their Element recovery key.** Codec never creates a new one on an account that already has secret storage: it only asks you to enter the existing key. "Set up encryption" appears only on brand-new accounts.
3. **Media is encrypted before upload** (same scheme as Element), so the server never sees images, files or voice notes from encrypted rooms, and there are no server thumbnails for them: codec downloads and decrypts each image when it scrolls into view. GIFs in encrypted rooms are click-to-load so Klipy's CDN does not learn what you viewed.

## 2. Undecryptable rows, decoded
| The row says | Why | What fixes it |
|---|---|---|
| Unlock with your recovery key to read older messages | Sent before this session existed; the account has a key backup | **Unlock** (the link on the row, or the banner) |
| This session can't read older messages (no key backup) | Sent before this session existed; the account has no backup | Nothing for that message; set up a backup so the next session can |
| Restoring from backup... | Keys are arriving after an unlock | Wait a few seconds |
| The sender's device withheld the key. Verify this session. | The sender only shares with verified sessions | **Verify** |
| Sent before you joined | Normal Matrix behaviour | Nothing |
| Unable to decrypt | The key has not arrived (yet) | Usually resolves itself; if not, docs/BUGS.md "Phase 5" |

## 3. Your steps (user-only, on 704.chat)
1. Sign in to codec with Keycloak. The banner says **Verify this session**.
2. Either verify from Element (Settings > Sessions > the codec session > Verify, compare emoji), or click the banner and **Use recovery key**, then paste the recovery key or passphrase you set in Element. Verifying from Element is enough: once verified, history restores by itself. The recovery key is for when no other device is available; it verifies and restores in one step.
3. Open each of the 6 encrypted rooms: history should read, and a message sent from codec should appear decrypted in Element (and the other way round). Send an image and a voice note from codec; Element should show both.
4. Charlie and Juanjo repeat 1-3. Fill in the manual checklist in docs/BUGS.md "Phase 5" (one result column per tester). Anything odd: screenshot + the row's reason text.
5. Optional, new-account check: create a throwaway Keycloak user, sign in, click **Set up**, finish the sign-in popup, save the key it shows. This is the one flow (SSO cross-signing setup) nobody could test locally.

## 4. Local walkthrough
The full desktop script (11 steps, three browser windows) is in docs/PHASE5_PLAN.md "Desktop demo script"; `e2e/smoke.spec.ts` step 13 replays it. Shortest version: log in as **alice**, click **Set up** on the banner, copy the key; open `#vault` (lock in the header), send a message; in an incognito window log in as alice again: the message shows as "Unlock with your recovery key...", verify with emoji from the first window and watch the row turn into text without a reload (the recovery key is only needed when no other window is open).

## 5. Scripts
| Command | What it does |
|---|---|
| `npm run seed` | Adds the encrypted `#vault` channel (idempotent; **not** `seed:reset`) |
| `npm run e2ee:sample` | bob posts encrypted texts and an encrypted image to `#vault` from a Node crypto client, exports its room keys to `seed/e2ee-keys.json`, signs its device out |
| `npm run verify:e2ee` | No-browser check: `#vault` encryption state, sample events are `m.room.encrypted`, media bytes are ciphertext, attachment crypto round trip |
| `npm run test:e2e:e2ee` | `e2ee-core`, `e2ee-media`, `e2ee-security` specs (desktop, two browser contexts) |

## 6. Known limits
Reactions in encrypted rooms are sent in the clear (the server sees who reacted with what; matrix-js-sdk and Element both do this); no QR verification; no sessions list (sign out other sessions from Element); the key store is not encrypted at rest (same trust level as the access token in the browser); encrypted media needs a secure context (localhost, https, the APK), so `dev:lan` from a phone browser cannot show it; a session that logs out loses its keys by design; on-device search, push and URL preview cards remain future phases.
