# Phase 4 Tickets

Priorities: **P0** = a demo script in docs/PHASE4_PLAN.md breaks without it. P1 = demo noticeably better. P2 = polish. Work top-down inside your column. Estimates are focused hours. Numbering continues from Phase 3 (Principal resumes at 13, Dev A at 20, Dev B at 23, QA at 19).

## Ownership map (hard rule, as docs/PHASE3_TICKETS.md)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Principal | `src/app/**`, `src/store/**`, `src/lib/**` (new `src/lib/gif/`), `public/**` (new `public/gif-fixtures/`), `index.html`, `capacitor.config.ts`, `scripts/**`, `package.json`, `.env.example`, `docs/ARCHITECTURE.md`, `docs/MOBILE.md` | - |
| Dev A | `src/features/gif/**` (new folder, exports `GifPicker` from its `index.ts`) | anything else (Dev A does **not** touch `src/features/navigation/**` this phase) |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:*` script lines in `package.json` | anything else |

Shared-layer needs go in your report as **Request to Principal: file, function, shape, why**. Devs build against the table below from day 1; names are **subject to the Principal's ARCHITECTURE deltas** (docs/ARCHITECTURE.md "Phase 4 deltas" wins), wire shapes and the mock fixture contract in docs/PHASE4_ACCEPTANCE.md are not. Everyone: one browser context per spec, no parallel Playwright workers on this machine.

## Shared API (Principal exposes; devs consume only)
Realigned 2026-10-09 to the shipped `src/lib/gif/` (the code wins; `src/lib/gif/types.ts` is the reference). The mock fixture contract in docs/PHASE4_ACCEPTANCE.md is unchanged.

| Module | Export | Shape / rule |
|---|---|---|
| `@/lib/gif` (`types.ts`) | `GifResult` | `{ id: string, title, previewUrl, previewMimetype: 'image/webp' \| 'video/mp4' \| 'image/gif', previewW, previewH, fullUrl, fullW, fullH, fullSize?, stillUrl?, mimetype: 'image/gif', provider: GifProviderName }`; URLs absolute; `stillUrl` is Klipy's `sm.jpg`, the mock's `<id>.png`. |
| | `GifPage`, `GifQueryOptions`, `GifRating`, `GifProviderName`, `GifProviderError` | `{ results: GifResult[], nextPage: number \| null, hasNext }` (provider order, never re-sorted); `{ page?, limit?, rating?: 'g' \| 'pg' \| 'pg-13' \| 'r', signal? }`; `'klipy' \| 'mock'`; `Error` with `kind: 'auth' \| 'rate-limit' \| 'network' \| 'bad-response' \| 'aborted'`, `status?`, `retryAfterMs?`. |
| | `GifMessage`, `GifMessageContent`, `GIF_CONTENT_KEY` | The wire field `dev.matrixpoc.gif` (`provider, id, title, url, w, h, previewUrl?, previewW?, previewH?, stillUrl?`) and the full `m.text` content; `buildGifContent(gif)`, `parseGifContent(content, { origin? })`, `isAllowedGifUrl(url)`. |
| `@/lib/gif` (`provider.ts`) | `getGifProvider()`, `gifProviderName()`, `setGifProvider(name \| null)`, `setGifApiKey(key \| null)`, `getGifApiKey()` | `GifProvider { name, search(q, opts), trending(opts) }`. Resolution: `localStorage['matrix-poc.gifProvider']` (forces) -> key present (`matrix-poc.gifApiKey` -> `VITE_GIF_API_KEY`) ? `klipy` : `mock`. Read on every call. `'klipy'` with no key -> every call rejects `kind: 'auth'`. No top-level `searchGifs`/`trendingGifs`. Debouncing is the caller's (Dev A, 300 ms); abort via `opts.signal`. |
| `@/lib/gif` (`config.ts`) | `GIF_CONTENT_RATING = 'medium'`, `GIF_SEND_VARIANT = 'hd'`, `GIF_IMAGE_HOSTS` (`static.klipy.com`, `static1.`, `static2.`), `GIF_MAX_DIMENSION = 2000`, `KLIPY_DEFAULT_BASE`, `GIF_PROVIDER_STORAGE_KEY`, `GIF_API_KEY_STORAGE_KEY`, `GIF_CUSTOMER_ID_STORAGE_KEY` | Constants; `VITE_GIF_API_BASE` overrides the API origin. Klipy clamps `limit` to 8..50 (default 24) and sends a stable `customer_id`. |
| `@/lib/gif` (`mock-fixtures.ts`) | `MOCK_FIXTURES`, `MOCK_FIXTURE_PATH`, `MOCK_EMPTY_QUERIES` (`__empty__`, `nothing-here`), `MOCK_ERROR_QUERY` (`__error__`) | The 8-fixture table (ids, titles, dimensions) from the contract; Dev A's dev harness and QA may import it. |
| `@/lib/gif` (`klipy.ts`) | `createKlipyProvider`, `mapKlipyItem`, `klipyRequestUrl` | Path-segment key, `search`/`trending`, `page`/`per_page`/`content_filter`/`customer_id` (+`locale` when configured), mapping per AC-G2-2, errors by `kind`. Features import only the provider interface. |
| `src/lib/matrix/actions.ts` | `sendGif(roomId, gif: GifResult, { threadRoot? })` | `buildGifContent(gif)` + the Phase 3 relation when `threadRoot`; sends via `sendRoomMessage`; resolves with the event id; no fetch, no upload. |
| `src/lib/matrix/utils.ts` | `getGifContent(event): GifMessage \| null`, `isGifEvent(event)`, `getDisplayBody(event).gif` | `parseGifContent` with the host allow list; `canEditEvent` is false for GIF events; `previewText` of a GIF event is `[gif] <title>` (reply quotes, thread list, channel previews). |
| `src/store/layout.ts` | `registerBackHandler(fn: () => boolean): () => void` | Android back: the Shell calls registered handlers newest-first before its own order (thread -> drawers -> `minimizeApp`); a handler returning `true` consumed the press. Dev B registers one while the GIF picker is open on phone. |
| `src/app/devtools.ts` | `window.__poc.gif` | `{ provider: getGifProvider, providerName, setProvider, setApiKey }` for AC-G1 / QA `page.evaluate`. |
| `src/app/**`, `index.html`, `capacitor.config.ts`, `src/lib/format.ts` | image host allow list | `https://static*.klipy.com` images load in the dev build and the Android WebView (CSP `img-src` if any, sanitizer untouched for the custom field, Capacitor config). |
| `@/features/gif` | `GifPicker` | `<GifPicker variant="popover" \| "sheet" initialQuery? onPick(gif) onClose() />` from Dev A's `index.ts`. Dev A owns the box (sheet: fixed, bottom safe-area, 2 columns; popover: 420 x 480 max, no positioning of its own) and closes only via Escape inside it and `gif-close`. Dev B owns the mount: positioning, `gif-backdrop`, click-outside, Escape at the mount level, exactly one instance per page. |
| `public/gif-fixtures/` | `mock-1..8.gif`, `mock-1..8.png` | Per the fixture contract; generated by `scripts/make-gif-fixtures.mjs` (`npm run gif:fixtures`), committed. |
| `scripts/send-gif-sample.mjs` | `npm run gif:sample` | `--as bob --room '#general:localhost' [--id mock-7] [--root $id] [--origin http://localhost:5173]`; prints `{ roomId, eventId }`. |

---

## Principal

| ID | P | Title | Est |
|---|---|---|---|
| PRIN-13 | P0 | `src/lib/gif/` abstraction, resolver, mock provider, fixture generator | 5h |
| PRIN-14 | P0 | `klipy` provider | 3h |
| PRIN-15 | P0 | `sendGif`, `getGifContent`, image host allow list | 3h |
| PRIN-16 | P1 | `scripts/send-gif-sample.mjs`, `.env.example`, MOBILE + ARCHITECTURE deltas | 2h |

**PRIN-13 Core + mock** - `src/lib/gif/{types,config,index}.ts` and `providers/mock.ts` per the table (resolver order, cache, abort). `scripts/make-gif-fixtures.mjs`: pure-Node GIF89a encoder (global palette, 2 frames, NETSCAPE loop extension, LZW; no ffmpeg on this machine) plus a PNG still (reuse the CRC/zlib approach of `e2e/fixtures/make-test-assets.mjs`), byte-stable, writing `public/gif-fixtures/` per the fixture contract; `gif:fixtures` in `package.json`. Mock search/trending/`__empty__`/`__error__`/paging rules exactly as the contract; `window.__poc.gif` in `devtools.ts`. Verify with a probe: `/gif-fixtures/mock-1.gif` starts with `GIF89a`, two image descriptors, Chrome animates it. AC: AC-G1-1..3.

**PRIN-14 Klipy provider** - `providers/klipy.ts`: URL = `https://api.klipy.com/api/v1/${key}/gifs/{search|trending}` with `q`, `page`, `per_page`, `content_filter`, `locale`; map items per AC-G2-2 (`String(item.id)`, `hd`->`md`->`sm` gif for `url`, `sm` webp->mp4->gif for the preview, `sm.jpg` still), `hasNext` from `data.has_next`; non-2xx and `result: false` -> `GifProviderError(status)`; `signal` passed to `fetch`. No key is committed anywhere; the fake key in QA's tests is `e2e-fake-key`. Reference: the Advisor's findings in docs/PHASE4_PLAN.md "Klipy API facts" (no live probe is possible without a key; keep the mapping in one function so the stakeholder's first live run can fix it fast). AC: AC-G2-1..4 (AC-G2-4's debounce half is Dev A's).

**PRIN-15 Send + read + hosts** - `actions.ts` `sendGif` (contract body and field, `threadRoot`); `utils.ts` `getGifContent` with the allow list, `canEditEvent` false for GIF events, `previewText` -> `[gif] <title>`; `layout.ts` `registerBackHandler` wired into the Shell's back order; check `index.html` / `capacitor.config.ts` / `src/lib/format.ts` so a `static.klipy.com` `<img>` is never blocked (add a CSP `img-src` entry only if a CSP exists); confirm on the Android WebView once (AC-G3-5, manual). Verify with a probe: send via `sendGif` under `mock`, fetch the event back, compare field by field; send a forged field via API and confirm `getGifContent` is `null`. AC: AC-G3-1..5.

**PRIN-16 Sample script + docs** - `scripts/send-gif-sample.mjs` modelled on `send-thread-sample.mjs` (login as bob, contract content via `buildGifContent` from `MOCK_FIXTURES`, `--root` adds the thread relation, JSON out); `gif:sample` in `package.json`. `.env.example`: `VITE_GIF_API_KEY` (optional; Partner Panel `https://partner.klipy.com/api-keys`; mock fallback; extractable from the APK). docs/MOBILE.md: rebuild note, phone needs internet for `static.klipy.com`. docs/ARCHITECTURE.md "Phase 4 deltas": names, resolver order, the hot-link decision and Klipy rules, the static-thumbnail note for user-attached GIFs (`docs/advisor/gif-thumb-probe.mjs`). AC: AC-G10-1/2.

---

## Dev A - GIF picker (`src/features/gif/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-A-20 | P0 | `GifPicker`: popover + sheet, search (debounce), trending, grid, states, attribution | 5h |
| DEV-A-21 | P0 | Keyboard navigation, selection, focus trap | 2h |
| DEV-A-22 | P1 | Load more (`gif-load-more`), mp4 previews, aspect reservation | 2h |
| DEV-A-23 | P2 | Picker polish | 1h |

**DEV-A-20 Picker** - `components/GifPicker.tsx` + css, `hooks/useGifSearch.ts` (query state, 300 ms debounce, `AbortController` per request via `opts.signal`, `getGifProvider().search/trending`, trending when empty, `loading`/`error` (by `kind`)/`results`/`nextPage`, `retry()`), `index.ts` export. Registry ids with `data-variant` / `data-provider` (`gifProviderName()`), placeholder and attribution per provider (AC-G4-7), heading, grid in API order (never sort or filter, AC-G4-3), `gif-item-{id}` with `data-index`/`data-w`/`data-h`, `<img>` previews (mp4 is DEV-A-22), `gif-loading` only while the grid is empty, `gif-empty`, `gif-error` + `gif-error-retry`, `gif-close` and Escape *inside the picker* -> `onClose` (no backdrop, no outside-click listener: the mount owns those), click tile -> `onPick` once. Sheet variant: `position: fixed`, bottom safe-area, 55-85 % height, 2 columns, 44 px targets, 16 px input font; popover variant: 3 columns, 420 x 480 max, no positioning of its own. Build against `mock` first; a `__dev__` harness like `src/features/conversation/__dev__/` is fine. AC: AC-G4-1..7, AC-G9-1 (sheet half), AC-G9-3 (font/size half), AC-G2-4 (debounce half).

**DEV-A-21 Keyboard** - `role="listbox"`/`option`, `aria-activedescendant`, `data-selected`, arrow keys with column-aware up/down and clamping, `scrollIntoView({ block: 'nearest' })`, Enter -> `onPick`, Escape -> `onClose`, printable keys refocus `gif-search`, Tab trapped inside the picker, index 0 pre-selected when results arrive for an `initialQuery` (so Enter sends straight away). AC: AC-G5-1..4.

**DEV-A-22 Load more + video** - `gif-load-more` sentinel with an IntersectionObserver fetching `nextPage` while it is not `null`; `<video muted autoplay loop playsinline>` for `previewMimetype: 'video/mp4'`; tiles reserve `aspect-ratio: previewW / previewH`. AC: AC-G4-8.

**DEV-A-23 Polish** - hover title tooltip, `Clear` button in the search box, loading skeleton tiles instead of a spinner, remember the last query per session. No new AC.

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-B-23 | P0 | Slash commands, `composer-gif`, mounting the picker (popover / sheet) | 3h |
| DEV-B-24 | P0 | Send flow: `gif-pending`, `sendGif`, error toast, one in flight | 2h |
| DEV-B-25 | P0 | `GifMessage` rendering: badge, offscreen unmount, reduced motion, fallback | 4h |
| DEV-B-26 | P1 | Thread composer + phone integration | 1h |

**DEV-B-23 Triggers + mount** - `Composer.tsx`: `composer-gif` (lucide `ImagePlay` or similar, title `Send a GIF`, via `tid`) between attach and the input, same height as the other buttons; a `parseSlashGif(text)` helper (`/^\/(gif|giphy)(?:\s+(.*))?$/i`, trimmed) checked in the Enter handler before `sendText`: match -> clear the input, open the picker with the query, send nothing; no match -> unchanged send path. Picker state is **page-global**, not per source: `useConversationUi.gifPicker: { sourceKey, initialQuery } | null` (`openGifPicker(source, query?)`, `closeGifPicker()`); the `Conversation` (channel or panel) whose `sourceKey` matches renders the single `<GifPicker>`, so opening from the panel replaces a channel-opened one; `variant` from `useIsPhone()`, popover positioned in a wrapper above the composer (`position: absolute; bottom: 100%`); the mount renders `gif-backdrop` (popover and sheet) and handles click-outside and Escape at the mount level, closes on room change, and returns focus to the input on any close; reply banner untouched. AC: AC-G6-1..7.

**DEV-B-24 Send flow** - `onPick`: close the picker, set `gifPending` for that source, `sendGif(roomId, gif, { threadRoot })`, clear on resolve/reject; reject -> `useToastStore` `Could not send GIF`; `composer-gif` disabled and `/gif` Enter ignored while pending; focus stays in the input. AC: AC-G7-1..4.

**DEV-B-25 Rendering** - `components/GifMessage.tsx` + css, chosen by `MessageBody` when `getGifContent(event)` is non-null (before the text path): `message-gif` with `data-provider`/`data-gif-id`/`data-state`, `message-gif-img` sized by the AC-B4 `fitted()` rule (share the helper from `ImageAttachment`), `alt` = title, `message-gif-badge`; `useInView` (IntersectionObserver, `rootMargin: '200px'`) -> `offscreen` unmounts the `<img>` into `message-gif-placeholder` of the same box; `prefers-reduced-motion` (`matchMedia`) -> `paused` with `stillUrl` or the placeholder plus `message-gif-play`; `onError` -> `fallback` with `message-gif-fallback` (title + `url` link). The plain body is not rendered for GIF rows; `message-action-edit` hidden (`canEditEvent` is false anyway); reply quotes use `previewText`. Keep stick-to-bottom and pagination anchoring unaffected (fixed box size). AC: AC-G8-1..6.

**DEV-B-26 Thread + phone** - `thread-composer-gif` through the `tid` prefix, picker in the panel with `threadRoot` sends, one instance rule; phone: opening the sheet calls `useLayoutStore.closeAll()`, Android back order (sheet -> thread -> drawers) via `registerBackHandler` while the sheet is open. AC: AC-G6-6, AC-G7-4, AC-G9-2 (sheet half), AC-G9-4.

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est |
|---|---|---|---|
| QA-19 | P0 | Stubs (Klipy API + CDN), quota guard, provider override, `sendGifMessage`, fixture checks | 3h |
| QA-20 | P0 | `e2e/gif.spec.ts` (desktop, AC-G1..G8) | 5h |
| QA-21 | P0 | `e2e/mobile-gif.spec.ts` (phone: sheet, button, slash, send, rendering) | 2h |
| QA-22 | P0 | Demo step 12 in both smoke specs + final runs | 2h |
| QA-23 | P1 | docs/BUGS.md Phase 4 section | 1h |

**QA-19 Fixtures** - `e2e/fixtures/gif.ts`: `useGifProvider(page, 'mock' | 'klipy')` (sets `matrix-poc.gifProvider` and, for klipy, `matrix-poc.gifApiKey = 'e2e-fake-key'` via `addInitScript` before `goto`), `stubKlipy(page, { search?, trending?, status?, delayMs? })` routing `https://api.klipy.com/api/v1/*/gifs/search*` and `.../trending*` to `e2e/fixtures/klipy-search.json` / `klipy-trending.json` (verified shape, `static.klipy.com` URLs, one item with an `sm.mp4` preview, `sm.jpg` stills), `stubKlipyCdn(page, { fail?: string[] })` serving `public/gif-fixtures/*.gif|png` bytes for `https://static*.klipy.com/**` with the right `Content-Type`, and `guardKlipyQuota(page)` (catch-all route for both hosts that aborts and records; a test fails if it fires) installed by the shared `test` fixture for **every** spec. `e2e/fixtures/matrix-api.ts`: `sendGifMessage(roomId, gifId = 'mock-1', { threadRoot?, origin? })` building the contract via `buildGifContent` from `MOCK_FIXTURES` (with the mock `stillUrl`), `sendRaw(roomId, content)` for forged fields. `e2e/fixtures/ui.ts`: `openGifPicker(page)`, `slashGif(page, query)`, `pickGif(page, id)`, `expectGifRow(page, eventId, state?)`. Fixture checks: `/gif-fixtures/mock-1.gif` magic/size/`Content-Type` (AC-G1-3) with a tiny GIF frame counter. `playwright.config.ts`: `gif.spec.ts` in `desktop`, `mobile-gif.spec.ts` in `mobile`; `test:e2e:gif` script line.

**QA-20 Desktop suite** - `e2e/gif.spec.ts`, serial, one context: AC-G1-1/2/3, AC-G2-1..4 (request assertions via `page.waitForRequest` on the stub; 429 -> `rate-limit`, 401 -> `auth`, 500 -> `bad-response`, abort; debounce by counting requests), AC-G3-1/2/4 (`getEvent` field by field; forged fields via `sendRaw`), AC-G4-1..8 (through the composer button), AC-G5-1..4, AC-G6-1..5/7, AC-G7-1..3 (500 on `send` via `page.route` once), AC-G8-1..6 (`emulateMedia` reduced motion; offscreen by sending 20 texts via bob then scrolling; `scrollHeight` delta), AC-G3-3/G6-6/G7-4 (P1, at the end). Note manual criteria (AC-G3-5, AC-G9-2 back button) in the spec header.

**QA-21 Mobile suite** - `e2e/mobile-gif.spec.ts`: AC-G6-1 (44 px), AC-G9-1/3/4 (sheet geometry against `app-shell`, font size, backdrop), AC-G7-1 on phone, AC-G8-1 on phone, `composer-gif` keyboard/safe-area by the AC-V6-1 rules.

**QA-22 Demo steps + runs** - `smoke.spec.ts` step 12 (desktop demo 2-7 under `mock`, `stepShot(page, 12, ...)` per sub-step, bob via `sendGifMessage`) and `mobile-smoke.spec.ts` step 12 (phone demo 2-5, `phoneShot`); then full `desktop` and `mobile` runs at the end of Wave 11 with the quota guard on (AC-G11-1..4), results into docs/STATUS.md.

**QA-23 Bug log** - docs/BUGS.md "Phase 4" section, spec commands, severity note: S1 if a plain `/text` message is swallowed by the slash parser, a forged field renders an off-list host, or any request reaches Klipy unstubbed during a run.

## P0 set (both demo scripts work with exactly these)
PRIN-13, 14, 15 · DEV-A-20, A-21 · DEV-B-23, B-24, B-25 · QA-19, 20, 21, 22. Total **39 h** (Principal 11 h, A 7 h, B 9 h, QA 12 h). The Principal is the critical path on day 1 of Wave 10: PRIN-13 lands first because Dev A's grid and QA's fixture checks need the real mock data; Dev B can build DEV-B-23 (triggers, mount) and the `GifMessage` markup against the types and the fixture contract before PRIN-15 lands, and QA can post contract events with `sendGifMessage` before `sendGif` exists. Dev A finishes early and takes DEV-B-26 if Dev B is behind (file names coordinated via STATUS notes as before). P1 (sample script + docs, load more, thread/phone integration, bug log): 6 h. P2: 1 h.
