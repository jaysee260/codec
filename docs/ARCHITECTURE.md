# Architecture (source of truth for the shared layer)

Diagrams of the same architecture (layers, startup, data flow, encryption, layout): `docs/ARCHITECTURE_DIAGRAMS.md`.

This document is the contract between the Principal-owned core (`src/lib`, `src/store`, `src/app`,
`seed`, `scripts`, `homeserver`, and since Phase 2 `capacitor.config.ts`, `android/`, `ios/`) and the
feature owners. Where it differs from `docs/TICKETS.md` / `docs/PHASE2_TICKETS.md` / `docs/PHASE3_TICKETS.md` /
`docs/PHASE4_TICKETS.md` / `docs/PHASE5_TICKETS.md` "Shared API", **this file wins**; the differences are listed first.

## Phase 6 deltas (link previews)

A message with http(s) links shows a card per link (site name, title, description, og:image), like Slack / Element.
The homeserver fetches the page (`/_matrix/client/v1/media/preview_url`, v3 fallback; the SDK picks) and re-hosts
og:image as an `mxc://` URI. Decisions are in the Phase 6 brief / docs/PHASE6_*.md (PM); this section is the API.
Ownership: Principal `src/lib/preview/`, `public/preview-fixtures/`, `scripts/make-preview-fixtures.mjs`, the test
Synapse whitelist; Dev A `src/features/link-preview/` (card + embed components); Dev B wires them into
`src/features/conversation/` (messages + thread view; reply quotes / thread list / room previews stay text only).

### API (`src/lib/preview/index.ts`, import from `@/lib/preview`)

```ts
interface LinkPreview { url: string; siteName?: string; title?: string; description?: string; image?: LinkPreviewImage }
interface LinkPreviewImage { mxc: string; width?: number; height?: number; mimetype?: string; size?: number }   // ALWAYS mxc: render via mxcToHttp(mxc, w, h)
interface LinkEmbed { provider: 'youtube' | 'spotify'; kind: 'video' | 'track' | 'album' | 'playlist' | 'episode'; id: string;
                      embedUrl: string; canonicalUrl: string; startSeconds?: number }
type LinkPreviewStatus = 'idle' | 'loading' | 'ready' | 'empty';

getPreviewUrls(event: MatrixEvent, max = 3): string[]       // links that get a card, message order, deduped (hash-stripped);
                                                            // [] for GIF / redacted / undecrypted / media events; skips <pre>/<code>,
                                                            // matrix.to, the homeserver's media URLs. Ignores room encryption on purpose.
extractPreviewUrls(body: DisplayBody | PreviewSource | string, { max?, hsUrl? }): string[]   // the pure core of the above
shouldAutoPreview(roomId, event?): boolean                  // THE encrypted-room rule: false when the room has m.room.encryption
                                                            // (or the event is m.room.encrypted) -> render a "Show preview" button instead
getLinkPreview(url, { signal?, ts? }): Promise<LinkPreview | null>   // client.getUrlPreview + LRU (200 urls; hits 1 h, misses 5 min) +
                                                            // in-flight dedupe; null = none / blocked / failed (never throws; AbortError on signal)
peekLinkPreview(url): LinkPreview | null | undefined        // sync cache read (undefined = unknown); primeLinkPreview(url, p | null); clearLinkPreviewCache()
useLinkPreview(url, { enabled?, ts? }): { status, preview } // enabled=false -> 'idle' (a cached hit still renders); unmount aborts the wait, not the request
useHiddenPreview(eventId, url): { hidden, hide, unhide }    // "x" on the card; localStorage 'matrix-poc.hiddenPreviews' = [`${eventId}|${url}`, ...] (max 1000)
isPreviewHidden / hidePreview / unhidePreview / clearHiddenPreviews / subscribeHiddenPreviews   // non-hook forms
parseEmbed(url): LinkEmbed | null                           // YouTube watch / youtu.be / shorts / embed / live (+ t= -> ?start=N) ->
                                                            // https://www.youtube-nocookie.com/embed/<id>; Spotify track|album|playlist|episode
                                                            // (intl-xx/ ok) -> https://open.spotify.com/embed/<kind>/<id>. No network; iframe only after the click.
previewImageLayout(image, minWidth = 400): 'large' | 'thumbnail' | 'none'   // large = width >= 400 && landscape; unknown dims = thumbnail
normalizePreview(url, rawOgObject): LinkPreview | null      // trims, drops non-mxc og:image, null when no title/description/image
PREVIEW_MAX_LINKS = 3, PREVIEW_CACHE_MAX = 200, PREVIEW_CACHE_TTL_MS, PREVIEW_NEGATIVE_TTL_MS, HIDDEN_PREVIEWS_STORAGE_KEY
```

Module split: `types.ts`, `extract.ts`, `embed.ts`, `normalize.ts`, `cache.ts`, `hidden.ts` are pure (no React / SDK /
`import.meta.env`; Node imports them with type stripping, like `src/lib/gif`); `fetch.ts` and `policy.ts` touch the SDK;
`hooks.ts` is the only React module. Dev hook: `window.__matrixPoc.preview` is the whole module.

Intended wiring (Dev B): `const urls = useMemo(() => getPreviewUrls(event), [event, body])`; per url, skip when
`useHiddenPreview(event.getId()!, url).hidden`; `const auto = shouldAutoPreview(roomId, event)`; render Dev A's card with
`useLinkPreview(url, { enabled: auto || clicked, ts: event.getTs() })`; in an encrypted room render the "Show preview"
button until `clicked`, and the "No preview available" note when the answer is `'empty'`; `parseEmbed(url)` decides whether the
card gets a play button. Reserve the image box from `image.width/height` before the bytes arrive (stick-to-bottom).

### Why these choices
- **No automatic fetch in encrypted rooms** (`shouldAutoPreview`): the preview request hands the URL to the homeserver in
  clear, which defeats E2EE. Same posture as GIFs (AC-E6-5). A cached hit may still render there: the server has already seen it.
- **Own negative cache**: the SDK caches the *promise* per minute bucket, rejections included; without our 5-minute negative
  TTL a transient failure would be permanent for that minute and a retry impossible, and a success would never expire.
- **og:image must be mxc**: Synapse always re-hosts it; a server that returned a raw third-party URL would otherwise make
  every viewer's browser fetch from that host. `normalizePreview` drops anything that is not `mxc://`.
- **HTML scanning with regexes, not DOMParser**: keeps `extract.ts` Node-loadable; the tokeniser consumes tags whole so
  URLs in attributes (`<img src>`) are never previewed, only anchor hrefs and text URLs.

### Test homeserver (whitelist + fixtures)
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

## Phase 5 deltas (end-to-end encryption)

What the Phase 5 brief, docs/PHASE5_PLAN.md, docs/PHASE5_TICKETS.md (PRIN-17..23) and docs/PHASE5_ACCEPTANCE.md say versus
what is shipped, and why. The core API is in "Encryption (Phase 5)" at the end of this file; the traps in "Encryption gotchas (Phase 5)".
Verified end to end with a throwaway Playwright script against a throwaway Synapse 1.163 (login, UTD history,
key import, live send/receive both ways, encrypted upload, reload, setup, SAS self-verification, logout wipe, unlock).

| Topic | Brief / plan / tickets / acceptance say | What is actually shipped | Why |
|---|---|---|---|
| Boot order | `initRustCrypto` before `startClient`, per-user/device store | `createClient({ cryptoCallbacks, verificationMethods })` -> `initCrypto()` (`initRustCrypto({ cryptoDatabasePrefix })`, prefix `matrix-poc-crypto:<userId>:<deviceId>`; IndexedDB name `matrix-poc-crypto:@alice:localhost:<deviceId>::matrix-sdk-crypto`) -> `startClient`. A crypto failure never blocks login: `getCryptoError()` is set, `useSecurityStore.cryptoReady` stays false, the app runs unencrypted (sends into encrypted rooms throw `EncryptionNotReadyError`). | Advisor risk 1 (one store per device; a fresh SSO device must never reuse an old device's keys). |
| Store at rest | - | **Not encrypted at rest** (no `storageKey` / `storagePassword`): the browser profile is the trust boundary of this POC, same as the access token in `localStorage`. | Documented choice; a passphrase prompt on every boot is out of scope. |
| Wipe | `clearStores` on logout and the token-rejected path | `logout()` and `fail()`: `stopClient()` -> `removeAllListeners` -> `clearStores({ cryptoDatabasePrefix })` -> `store.destroy()`; the secret-storage key cache is cleared too. The wait for `indexedDB.deleteDatabase` is bounded (4 s): an in-flight backup upload can keep the Rust engine's connection open a few seconds past `stopClient()`, the delete stays queued in the browser and the prefix is recorded in `localStorage['matrix-poc.pendingCryptoWipes']`, which `initCrypto` retries before the next boot. Verified: the store was gone 17 s after the login form appeared, and the next boot deletes it at the latest. A session *switch* without logout keeps the old store (the old device still exists). | `clearStores` throws while the client runs; found in verification right after `setupRecovery`. |
| Token rejected after boot | wipe like logout, "Session expired" on the login form (AC-E1-4) | `bindClient({ onSessionLoggedOut })` -> `fail(MatrixError M_UNKNOWN_TOKEN, 'error')`: same wipe as logout, status `error` with "Session expired, please log in again" (BUG-11; the plain `logout()` path clears the message). | - |
| First-load landing (BUG-18) | land on the first space / #general on a fresh login | `bindClient` ignores every `scheduleRooms()` until the initial sync is `Prepared` (the `Prepared` handler does the first full `recomputeRooms`), and `recomputeRooms` returns early while `client.getSyncState()` is null. Before: account data / presence / device and decryption events during the (now longer, Phase 5) initial sync fired the debounced recompute on a partial world (probe: 0 rooms, sync `null`), `ready` flipped, the first-load rule saw no spaces, chose Home + the first DM and **persisted** it. Probe after the fix: 6/6 first snapshots at `PREPARED` with all rooms. | S2: 85 of 87 red tests in the first full Phase 5 run. |
| Loading | `app-loading[data-stage]` | `useSessionStore.loadingStage: 'crypto' \| 'sync' \| null`; `LoadingScreen` renders `data-stage` and "Setting up encryption..." during `crypto`. | AC-E1-5. |
| Decrypted re-render | bridge listens to `MatrixEventEvent.Decrypted` | `bridge.ts` `onDecrypted`: schedules the event's room (or thread) snapshot, `scheduleRooms()` (previews) and bumps `threadsVersion`. Rows memoised on `event.getId()` must include `useRoomTimeline().version`. | Advisor risk 2. |
| UTD events | `isDisplayableEvent` keeps `m.room.encrypted`; `getDisplayBody` gains `decryption` | Shipped as specified, minus encrypted **relations**: an `m.room.encrypted` whose wire `m.relates_to` is `m.replace` / `m.annotation` (or an `m.reaction`) is never a row, and neither is one redacted after this session saw it as a relation (`isEncryptedRelation`, ids remembered by the bridge via `noteEncryptedRelation`; same rule as Dev B's `isHiddenEncryptedRelation`). Residual: a relation redacted before this session loaded shows as "Message deleted". `getDecryptionState(event)`, `describeDecryptionFailure(code)` (table below), `DisplayBody { isEncrypted, decryption?, file?, thumbnailFile? }`; a failed row is `msgtype: 'm.bad.encrypted'`, `text` = the reason; a row still decrypting is `msgtype: 'm.room.encrypted'`, `text: 'Decrypting...'`; `previewText` -> `Unable to decrypt` / `Decrypting...`. Relations stay on `getWireContent()` (threads, replies, reactions work before decryption). | - |
| Attachments | `attachments.ts` (WebCrypto, no npm install), `useMediaObjectUrl`, `mediaSourceOf` | `src/lib/matrix/attachment-crypto.ts` (pure: `encryptAttachment`, `decryptAttachment`, `isEncryptedFile`, types; Node-loadable) + `attachments.ts` (re-exports those and adds `fetchDecryptedMedia`, `fetchDecryptedBlob`, `releaseDecryptedMedia`). Hook is `useDecryptedMediaUrl(file, mimetype)`; `useMediaObjectUrl` is an alias; `mediaSourceOf(body)` in `media.ts`. `uploadEncryptedMedia(blob)`, `uploadFile(file, { encrypt?, roomId? })`. | The scripts import the pure module (the app one pulls `config.ts` / `import.meta.env`). |
| Voice notes | `VoiceMessageInfo.file?` | Encrypted voice events carry `file` at the top level **and** `org.matrix.msc1767.file: { file, name, mimetype, size }`; `getVoiceMessage` reads either; `url` is `''` when encrypted. | Element compatibility. |
| Encrypted by default | `createChannel` / `createDm` add `m.room.encryption` | `createChannel({ ..., encrypted? = true })`, `createDm(userId, { encrypted? = true })`, `createSpace({ ..., encrypted? = false })` (spaces stay plain), `enableRoomEncryption(roomId)`, `prepareToEncrypt(roomId)` (no-op in plain rooms), `isRoomEncrypted(roomId)`, `RoomSummary.encrypted`, `useRoomEncrypted(roomId)`. | AC-E6. |
| `securityHint` rule | tickets: `setup` = no cross-signing keys **and** no secret storage; `unlock` = verified but no backup key | `setup` = no cross-signing keys **and** no secret storage; `unlock` = no cross-signing keys but a recovery key exists (AC-E5-5: `unlockWithRecoveryKey` bootstraps the identity from / into 4S; `setupRecovery` throws "A recovery key already exists" unless `reset`); `verify` = identity exists, this device is not cross-signed; `unlock` = verified, a key backup exists and its key is not cached; else null (in that order). | What the SDK can answer offline; "verified but no backup key" is the second `unlock` case. |
| `hint` timing | refreshed on `CryptoEvent.*` | Also refreshed on `ClientEvent.Sync` `Prepared`: `status` is `null` until the first sync and its `/keys/query` landed (~1 s after `app-shell`). QA: wait for `status !== null`. | Found in verification. |
| UIA | `makeUiaCallback({ passwordPrompt })`; SSO via the fallback page after a 704.chat spike | `makeUiaCallback({ password?, sso? })`: null auth first (spec v1.11: the first cross-signing upload needs no UIA; verified on Synapse 1.163), then `m.login.password` (`prompt.kind: 'password'`), then `m.login.sso` through the fallback page `/_matrix/client/v3/auth/m.login.sso/fallback/web?session=` in a popup (`prompt.kind: 'sso'`, `url`, `popupBlocked`); resubmits `{ session }` when the popup posts `authDone`, closes, or the user presses Done. **The SSO path is not spiked on 704.chat** (no reachable SSO server from the build environment): manual check owed, see docs/BUGS.md checklist. | Advisor risk 5. |
| Recovery | `unlockWithRecovery`, `setUpEncryption`, `backup.state` | Names: `unlockWithRecoveryKey(input)` (key **or** passphrase when the key description has one; wrong key -> `RecoveryKeyError('wrong')` -> store returns false + `recovery.error`), `restoreFromBackup()`, `setupRecovery({ passphrase?, reset? })`; backup state is the `KeyBackupSummary { version, trusted, keyCached, enabled }` object (no `state` enum). Unlock = check key -> `bootstrapCrossSigning` (imports the private keys from 4S, signs this device) -> `restoreKeyBackup` with `recovery.progress { imported, total }` -> `recovery.lastRestore`. | - |
| Dev hook | `__matrixPoc.security` / `__matrixPoc.crypto` | Both names, same object: the whole `security.ts` module + `{ store: useSecurityStore, cryptoDatabasePrefix, getCryptoError, importRoomKeys(json), exportRoomKeys() }`; also `__matrixPoc.securityStore`, `attachments` (module), `cryptoLifecycle` (`crypto.ts`). | - |
| Seed | `#vault` + `rooms.vault`, do not reset | `#vault` (alias `#vault:localhost`, topic "Encrypted. Say it here.", alice/bob/dave, `m.room.encryption` in `initial_state`, no script messages) and an encrypted DM `dm-alice-dave`. `npm run seed` on an already-seeded server is **additive**: it creates only the rooms whose alias / DM is missing, refreshes every room id from the server and **re-records the keyed event ids** of the existing channels from their history (sender + body match, in script order; BUG-15: a machine without `seed-output.json` gets a complete file; `e2e/fixtures/seed.ts` refuses to load a file missing any of the 11 `general.*` ids). | Never `seed:reset`. |
| Scripts | `e2ee:sample`, `verify:e2ee` | `scripts/send-encrypted-sample.mjs` (`--as bob --room '#vault:localhost' --count 3 [--no-image] [--keys seed/e2ee-keys.json] [--image path]`; prints `{ roomId, eventIds, keys }`, merges this device's Megolm sessions into `seed/e2ee-keys.json`, logs the device out), `scripts/verify-e2ee.mjs` (attachment round trip + tamper, room state, wire shape, decrypts the sample with the keys file, media bytes are ciphertext with the right SHA-256), `scripts/lib/e2ee-api.mjs`. `seed/e2ee-keys.json` is gitignored. | AC-E7. |
| Shell | `security-banner-host`, `security-dialogs-host` | Both hosts render on both layouts (banner above `channel-header`, and above the `empty-state` when no room is selected, so a fresh account with no rooms still sees "Set up encryption"; dialogs once per page: a **sibling after the desktop grid**, after the drawers on phone); both are `display: contents`, so they never take a grid / flex cell (an earlier cut put the dialogs host inside the grid and pushed the member / thread panels to a second row). `SecurityDialogs` must render `position: fixed` overlays or nothing; `@/features/security` is resolved through `import.meta.glob` + `lazy`, so the shell builds before Dev A's module exists and renders nothing then. `current-user[data-verified]`: `"unknown"` until the status snapshot lands **and** while the account has no cross-signing identity (AC-E4-1, BUG-14), `"false"` = identity exists but this device is not signed, `"true"` = signed (+ `current-user-verified` line). | PRIN-23. |

### Advisor consultations (Phase 5, Principal)

| Topic | Outcome |
|---|---|
| `/tmp/claude-0/team/advisor-risks.md` (relayed by the coordinator) | Risk 1 `clearStores` on logout + per-device prefix: done. Risk 2 `Decrypted` listener in the bridge: done. Risk 3 attachments not in the SDK: own WebCrypto implementation, round trip + tamper checked in `verify:e2ee`. Risk 4 `cryptoCallbacks.getSecretStorageKey` at `createClient`: done (session cache + store prompt). Risk 5 SSO UIA: fallback-page popup implemented, **not** spiked on 704.chat. Risk 6 Vite `optimizeDeps.exclude` for the wasm: done, `.wasm` emitted once (7.8 MB) by `npm run build`. |
| Direct consult | None this wave (the risk list covered the open questions). |

## Phase 4 deltas (GIF picker)

What the Phase 4 brief, docs/PHASE4_PLAN.md and docs/PHASE4_ACCEPTANCE.md say versus what is shipped, and why. The full
API is in "GIFs (Phase 4)" below. The **wire shape** (`dev.matrixpoc.gif`) and the **mock fixture contract** are exactly the
acceptance doc's; only module/function names differ.

| Topic | Brief / plan / acceptance say | What is actually shipped | Why |
|---|---|---|---|
| Sending | brief: fetch the GIF bytes, `uploadMedia`, send `m.image` with `info.mimetype: 'image/gif'`, magic-byte check, CORS relay in `lan-proxy.mjs`; `isAnimatedGifEvent()` | **No upload, no relay.** `sendGif()` sends `m.text` `{ body: "<title> <url>", 'dev.matrixpoc.gif': {...} }` (shape below); the timeline hot-links the GIF from `static.klipy.com`; `getGifContent(event)` / `isGifEvent(event)` replace `isAnimatedGifEvent` | Orchestrator decision 2026-10-09 after the Advisor's finding: Klipy's integration terms forbid storing, mirroring, re-hosting or proxying its media and routing requests through partner servers without written approval (docs.klipy.com/integration-requirements). User-attached GIF files via the paperclip stay `m.image` (unchanged, render static: see the Synapse gotcha). |
| Provider API names | acceptance: `searchGifs(q)` / `trendingGifs({ page, limit })` -> `{ items, hasNext }`, `GifResult { url, w, h, ... }`, `window.__poc.gif` | brief's names: `getGifProvider().search(q, opts)` / `.trending(opts)` -> `GifPage { results, nextPage, hasNext }`, `GifResult { fullUrl, fullW, fullH, previewUrl, previewMimetype, previewW, previewH, stillUrl?, ... }`; `searchGifs` / `trendingGifs` exist as one-liners; dev hook is `window.__matrixPoc.gif` (the existing hook object) | The brief fixed the names before the acceptance was written; both are exported so either reads correctly. `hasNext` is `nextPage !== null`. |
| Module layout | plan: `src/lib/gif/config.ts`, `index.ts` resolver, `providers/klipy.ts`, `providers/mock.ts` | `src/lib/gif/{types,config,message,mock-fixtures,mock,klipy,provider,index}.ts` (flat; `provider.ts` is the resolver, `index.ts` the barrel) | Brief's layout; every module except `provider.ts` is pure (no env, no DOM) so Node scripts import them. |
| Mock fixtures | brief: 12 fixtures `mock-1..12`, 2-4 frames, < 50 KB; acceptance: 8 fixtures, 2 frames, <= 3 KB, + PNG stills | **Acceptance wins**: 8 fixtures `mock-1..8`, 2-3 frames, <= 3 KB, `<id>.png` stills; titles/dimensions in the table below | QA's criteria assert "exactly 8 in this order" and the demo queries. |
| Reserved mock queries | acceptance: `nothing-here` -> `[]`, `__error__` rejects with `Error('mock: simulated failure')`; orchestrator: `__empty__`, `GifProviderError({ kind: 'network' })` | `nothing-here` **and** `__empty__` -> `[]`; `__error__` rejects with `GifProviderError('network', 'mock: simulated failure')` (an `Error` with that message) | Satisfies both. |
| `stillUrl` for mock | orchestrator note: omitted for mock | **Emitted** (`<origin>/gif-fixtures/<id>.png`) | AC-G3-1 asserts "`stillUrl` the png"; coordinator confirmed. |
| Send variant | orchestrator: `fullUrl` = `md.gif` first; acceptance: `hd`, else `md`, else `sm` | `GIF_SEND_VARIANT = 'hd'` (`src/lib/gif/config.ts`), fallback md -> sm | AC-G2-2 / AC-G3-2 assert hd dimensions. One constant to flip. |
| Content rating | brief: `rating` option default `pg` | Klipy has `content_filter` off / low / medium / high, not ratings: `opts.rating` maps g -> high, pg -> medium, pg-13 -> low, r -> off; default `GIF_CONTENT_RATING = 'medium'` | Verified against the docs. |
| `customer_id` | plan: out of scope; AC-G2-1 lists `q&page&per_page&content_filter` | **Sent on every Klipy request**: `getGifProvider()` passes `getGifCustomerId()` (random UUID in localStorage `matrix-poc.gifCustomerId`, generated on first use) as `customer_id` | Coordinator ruling after QA's report; the PM drops it from the out-of-scope list. |
| Klipy result id | acceptance AC-G2-2: `id = String(item.id)` | `id = item.slug` (`'hello-hi-662'`), `String(item.id)` only when there is no slug | BUG-9: Klipy ids are numbers above 2^53 that collapse in `JSON.parse`, so stringifying them is neither unique nor safe in testids; the slug is. |
| Mock titles | acceptance table: `Taco Tuesday`, `Party time` (and "`tacos` -> exactly [mock-1]") | `Tacos Tuesday`, `Tacos party`: `tacos` / `taco` -> [mock-1, mock-2, mock-3], `party` -> [mock-3, mock-4] | BUG-8 ruling (the demo expects three tacos results). Files do not embed titles; no regeneration needed. |
| 429 handling | brief: retry once honouring `Retry-After`; plan: any non-2xx -> `gif-error` | Retry **once** (`Retry-After` seconds / HTTP date, else 1 s), a second 429 rejects with `GifProviderError('rate-limit', status 429)`; 5xx/network reject at once with `status` | Both; QA's 429 stub sees two requests ~1 s apart. |
| Provider override | plan/acceptance: `localStorage['matrix-poc.gifProvider']` wins over keys | Shipped as specified: `setGifProvider('klipy' \| 'mock' \| null)` (alias `setGifProviderOverride`); `'klipy'` with no key -> every call rejects `GifProviderError('auth')` | QA flips per test on the running dev server. |
| Android back for the sheet | acceptance AC-G9-2: back closes the sheet before drawers | `registerBackHandler(fn) => unregister` + `runBackHandlers()` in `src/store/layout.ts`; `App.tsx` runs `runBackHandlers() \|\| closeThread() \|\| closeDrawers()` | New seam; handlers run newest first, return true to consume. |
| Demo script room | acceptance AC-G10-1: `gif:sample` defaults to `#general` | Defaults to **`#dev:localhost`** (`--room '#general:localhost'` for the demo) | Team rule: scripts never post in #general (coordinator). |
| Thumbnails | brief: "render the full download URL for `image/gif`" | Moot for picked GIFs (no mxc). Still true for user-attached GIFs: `/thumbnail` is a static PNG, `&animated=true` gives animated WebP (Synapse 1.162, verified) | Recorded under "GIFs (Phase 4)". |

### Advisor consultations (Phase 4, Principal)

| Topic | Outcome |
|---|---|
| Advisor agent (Klipy + Synapse verification; sources docs.klipy.com `llms-full.txt`, live curl, `docs/advisor/gif-thumb-probe.mjs`) | Auth = path segment, endpoints/params/response shape as in "Klipy facts"; CORS `*` on api.klipy.com (preflight OK) and static*.klipy.com; Test key 100 req/h, 429 undocumented; attribution: `Search KLIPY` placeholder required, `Powered by KLIPY` optional; **integration terms forbid re-hosting / proxying / reordering** -> escalated, orchestrator chose hot-linking; Synapse: `/download` unchanged bytes, `/thumbnail` static PNG, `?animated=true` animated WebP, upload cap 50 MB. Independently re-verified by the Principal (curl: API 404 `{"result":false,"errors":{"message":["The provided API key is invalid."]}}` for a bad key with `access-control-allow-origin: *`; CDN GIF/WebP `access-control-allow-origin: *`, `cache-control: public, max-age=86400`). |
| `advisor` tool, plan review | Keep every gif module except `provider.ts` Node-loadable (relative `.ts` imports, no `import.meta.env` at top level) so the scripts import the real builder; mock `fullUrl` must be absolute; validate `previewUrl`/`stillUrl` with the same allow list; Klipy ids via `String()`; clamp `per_page` 8..50; 404 + `result:false` = auth; `signal` option for debounce; add `*.gif binary` to `.gitattributes`; `verify:gif` without a browser (raw API, one message to #dev). All applied. |

## Phase 3 deltas (threads)

What the Phase 3 brief, docs/PHASE3_PLAN.md and docs/PHASE3_TICKETS.md say versus what is shipped, and why.
The full thread API is in "Threads (Phase 3)" below; the SDK traps in "Thread gotchas (Phase 3)".

| Topic | Brief / plan / tickets say | What is actually shipped | Why |
|---|---|---|---|
| Reply fallback key | brief: `is_falling_back_to_thread: true` | **`is_falling_back: true`** (`m.relates_to: { rel_type: 'm.thread', event_id: <root>, is_falling_back: true, 'm.in_reply_to': { event_id: <latest sent reply, else root> } }`) | Spec (Threading, v1.4+), matrix-js-sdk `IEventRelation`, Element. Synapse accepts the wrong key silently; only Element rendering would reveal it. Advisor-verified. |
| `threadSupport` | brief: in `createClient` | `startClient({ threadSupport: true })` (`src/lib/matrix/client.ts`) | In v43 it is a start option; `client.supportsThreads()` reads `clientOpts`. |
| `isDisplayableEvent` | tickets: additionally drops thread replies | **Unchanged** (thread replies are displayable - the thread panel needs the same predicate); the main-only filter is `isMainTimelineEvent()` and `useRoomTimeline` / `useTimeline({ roomId })` apply it | The SDK already partitions replies out of `room.getLiveTimeline()`; verified (0 leaks, incl. live replies and local echoes). |
| Thread store file | tickets: `src/store/thread.ts` | `src/store/threads.ts` (+ `thread.ts` re-export) | Both import paths work. |
| `useThreadStore` shape | `{ open, openThreadRootId, openThread, closeThread }` + `useOpenThreadRootId()` | Same, plus `openThreadRoomId`, `version`, `closeThread(): boolean`, `useOpenThread()`. `openThread` collapses a reply id to its root, get-or-creates the SDK `Thread`, closes phone drawers; a room switch and logout close it. | Superset. |
| `sourceKey` | `threadRootId ?? roomId` | Same. The store maps are keyed by `threadKey(roomId, rootId)` = `` `${roomId}|${rootId}` `` (`eventsByThread`, `canPaginateBackThread`, `isPaginatingThread`); `eventsByRoom` etc. are untouched. | Phase 1 maps stay as they were. |
| `threadVersion` | on the timeline store | `useTimelineStore.threadVersion` **and** `useThreadStore.version` (mirrors); `version` bumps too | Phase 1 memo deps keep working. |
| `paginateBack` | `useTimelineStore.paginateBack(source, limit)` | `paginateBack(roomId \| source, limit)` on the store, `paginateBack(source)` module export, `paginateBackThread(roomId, rootId, limit)` | Backwards compatible. |
| `useThreadSummary` | `{ count, latestTs, participants, hasUnread, participated }`, participants newest first max 5, `count = max(server, sdk)` | Same + `rootId, roomId, latestEvent?, rootEvent?/root?`; redacted roots -> `null`. `participated` is true for the **root author** too (spec). | - |
| `useRoomThreads` | `{ threads: ThreadInfo[], loading, error, refresh() }`, follows `next_batch` up to 3 pages | `{ threads, loading, error, refresh(), hasMore, loadMore() }`; first call loads one page (newest 30 by activity, `include=all` + `participated`), `loadMore()` pages older ones; `ThreadInfo = ThreadSummary` (`root` and `rootEvent` are the same object) | Explicit paging instead of 3 hidden requests. |
| `replyTo` + `threadRoot` | tickets / AC-T2-3: reject, nothing sent | **Rejected**: `sendText` throws `ThreadReplyConflictError` before sending (quote replies inside threads are out of scope; every thread reply is the `is_falling_back: true` fallback shape) | Acceptance doc wins for the POC (an earlier draft of this row allowed it). |
| Redacted thread replies | - | SDK v43 `makeRedacted` -> `moveAllRelatedToMainTimeline` moves a redacted reply (and its reactions/edits) into the room's live timeline and strips its thread markers. **Store-level guard (primary)**: the bridge records the id from `RoomEvent.Redaction` (still carries the thread id) in `timeline.ts` (`markRedactedThreadReply` / `isRedactedThreadReply`), and `eventsByRoom` snapshots + `useTimeline({ roomId })` skip it. Dev B's view-level guard in `useRoomEvents` stays as a second line. **Residual**: a reply redacted *before* this session loaded has no record and renders as "Message deleted" in the channel after a reload (server/SDK limitation until MSC3389). | Found by Dev B. |
| `sendReadReceipt` | unchanged signature | `(roomId, event, { threadId? })` - the 3rd argument is optional and informational; the SDK derives `thread_id` (`'main'` or the root) from the event | Phase 1 callers unchanged. |
| Thread-scoped typing | brief: `sendTyping` / `useTyping(source)` scoped to the thread | `sendTyping(roomId, typing, timeoutMs?, { threadRoot? })` and `useTyping(source)` accept the thread but are **room-wide** | Matrix has no thread-scoped typing (no spec field, nothing in Synapse). Documented, not faked. |
| Unread (Phase 1 contract change) | PM: `unreadByRoom` main-only, `threadUnreadByRoom` | `RoomSummary.unread` / `unreadByRoom` = `room.getRoomUnreadNotificationCount()` (**main timeline only**); `RoomSummary.threadUnread` / `threadUnreadByRoom[roomId]` = `room.hasThreadUnreadNotification()`; `useThreadUnread(roomId)` reads the same | v43 `getUnreadNotificationCount()` adds every thread's count and a `main` receipt never clears those, so the channel badge would stick. Thread replies no longer count towards the channel badge (Discord semantics). |
| What "unread" means for a thread | - | Server-computed per-thread notification counts (`unread_thread_notifications`, MSC3773 / v1.4; the SDK requests them in its sync filter). Follow the push rules like room unreads; cleared by a receipt with `thread_id` = root (`markThreadRead`), **not** by a main-timeline receipt. Verified: 3 bob/carol replies -> `getThreadUnreadNotificationCount(root) === 3` for alice; `markThreadRead` -> 0 after the next /sync. | Honest and server-backed; no client-side guessing. |
| Phone thread layer | tickets: over the conversation **below the header**, conversation mounted + `inert`/`aria-hidden`; back: thread -> drawers -> minimise. Brief: full screen | Below the header as the tickets say (Dev A turns the header into back + "Thread"); `Conversation` stays mounted (scroll kept), `inert` + `aria-hidden`; z-index under the drawers (edge swipes still work); Android back: thread, then drawers, then minimise | Tickets are more specific than the brief. |
| Desktop member panel | - | Not rendered while a thread is open, re-rendered on close; `useNavUiStore.membersOpen` untouched; pixel-identical when no thread is open | - |
| Thread first page | - | The SDK's initial fetch is `/relations` **without a limit** = Synapse's default of 5 relation events (reactions and edits count), so a busy thread opened with 2-3 replies. `ensureThreadTimeline` waits for that fetch and tops up once (`paginateBack(30)`) when fewer than 20 replies are visible. | Found in verification. |
| Thread local echo | - | SDK v43 `Room.addPendingEvent` (chronological ordering) only offers pending events to the room's own timeline sets, never to a thread's, so a reply's `~` echo would not show until the server echoed it. The bridge adds it to the thread on `LocalEchoUpdated` (`thread.addEvent`); the remote echo is merged, no duplicate. Verified. | Advisor-flagged, confirmed in the browser. |
| `formatRelative` | PM: `just now` / `N min ago` / `N h ago` / `yesterday` / short date | `formatRelative(ts, now?)` in `src/lib/format.ts` (re-exported from utils): `just now` (<60 s), `N min ago`, `N h ago` (<24 h), `yesterday`, `N d ago` (<7 d), else `DD/MM/YYYY` | Pinned strings for Dev A's list and Dev B's summary row. |
| Seed | brief: two threads in #general; tickets: one in #dev (carol root) | **Both** (docs/SEED_DATA.md "Threads"): `general.threadRoot` + `general.threadReply1..3`, `general.reacted` + `general.lateThreadReply1` (sent after alice's last receipt -> unread), `dev.threadRoot` + `dev.threadReply1..3`; carol joins #dev. Next `seed:reset` only. | Brief wins, tickets added. |
| Sample script | tickets: `--as bob --room ... [--root $id] [--replies 3]` | `scripts/send-thread-sample.mjs`: `--room`, `--replies`, `--as` / `--reply-as` (round-robin senders), `--root-as`, `--root <id>` (reply to an existing root), `--body`, `--json` (default `seed/thread-sample.json`); validates the server bundle and `/threads` | Superset. |
| ThreadView | Principal placeholder, Dev B replaces | Dev B's real panel landed in the same wave (ids per docs/PHASE3_ACCEPTANCE.md: `thread-panel`, `thread-root`, `thread-close` (**desktop only**; phone closes via Dev A's `header-back`), `thread-replies-divider`, `thread-message-list`, `thread-typing`, `thread-composer*`). **Reply rows inside the panel keep `message-<id>` ids** (the `thread-` prefix applies to the list, not to rows), so selectors must be scoped: `thread-message-list` vs `message-list`. | Found while pointing `verify:threads` at the real DOM. |
| Escape | - | The shell does **not** bind Escape to the thread (Dev B's composer uses Escape to cancel reply/edit); `thread-close`, Android back and room switch close it | Avoids stealing Escape from the composer. |

### Advisor consultations (Phase 3, Principal)

| Topic | Outcome |
|---|---|
| Advisor agent verification (relayed by the coordinator; probe `docs/advisor/thread-probe.mjs`) | `is_falling_back` not `is_falling_back_to_thread`; `threadSupport: true` works; `room.getThreads()` only knows instantiated threads, use `createThreadsTimelineSets()` + `fetchRoomThreads()` (`/v1/rooms/{id}/threads`); thread history via `paginateEventTimeline(thread.liveTimeline, { backwards })` -> `/relations/{root}/m.thread?dir=b&recurse=true`; the client does **not** re-emit `ThreadEvent.*` (subscribe on the Room), `RoomEvent.Timeline` reaches the client with `timelineSet.thread` set and the Phase 1 bridge dropped exactly those; `getReplyTargetId` must ignore `is_falling_back`; the SDK omits `m.in_reply_to` on the first reply when no `Thread` exists -> `createThread` first; Synapse returns `unsigned.m.relations.m.thread` in /threads, /messages and /sync. All applied. |
| `advisor` tool, completion review | Gaps found: re-run `verify:phone` after the phone `<main>` restructure (Phase 2 invariants with no thread open), ARCHITECTURE described the retired placeholder (fixed above; row-id scoping gotcha added), syntax-check `seed.ts` under Node type stripping (`node --check`), re-export `useOpenThreadRootId` / `ThreadInfo` from `hooks.ts` and `store/index.ts`. All done. |
| `advisor` tool, plan review | Run three empirical checks first: thread local echo (missing in v43 -> bridge fix, do **not** switch to `pendingEventOrdering: Detached`), per-thread unread counts arrive, receipts now carry `thread_id` so `unread_notifications` becomes main-only (document as a Phase 1 contract change). Send path: `createThread` before the first send, fallback target = `thread.lastReply(ev => ev.isRelation('m.thread') && !ev.status)` (never a `~` id), `replyTo` + `threadRoot` -> `is_falling_back: false`, collapse reply ids to the root, pass `threadId` for reactions/edits/redactions of thread replies, `getReactions` from `event.getThread()?.timelineSet.relations`. Bridge: route `RoomEvent.TimelineReset` by `timelineSet.thread` (the Thread resets its timeline when the initial fetch lands), never cache `thread.liveTimeline`. Keep `isDisplayableEvent` unchanged; filter the root out of thread `events`. Seed: post the 1-reply thread after alice's final receipt. Shell: skip rendering the members aside, `--thread-w` token, phone z-index under the backdrop, `resetThreads()` on logout. All applied and verified (`npm run verify:threads`). |

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
    LoadingScreen.tsx          data-testid=app-loading until PREPARED; (Phase 5) data-stage=crypto|sync
    Shell.tsx                  desktop: 72 | 240 | 1fr | auto grid; phone: full-screen column + two drawers (Phase 2); (Phase 5) security hosts
    Drawer.tsx                 off-canvas drawer container (phone), data-testid nav-drawer / member-drawer
    UserFooter.tsx             bottom-left user pill + logout; (Phase 5) data-verified + "Verified" line
    Toast.tsx                  global toasts
    devtools.ts                window.__matrixPoc in dev builds only
    theme.css                  design tokens (the only CSS variables features may use) incl. --safe-*, --tap-target, --vvh
  styles/global.css            reset, scrollbars, utilities (.u-avatar, .u-btn, .u-input, ...), 100dvh, phone-only rules
  lib/
    format.ts                  sanitizeHtml, linkify, formatTime, isSameDay, formatDayDivider, initialsOf, colorFor; (Phase 3) formatRelative
    native.ts                  (Phase 2) isNativeApp, platform/getPlatform, initNative, tap/hapticTap, onAppStateChange
    gif/                       (Phase 4) GIF picker backend, no React, no Matrix; all but provider.ts are Node-loadable
      types.ts                 GifResult, GifPage, GifProvider, GifQueryOptions, GifMessage, GifProviderError
      config.ts                GIF_CONTENT_RATING, GIF_SEND_VARIANT, GIF_IMAGE_HOSTS, GIF_MAX_DIMENSION, KLIPY_DEFAULT_BASE, storage keys
      message.ts               buildGifContent (the wire shape), parseGifContent / isAllowedGifUrl (host allow list), GIF_CONTENT_KEY
      mock-fixtures.ts         MOCK_FIXTURES catalogue (ids, titles, dimensions), MOCK_EMPTY_QUERIES, MOCK_ERROR_QUERY
      mock.ts                  createMockProvider, mockGifResults (own-origin /gif-fixtures/*.gif + .png)
      klipy.ts                 createKlipyProvider, mapKlipyItem, klipyRequestUrl, parseRetryAfter, RATING_TO_CONTENT_FILTER
      provider.ts              getGifProvider / gifProviderName / searchGifs / trendingGifs, key + provider overrides (env + localStorage)
      index.ts                 barrel ('@/lib/gif')
    audio/                     (Phase 2) voice-note primitives, no React, no Matrix
      encode.ts                Shared API: pickVoiceMimeType, encodeToOggOpus, decodeToPcm, computeWaveform, baseMimetype
      recording.ts             startRecording (getUserMedia + MediaRecorder lifecycle), createLevelMeter, pickRecordingMimeType
      analysis.ts              decodeAudio, analyzeAudio, waveformFromSamples, sanitizeWaveform, computeWaveformFromBlob, getAudioDuration
      mime.ts                  containerMimeType, extensionFor, voiceFileName, isAudioMimeType
      index.ts                 re-exports
    matrix/
      config.ts                getHsUrl/setHsUrl/hasHsUrlOverride/normalizeHsUrl, DEFAULT_HS_URL, storage keys, localpartOf, serverNameOf
      mxc.ts                   mxcToHttp (pure; resolves getHsUrl() per call)
      client.ts                getClient, login, register, logout, session persistence, startClient; (Phase 5) initCrypto before startClient, wipe on logout
      crypto.ts                (Phase 5) engine lifecycle: cryptoDatabasePrefix, initCrypto, wipeCryptoStore, cryptoCallbacks, secret-storage key cache
      security.ts              (Phase 5) CryptoApi wrappers: status, SAS verification, UIA (password / SSO fallback), recovery key, backup
      attachment-crypto.ts     (Phase 5) pure AES-256-CTR + SHA-256 attachment scheme (WebCrypto); Node-loadable
      attachments.ts           (Phase 5) EncryptedFile, encrypt/decryptAttachment (re-exported), fetchDecryptedMedia -> blob: URL cache
      media.ts                 authenticated media (service worker); (Phase 5) MediaSource, mediaSourceOf, encrypted openMedia / downloadMedia
      actions.ts               every write + a few aggregate readers (members, reactions); sendVoiceMessage (Phase 2); sendGif (Phase 4); (Phase 5) encrypted uploads, encrypted-by-default rooms
      utils.ts                 read helpers over SDK objects (display names, avatars, getDisplayBody, getVoiceMessage, getGifContent, ...); (Phase 5) isRoomEncrypted, getDecryptionState
  store/
    session.ts                 useSessionStore; (Phase 5) loadingStage, binds/unbinds the security store
    security.ts                (Phase 5) useSecurityStore: status, hint, verification flow, recovery, prompts; bindSecurity/unbindSecurity/resetSecurity
    rooms.ts                   useRoomStore + recomputeRooms + waitForRoom + onRoomSelected (Phase 2); (Phase 5) RoomSummary.encrypted
    layout.ts                  (Phase 2) useLayoutStore, useIsPhone, useViewport, detectIsPhone; stamps <html data-layout>, --vvh; (Phase 4) registerBackHandler, runBackHandlers
    timeline.ts                useTimelineStore + refreshTimeline + setTypingForRoom; (Phase 3) TimelineSource, thread snapshots, paginateBack(source), ensureThreadTimeline
    threads.ts                 (Phase 3) useThreadStore (open thread), useThreadSummary, useThreadRoot, useRoomThreads, useThreadUnread, useOpenThread(RootId)
    thread.ts                  (Phase 3) re-export of threads.ts (docs/PHASE3_TICKETS.md name)
    bridge.ts                  bindClient/unbindClient: SDK events -> stores (debounced); (Phase 3) thread timeline sets, per-room ThreadEvent.*, thread local echo; (Phase 5) MatrixEventEvent.Decrypted
    hooks.ts                   useRoomTimeline, useTyping, useMembers, useRoomSummary, useSelectedRoom, useMyUserId (+ re-exports useIsPhone, useViewport); (Phase 3) useTimeline(source) + thread hooks re-exported; (Phase 5) useRoomEncrypted, useDecryptionState, useDecryptedMediaUrl (= useMediaObjectUrl), security hooks re-exported
    toast.ts                   useToastStore, showToast, withToast
    index.ts                   re-exports
  features/
    navigation/                (Dev A) index.ts exports SpaceRail, ChannelSidebar, ChannelHeader, MemberPanel, useNavUiStore
    conversation/              (Dev B) index.ts exports Conversation and (Phase 3) ThreadView (placeholder by the Principal; Dev B replaces the internals)
    gif/                       (Dev A, Phase 4) GifPicker (search, trending, grid, keyboard, sheet variant)
    security/                  (Dev A, Phase 5) index.ts exports SecurityBanner, SecurityDialogs (the Shell resolves it lazily; absent = renders nothing)
public/gif-fixtures/           (Phase 4) mock-1..8.gif (animated GIF89a) + mock-1..8.png stills, generated by scripts/make-gif-fixtures.mjs
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
scripts/send-thread-sample.mjs (Phase 3) post a thread (root + replies, exact wire shape) via the API, validate the server bundle (npm run thread:sample)
scripts/send-encrypted-sample.mjs (Phase 5) bob posts encrypted texts + an encrypted PNG into #vault with the Node crypto engine, exports keys (npm run e2ee:sample)
scripts/verify-e2ee.mjs        (Phase 5) attachment round trip, room state, wire shape, decrypt with seed/e2ee-keys.json, ciphertext on the server (npm run verify:e2ee)
scripts/lib/e2ee-api.mjs       (Phase 5) Node crypto client helpers, loginWithDevice, downloadMedia, mergeRoomKeys, quietLogger
scripts/verify-thread-shell.mjs (Phase 3) desktop + Pixel 7 Playwright check of the thread core on :5183 + screenshots (npm run verify:threads)
scripts/make-gif-fixtures.mjs  (Phase 4) pure-Node GIF89a + PNG encoder rendering the MOCK_FIXTURES catalogue into public/gif-fixtures (npm run gif:fixtures)
scripts/send-gif-sample.mjs    (Phase 4) bob posts a contract GIF message to #dev via the API using the client's buildGifContent (npm run gif:sample)
scripts/verify-gif.mjs         (Phase 4) no-browser check of the gif core: mock contract, fixtures, wire shape, Klipy mapping, live round trip to #dev, optional real Klipy search (npm run verify:gif)
scripts/lib/gif-api.mjs        (Phase 4) raw API helpers + type-stripped import of src/lib/gif for the two scripts above
scripts/verify-scaffold.mjs    throwaway Playwright smoke (login + screenshot)
homeserver/                    homeserver.yaml (single config, committed), docker-compose.yml, wsl/ (no-Docker fallback), data/* (ignored)
docs/MOBILE.md                 (Phase 2) phone browser path, toolchain, APK, LAN proxy, iOS handoff, troubleshooting
e2e/, playwright.config.ts     (QA)
```

## Ownership

| Owner | Owns | Must not edit |
|---|---|---|
| Principal | `src/app/**`, `src/store/**`, `src/lib/**` (incl. `audio/**`, `gif/**`, `native.ts`), `public/**`, `src/styles/**`, `index.html`, `capacitor.config.ts`, `android/**`, `ios/**`, `seed/**`, `scripts/**`, `homeserver/**`, `package.json`, `.env.example`, `docs/ARCHITECTURE.md`, `docs/MOBILE.md`, root configs | - |
| Dev A | `src/features/navigation/**`, (Phase 4) `src/features/gif/**`, (Phase 5) `src/features/security/**` | anything else |
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
   (`createClient` with `timelineSupport: true`), starts the Rust crypto engine (`initCrypto`, Phase 5; loading stage `crypto`), calls
   `startClient({ initialSyncLimit: 30, lazyLoadMembers: true, pendingEventOrdering: 'chronological', threadSupport: true })`
   (Phase 3: `threadSupport` makes the SDK partition `m.thread` replies into `Thread` models, add `thread_id` to receipts and
   request `unread_thread_notifications`),
   then `bindClient()` subscribes the bridge and `bindSecurity()` the security store (loading stage `sync`), then `waitForPrepared()` resolves on `SyncState.Prepared`.
   Status becomes `'ready'` and the shell renders. The bridge does one full `recomputeRooms()` +
   `refreshTimelines(all rooms)` at PREPARED and again whenever the SDK goes ERROR -> SYNCING (catch-up).
3. From then on every SDK event lands in a store through the bridge with a 50 ms (rooms) / 30 ms
   (timelines) trailing debounce. React re-renders once per burst, never once per event.
4. `logout()` -> server logout (best effort), `stopClient()`, listeners removed, crypto store wiped, localStorage cleared,
   stores and the link-preview cache reset. Token revoked server-side (`HttpApiEvent.SessionLoggedOut`) does the same
   but lands in `'error'` with "Session expired" on the login form.

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
| `unreadByRoom`, `highlightByRoom` | `Record<roomId, number>` | From `room.getRoomUnreadNotificationCount()` - the **main timeline only** since Phase 3 (server-computed; updates after receipts sync back). Thread replies never count here. |
| `threadUnreadByRoom` | `Record<roomId, boolean>` | (Phase 3) `room.hasThreadUnreadNotification()`: some thread in the room has unread notifications (server `unread_thread_notifications`, cleared by threaded receipts). The header "Threads" dot. Same value as `useThreadUnread(roomId)`. |
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

### `useLayoutStore` (`src/store/layout.ts`, Phase 2)

| Member | Type | Semantics |
|---|---|---|
| `isPhone` | `boolean` | `matchMedia('(max-width: 767px)')` **or** `'(pointer: coarse) and (max-width: 1023px)'`, live (AC-M1-3). Desktop Playwright 1280x720 is never a phone. Mirrored as `<html data-layout="phone\|desktop">` and on `app-shell[data-layout]`. |
| `navOpen`, `membersOpen` | `boolean` | Phone drawers (`nav-drawer`, `member-drawer`). Opening one closes the other. Leaving phone mode closes both. Desktop member panel visibility is still Dev A's `useNavUiStore.membersOpen`. |
| `openNav()`, `closeNav()`, `toggleNav()` | `void` | `header-menu` calls `openNav()`. |
| `openMembers()`, `closeMembers()`, `toggleMembers()` | `void` | `member-toggle` on phone calls `openMembers()`. |
| `closeDrawers()` / `closeAll()` | `() => boolean` | Close whichever is open (backdrop, Escape, Android back). True if one was open. |
| `registerBackHandler(fn)` (module export, Phase 4) | `(fn: () => boolean) => () => void` | Android back: handlers run newest first; return true to consume the press (close your sheet). Returns the unregister function. `App.tsx` runs `runBackHandlers() \|\| closeThread() \|\| closeDrawers()` then minimises the app. |
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
| `version` | `number` | Bumps on every timeline/typing commit (and on thread commits). |
| `threadVersion` | `number` | (Phase 3) Bumps on thread snapshot commits and Thread model changes (`ThreadEvent.New/Update/Delete`). |
| `eventsByThread` | `Record<threadKey, MatrixEvent[]>` | (Phase 3) Copy of `room.getThread(rootId).liveTimeline.getEvents()`, oldest first, unfiltered (reactions/edits to replies included; the root is included once the start of the thread is reached). Key = `threadKey(roomId, rootId)` = `` `${roomId}|${rootId}` ``. |
| `canPaginateBackThread`, `isPaginatingThread` | `Record<threadKey, boolean>` | (Phase 3) As the main ones; `canPaginateBackThread` is `true` (unknown) until the Thread's initial `/relations` fetch has run. |
| `paginateBack(roomId \| source, limit=30)` | `Promise<void>` | Main: `client.paginateEventTimeline(liveTimeline, { backwards: true, limit })`, then refreshes the snapshot. Thread source: `paginateEventTimeline(thread.liveTimeline, ...)` = `/relations/{root}/m.thread?dir=b&recurse=true`. No-op while in flight or at the start. |
| `paginateBackThread(roomId, rootId, limit=30)` | `Promise<void>` | (Phase 3) The thread branch, callable directly. |

Helpers: `refreshTimeline(roomId)`, `refreshTimelines(ids)`, `ensureTimeline(roomId)`, `setTypingForRoom`, `resetTimelines`; (Phase 3)
`paginateBack(source, limit?)` (module export), `refreshThread(roomId, rootId)`, `refreshThreads(roomId, rootIds)`,
`ensureThreadTimeline(roomId, rootId): Promise<Thread | null>` (get-or-create the SDK Thread, wait for its initial fetch, top the
first page up to >= 20 visible replies), `bumpThreadVersion()`, `threadKey(roomId, rootId)`, `sourceKey(source)` = `threadRootId ?? roomId`.
`type TimelineSource = { roomId: string; threadRootId?: string }`.

### Hooks (`src/store/hooks.ts`)

| Hook | Returns | Notes |
|---|---|---|
| `useTimeline(source)` | `{ events, allEvents, hasMore, isPaginating, version, paginateBack(limit?) }` | (Phase 3) `{ roomId }` = main timeline: `events` = `allEvents.filter(isMainTimelineEvent)` (messages + stickers, incl. redacted; no reactions/edits/state/**thread replies**). `{ roomId, threadRootId }` = that thread: `events` = the replies (`isDisplayableEvent`, root excluded), oldest first; mounting it calls `ensureThreadTimeline`. Same shape either way (`type Timeline = RoomTimeline`). |
| `useRoomTimeline(roomId)` | same | Phase 1 name = `useTimeline({ roomId })`. Calls `ensureTimeline`. |
| `useTyping(roomId \| source)` | `string[]` | Display names of typing users (never me). Room-wide for a thread source too (Matrix has no thread typing). |
| `useThreadSummary(event)` | `ThreadSummary \| null` | (Phase 3) Summary row data for a root; `null` for messages without a thread. See "Threads". |
| `useThreadRoot(roomId, rootId)` | `MatrixEvent \| undefined` | (Phase 3) Loaded timeline -> Thread model -> `/event`. |
| `useRoomThreads(roomId)` | `{ threads, loading, error, refresh(), hasMore, loadMore() }` | (Phase 3) Thread list, newest activity first. |
| `useThreadUnread(roomId)` | `boolean` | (Phase 3) = `threadUnreadByRoom[roomId]`. |
| `useOpenThread()`, `useOpenThreadRootId()` | `{ roomId, threadRootId } \| null`, `string \| null` | (Phase 3) Selectors over `useThreadStore`. |
| `useMembers(roomId)` | `{ joined: MemberInfo[], invited: MemberInfo[] }` | Sorted by power level desc then name; triggers `loadMembers`. `MemberInfo = { userId, name, avatarUrl, powerLevel, membership, presence }`. |
| `useRoomSummary(roomId)` | `RoomSummary \| undefined` | |
| `useSelectedRoom()` | `RoomSummary \| undefined` | |
| `useMyUserId()` | `string \| null` | |

### Actions (`src/lib/matrix/actions.ts`)

| Function | Signature | Semantics |
|---|---|---|
| `sendText` | `(roomId, body, opts?: { html?, replyTo?: MatrixEvent \| string, mentions?: string[], threadRoot?: string }) => Promise<eventId>` | `m.text`; `html` -> `formatted_body`; `replyTo` -> `m.relates_to.m.in_reply_to`; `mentions` -> `m.mentions.user_ids`. Local echo appears immediately. (Phase 3) `threadRoot` sends into that thread with the wire shape below (local echo in the thread, never in the main list); `replyTo` + `threadRoot` **throws `ThreadReplyConflictError`** before sending (AC-T2-3). |
| `sendHtml` | `(roomId, body, html, opts?) => Promise<eventId>` | (Phase 3) `sendText` with `html`. |
| `editText` | `(roomId, targetEventId, body, html?, opts?: { threadRoot? }) => Promise<eventId>` | Sends `m.replace` with `m.new_content` and `* ` fallback body. A thread reply's edit is routed through its thread (derived from the target when omitted). |
| `redactEvent` | `(roomId, eventId, reason?) => Promise<void>` | Messages, reactions, anything. Thread replies are redacted through their thread (derived). |
| `sendReaction` | `(roomId, targetEventId, key, opts?: { threadRoot? }) => Promise<eventId>` | `m.reaction` / `m.annotation`. Thread derived from the target when omitted. |
| `toggleReaction` | `(roomId, targetEventId, key, opts?) => Promise<void>` | Adds, or redacts my existing reaction with that key. |
| `uploadFile` | `(file: File) => Promise<{ mxc, mimetype, size, name, w?, h? }>` | Media upload; image dimensions measured in the browser. |
| `sendFile` | `(roomId, file, opts?: { threadRoot? }) => Promise<eventId>` | `m.image` for `image/*` (with `info.w/h`), else `m.file`. |
| `sendTyping` | `(roomId, typing, timeoutMs=5000, opts?: { threadRoot? }) => Promise<void>` | Room-wide; `threadRoot` is accepted and ignored (no thread typing in Matrix). |
| `sendReadReceipt` | `(roomId, event: MatrixEvent \| eventId, opts?: { threadId? }) => Promise<void>` | `m.read`. Skips local echoes. (Phase 3) carries `thread_id`: `'main'` for main-timeline events and thread roots, the root id for thread replies - derived from the event by the SDK; `threadId` is only used when the event is an id that is not loaded. |
| `markRoomRead` | `(roomId) => Promise<void>` | Receipt for the newest sent event in the main live timeline (threads keep their own). |
| `markThreadRead` | `(roomId, rootId) => Promise<void>` | (Phase 3) Threaded receipt on the newest loaded reply; clears that thread's unread count. |
| `resolveThreadRoot` | `(roomId, eventId) => string` | (Phase 3) Reply id -> its root; roots / plain ids unchanged (threads never nest). |
| `threadRootOf` | `(roomId, eventId) => string \| undefined` | (Phase 3) Root of a *reply* (wire relation), undefined for roots and plain messages. |
| `ensureThread` | `(roomId, rootId) => Promise<Thread \| null>` | (Phase 3) Get-or-create the SDK `Thread` (fetches the root when not loaded; triggers its initial `/relations` fetch). |
| `fetchRoomThreads` | `(roomId) => Promise<void>` | (Phase 3) `createThreadsTimelineSets()` + `fetchRoomThreads()` = `GET /v1/rooms/{id}/threads?include=all|participated` (newest 30), once per room. |
| `hasMoreRoomThreads`, `loadMoreRoomThreads` | `(roomId) => boolean`, `(roomId, limit=30) => Promise<boolean>` | (Phase 3) Thread-list paging. |
| `createChannel` | `({ spaceId, name, topic?, encrypted? }) => Promise<roomId>` | `preset: public_chat`, `visibility: private`, encrypted unless `encrypted: false` (Phase 5), `m.space.parent` on the room, `m.space.child` (next `order`) on the space. |
| `createSpace` | `({ name, topic? }) => Promise<spaceId>` | `m.space`, public preset, then `createChannel({ name: 'general' })`. |
| `inviteUser` | `(roomId, userId) => Promise<void>` | Throws `MatrixError` (e.g. unknown user). |
| `createDm` | `(userId, { encrypted? }) => Promise<roomId>` | Encrypted unless `encrypted: false` (Phase 5). Reuses a joined room from `m.direct`; else `is_direct` + `trusted_private_chat` + invite, and updates `m.direct`. |
| `findDmRoomId`, `getDirectMap` | sync | `m.direct` readers. |
| `joinRoom` | `(roomIdOrAlias) => Promise<roomId>` | |
| `leaveRoom` | `(roomId) => Promise<void>` | |
| `getJoinedMembers`, `getInvitedMembers` | `(roomId) => RoomMember[]` | Sync readers (lazy-loaded; see `loadMembers`). |
| `loadMembers` | `(roomId) => Promise<void>` | `room.loadMembersIfNeeded()`; the store `version` bumps when they arrive. |
| `getReactions` | `(roomId, eventId) => { key, count, mine, senders, myEventId? }[]` | From `timelineSet.relations`; safe in render. (Phase 3) Reads the thread's relations when the target is a thread reply, so one call works in both panels. |
| `fetchEvent` | `(roomId, eventId) => Promise<MatrixEvent \| undefined>` | Local timelines (main and threads) first, then `/rooms/{id}/event/{eventId}` (through the SDK event mapper). For reply quotes whose target is not loaded. |
| `canRedactEvent` | `(roomId, event) => boolean` | `room.currentState.maySendRedactionForEvent`. |
| `canEditEvent` | `(event) => boolean` | Own, non-redacted `m.room.message`; (Phase 4) false for GIF messages. |
| `myPowerLevel` | `(roomId) => number` | |
| `retryOnRateLimit` | `(fn: () => Promise<T>, label?) => Promise<T>` | Retries `fn` on 429 honouring `retry_after_ms` up to 30 s total, then throws `RateLimitedError` (`.retryAfterMs`, readable `.message`). Already applied inside `createChannel`, `createSpace`, `createDm`, `inviteUser`, `joinRoom`. |
| `sendVoiceMessage` (Phase 2) | `(roomId, blob: Blob, { durationMs: number, waveform: number[], mimetype: string }) => Promise<eventId>` | `uploadContent(blob, { name: 'Voice message.<ext>', type, includeFilename: true })` then sends **exactly** the contract content below. `mimetype` is reduced to its base type; `waveform` is sanitised (ints 0..1024, resampled to 100 when > 120); `durationMs` rounded. Throws on upload/send failure (Dev B shows `recording-error`). |
| `sendGif` (Phase 4) | `(roomId, gif: GifResult, opts?: { threadRoot? }) => Promise<eventId>` | `m.text` with `body: "<title> <url>"` + `dev.matrixpoc.gif` (`buildGifContent(gif)`, shape in "GIFs (Phase 4)"); **nothing is uploaded**. `threadRoot` adds the Phase 3 relation. Local echo appears immediately; throws on send failure (Dev B shows the `Could not send GIF` toast). |

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
`isPendingEvent(e)`, (Phase 3) `isThreadReply(e)`, `isThreadRoot(e)`, `getThreadRootId(e)`, `getThreadRelation(e)`,
`getThreadServerSummary(e) => { count, latestEvent?, participated } | null`, `isMainTimelineEvent(e)`, `formatRelative(ts)`, and

```ts
getDisplayBody(event) => { text, html?, msgtype, isEdited, isRedacted, replyTo?, url?, info?, mentions, voice?, threadRoot?, gif? }
```
`replyTo` is **undefined for the thread fallback** (`m.in_reply_to` with `is_falling_back: true` - the previous reply, not a
quote); `threadRoot` is set for thread replies.
`text`/`html` already reflect the latest edit (the SDK swaps `getContent()` when the `m.replace` arrives) and have
legacy reply fallbacks stripped. Sanitise `html` with `sanitizeHtml()` from `src/lib/format.ts` before rendering.
`voice` (Phase 2) is `getVoiceMessage(event) ?? undefined` for `m.audio` events.
`gif` (Phase 4) is `getGifContent(event) ?? undefined`: present only for `m.text` events whose `dev.matrixpoc.gif` validates (see "GIFs (Phase 4)");
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

## Threads (Phase 3)

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

## GIFs (Phase 4)

Slack-style GIF picker backed by Klipy (Tenor is gone, Giphy is paid), with a keyless mock. Plan: docs/PHASE4_PLAN.md;
contract + testids: docs/PHASE4_ACCEPTANCE.md. Everything below is Principal-owned (`src/lib/gif/`, `sendGif`, `getGifContent`,
`public/gif-fixtures/`); the picker is Dev A's `src/features/gif/`, the composer/timeline side is Dev B's.

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

getGifProvider(): GifProvider             // memoised per (provider, key, base); re-reads localStorage on every call
gifProviderName(): 'klipy' | 'mock'        // matrix-poc.gifProvider override -> key present ? klipy : mock
searchGifs(q, opts?) / trendingGifs(opts?) // one-liners over getGifProvider()
getGifApiKey() / setGifApiKey(key | null)  // runtime key (localStorage matrix-poc.gifApiKey) over VITE_GIF_API_KEY
setGifProvider('klipy' | 'mock' | null)    // force a provider (alias setGifProviderOverride); getGifProviderOverride()
buildGifContent(gif): GifMessageContent    // the wire shape below (pure)
parseGifContent(content, { origin? }): GifMessage | null   // validator (pure); isAllowedGifUrl(url, { origin? })
createKlipyProvider({ apiKey, baseUrl?, locale?, customerId?, contentFilter?, fetch? }), mapKlipyItem(item), klipyRequestUrl(...), parseRetryAfter(h)
getGifCustomerId()                         // random UUID in localStorage matrix-poc.gifCustomerId; getGifProvider() sends it as customer_id
createMockProvider({ baseUrl?, basePath?, delayMs? }), mockGifResults(opts), MOCK_FIXTURES, MOCK_EMPTY_QUERIES, MOCK_ERROR_QUERY
GIF_CONTENT_RATING = 'medium', GIF_SEND_VARIANT = 'hd', GIF_IMAGE_HOSTS, GIF_MAX_DIMENSION = 2000, GIF_CONTENT_KEY = 'dev.matrixpoc.gif'
```

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
URL preview unfurls it); no `format` / `formatted_body` / top-level `url` / `info`; `m.relates_to` (Phase 3 thread relation) when
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

### GIF gotchas

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

## data-testid convention

`data-testid`, kebab-case, `{area}-{element}`; dynamic suffix is the raw Matrix id (`channel-item-!abc:localhost`,
`message-$xyz`, `member-item-@bob:localhost`, `reaction-👍`). Helper attributes: `data-name` (room/user display name),
`data-sender`, `data-count`, `data-mine`, `data-selected`. The full registry is `docs/ACCEPTANCE.md` (+
`docs/PHASE2_ACCEPTANCE.md`); the Principal-owned ids are `login-form`, `login-username`, `login-password`,
`login-submit`, `login-register-toggle`, `login-error`, `app-loading`, `app-shell` (+ `data-layout`), `current-user`,
`logout-button`, `toast`, `empty-state`, and since Phase 2 `login-advanced-toggle`, `login-hs-url`, `login-hs-url-reset`,
`login-hs-url-effective`, `nav-drawer` (+ `data-open`), `member-drawer` (+ `data-open`), `drawer-backdrop` (+ `data-open`),
and since Phase 3 `thread-panel-container` and `app-shell[data-thread-open]` (the `thread-*` ids inside belong to `ThreadView`).
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

Phase 3:

```
npm run thread:sample              # alice root + 3 replies (bob/carol) in #dev via the API; validates; writes seed/thread-sample.json
npm run dev -- --port 5183 && npm run verify:threads   # thread core check (desktop + Pixel 7) + docs/screenshots/phase3-thread-shell*.png
```

Phase 4:

```
npm run gif:fixtures               # regenerate public/gif-fixtures/mock-1..8.{gif,png} from src/lib/gif/mock-fixtures.ts (byte-stable)
npm run gif:sample                 # bob posts a contract GIF (mock-7) to #dev via the API; --id mock-3 --room '#general:localhost' --root <id> --origin <url>
npm run verify:gif                 # no browser: mock contract, fixtures, wire shape, Klipy mapping/urls/errors, alice -> #dev round trip; real Klipy search when VITE_GIF_API_KEY is set
```

`.env`: `VITE_GIF_API_KEY=<Klipy app key>` switches the picker to Klipy (unset = mock). Runtime: `localStorage['matrix-poc.gifApiKey']`,
`localStorage['matrix-poc.gifProvider'] = 'klipy' | 'mock'` (QA; wins over keys). `VITE_GIF_API_BASE` points the provider at a stub origin.

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

## Thread gotchas (Phase 3, matrix-js-sdk v43 + Synapse 1.162)

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

## Encryption (Phase 5)

Boot: `startClientFromSession(session, { onSyncState?, onCryptoLoading? })` -> `createClient({ ..., cryptoCallbacks, verificationMethods: ['m.sas.v1'] })` -> `initCrypto` -> `startClient` -> `bindClient` -> `bindSecurity` -> Prepared. Logout: `unbindSecurity` -> `unbindClient` -> `logout()` (stop, wipe) -> `reset*` stores.

### `src/lib/matrix/crypto.ts` (engine lifecycle; features never import it)
`CRYPTO_DB_PREFIX`, `cryptoDatabasePrefix({ userId, deviceId })`, `VERIFICATION_METHODS`, `initCrypto(client, session): Promise<boolean>`,
`getCryptoError(): string | null`, `wipeCryptoStore(client, session)`, `cryptoCallbacks` (`getSecretStorageKey({ keys }, name)` = a cached key
by id, then by value (`findCachedSecretStorageKey(keys, cached, checkKey)`, pure, unit-tested), else the registered prompt for the default key id
if offered, validated with `secretStorageKeyMatches` before caching; `cacheSecretStorageKey`), `setSecretStorageKeyPrompt(fn | null, { defaultKeyId? })`
(`fn(keyInfo, keyId, { secretName?, differentKey })`), `SecretStorageKeyMissError { reason: 'cancelled' | 'wrong-key' |
'no-key' }` (the callback throws it instead of answering null; the SDK propagates it; a typed key is cached only when the description has a MAC), `cacheSecretStorageKey`, `hasCachedSecretStorageKey`, `clearSecretStorageKeyCache`, `resolveRecoveryInput(input, keyInfo)` (recovery key or
passphrase -> raw key, checked against the description). Importable from plain Node (no `@/`, no runtime client.ts import).

### `src/lib/matrix/security.ts` (CryptoApi wrappers; the store calls these)
- `getCryptoApi()`, `isCryptoReady()`, `getOwnDeviceStatus(): Promise<OwnDeviceStatus>`, `getKeyBackupSummary()`, `getEventEncryptionInfo(event)`.
- `OwnDeviceStatus { deviceId, verified, hasCrossSigningKeys, crossSigningReady, secretStorageReady, defaultKeyId, backup: KeyBackupSummary { version: string | null, trusted, keyCached, enabled } }`.
- Verification: `requestOwnUserVerification()`, `requestDeviceVerification(userId, deviceId)`, `onVerificationRequestReceived(listener) => off`, `startSas(request)`.
- UIA: `UiaOptions { password?: () => Promise<string | null>; sso?: (url, popupBlocked) => Promise<void> }`, `makeUiaCallback(opts)`, `ssoFallbackUrl(session)`.
- Recovery: `RecoveryKeyError { kind: 'none' | 'invalid' | 'wrong' }`, `checkRecoveryKey(input) => { keyId, key }`, `unlockWithRecoveryKey(input, { uia?, onProgress? }) => UnlockResult { verified: true, restore: KeyBackupRestoreResult | null, restoreError?: { reason: RestoreFailureReason, message } }` (verification is the success condition, the restore is best effort; `RestoreFailureReason = 'cancelled' | 'wrong-key' | 'no-key' | 'failed'`), `attemptRestoreFromBackup(onProgress?)` (the same restore, classified instead of thrown), `restoreFromBackup(onProgress?)` (`{ total: 0, imported: 0 }` when there is no backup), `setupRecovery({ passphrase?, reset?, uia? }) => recoveryKey` (cross-signing first, then secret storage + backup; throws when secret storage already exists and `reset` is not set).

### `useSecurityStore` (`src/store/security.ts`; re-exported from `@/store`)
State `{ cryptoReady, cryptoError, status: OwnDeviceStatus | null, hint: 'setup' | 'verify' | 'unlock' | null, verification: VerificationFlow | null, recovery: RecoveryState, prompt: PendingPrompt | null, newRecoveryKey: string | null, backupRemaining: number | null, version }` (`backupRemaining` = keys still to upload, from `CryptoEvent.KeyBackupSessionsRemaining`; show "Backing up N keys" while > 0).
- `VerificationFlow { stage: 'requested' | 'ready' | 'started' | 'sas' | 'done' | 'cancelled', initiatedByMe, isSelf, otherUserId, otherDeviceId?, sas: { emoji: [symbol, name][] (7), decimal? } | null, error }`. One flow at a time; the SAS starts by itself once both sides are ready; verified: both call `confirmSas()`.
- `RecoveryState { busy: 'unlock' | 'restore' | 'setup' | null, progress: { imported, total } | null, lastRestore: { imported, total } | null, error, errorKind?: 'none' | 'invalid' | 'wrong', backupLocked: { reason: RestoreFailureReason, message } | null }` (`backupLocked` = verified but the backup stayed locked: set by an unlock whose restore failed, or a restore that failed on the key; cleared by a successful restore / setupRecovery / new unlock; the recovery dialog's `locked` phase). (`errorKind` = `RecoveryKeyError.kind` when the key itself failed: no recovery key on the account / not a key or passphrase / does not open secret storage; absent for other failures. Match on it, never on `error` text).
- Incoming requests: `bindSecurity` tracks every live `VerificationRequestReceived`; a finished (`done` / `cancelled`) flow is replaced, and an active one is cancelled (`request.cancel()`) so the newest request wins (AC-E4-7). **Engine rule** (verified, Rust crypto 18.9): a second concurrent request from the *same user* is refused: it arrives already cancelled (`m.user`) and the engine cancels the first one with `m.user` too, so the store shows the active flow as `cancelled` ("Cancelled (m.user)") and ignores the dead newcomer; the other device simply requests again (that request is tracked). The replace-on-arrival path applies to requests the engine lets through (another user, or after the earlier flow ended).
- `PendingPrompt { kind: 'password' | 'recovery-key' | 'sso', message, secretName?, differentKey?, url?, popupBlocked? }`: render while non-null (busy or not), answer with `answerPrompt(value | null)` (`'done'` for `sso`; null cancels). Closing a dialog never answers it: only an explicit Cancel does.
- Actions: `refresh()`, `startSelfVerification()`, `acceptVerification()`, `cancelVerification()`, `confirmSas()`, `mismatchSas()`, `dismissVerification()`, `unlockWithRecoveryKey(input): Promise<boolean>`, `restoreFromBackup()`, `setupRecovery({ passphrase?, reset? }): Promise<string | null>` (the key is also in `newRecoveryKey` until `dismissRecoveryKey()`), `answerPrompt(value)`.
- `securityHint(status)`, `useSecurityHint()`; `bindSecurity(client)` / `unbindSecurity()` / `resetSecurity()` are called by the session store.

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

## Encryption gotchas (Phase 5, matrix-js-sdk v43 + Rust crypto)

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
- **Two secret-storage keys** (production hang, 2026-10-18): an account whose 4S was re-created by another client can keep `m.megolm_backup.v1` encrypted under an older, non-default key while the cross-signing keys sit under the default one. Unlock then verifies the device and *afterwards* the SDK asks `getSecretStorageKey` for the other key id. The callback matches cached keys by value too (one recovery key under two ids), and otherwise prompts (`differentKey: true`); the recovery dialog must render that prompt while busy, or the SDK waits forever. A cancelled / wrong prompt ends in `locked` (verified, backup locked) with "Enter other key" and "Reset backup" (`setupRecovery({ reset: true })`), never in a failed unlock.
- **Playwright**: the repo's Playwright 1.63 wants Chromium 1243; the box has 1194 under `/opt/pw-browsers` (`chromium.launch({ executablePath })`).
