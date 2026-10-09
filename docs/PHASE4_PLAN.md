# Phase 4 Plan: GIF picker

Phases 1-3 shipped the desktop client, the phone layout and Android APK, voice notes and threads (docs/PHASE3_PLAN.md). Phase 4 adds a **Slack-style GIF picker** (`/giphy`-like). Tickets: docs/PHASE4_TICKETS.md. Criteria and testids: docs/PHASE4_ACCEPTANCE.md. Status: docs/STATUS.md "Phase 4".

## Goals
1. **Send a GIF in three keystrokes**: `/gif tacos`, Enter, Enter; or the GIF button, trending, click. Desktop and phone.
2. **Interoperable and compliant**: the message is a plain `m.text` with the title and the GIF link (Element shows the link and, with server URL previews now on, unfurls it) plus a namespaced field our client renders inline; Klipy's usage rules are honoured (no re-hosting, no proxying, API order, `Search KLIPY`).
3. **Works without a key**: a `mock` provider with local fixture GIFs runs the whole flow (demo, tests) until the stakeholder pastes a Klipy key.

## Product decisions
| Topic | Decision |
|---|---|
| Provider | **Klipy**. Tenor shut down in June 2026; Giphy is paid for production use. Klipy needs an app key only the stakeholder can obtain (Partner Panel; Test key = 100 requests/hour, Production = unlimited), so the client ships a provider abstraction (`src/lib/gif/`): a `klipy` provider and a `mock` provider (local fixture GIFs) used automatically when no key is present. |
| Klipy API facts (Advisor, verified) | Key is a **URL path segment**: `GET https://api.klipy.com/api/v1/{key}/gifs/search?q=&page=&per_page=&content_filter=&locale=` and `.../gifs/trending?...`; `page` is 1-based; response `{ result, data: { data: [item], current_page, per_page, has_next } }`; item `{ id: number, slug, title, file: { hd\|md\|sm\|xs: { gif\|webp\|jpg\|mp4\|webm: { url, width, height, size } } } }`, files on `https://static.klipy.com/`. Example sizes: hd gif 498x498 4 MB, md gif 3.7 MB, sm gif 220x220 315 KB, sm webp 80 KB, xs webp 25 KB. CORS open (`*`) on both hosts. |
| **Decision: hot-link** (orchestrator, 2026-10-09) | Klipy's guidelines forbid storing, mirroring, re-hosting or proxying its media without written approval, so the brief's re-upload path and any relay are **dropped; we comply**. `sendGif` sends `m.room.message` / `msgtype: 'm.text'`, `body: "<title> <gif url>"`, plus `dev.matrixpoc.gif { provider, id, title, url, w, h, previewUrl, previewW, previewH, stillUrl? }` (exact shape in docs/PHASE4_ACCEPTANCE.md). Our client renders the field inline as an animated GIF loaded straight from `static.klipy.com`; other clients show the title and link. `url` is the `GIF_SEND_VARIANT` gif (`hd`, fallback `md`, `sm`); `previewUrl` the `sm` webp/mp4; `stillUrl` the `sm.jpg` (paused frame; the mock's `<id>.png`). The Principal owns allowing `https://static.klipy.com` images (sanitizer / CSP / Capacitor). Re-hosting later needs Klipy's written approval (user-only step 4). |
| Klipy rules carried into acceptance | Results displayed in the order returned, unfiltered (AC-G4-3); search placeholder exactly `Search KLIPY` under `klipy` (AC-G4-7); optional `Powered by KLIPY` line, included; `content_filter` default `medium` (`GIF_CONTENT_RATING`); debounce >= 300 ms and QA stubs everything (100 requests/hour). |
| Key handling | `gifProviderName()` resolves **runtime first**: `localStorage['matrix-poc.gifProvider']` (`klipy` / `mock`, forces) -> `localStorage['matrix-poc.gifApiKey']` -> `VITE_GIF_API_KEY` (build time, `.env`) -> `mock`. Same pattern as `matrix-poc.hsUrl`: QA flips providers per test without restarting the dev server (Playwright reuses the running `npm run dev`), and the stakeholder can paste a key in DevTools without a rebuild. The key is visible in every request URL and a key baked into the APK is extractable from the bundle; **acceptable for a POC**, documented in docs/MOBILE.md. |
| Trigger | `/gif <query>` and `/giphy <query>` in the composer: exact command (case-insensitive) followed by a space or the end of the text; Enter opens the picker pre-searched and **consumes** the command (composer cleared). Any other `/text` sends as plain text. Empty query = trending. Plus a GIF button (`composer-gif`) next to attach. Escape without a pick leaves the composer empty and focused (restoring the text is P1). |
| Picker | Search with 300 ms debounce, trending on open, grid of animated previews (`sm.webp`, else `sm.gif`), API order, arrow-key navigation + Enter, attribution line, loading / empty / error states, desktop popover above the composer, phone bottom sheet. |
| Rendering | Rows whose content has a valid `dev.matrixpoc.gif` (host allow-listed: `static.klipy.com`, or our own origin for `mock`) render `<img src=url>` sized from `w/h`, a small `GIF` badge, and the body text hidden; any other host renders as the plain `m.text` it is. Off-screen rows unmount the `<img>` into a sized placeholder (IntersectionObserver) and remount when visible; under `prefers-reduced-motion` the row shows `stillUrl` (else the placeholder) with a play control, click to animate. User-attached GIF files (paperclip) stay `m.image` and still render as Synapse's static thumbnail: **out of scope**, noted. |
| Content rating | `GIF_CONTENT_RATING = 'medium'` (Klipy `content_filter`: `off\|low\|medium\|high`) in `src/lib/gif/config.ts`; a constant, not a UI setting. |
| Threads | The shared `Composer` takes `source`, so the picker mounts in the thread panel for free; `sendGif(..., { threadRoot })` adds the Phase 3 relation. P0 covers the channel; the thread path has one P1 criterion. |
| Testids | `composer-gif` follows the Phase 3 prefix rule (`thread-composer-gif` in the panel). The picker is a singleton overlay: `gif-*` ids are never prefixed. |
| Mock fixtures | Real 2-frame animated GIFs plus a PNG still each, generated by a pure-Node encoder (`scripts/make-gif-fixtures.mjs`, no ffmpeg on this machine) into `public/gif-fixtures/`, Principal-owned, served from our own origin (`/gif-fixtures/mock-1.gif`). Titles cover the demo queries (`tacos`, `party`, `cat`); reserved queries make the mock return empty (`__empty__`, `nothing-here`) or reject (`__error__`); the mock emits a `stillUrl` (`<id>.png`) too. QA's CDN stub serves the same files for `static.klipy.com`. |

## In scope
| Area | Owner | Deliverable |
|---|---|---|
| GIF core | Principal | `src/lib/gif/` (`types.ts`, `config.ts`, `index.ts` resolver, `providers/klipy.ts`, `providers/mock.ts`), fixtures + generator, `sendGif` action + `getGifContent` reader, image-host allow list (sanitizer / CSP / Capacitor), `.env.example`, ARCHITECTURE deltas, `scripts/send-gif-sample.mjs` (bob posts a GIF for the demo) |
| Picker | Dev A | `src/features/gif/` `<GifPicker initialQuery onPick onClose variant />`: search, trending, grid, keyboard, attribution, states, sheet variant |
| Conversation | Dev B | Slash commands, `composer-gif`, mounting the picker (popover / sheet), send flow with `gif-pending` + error toast, `GifMessage` rendering rules (badge, pause offscreen, reduced motion) |
| QA | QA | Klipy + CDN stubs (`page.route`) with a quota guard, provider override helper, `e2e/gif.spec.ts`, `e2e/mobile-gif.spec.ts`, event verification via API, demo step 12 in both smoke specs, docs/BUGS.md Phase 4 |

## Out of scope
URL preview **client** (the server endpoint is enabled and verified; a later phase) · stickers (`m.sticker`) · uploading the user's own GIF files (already works via attach; renders static) · re-hosting on the homeserver (needs Klipy's approval) · a GIF key field on the login screen (DevTools/localStorage is enough) · recent/favourite GIFs (Klipy's `customer_id` is sent, a stable uuid in `matrix-poc.gifCustomerId`, but no "recent" UI) · E2EE, push, calls (unchanged).

## Desktop demo script (stakeholder, laptop)
Prep by us: homeserver up, `npm run dev`, `.env` with or without `VITE_GIF_API_KEY` (mock works keyless; dry-run on `mock`, switch to `klipy` only for the live run to spare the 100/hour Test quota), a terminal ready for `npm run gif:sample` (bob posts a GIF).

| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Log in as `alice` / `password123`; `#general` opens | The Phase 3 layout unchanged, plus a **GIF** button beside the paperclip. |
| 2 | Type `/gif tacos`, Enter | A picker pops up above the composer, search box reading `tacos`, a grid of animated results, `Powered by KLIPY` at the bottom; the composer is empty. |
| 3 | Press ArrowRight twice, then Enter | The highlight moves from the first of three tiles to the third (`Tacos party` under mock); on Enter the picker closes, a `Sending GIF...` chip shows in the composer for a moment, then the GIF appears as alice's message, animating, with a small `GIF` badge. |
| 4 | Scroll up until the GIF leaves the view, then back down | The timeline does not jump (a same-size placeholder holds its place) and the GIF animates again once visible; for us: DevTools shows the `<img>` unmounted while off screen. |
| 5 | Click the **GIF** button | The picker opens on **Trending** with the placeholder `Search KLIPY`; type `party`; results update as you type. |
| 6 | Click a tile | Same as step 3. Optional: Element Web as bob shows the title, the link and a URL preview card. |
| 7 | We run `npm run gif:sample` | Within 2 s bob's GIF appears, animating, with the badge. |
| 8 | Hover bob's GIF message, click **Reply in thread**, click `GIF` in the thread composer, pick one | The GIF lands in the thread, not the channel (P1). |

## Phone demo script (stakeholder, Android device; prep as in Phase 2 plus the script above)
| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Open the app, log in as alice | `#general` full-screen; the composer shows paperclip, **GIF**, mic. |
| 2 | Tap **GIF** | A bottom sheet with a search box, Trending results in 2 columns, the attribution line, a close button. |
| 3 | Type `tacos` | Results update; the sheet stays above the keyboard. |
| 4 | Tap a tile | The sheet closes, the chip shows briefly, the GIF appears animating with the badge. |
| 5 | Type `/giphy cat`, send | The sheet opens pre-searched; tap a tile; sent as in step 4. |

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Messages depend on Klipy's CDN availability (and the phone needs internet, not just the LAN); permanence of `static.klipy.com` URLs is **unverified** (no expiry or signing documented) | A GIF row shows a broken image when the CDN is down or the device is offline | `GifMessage` falls back to the title + link (`message-gif-fallback`) on `img` error; the `mock` provider is CDN-free for the demo; re-hosting later needs Klipy's written approval (user-only step 4). |
| No Klipy key until the stakeholder signs up | Real provider untested by the team | `mock` runs every demo step and every test keyless; QA tests the `klipy` code path against `page.route` stubs written from the verified response shape, with a fake key in the URL; the real key is tried by hand in Wave 11. |
| Test key = 100 requests/hour; 429 behaviour undocumented | Search spam while typing burns the quota mid-demo; a key in `.env` during a suite run burns it too | 300 ms debounce, in-flight requests aborted (`AbortController`), last 20 queries cached in memory, any non-2xx -> `gif-error` + retry (no `Retry-After` assertion); QA's catch-all route **fails any test** that lets a request reach `api.klipy.com` or `static.klipy.com`; demo dry-runs on `mock`. |
| Forged `dev.matrixpoc.gif` fields (any user can send one pointing anywhere) | Tracking pixels / arbitrary images in the timeline | Host allow list in `getGifContent` (`static.klipy.com`, own origin); anything else renders as plain text. |
| `hd.gif` is ~4 MB per item | Slow on Wi-Fi, heavy timelines | `GIF_SEND_VARIANT` constant (`hd` -> `md` -> `sm`), unmount offscreen, reduced-motion = click to play; picker previews are `sm.webp`. |
| Synapse thumbnails animated GIFs as a static frame (verified, `docs/advisor/gif-thumb-probe.mjs`) | Only affects user-attached `m.image` GIFs | Out of scope, noted in docs/ARCHITECTURE.md; `?animated=true` (animated webp) is the later fix. |
| `mock` is single-device: its URLs are the sending device's own origin (`http://localhost:5173/...` on desktop, `http://localhost/...` in the APK), so a mock GIF renders as plain text on any other device and bob's `gif:sample` does not render on the phone | Looks like a bug in a cross-device check | Documented limitation, no demo step crosses devices under `mock`; `klipy` is cross-device (CDN URLs). Not a bug in Wave 12. |
| Memory on this machine during the e2e runs | Browser OOM, BUG-4-style timing fails | Agents use **one browser context** per spec; GIF specs are serial and short; fixtures are tiny (< 20 KB). |
| Klipy response shape drifts from the stub | "Real path" tests pass against a wrong shape | The stub JSON mirrors the verified shape; the mapping lives in `providers/klipy.ts` only; the stakeholder's live run is the final check. |
| Key visible in URLs / baked into the APK | Key extractable | Accepted for a POC (documented); the key can be revoked in the Partner Panel. |

## User-only steps (stakeholder)
1. Sign up at Klipy's Partner Panel (`https://partner.klipy.com/api-keys`), "Add Platform" -> Test key (Production via the form there).
2. Paste it into `.env` as `VITE_GIF_API_KEY=...` (see `.env.example`), restart `npm run dev`; or at runtime: DevTools -> `localStorage.setItem('matrix-poc.gifApiKey', '...')`, reload.
3. Rebuild the APK with the key baked: `npm run cap:build:android:lan` (reads `.env`), reinstall on the device (the phone needs internet for `static.klipy.com`).
4. If GIFs should ever live on the homeserver (durability, offline LAN), request Klipy's written approval for re-hosting first.

## Advisor consultations (recorded per the stakeholder's instruction)
| # | Topic | Options considered | Advisor's position / outcome |
|---|---|---|---|
| 1 | PM design review before writing (provider resolution, fetch seam, event shape, rendering, fixtures, slash rules, thread prefix, threads) | Build-time key only vs runtime override; canvas snapshot vs Synapse thumbnail for the paused frame; separate QA GIF generator vs shared fixtures | Adopted: runtime resolution via localStorage (Playwright reuses the running dev server, so an env key would flip every spec); mock fixtures are real GIFs from a pure-Node encoder owned by the Principal (`public/` added to the ownership map), reserved empty/error queries; `gif-*` never prefixed; threads fall out of the shared composer, verified by one P1 criterion; no Klipy facts from memory. The upload-side advice (magic bytes, `info.size`) became moot with the hot-link decision. |
| 2 | Advisor agent's verification of Klipy and Synapse | - | Auth = path segment; endpoints, pagination (`page`/`per_page`/`has_next`), response shape and variant sizes as in Decisions; CORS open on API and CDN; Test key 100 req/hour, 429 undocumented; attribution: `Search KLIPY` placeholder required, `Powered by KLIPY` optional; **usage rules forbid re-hosting, proxying and reordering**; Synapse 1.162 `/download` unchanged bytes, `/thumbnail` static PNG, `?animated=true` animated webp, upload limit 50 MB. Probe: `docs/advisor/gif-thumb-probe.mjs`. |
| 3 | Re-upload vs Klipy's no-re-hosting rule | (a) POC-only re-upload with an approval caveat; (b) hot-link message + inline `<img>` from the CDN; (c) no change | Advisor leaned (a) (interop, durability; ToS allow personal use). **Superseded by the orchestrator's decision (2026-10-09): comply, hot-link (b)** with `m.text` + `dev.matrixpoc.gif`, no relay. Kept from the consult: order-preservation and placeholder criteria, `GIF_SEND_VARIANT`, QA quota guard, `hasNext` in results. |
| 4 | PM review of the finished docs | Fixture titles vs the demo's two ArrowRights; per-source vs page-global picker state; `previewText` vs the quote text; mock cross-device; Android back mechanism | Adopted: three fixtures match `tacos` (`mock-1..3`) so demo step 3 and smoke step 12 hold under `mock`; picker state is page-global in `useConversationUi` (one instance, AC-G6-6); quotes/thread list/channel previews all show `GIF: <title>` (AC-G8-6); `mock` single-device limitation recorded as a risk; `registerBackHandler` added to the Shared API (PRIN-15) for the sheet's Android back; demo step 4 reworded to something observable. (The `GIF: <title>` wording and the `locale=us` assertion were superseded by consult 5.) |
| 5 | Realignment to the shipped `src/lib/gif/` (coordinator, Dev B's finding) | Rewrite the shipped names to the docs vs rewrite the docs to the code | The code wins: `getGifProvider()`/`gifProviderName()`/`setGifProvider()`/`setGifApiKey()` from `@/lib/gif` (no top-level `searchGifs`), `GifResult` with `previewMimetype`/`fullUrl`/`fullW`/`fullH`/`fullSize?`/`mimetype`/`provider`, `GifPage { results, nextPage }`, `GifProviderError { kind, status?, retryAfterMs? }`, `__empty__`/`__error__`, `previewText` `[gif] <title>` (as implemented in `utils.ts`), `customer_id` sent (no `locale` by default), `GIF_IMAGE_HOSTS` incl. `static1`/`static2`; `stillUrl?` and `registerBackHandler` accepted and kept; `gif-backdrop`/click-outside/Escape-at-mount moved to Dev B (AC-G4-6, AC-G6-5). The 8-fixture mock contract (`tacos` -> `mock-1..3`) stays as the Principal shipped it. |

## Sequence
| Wave | Who | Output |
|---|---|---|
| 10 | Principal | PRIN-13 (abstraction + mock + fixtures) first so Dev A and QA have real data on day 1, then PRIN-15 (`sendGif`, `getGifContent`, host allow list), PRIN-14 (klipy), PRIN-16. Dev A / Dev B / QA start P0s on day 1 against the Shared API table and the mock fixture contract. |
| 11 | Dev A, Dev B, QA in parallel | P0 tickets, then P1; the stakeholder's real key tried by hand as soon as it exists. |
| 12 | All | Both demo scripts dry-run (desktop smoke step 12, phone smoke step 12), Element interop check by hand (link + URL preview), docs/BUGS.md triage, docs/STATUS.md final, APK rebuilt with the key. |
