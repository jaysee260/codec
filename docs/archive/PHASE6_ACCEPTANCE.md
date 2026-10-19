# Phase 6 Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md and the Phase 2-5 acceptance docs (conventions, registries and criteria stay in force). Numbering `AC-L<group>-<n>`; each group names its tickets (docs/archive/PHASE6_TICKETS.md). **P0** = the desktop demo script in docs/archive/PHASE6_PLAN.md breaks without it, P1 = noticeably better, P2 = polish. "desktop" = the `desktop` Playwright project, "phone" = `mobile`, logged in as alice; **dirty seed always allowed**: every criterion sends its own messages (in `#dev`, or `#vault` for encrypted) and asserts on its own event ids. "`F`" = the fixture origin `http://localhost:<the page's own Vite port>/preview-fixtures` (the test Synapse whitelists `127.0.0.1/32` and `::1/128`; always the page's own port, pool runs use 5173-5180). "a preview request" = any request whose URL contains `/preview_url` (QA listens with `page.on('request')` and a catch-all `page.route`). API names follow docs/archive/PHASE6_TICKETS.md "Shared API"; the Principal's docs/ARCHITECTURE.md "Phase 6 deltas" wins on names, never on behaviour.

## Fixture pages (Principal, `public/preview-fixtures/`, served by Vite, fetched by Synapse)
`npm run preview:fixtures` regenerates the two PNGs deterministically (`scripts/make-preview-fixtures.mjs`); the pages are hand-written and reference images by root-relative path, so any Vite port works.

| Page | OpenGraph | Expected card |
|---|---|---|
| `article.html` | `og:site_name` "The Codec Gazette", `og:title` "Link previews land in Phase 6", `og:description` (two sentences), `og:image` `/preview-fixtures/hero.png` 1200x630 **with** `og:image:width/height` | `large` layout |
| `square.html` | site "Ringo", title "Ringo - the tiny tool with the round logo", description, `og:image` `/preview-fixtures/thumb.png` 128x128, no dimensions | `thumbnail` layout |
| `long.html` | site "Clamp Test Weekly", a title far longer than 2 lines, a description far longer than 3 lines, `og:image` hero.png (no dimensions in the page, but **Synapse measures the image it downloads** and reports 1200x630) | `large` layout; the clamp fixture |
| `nodims.html` | hero.png without `og:image:width/height` in the page | `large` too, for the same reason: Synapse fills the dimensions in. A genuine "no dimensions" answer can only come from a `page.route` stub |
| `noimage.html` | site "Codec Fixtures", title "Text-only release notes", description, no image | `text` layout |
| `title-only.html` | `<title>` "Plain page with only a title", no `og:*` | a card with the synthesised title (Synapse may add a description from the body text) or no card; QA asserts "no error, no request repeated" |
| `empty.html` | no `<title>`, no `og:*` | **no card** (`unavailable` in encrypted rooms) |
| no dimensions | QA stubs `preview_url` with an mxc `og:image` and no width/height | `thumbnail` layout (the box must be reservable, so unknown size is never large) |

## Test ID registry (additions)
### Link preview feature (Dev A, `src/features/link-preview/**`)
| testid | Element |
|---|---|
| `link-preview` (+`data-url` = the normalised, hash-stripped URL `extractPreviewUrls` returned, `data-state="click-to-load\|loading\|ready\|unavailable"`, `data-layout="large\|thumbnail\|text"` when `ready` (from `previewImageLayout`), `data-embed="youtube\|spotify"` when `parseEmbed(url)` is non-null) | One card (or its placeholder / button) per previewable URL, in message order; a hidden card is **not rendered**; in plain rooms an `empty` result renders nothing at all |
| `link-preview-site`, `link-preview-title`, `link-preview-description` | Site name (hostname fallback); title as `<a target="_blank" rel="noopener noreferrer" href=url>`; description, 3-line clamp (`-webkit-line-clamp: 3`) |
| `link-preview-image` | `<img>` whose `src` is an `mxcToHttp(...)` URL on the homeserver (`/_matrix/media/v3/` or `/_matrix/client/v1/media/`), inside a box with `width`/`height` (or `aspect-ratio`) set **before** load; `data-size="large\|thumbnail"` |
| `link-preview-hide` | The "x" (`aria-label="Hide preview"`, 44 px on phone) |
| `link-preview-load` | Encrypted rooms: the **Show preview** button (text "Show preview", plus the hostname) shown in state `click-to-load` |
| `link-preview-unavailable` | Encrypted rooms only: "No preview available" note (state `unavailable`) |
| `link-preview-play` | Play button over the card image for YouTube / Spotify URLs |
| `link-preview-embed` | The `<iframe>` created after the play click (`src` on `www.youtube-nocookie.com/embed/` or `open.spotify.com/embed/`) |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `link-previews` (+`data-count`) | Host under `message-body` in a row (main timeline and `thread-panel`), one `link-preview` child per URL; absent when there is nothing to preview |

### Core (Principal)
| name | Shape |
|---|---|
| `window.__matrixPoc.preview` | The whole `src/lib/preview` module (`src/app/devtools.ts`): `extractPreviewUrls`, `getPreviewUrls(event)`, `shouldAutoPreview(roomId, event?)`, `getLinkPreview`, `peekLinkPreview`, `primeLinkPreview`, `clearLinkPreviewCache()`, `linkPreviewCacheSize()`, `parseEmbed`, `previewImageLayout`, `isPreviewHidden`, `hidePreview`, `clearHiddenPreviews` (names per ARCHITECTURE "Phase 6 deltas (link previews)") |
| `localStorage['matrix-poc.hiddenPreviews']` (`HIDDEN_PREVIEWS_STORAGE_KEY`) | JSON array of `"<eventId>|<url>"` strings (`hiddenPreviewKey`), newest last, capped at `HIDDEN_PREVIEWS_MAX` (1000) |

## Criteria

### AC-L1 URL extraction (PRIN-24)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L1-1 | P0 | Given a plain `m.text` body `see F/article.html, and F/square.html.` then `extractPreviewUrls` (dev hook) returns exactly `[F/article.html, F/square.html]`: trailing punctuation dropped (the `linkify` rule), order kept, `http` and `https` both accepted, nothing else (`ftp:`, `mailto:`, bare `example.org`) returned. |
| AC-L1-2 | P0 | Given a body with 5 distinct links, then only the **first 3** are returned; given the same link 3 times, then it is returned **once**; `F/a.html` and `F/a.html#x` collapse into one (`F/a.html`, the hash stripped: the server would answer the same), while `F/a.html?x=1` is distinct. `m.emote` bodies count as prose; `m.image` / `m.file` captions yield nothing. |
| AC-L1-3 | P0 | Given a formatted body whose `formatted_body` has a link inside `<code>` or `<pre>` and one outside, then only the outside link is returned (the plain `body` is **not** used when `formatted_body` exists, so code links never leak back in). |
| AC-L1-4 | P0 | Given links to `https://matrix.to/#/...`, to the homeserver's own media (`<hsUrl>/_matrix/media/v3/download/...`, `/_matrix/client/v1/media/...`) or an `mxc://` URI, then none is returned. |
| AC-L1-5 | P0 | Given a GIF message (Phase 4 contract, its body carries the GIF URL), a redacted message, an undecryptable (`m.bad.encrypted`) or still-decrypting event, then no `link-previews` host renders for it. An `m.notice` with a link gets a card like `m.text`. |

### AC-L2 Automatic cards in plain rooms (PRIN-24, DEV-A-30, DEV-B-32)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L2-1 | P0 | Given `#dev`, when alice sends `Read this: F/article.html`, then within 5 s her row has `link-previews[data-count="1"]` with `link-preview[data-url=F/article.html][data-state="ready"]`, `link-preview-site` "The Codec Gazette", `link-preview-title` "Link previews land in Phase 6" whose `href` is the URL with `target="_blank"` and `rel` containing `noopener`, and `link-preview-description` non-empty; exactly **one** preview request was made, and it was `GET .../preview_url?url=<encoded URL>&ts=<number>` with the `Authorization` header. |
| AC-L2-2 | P0 | Given a message with `F/square.html F/article.html F/long.html F/title-only.html`, then `data-count` is `3`, the cards appear in that order (`thumbnail`, `large`, `large`), and no request is made for `title-only.html`. |
| AC-L2-3 | P0 | Given bob sends the AC-L2-1 message (API, as bob), then alice's row shows the same card (cards are per message, not per sender); the message text still contains the clickable link. |
| AC-L2-4 | P1 | Given the server returns an `og:image` that is **not** an `mxc://` URL (QA: `page.route` stub), then the card renders without `link-preview-image`. |

### AC-L3 Encrypted rooms: click-to-load (DEV-B-33, DEV-A-30)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L3-1 | P0 | Given `#vault`, when alice sends `F/article.html` and waits 3 s, then the row shows `link-preview[data-state="click-to-load"]` with `link-preview-load` reading "Show preview" and the hostname, **no** `link-preview-title`, and **zero** preview requests were made since the page loaded (request listener + catch-all route; AC-E6-4 continues to hold up to this point). Scrolling the row out of view and back changes nothing. |
| AC-L3-2 | P0 | When alice clicks `link-preview-load`, then exactly **one** preview request is made (for that URL only), the state goes `loading` -> `ready`, and the card equals AC-L2-1's. Other links in the same message keep their own buttons. |
| AC-L3-3 | P0 | Given a message with 2 links in `#vault`, when only the first button is clicked, then only the first URL appears in any request URL. |
| AC-L3-4 | P0 | Given `F/empty.html` (or an unreachable host) in `#vault`, when its button is clicked, then the element becomes `link-preview[data-state="unavailable"]` with `link-preview-unavailable` "No preview available"; no toast, no console error. |
| AC-L3-5 | P1 | Given a card loaded in AC-L3-2, when alice scrolls away and back within a minute (row unmounts and remounts), then it is `ready` immediately with no new request (in-memory cache); after a page **reload** it is `click-to-load` again and no request is made. |
| AC-L3-6 | P0 | Given a room that turns encrypted while open (AC-E6-6 setup), then a link sent **after** the flip gets the button, not an automatic card. |

### AC-L4 Card layout and images (DEV-A-30, PRIN-24)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L4-1 | P0 | Given the `article.html` card, then `data-layout="large"`, `link-preview-image[data-size="large"]` sits **below** the title/description (its `y` is greater than the description's), its `src` is an `mxcToHttp` thumbnail URL on the homeserver (never `<vite origin>/preview-fixtures/hero.png`), and it loads (`naturalWidth > 0`). |
| AC-L4-2 | P0 | Given the `square.html` card, then `data-layout="thumbnail"`, the image box is at most 96x96 CSS px and sits **beside** the text (same row as the title, not below the description); a stubbed answer with an mxc image and **no** width/height also renders `thumbnail` (`previewImageLayout` rule: unknown dimensions, not landscape, or width < 400 -> thumbnail; real pages cannot produce this because Synapse measures the image). `noimage.html` renders `data-layout="text"` with no `link-preview-image`. |
| AC-L4-3 | P0 | Given any card with an image, then the image box's rendered `height` is the same **before** the `<img>` loads (QA: route the thumbnail to delay 1 s and measure) and after: the row's height does not change when the image arrives. |
| AC-L4-4 | P0 | Given the `long.html` card on desktop, then the card is at most 480 px wide and the description element has at most 3 rendered lines (`clientHeight <= 3 * lineHeight + 2`); the `article.html` card shows its two sentences in full. |
| AC-L4-5 | P0 | **phone**: given the same card, then the card's width equals the message body's available width (within 2 px), `document.documentElement.scrollWidth <= innerWidth` (no horizontal scroll), `link-preview-hide` and `link-preview-load` are at least 44x44 px, and the title link is tappable. |
| AC-L4-6 | P1 | Given `long.html`, then the title is clamped to 2 lines; given no `og:site_name` (`title-only.html` or a stub), `link-preview-site` shows the hostname (`localhost`). |

### AC-L5 Hide, per viewer (PRIN-24, DEV-A-30)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L5-1 | P0 | Given a `ready` card, when alice clicks `link-preview-hide`, then that `link-preview` is removed, `data-count` drops by one (the host disappears at 0), the message text is unchanged, **no** event is sent to the room (API: the latest room event is still the message, no redaction / edit), and `localStorage['matrix-poc.hiddenPreviews']` contains `"<eventId>|<url>"`. |
| AC-L5-2 | P0 | When the page reloads, then the card stays hidden; given the **same URL in a different message**, that one still shows a card (the key is event id + URL). |
| AC-L5-3 | P0 | Given bob (second context or a fresh context) views the same message, then he sees the card (hiding is local to the viewer). |
| AC-L5-4 | P1 | Given `click-to-load` and `unavailable` elements in `#vault`, then they also carry `link-preview-hide` and hiding them persists the same way. |

### AC-L6 Errors stay quiet, caching (PRIN-24, DEV-B-32)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L6-1 | P0 | Given `preview_url` answers 404, 403, 429, 500, or a body without `og:title` / `og:description` / `og:image` (QA: `page.route` per case), then the row shows no `link-preview` for that URL in `#dev` (and `unavailable` after the click in `#vault`), no toast, no uncaught error in the console, and the message text renders normally. |
| AC-L6-2 | P0 | Given a slow `preview_url` (QA: route delays 3 s), then the row renders its text immediately, `link-preview[data-state="loading"]` reserves at most one line of height, and the card arrives when the response does (no client-side timeout of our own: the SDK's HTTP timeout applies and resolves to `empty`). |
| AC-L6-3 | P0 | Given the AC-L2-1 card, when alice scrolls 30 messages up and back down (the row unmounts / remounts), sends another message, or an edit of another message bumps the store `version`, all within the cache lifetime, then **no** additional preview request is made for that URL (requests counted since the first card). A failed URL (`null`, the negative cache) is not retried on remount either. |
| AC-L6-4 | P0 | Given two messages with the same URL rendered in the same paint (QA: send two in a row), then exactly **one** request is made (in-flight dedupe) and both rows show `ready`. |
| AC-L6-5 | P1 | Given `__matrixPoc.preview.clearLinkPreviewCache()` then a remount, the URL is fetched again (the cache is the only reason it was not); the cache is bounded (`PREVIEW_CACHE_MAX` 200 URLs, hits live `PREVIEW_CACHE_TTL_MS` 1 h, misses `PREVIEW_NEGATIVE_TTL_MS` 5 min; `linkPreviewCacheSize()` never exceeds 200). |

### AC-L7 Threads, quotes, edits, scroll (DEV-B-32, DEV-B-34)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L7-1 | P0 | Given a thread whose root and one reply each contain `F/article.html`, when the panel is open, then `thread-panel` shows a `link-previews` host under the root (`thread-root`) and under the reply; the main-timeline `thread-summary-*` row and the Threads list (`threads-list` items) contain **no** `link-preview`; a reply quoting that message (`message-reply-quote`) contains none either. |
| AC-L7-2 | P0 | Given alice's message `F/square.html`, when she **edits** it to `F/article.html`, then within 5 s the row's card is the article card and the square card is gone (`data-count` 1); editing to text without links removes the host; the Phase 5 `message-edited` marker is unaffected. |
| AC-L7-3 | P0 | Given alice is pinned to the bottom of `#dev` (AC-B1-1), when a new message with `F/article.html` arrives (bob via API) and its large image loads, then the list is still at the bottom (`scrollHeight - scrollTop - clientHeight < 2`) after the card is `ready` and after the image loads (**regression for stick-to-bottom**, BUG-28 family). |
| AC-L7-4 | P0 | Given alice scrolled up with an older article card above the viewport still `loading`, when its card and image arrive, then the message she was reading keeps its on-screen position within 2 px (reserved boxes; the Phase 4 no-jump rule). |
| AC-L7-5 | P1 | Given a redaction of a message with a card, then the card disappears with the text (`message-redacted` only). |

### AC-L8 Embeds (P1; DEV-A-31, PRIN-24)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L8-1 | P1 | Given `parseEmbed` (dev hook): `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, `https://youtu.be/dQw4w9WgXcQ?t=5`, `https://youtube.com/shorts/dQw4w9WgXcQ` -> `{ provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ[?start=5]', startSeconds }`; `https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC` -> `{ provider: 'spotify', kind: 'track', id, embedUrl: 'https://open.spotify.com/embed/track/<id>' }` (also `album`, `playlist`, `episode`, and `/intl-de/` prefixes); `https://www.youtube.com/` and `https://open.spotify.com/user/x` -> `null`. |
| AC-L8-2 | P1 | Given a YouTube URL in `#dev` (QA stubs `preview_url` with an mxc image so no internet is needed), then the card is `ready` with `data-embed="youtube"` and `link-preview-play`, and **no** request goes to any host other than the homeserver and the Vite origin (catch-all route on `**youtube**`, `**ytimg**`, `**spotify**` fails the test). |
| AC-L8-3 | P1 | When `link-preview-play` is clicked, then `link-preview-embed` is an `<iframe>` with `src` starting `https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ` (Spotify: `https://open.spotify.com/embed/track/<id>`), with a `sandbox` attribute and the image/play button gone; QA asserts the iframe exists and its `src`, with the route still blocking the host (the request is now expected and the test allows it after the click). |
| AC-L8-4 | P1 | Given the same URL in `#vault`, then the flow is **Show preview** -> card with play -> click -> iframe; no third-party and no homeserver preview request before the respective clicks. |

### AC-L9 Homeserver config, fixtures, docs (PRIN-25)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L9-1 | P0 | Given the test Synapse (`homeserver/homeserver.yaml` and the pool template in `scripts/hs.mjs`), then `url_preview_enabled: true`, `url_preview_ip_range_whitelist` contains `127.0.0.1/32` and `::1/128`, the blacklist is otherwise unchanged, and `GET /_matrix/client/v1/media/preview_url?url=<F/article.html>` as alice returns `og:title` "Link previews land in Phase 6" and an `mxc://` `og:image` with `og:image:width` 1200 (`e2e/homeserver-config.spec.ts` or the new spec). Production configs are not touched. |
| AC-L9-2 | P0 | Given `npm run dev` (or the pool's Vite), then every page in the fixture table above is served at `/preview-fixtures/<name>` with the stated tags, `hero.png` is 1200x630 and `thumb.png` 128x128, and `npm run preview:fixtures` reproduces them byte for byte. |
| AC-L9-3 | P0 | docs/ARCHITECTURE.md has a "Phase 6 deltas (link previews)" section: the module map (`extract`, `normalize`, `cache`, `embed`, `hidden` pure; `fetch`, `policy` SDK-bound; `hooks` React), the cache policy (200 / 1 h / 5 min, in-flight dedupe, the SDK's own per-minute promise cache gotcha), the extraction rules, the hidden-store key, the whitelist note and the "fixture URL must use the page's own port" gotcha; `npm run typecheck` and `npm run build` pass. |

### AC-L10 Suites, regression (QA-30..33)
| ID | P | Given / When / Then |
|---|---|---|
| AC-L10-1 | P0 | `e2e/link-preview.spec.ts` (desktop: AC-L1..L3, L4-1..4, L5..L9) and `e2e/mobile-link-preview.spec.ts` (phone: AC-L4-5, L3-1/2, L5-1) exist, use `e2e/fixtures/link-preview.ts` (`fixtureUrl(page, name)`, `previewRequests(page)` listener, `stubPreview(page, handler)`, `resetPreviews(page)` = `__matrixPoc.preview.clearHiddenPreviews()` + `clearLinkPreviewCache()`), and run in the parallel suite; `npm run test:e2e:link-preview` runs both. |
| AC-L10-2 | P0 | Every spec installs the **no-third-party** guard (`**youtube**`, `**ytimg**`, `**spotify**`, `**googlevideo**` -> fail) and the **no preview request in encrypted rooms before a click** guard where it applies. |
| AC-L10-3 | P0 | Both projects green at the end of Wave 18 (fresh-seed skips only), recorded in docs/STATUS.md; Phase 1-5 suites unchanged (plain text messages render byte-for-byte as before when they have no links). |
| AC-L10-4 | P0 | Every bug or review finding fixed in Wave 18 has a regression test in `e2e/` in the same change (JC's rule); docs/BUGS.md "Phase 6" lists the spec commands and the severity rule (S1: a preview request from an encrypted room without a click, a third-party request without a click, or a raw non-homeserver image URL rendered). |
