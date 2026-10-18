# Phase 6 Plan: link preview cards

Phases 1-5 shipped the desktop client, phone layout and APK, voice notes, threads, the GIF picker, authenticated media, SSO and E2EE. Today a pasted link renders as just a link. Phase 6 turns it into a **card** (site name, title, description, image), the way Slack, Discord and Element do, using the homeserver's URL preview API the server half already provides (`url_preview_enabled: true` on the test Synapse; matrix-js-sdk 43's `client.getUrlPreview(url, ts)` picks the authenticated `/_matrix/client/v1/media/preview_url` when the server supports it, else the v3 media one). Scope source: the orchestrator's Phase 6 brief (stakeholder: JC, "build the remainder of link preview cards"). Tickets: docs/PHASE6_TICKETS.md. Criteria and testids: docs/PHASE6_ACCEPTANCE.md. Status: docs/STATUS.md "Phase 6".

## Goals
1. **A link becomes a card** in plain rooms with no extra action: up to 3 cards per message, image included, without the message list jumping.
2. **Encrypted rooms stay private**: no URL leaves the device until the reader asks for that one preview.
3. **Quiet when it cannot work**: a page with no metadata, a blocked host or a server error shows no card and no error noise; previews are cached so scrolling back costs nothing.

## Product decisions (settled by the orchestrator; written down here, not reopened)
| Topic | Decision |
|---|---|
| Plain (unencrypted) rooms | **Automatic.** Up to **3 distinct** http(s) links per message get a card each, in message order. Skipped: links inside `code` / `pre` blocks of the formatted body, `matrix.to` links, links to the homeserver's own media (`/_matrix/media/*`, `/_matrix/client/v1/media/*`), GIF messages (already inline), redacted / undecryptable / still-decrypting messages. Bridge notices (`m.notice`) are previewed like text. |
| Encrypted rooms | **Click-to-load, the privacy default.** Asking the homeserver for a preview tells it which URL is in the message, which defeats E2EE. So in an encrypted room **no `preview_url` request is made automatically**: each previewable link gets a small **Show preview** button under the message; clicking it fetches and shows that one card. Same spirit as GIFs in encrypted rooms (AC-E6-5 in docs/PHASE5_ACCEPTANCE.md). Element's default is "off in encrypted rooms"; ours is off-with-a-button. AC-E6-4 ("no preview request from an encrypted room") stays in force **until the click**. |
| Card | Site name (`og:site_name`, else the hostname), title (a link, new tab, `noopener noreferrer`), description clamped to ~3 lines, image when `og:image` exists. `og:image` comes back as an **mxc URL**: always rendered through the existing media helpers (`mxcToHttp` / authenticated media via `public/media-sw.js`), never a raw URL, so it works with `enable_authenticated_media` on (production) and off (test server). |
| Image layout | The image **reserves its box** before it loads (no scroll jump, which keeps stick-to-bottom working). Wide images (`og:image:width >= 400` and landscape) render **large** under the text; small / square ones, and images with **no dimensions**, render as a **thumbnail** on the side (a fixed box, so it can always be reserved). Phone: the card is full width. |
| Hide | An "x" on the card hides it **for this viewer** (localStorage, keyed by event id + URL). Nothing is sent to the room; the message text keeps its link. |
| Embeds (P1, cut first) | YouTube (`youtube.com/watch`, `youtu.be/<id>`, `/shorts/<id>`) and Spotify (`open.spotify.com/{track,album,playlist,episode}/<id>`) cards show a play button; the player iframe (`youtube-nocookie.com/embed`, `open.spotify.com/embed`) is created **only after the click**. No third-party request before a click, in any room. |
| Errors and cache | A failed / empty / blocked preview shows **no card** (in encrypted rooms the button becomes a short "No preview available" note). Previews are cached **per URL in memory** (in-flight requests deduped; LRU of 200 URLs, hits kept 1 h, misses 5 min), so re-renders and scrolling back never refetch. |
| Threads and quotes | Cards render in the thread panel too (root and replies). Reply quotes, thread list snippets and room previews stay **text only**. |
| Edits | Cards follow the message's current (edited) text: new links get cards, removed links lose theirs; a hidden card stays hidden for that event id + URL. |
| After a click (encrypted) | The loaded card stays shown while the in-memory cache holds it (this page load); after a reload the button is back. Nothing about the click is persisted (PM call: persisting it would be a second place that remembers which URLs you looked at). |
| Request timing | `getLinkPreview(url, { ts: event.getTs() })` -> SDK `getUrlPreview` (the SDK buckets `ts`, so repeats hit the server's cache). A card is requested when its row is first rendered; the in-view gate is not needed because the server does the fetching. Duplicate links in one message collapse on the hash-stripped URL. |

## In scope
| Area | Owner | Deliverable |
|---|---|---|
| Preview core | Principal | `src/lib/preview/**` (pure: `extract`, `normalize`, `cache`, `embed`, `hidden`; SDK-bound: `fetch` (`getLinkPreview` with LRU + dedupe), `policy` (`shouldAutoPreview`, `getPreviewUrls`); React: `hooks` (`useLinkPreview`, `useHiddenPreview`); all in the tree), `__matrixPoc.preview`, the test homeserver whitelist, OpenGraph fixture pages under `public/preview-fixtures/` + `npm run preview:fixtures`, ARCHITECTURE "Phase 6 deltas (link previews)" |
| Card and embed UI | Dev A (`src/features/link-preview/**`, new) | `LinkPreviewCard` (loading / ready / click-to-load / unavailable states, large vs thumbnail layout, hide, phone full width), `EmbedPlayer` (play button -> iframe), exported from `index.ts` |
| Wiring | Dev B (`src/features/conversation/**`) | Cards under `message-body` in rows and in the thread panel, encrypted click-to-load, edits, scroll stability with stick-to-bottom |
| QA | QA | `e2e/fixtures/link-preview.ts`, `e2e/link-preview.spec.ts`, `e2e/mobile-link-preview.spec.ts`, regression runs, docs/BUGS.md "Phase 6" |

## Out of scope
Sender-side bundled previews (MSC4095) · a settings screen or global toggle · per-room toggles · previews in the composer before sending · embeds beyond YouTube and Spotify · previews for `m.file` / image captions · changing the homelab Synapse ourselves (JC does it, see "User-only steps") · persisting "already loaded" clicks across reloads.

## Desktop demo script (stakeholder, laptop, local server)
Prep by us: Synapse up with the test whitelist (so it can fetch pages from the Vite origin), `npm run dev`, Chrome as `alice` / `password123`, `#dev` open. `F` = `http://localhost:5173/preview-fixtures`.

| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Send `Read this: F/article.html` in `#dev` | Within 2 s a card under the message: "The Codec Gazette", the bold title "Link previews land in Phase 6" (a link), two sentences of description, a **large** image under the text. The message list stays pinned to the bottom. |
| 2 | Send `F/square.html and F/article.html and F/long.html and F/title-only.html` | Three cards at most, in message order: a thumbnail card ("Ringo", small round logo on the side), the article card again (instant, from the cache), the "Clamp Test Weekly" card, large image, with its title cut at 2 lines and description at 3. `title-only.html` is the 4th link and gets nothing. |
| 3 | Click the title of a card | The page opens in a new tab; the chat tab is unchanged. |
| 4 | Click the **x** on the article card, then reload | The card is gone before and after the reload; the link in the message text is still there. Window 2 (bob) still sees that card: hiding is personal. |
| 5 | Scroll up 20 messages, then back down | No refetch (DevTools Network: no new `preview_url`), no jump. |
| 6 | Open `#vault` (encrypted), send `F/article.html` | No card and no request: a small **Show preview** button under the message. DevTools: no `preview_url` call. |
| 7 | Click **Show preview** | One request, then the same card as step 1. |
| 8 | In `#vault`, send `F/empty.html` and click **Show preview** | The button turns into "No preview available". In `#dev` the same link shows nothing at all. |
| 9 | Send `https://www.youtube.com/watch?v=dQw4w9WgXcQ` in `#dev` | A card with a play button over the image (preview from the server; nothing fetched from YouTube yet). Click play: the player appears in place and starts. |
| 10 | Hover a message with a card, **Reply in thread**, send `F/article.html` in the thread | The card renders inside the thread panel; the thread summary row and the Threads list show plain text only. |

## Phone demo script (stakeholder, Android device or the `mobile` project)
| # | Stakeholder does | They should see |
|---|---|---|
| 1 | Open `#dev`, send `F/article.html` (the device's homeserver proxy URL per docs/MOBILE.md) | A full-width card under the message, the image spanning the card, no horizontal scroll, the list still at the bottom. |
| 2 | Tap the title | Opens in the browser / a new tab. |
| 3 | Tap the **x** | Card gone; tap target at least 44 px. |
| 4 | Open `#vault`, send a link, tap **Show preview** | Button (44 px) then the card, same as desktop. |

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Test Synapse blocks `127.0.0.0/8` (`url_preview_ip_range_blacklist`) | No real round trip in tests or the local demo | Test config only (landed): `url_preview_ip_range_whitelist: ['127.0.0.1/32', '::1/128']` in `homeserver/homeserver.yaml` and the pool template in `scripts/hs.mjs`; fixture pages served from the Vite origin. The pool snapshot must be regenerated after the config change (orchestrator runs `hs:pool:snapshot`; nobody resets the dev server). |
| Fixture URL must use the page's own Vite port (pool ports 5173-5180) | Hard-coded `5173` breaks parallel runs | QA builds the fixture URL from `page.url()`'s origin (`localhost` is fine: both loopback addresses are whitelisted). |
| The SDK caches `getUrlPreview` promises per minute, rejected ones included | A transient failure looks permanent for a minute | Our LRU's 5 min negative TTL is the retry policy; documented in the deltas, not worked around. |
| Card images shift the list | Breaks stick-to-bottom and the Phase 4 "no jump" rule | Box reserved from `og:image:width/height` (large) or a fixed thumbnail box; images without dimensions never go large. The BUG-28 ResizeObserver re-pin covers the row growing while pinned. |
| `getUrlPreview` rejects on 404 / 429 / blocked / timeout | Error toasts or spinners forever | Every failure resolves to `null` -> no card; a 10 s client timeout; the result (including `null`) is cached for the session. |
| Raw `og:image` URLs | A card could load a third-party image directly | Only `mxc://` images are rendered; anything else is dropped. Synapse always rewrites to mxc. |
| Regex extraction on HTML bodies picks links inside `<code>` | Cards for code snippets | Extraction walks the sanitised HTML and skips `code` / `pre` subtrees; plain bodies use `linkify`'s rule (trailing punctuation dropped). |
| Embeds load third-party scripts | Privacy and CSP | iframe created only on click, with `sandbox` + `allow` set; `youtube-nocookie.com`; no YouTube / Spotify thumbnail fetch (the card uses the server's `og:image`). |
| Homelab Synapse has no `lxml` or previews off | Nothing works on 704.chat | User-only step below; the client degrades to plain links when the server returns 404 / 403 for `preview_url`. |

## User-only steps (JC, homelab Synapse via Hubot; the orchestrator writes the prompt)
1. Check `url_preview_enabled: true` in the homelab `homeserver.yaml` and that Synapse was installed with the `url-preview` extra (`lxml` importable; otherwise Synapse logs a warning and previews 404).
2. Keep `url_preview_ip_range_blacklist` as is (private ranges stay blocked on the real server; only the test server gets a whitelist).
3. Optional: `url_preview_url_blacklist` entries for hosts that should never be previewed; `max_spider_size` default is fine.
4. Restart Synapse, then `curl -H 'Authorization: Bearer <token>' 'https://<hs>/_matrix/client/v1/media/preview_url?url=https://example.org'` returns `og:*` JSON.

## Advisor consultations (recorded)
None needed while planning: the product decisions came settled from the orchestrator and the mechanics (SDK call, media helpers, click-to-load pattern) already exist in the codebase. Open questions for the Principal are listed in docs/PHASE6_TICKETS.md "Shared API".

## Sequence
| Wave | Who | Output |
|---|---|---|
| 16 | PM + Principal | This plan, acceptance, tickets; PRIN-24 (`src/lib/preview` core + hidden store + dev hook) and PRIN-25 (test whitelist, fixture pages, ARCHITECTURE deltas) so devs and QA have real previews on day 1. |
| 17 | Dev A, Dev B, QA in parallel | DEV-A-30/31 card + embed, DEV-B-32..34 wiring, QA-30..32 fixtures + specs; P1 after P0. |
| 18 | All | Fix wave: review findings and bugs with a regression test each (JC's rule), demo dry run (desktop + phone scripts above), `desktop` and `mobile` regression runs, docs/STATUS.md final. |
