# Phase 6 Tickets

Priorities: **P0** = the desktop demo script in docs/PHASE6_PLAN.md breaks without it. P1 = demo noticeably better (embeds are the first P1 to cut). P2 = polish. Work top-down inside your column. Estimates are focused hours. Numbering continues from Phase 5 (Principal resumes at 24, Dev A at 30, Dev B at 32, QA at 30). Waves 16-18.

## Ownership map (hard rule, as docs/PHASE5_TICKETS.md)
| Owner | Owns (may create/edit) | Must not edit |
|---|---|---|
| Principal | `src/lib/**` (new `src/lib/preview/**`), `src/store/**`, `src/app/**`, `public/**` (new `public/preview-fixtures/`), `scripts/**`, `seed/**`, `homeserver/**`, `package.json`, `vite.config.ts`, `docs/ARCHITECTURE.md` | - |
| Dev A | `src/features/link-preview/**` (new; exports from its `index.ts`) | anything else |
| Dev B | `src/features/conversation/**` | anything else |
| QA | `e2e/**`, `playwright.config.ts`, `docs/BUGS.md`, the `test:*` script lines in `package.json` | anything else |
| PM | `docs/PHASE6_*.md`, `docs/STATUS.md` | anything else |

Shared-layer needs go in your report as **Request to <owner>: file, function, shape, why**. Devs build against the table below from day 1; names are **subject to the Principal's ARCHITECTURE deltas** (docs/ARCHITECTURE.md "Phase 6 deltas (link previews)" wins); behaviour in docs/PHASE6_ACCEPTANCE.md is not. Rules this phase: never call `client.getUrlPreview` outside `src/lib/preview`; never render an image URL that did not come from `mxcToHttp`; never create an embed iframe before a click; never request a preview in an encrypted room before the reader clicks; the card must reserve its image box before the bytes arrive; test messages go in `#dev` / `#vault`, never `#general`.

## Shared API (Principal exposes; devs consume only)
Aligned 2026-10-18 to the Principal's `src/lib/preview/` as it stands in the working tree (`types`, `extract`, `normalize`, `cache`, `embed`, `hidden`, `fetch`, `policy`, `hooks`, `index`); import everything from `@/lib/preview`.

| Module | Export | Shape / rule |
|---|---|---|
| `src/lib/preview/types.ts` | `LinkPreview`, `LinkPreviewImage`, `LinkEmbed`, `EmbedProvider`, `PreviewSource`, `ExtractOptions`, `LinkPreviewOptions`, `LinkPreviewStatus` | `LinkPreview { url, siteName?, title?, description?, image?: { mxc, width?, height?, mimetype?, size? } }`: at least one of title / description / image is present, strings trimmed and non-empty. `LinkEmbed { provider, kind: 'video' \| 'track' \| 'album' \| 'playlist' \| 'episode', id, embedUrl, canonicalUrl, startSeconds? }`. `LinkPreviewStatus = 'idle' \| 'loading' \| 'ready' \| 'empty'` (`empty` = no preview, blocked or failed alike). Pure module (Node-loadable). |
| `src/lib/preview/extract.ts` | `extractPreviewUrls(source: PreviewSource \| string, opts?: { max?, hsUrl? }): string[]`, `normalizePreviewUrl(candidate, opts?)`, `PREVIEW_MAX_LINKS` (3) | Pass the row's `DisplayBody` straight in. Returns the hash-stripped URLs, deduplicated, message order, first 3. Empty for GIF, redacted, media (`m.image`...), not-decrypted bodies; `m.text` / `m.notice` / `m.emote` are prose. HTML bodies: anchors and raw URLs outside `<pre>` / `<code>` / `<mx-reply>`; the plain `body` is ignored when `html` exists. `hsUrl` = `getHsUrl()` so homeserver media links are skipped (the SDK-bound wrapper passes it). |
| `src/lib/preview/normalize.ts` | `normalizePreview(url, raw): LinkPreview \| null`, `isMxcUrl(v)`, `previewImageLayout(image, minWidth = 400): 'large' \| 'thumbnail' \| 'none'` | Non-mxc `og:image` is dropped. `large` only when width and height are known, width >= 400 and landscape; otherwise `thumbnail` (unknown dimensions included). Dev A derives `data-layout` from it (`none` -> `text`). |
| `src/lib/preview/cache.ts` | `LruCache<V>` (`{ max, ttlMs, negativeTtlMs }`) | `get` returns `undefined` (unknown), `null` (remembered miss) or the value; reads refresh recency. The preview module owns one instance. |
| `src/lib/preview/embed.ts` | `parseEmbed(url): LinkEmbed \| null`, `isEmbedUrl(url)`, `YOUTUBE_EMBED_ORIGIN`, `SPOTIFY_EMBED_ORIGIN` | YouTube `watch?v=`, `youtu.be/<id>`, `/shorts/`, `/live/`, `/embed/` (+ `t=` -> `start`); Spotify `track` / `album` / `playlist` / `episode` (+ `intl-xx` prefix). No network. |
| `src/lib/preview/hidden.ts` | `isPreviewHidden(eventId, url)`, `hidePreview(eventId, url)`, `unhidePreview`, `clearHiddenPreviews()`, `subscribeHiddenPreviews(listener)`, `hiddenPreviewsVersion()`, `hiddenPreviewKey`, `HIDDEN_PREVIEWS_STORAGE_KEY` (`matrix-poc.hiddenPreviews`), `HIDDEN_PREVIEWS_MAX` (1000) | localStorage JSON array of `"<eventId>\|<url>"`; in-memory fallback without storage; cross-tab via `storage` events. Dev A uses the hook below rather than these directly. |
| `src/lib/preview/fetch.ts` | `getLinkPreview(url, opts?: { signal?, ts? }): Promise<LinkPreview \| null>`, `peekLinkPreview(url): LinkPreview \| null \| undefined`, `isLinkPreviewPending(url)`, `primeLinkPreview(url, preview \| null)`, `clearLinkPreviewCache()`, `linkPreviewCacheSize()`, `previewCacheKey(url)`, `PREVIEW_CACHE_MAX` (200), `PREVIEW_CACHE_TTL_MS` (1 h), `PREVIEW_NEGATIVE_TTL_MS` (5 min) | SDK-bound: `client.getUrlPreview(key, ts)` -> `normalizePreview`; one in-flight promise per hash-stripped URL; results **and** `null` go into the LRU; any rejection or non-mxc image -> `null`, never a throw (only `AbortError` when the caller's `signal` fires) and never a toast. It only *answers*; `shouldAutoPreview` decides whether to ask. |
| `src/lib/preview/policy.ts` | `shouldAutoPreview(roomId, event?): boolean`, `getPreviewUrls(event, max = 3): string[]` | `shouldAutoPreview` is false when the room has `m.room.encryption` **or** the event itself is encrypted. `getPreviewUrls` = `extractPreviewUrls(getDisplayBody(event), { hsUrl: getHsUrl() })`, empty for non-message types and redactions; it does not look at encryption (in an encrypted room these are the links that get a button). |
| `src/lib/preview/hooks.ts` | `useLinkPreview(url, { enabled?: boolean, ts? }): { status: LinkPreviewStatus, preview }`, `useHiddenPreview(eventId, url): { hidden, hide(), unhide() }` | `enabled: true` (plain room, or encrypted after the click) fetches on mount; a cache hit is `ready` synchronously on first paint (no loading flash on remount); `enabled: false` stays `idle` (a cached answer is still returned). Unmount aborts the wait, the cache keeps the answer. `useHiddenPreview` is `useSyncExternalStore` over `hidden.ts`. |
| `src/app/devtools.ts` | `window.__matrixPoc.preview` | The whole module (landed). QA asserts through it (AC-L1, AC-L6-5, AC-L8-1). |
| `src/lib/matrix/utils.ts` (existing) | `mxcToHttp(mxc, w?, h?, method?)` | Dev A builds `<img src>` with `mxcToHttp(image.mxc, w, h, 'scale')`; the media service worker adds the token when authenticated media is on. |
| `homeserver/homeserver.yaml`, `scripts/hs.mjs` | `url_preview_ip_range_whitelist: ['127.0.0.1/32', '::1/128']` (landed) | Test servers only; the pool snapshot is rebuilt by the orchestrator after the change. |
| `public/preview-fixtures/` (landed) | `article.html`, `square.html`, `long.html`, `nodims.html`, `noimage.html`, `title-only.html`, `empty.html`, `hero.png` (1200x630), `thumb.png` (128x128); `npm run preview:fixtures` regenerates the PNGs | Served by Vite at `/preview-fixtures/<name>`; tags per docs/PHASE6_ACCEPTANCE.md "Fixture pages". Synapse measures downloaded images, so pages without `og:image:width/height` still come back with dimensions; the no-dimensions thumbnail case is a stub. |
| `@/features/link-preview` (Dev A) | `LinkPreviewCard({ eventId, url, auto: boolean, ts? })`, `EmbedPlayer({ embed, poster? })` | One component per URL; owns its state via `useLinkPreview(url, { enabled: auto \|\| clicked, ts })` / `useHiddenPreview`; renders nothing when hidden or (plain room) `empty`. Dev B only maps URLs to cards. |

---

## Principal

| ID | P | Title | Est |
|---|---|---|---|
| PRIN-24 | P0 | `src/lib/preview` core: extraction, normalisation, SDK-bound `getLinkPreview` with LRU + dedupe + timeout, hidden store, hooks, dev hook | 5h |
| PRIN-25 | P0 | Test homeserver whitelist, OpenGraph fixture pages + images, ARCHITECTURE "Phase 6 deltas (link previews)" | 2h |
| PRIN-26 | P1 | `parseEmbed` edge cases (`music.youtube.com`, `intl-xx`, `t=1h2m`), `isEmbedUrl`, Node smoke for the pure modules (`scripts/verify-preview.mjs`, optional) | 1h |

**PRIN-24 Core** - Landed in the working tree (`fetch.ts` LRU 200 / 1 h / 5 min + in-flight dedupe, `policy.ts`, `hooks.ts`, `index.ts`, `__matrixPoc.preview`). Left: a probe on port 5183 against `#dev` (`__matrixPoc.preview.getLinkPreview('<F>/article.html')` resolves with an mxc image and `og:image:width` 1200; a second call makes no request; `empty.html` resolves `null` and is not re-requested within 5 min), `clearLinkPreviewCache()` on logout (the cache holds URLs the next user should not inherit), and `npm run typecheck` / `build`. AC: AC-L1-1..5, AC-L6 (core half), AC-L5 (store half), AC-L8-1.

**PRIN-25 Server + fixtures + docs** - Whitelist (`127.0.0.1/32`, `::1/128`) and fixtures landed; `hs-pool.mjs` build port moved to 8040 (8030 is the announced dev server). Left: ARCHITECTURE "Phase 6 deltas (link previews)" (module map, cache numbers, the SDK per-minute promise cache gotcha, extraction rules, hidden key, whitelist + "page's own port" note, "ask the orchestrator to rebuild the pool snapshot"). AC: AC-L9-1..3.

---

## Dev A - Link preview UI (`src/features/link-preview/**`, new)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-A-30 | P0 | `LinkPreviewCard`: states, large / thumbnail / text layouts, reserved image box, hide, phone full width | 5h |
| DEV-A-31 | P1 | `EmbedPlayer`: play button -> sandboxed iframe (YouTube nocookie, Spotify) | 2h |
| DEV-A-32 | P2 | Keyboard: card focusable, Escape on the hide button, `prefers-reduced-motion` for the loading shimmer | 1h |

**DEV-A-30 Card** - `components/LinkPreviewCard.tsx` + CSS module: `link-preview[data-url][data-state][data-layout][data-embed]`; `click-to-load` renders `link-preview-load` ("Show preview" + hostname, 44 px on phone) and `link-preview-hide`; `loading` renders a one-line placeholder; `ready` renders `link-preview-site` (siteName or hostname), `link-preview-title` (`<a target="_blank" rel="noopener noreferrer">`, 2-line clamp), `link-preview-description` (3-line clamp), `link-preview-image` (`mxcToHttp(image.mxc, w, h)`; **large**: box with `aspect-ratio: width / height`, max 480 px wide, under the text; **thumbnail**: fixed 72x72 box (<= 96) beside the text, `object-fit: cover`; requested thumbnail size = box size x `devicePixelRatio`); `unavailable` (encrypted only: `status === 'empty'` after a click) renders `link-preview-unavailable`; hidden -> `null`. Plain-room `empty` -> `null`. State mapping: `idle` -> `click-to-load`, `loading` -> `loading`, `ready` -> `ready`, `empty` -> `unavailable` (encrypted) or nothing (plain). Phone (`isPhoneLayout`): card width 100 % of the body, image full width, targets 44 px. `index.ts` exports `LinkPreviewCard`, `EmbedPlayer`. A `__dev__` harness with stubbed previews is fine. AC: AC-L2-1 (UI half), AC-L3-1/2/4 (UI half), AC-L4-1..6, AC-L5-1/4 (UI half), AC-L6-2 (UI half).

**DEV-A-31 Embed** - When `embed` is non-null and the card is `ready`: `link-preview-play` over the image (or in place of it for text layout); click swaps the image for `components/EmbedPlayer.tsx`: `<iframe data-testid="link-preview-embed" src={embed.embedUrl + autoplay} sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin">` in the same reserved box (16:9 for YouTube, 152 px tall for Spotify tracks / 352 px for albums and playlists). No network before the click: no poster from YouTube or Spotify (the card's own `og:image` is the poster). AC: AC-L8-2..4 (UI half).

---

## Dev B - Conversation (`src/features/conversation/**`)

| ID | P | Title | Est |
|---|---|---|---|
| DEV-B-32 | P0 | Cards under `message-body`: extraction per row, `link-previews` host, main timeline + thread panel, edits, redactions | 3h |
| DEV-B-33 | P0 | Encrypted click-to-load switch and the "no request before click" guarantee | 1h |
| DEV-B-34 | P0 | Scroll stability: stick-to-bottom and the no-jump rule with growing cards | 2h |

**DEV-B-32 Wiring** - `MessageBody` (or a sibling `LinkPreviews.tsx` rendered by `MessageRow` right after the body, both in the main list and in `ThreadView`'s rows and `thread-root`): `const urls = useMemo(() => getPreviewUrls(event), [event, body.text, body.html, body.isRedacted, body.decryption?.status, version])`; render `<div data-testid="link-previews" data-count={urls.length}>` with one `<LinkPreviewCard key={url} eventId={event.getId()} url={url} auto={shouldAutoPreview(roomId, event)} ts={event.getTs()} />` each, nothing when `urls` is empty. Edits already flow through `getDisplayBody` (the SDK swaps the content), so the memo deps make the cards follow; redaction removes the host with the body. `ReplyQuote`, `ThreadSummary`, `ThreadList` and DM previews keep `previewText` (verify, do not add cards). AC: AC-L2-1..3 (wiring half), AC-L7-1/2/5, AC-L1-5 (wiring half).

**DEV-B-33 Encrypted switch** - `auto = shouldAutoPreview(roomId, event)` (false when the room has `m.room.encryption` or the event is encrypted; re-read on `useRoomStore.version` so AC-L3-6's flip is picked up for new rows). Confirm with a request listener on your dev server that opening `#vault` with 10 linked messages makes **zero** `preview_url` calls, and that clicking one button makes exactly one. AC: AC-L3-1..3, AC-L3-5/6 (wiring half).

**DEV-B-34 Scroll** - With the list pinned, a card arriving on the newest row grows the row: `MessageList`'s stick logic (`stick.current`, the BUG-28 ResizeObserver) must re-pin after the card and after the image load; measure with `scrollHeight - scrollTop - clientHeight`. When scrolled up, a card arriving **above** the viewport must not move the reader: rely on the reserved boxes (no layout change on image load) and, if the card's text itself shifts the anchor, apply the Phase 4 image rule (`anchor.current`). Add the two cases to your dev-server checklist; QA pins them in AC-L7-3/4. AC: AC-L7-3/4, AC-L4-3 (wiring half).

---

## QA (`e2e/**`, `playwright.config.ts`)

| ID | P | Title | Est |
|---|---|---|---|
| QA-30 | P0 | `e2e/fixtures/link-preview.ts`: fixture URLs, request listener, stubs, guards, hidden-store reset; `test:e2e:link-preview` | 2h |
| QA-31 | P0 | `e2e/link-preview.spec.ts` (desktop: AC-L1..L3, L4-1..4, L5..L9) | 5h |
| QA-32 | P0 | `e2e/mobile-link-preview.spec.ts` (phone: AC-L4-5, L3-1/2, L5-1) | 2h |
| QA-33 | P0 | Regression runs (`desktop`, `mobile`), docs/BUGS.md "Phase 6", a regression test per Wave 18 fix | 2h |

**QA-30 Fixtures** - `fixtureUrl(page, name)` = `<origin of page.url()>/preview-fixtures/<name>` (the page's own port; `localhost` is whitelisted via both loopback addresses); `previewRequests(page)` -> `{ urls(): string[], count(): number }` from `page.on('request')` filtered on `/preview_url`; `stubPreview(page, (url) => body | status)` via `page.route(/preview_url/)` for the error / slow / non-mxc / text-layout / embed cases (the YouTube case answers with an mxc image from an earlier real fixture preview); `noThirdParty(page)` catch-all route failing on `**youtube**`, `**ytimg**`, `**googlevideo**`, `**spotify**` (allow-list toggled after the play click); `resetPreviews(page)` (`__matrixPoc.preview.clearHiddenPreviews()` + `clearLinkPreviewCache()`); `sendAsBob(roomId, body)` reuse from `matrix-api.ts`. `test:e2e:link-preview` runs both specs; both specs join the parallel suite (3 workers), serial inside the file where request counting needs it.

**QA-31 Desktop** - AC-L1 through the dev hook (`extractPreviewUrls` table cases incl. the `<code>` and `matrix.to` ones), AC-L2 real round trip against the whitelisted Synapse, AC-L3 with the request listener installed **before** navigation (`#vault`; a second context is not needed: send via API as alice), AC-L4-1..4 geometry (`boundingBox`, `naturalWidth`, the delayed-thumbnail route for the reserved-box check), AC-L5 (reload + fresh context for the "bob sees it" case), AC-L6 stubs (404 / 403 / 429 / 500 / empty / slow / non-mxc), AC-L7 (thread panel, edit via `message-edit` flow, bob's message while pinned, scroll-up anchor), AC-L8 (P1, stubbed preview, iframe `src`), AC-L9-1 (`preview_url` as alice via API). Header comment: which criteria hit the real server versus a stub.

**QA-32 Phone** - Pixel 7: full-width card (`boundingBox` vs `message-body`), no horizontal scroll, 44 px `link-preview-hide` / `link-preview-load`, the encrypted button flow, hide + reload.

**QA-33 Runs + log** - Full `desktop` and `mobile` at the end of Wave 17 and after the Wave 18 fixes; docs/BUGS.md "Phase 6" with spec commands and the severity rule (S1: a preview request from an encrypted room without a click, a third-party request without a click, a non-homeserver image URL rendered; S2: list jumps / loses the bottom; S3: cosmetic); one regression test per fix, in the same change.

## P0 set (the demo script works with exactly these)
PRIN-24, PRIN-25 · DEV-A-30 · DEV-B-32..34 · QA-30..33. Total **31 h** (Principal 7 h, A 5 h, B 6 h, QA 11 h; the PM's docs are outside the estimate). PRIN-24's `getLinkPreview` + hooks and PRIN-25's whitelist + fixtures are already in the tree, so Dev A sees real previews and QA gets a real round trip from day 1 (once the pool snapshot is rebuilt); Dev B wires `LinkPreviewCard` as soon as its `index.ts` exports exist, and can start the `link-previews` host with a placeholder meanwhile. P1 (embeds DEV-A-31 + PRIN-26, embed criteria in QA-31): 4 h, cut first. P2: 1 h.
