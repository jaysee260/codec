# Phase 4 Acceptance Criteria and Test ID Contract

Extends docs/ACCEPTANCE.md, docs/archive/PHASE2_ACCEPTANCE.md and docs/archive/PHASE3_ACCEPTANCE.md (conventions, registries and criteria stay in force). Numbering `AC-G<group>-<n>`; each group names its tickets (docs/archive/PHASE4_TICKETS.md). "desktop" = the `desktop` Playwright project, "phone" = the `mobile` project (Pixel 7), logged in as alice, **dirty seed always allowed**: every criterion sends its own messages and asserts on its own event ids. "under `mock`" = `localStorage['matrix-poc.gifProvider'] = 'mock'` set before the page loads; "under `klipy`" = `matrix-poc.gifProvider = 'klipy'` + `matrix-poc.gifApiKey = 'e2e-fake-key'` with **every** request to `api.klipy.com` and `static*.klipy.com` answered by QA's `page.route` stubs (an unstubbed request fails the test: the Test key quota is 100/hour). "a GIF via API" = QA's `sendGifMessage`, which sends the contract below as bob. **Realigned 2026-10-09 to the shipped `src/lib/gif/`**: API names and types below are the shipped ones (`src/lib/gif/types.ts`, `message.ts`, `provider.ts` win over older wording); the mock fixture contract is unchanged.

## GIF message event (the contract Dev B, Principal and QA code against)
`sendGif(roomId, gif, { threadRoot? })` sends exactly this `m.room.message` content (`buildGifContent(gif)` in `src/lib/gif/message.ts`; plus the Phase 3 `m.relates_to` when `threadRoot` is set; no `format`/`formatted_body`):

```json
{
  "msgtype": "m.text",
  "body": "Tacos dance https://static.klipy.com/ii/.../hd.gif",
  "dev.matrixpoc.gif": {
    "provider": "klipy",
    "id": "hello-hi-662",
    "title": "Tacos dance",
    "url": "https://static.klipy.com/ii/.../hd.gif",
    "w": 498,
    "h": 498,
    "previewUrl": "https://static.klipy.com/ii/.../sm.webp",
    "previewW": 220,
    "previewH": 220,
    "stillUrl": "https://static.klipy.com/ii/.../sm.jpg"
  }
}
```
Rules: `body` = `"<title> <url>"` (title trimmed, falls back to `GIF`; the URL is the last whitespace-separated token so Element shows the link and the server's URL preview unfurls it); `url` = `GifResult.fullUrl`, the `GIF_SEND_VARIANT` gif (`hd`, else `md`, else `sm`), always absolute: `https://static.klipy.com/...` for `klipy`, `<own origin>/gif-fixtures/<id>.gif` for `mock`; `id` is a string: the Klipy `slug` (`hello-hi-662`; Klipy's numeric `id` can exceed 2^53 and is unsafe in JSON), `mock-N` for mock; `w`/`h` = `fullW`/`fullH`, `previewW`/`previewH` positive integers (<= 2000); `previewUrl` = `sm.webp`, else `sm.mp4`, else `sm.gif` (the gif itself for `mock`); `stillUrl` = `sm.jpg` for `klipy`, `<own origin>/gif-fixtures/<id>.png` for `mock`, omitted when unknown. **Reading** (`parseGifContent` / `getGifContent(event)`): the field renders inline only when it is an object, `w`/`h` are integers 1..2000 and `url` is `https` on a host in `GIF_IMAGE_HOSTS` (`static.klipy.com`, `static1.klipy.com`, `static2.klipy.com`) or `<own origin>/gif-fixtures/<name>.gif|png`; otherwise the event is an ordinary `m.text`. Invalid `previewUrl`/`stillUrl` are dropped, not fatal. `previewText` of a GIF event is `[gif] <title>`. Edits of a GIF message are out of scope (`message-action-edit` hidden on GIF rows); reactions, replies, threads and delete work as for any message.

**Endpoints QA stubs** (`klipy`): `GET https://api.klipy.com/api/v1/{key}/gifs/search?q=&page=&per_page=&content_filter=&customer_id=` and `.../gifs/trending?page=&per_page=&content_filter=&customer_id=` (`locale` only when configured) -> `{ "result": true, "data": { "data": [item], "current_page": 1, "per_page": 24, "has_next": false } }`, item `{ id, slug, title, file: { hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height, size } } } }`; media `GET https://static.klipy.com/**` -> the mock fixture bytes with the right `Content-Type`. `VITE_GIF_API_BASE` can repoint the API origin, but the stubs target the default. QA's fixture JSON (`e2e/fixtures/klipy-search.json`, `klipy-trending.json`) mirrors this shape with `static.klipy.com` URLs.

## Mock provider fixture contract (PRIN-13; Dev A and QA rely on these)
Files `public/gif-fixtures/<id>.gif` (2-3 frame animated GIF89a, <= 3 KB each) and `<id>.png` (first frame). Trending returns all eight in this order; search is a case-insensitive substring match on the title in the same order (empty query = everything); `__empty__` and `nothing-here` return `[]`; `__error__` rejects with `GifProviderError` `kind: 'network'`; one page only (`nextPage` `null`, `hasNext` `false`; `limit` ignored); results resolve within 50 ms. `previewUrl` = the gif (`previewMimetype: 'image/gif'`), `previewW/H` = `fullW/H`, `stillUrl` = the png, `provider: 'mock'`.

| id | title | w x h | Matches |
|---|---|---|---|
| `mock-1` | `Tacos dance` | 240 x 180 | `tacos`, `dance` |
| `mock-2` | `Tacos Tuesday` | 200 x 200 | `tacos`, `tuesday` |
| `mock-3` | `Tacos party` | 240 x 180 | `tacos`, `party` |
| `mock-4` | `Party popper` | 160 x 160 | `party` |
| `mock-5` | `Cat typing` | 240 x 180 | `cat` |
| `mock-6` | `Cat nope` | 200 x 150 | `cat`, `nope` |
| `mock-7` | `Thumbs up` | 240 x 180 | `thumbs` |
| `mock-8` | `Facepalm` | 240 x 180 | `facepalm` |

So `tacos` and `taco` -> exactly `[mock-1, mock-2, mock-3]` (three results, so the demo's two ArrowRights land on `mock-3`), `party` -> `[mock-3, mock-4]`, `cat` -> `[mock-5, mock-6]`, `dance` -> `[mock-1]`.

## Test ID registry (additions)
Conventions as docs/ACCEPTANCE.md. **Prefix rule** (Phase 3): `composer-gif` and `gif-pending` live inside the composer and become `thread-composer-gif` / `thread-gif-pending` in the panel. The picker is a singleton overlay mounted once per page: every `gif-picker*`, `gif-search`, `gif-grid`, `gif-item-*`, `gif-*` state id is **never prefixed**. Row ids (`message-gif*`) are the same in the channel and the panel. **Close ownership**: Dev A's picker closes itself only via Escape *inside it* and `gif-close`; the mount (Dev B) owns `gif-backdrop`, click-outside and Escape at the mount level.

### Picker (Dev A, `src/features/gif/**`)
| testid | Element |
|---|---|
| `gif-picker` (+`data-variant="popover\|sheet"`, `data-provider="klipy\|mock"`) | Picker root; `role="dialog"`, `aria-label="GIF picker"` |
| `gif-search` | Text input; placeholder exactly `Search KLIPY` under `klipy`, `Search GIFs` under `mock`; autofocused on open |
| `gif-heading` | `Trending` while the query is empty, `Results for "<query>"` otherwise |
| `gif-grid` | Scrollable grid (`role="listbox"`); 3 columns in the popover, 2 in the sheet |
| `gif-item-{id}` (+`data-index`, `data-selected="true\|false"`, `data-w`, `data-h`) | One tile per result in provider order (`role="option"`, `aria-label` = title); contains the animated preview (`<img>` for webp/gif, muted looping `<video>` for mp4) |
| `gif-loading` | Spinner/skeleton while a request is in flight and the grid is empty |
| `gif-empty` | `No GIFs for "<query>"` |
| `gif-error`, `gif-error-retry` | `Could not load GIFs` (`Too many requests, try again shortly` for `kind: 'rate-limit'`) + a Retry button that re-runs the last request |
| `gif-attribution` | `Powered by KLIPY` under `klipy`, `Mock GIFs (no key)` under `mock` |
| `gif-close` | Close button (X); >= 44 px on phone |
| `gif-load-more` | Sentinel at the end of the grid; when visible and `nextPage` is not `null`, the next page is appended (P1) |

### Conversation (Dev B, `src/features/conversation/**`)
| testid | Element |
|---|---|
| `composer-gif` | Button between `composer-attach` and the input, title `Send a GIF`; prefix rule applies; >= 44 px on phone |
| `gif-backdrop` | Overlay behind the open picker (popover and sheet); click/tap closes; rendered by the mount, not the picker |
| `gif-pending` | Chip in the composer reading `Sending GIF...` from pick until the event is acked or fails; prefix rule applies |
| `message-gif` (+`data-provider`, `data-gif-id`, `data-state="playing\|paused\|offscreen\|fallback"`) | Row body wrapper for an event with a valid `dev.matrixpoc.gif`; replaces the plain text body |
| `message-gif-img` | The `<img>` loading `url`, `width`/`height` from `w/h` scaled into the 400 x 300 box (AC-B4 rule), `alt` = title |
| `message-gif-badge` | Small `GIF` label overlaid on the image |
| `message-gif-placeholder` | Sized empty box shown instead of the image while `offscreen`, and while `paused` when there is no `stillUrl` |
| `message-gif-play` | Play control shown in the `paused` state (reduced motion); click -> `playing` |
| `message-gif-fallback` | Title + link when the image fails to load (`fallback`) |

## Criteria

### AC-G1 Provider abstraction and mock provider (PRIN-13)
| ID | Given / When / Then |
|---|---|
| AC-G1-1 | Given no `VITE_GIF_API_KEY` and no localStorage overrides, then `gifProviderName()` is `mock` and `gif-picker` has `data-provider="mock"`. Given `matrix-poc.gifApiKey` set (or `setGifApiKey(k)`), then `klipy`. Given `matrix-poc.gifProvider = 'mock'` (or `setGifProvider('mock')`) and a key, then `mock` (the override wins); `'klipy'` with no key makes every call reject with `kind: 'auth'`. |
| AC-G1-2 | Given `mock`, when `getGifProvider().trending()` resolves, then `results` are `mock-1..mock-8` in order with the contract titles, dimensions, own-origin `fullUrl`/`previewUrl`/`stillUrl`, `mimetype: 'image/gif'`, `provider: 'mock'`, and `nextPage` `null`; `search('tacos')` -> `[mock-1, mock-2, mock-3]`, `search('DANCE')` -> `[mock-1]`, `search('__empty__')` -> `[]`, `search('__error__')` rejects with `GifProviderError` `kind: 'network'`. (QA via `page.evaluate` on `window.__poc.gif` or through the picker.) |
| AC-G1-3 | Given `GET /gif-fixtures/mock-1.gif` from the dev server, then the body starts with `GIF89a`, is an animated GIF (>= 2 image descriptors) of 240 x 180, and `Content-Type` is `image/gif`; `mock-1.png` is a PNG of the same size. The generator is byte-stable (re-running never dirties git). |

### AC-G2 Klipy provider (PRIN-14)
| ID | Given / When / Then |
|---|---|
| AC-G2-1 | Given `klipy` with key `e2e-fake-key`, when the picker opens, then exactly one request hits `https://api.klipy.com/api/v1/e2e-fake-key/gifs/trending` with `page=1`, `per_page=24`, `content_filter=medium`, a `customer_id` (stable across reloads in the same browser, `matrix-poc.gifCustomerId`), no `locale` unless configured, and no `Authorization` header; a search sends `.../gifs/search?q=tacos&page=1&per_page=24&content_filter=medium&customer_id=...`; `limit` is clamped to 8..50. |
| AC-G2-2 | Given the stub returns the fixture JSON, then each `GifResult` (`mapKlipyItem`) maps `id` = `item.slug` (not the numeric `id`, which can exceed 2^53), `title`, `fullUrl` = `file.hd.gif.url` (`md`, `sm` fallback) with `fullW/H/Size` from the same variant, `previewUrl` = `file.sm.webp.url` (else mp4, else gif) with `previewMimetype` and `previewW/H`, `stillUrl` = `file.sm.jpg.url`, `mimetype: 'image/gif'`, `provider: 'klipy'`; `nextPage` = `current_page + 1` when `has_next`, else `null`; the order equals the stub order. |
| AC-G2-3 | Given the stub answers 429, then the promise rejects with `GifProviderError` `kind: 'rate-limit'` (`status` 429, `retryAfterMs` from `Retry-After` when present); 401/403/404 -> `kind: 'auth'`; 500 or malformed JSON -> `'bad-response'`; a network failure -> `'network'`; an aborted signal -> `'aborted'`. The picker shows `gif-error` for every kind but `aborted`; `gif-error-retry` sends one new request. |
| AC-G2-4 | Given a search for `ta` then `tac` then `tacos` typed within 300 ms, then only one search request is sent (debounce; earlier in-flight ones are aborted); the same query twice within a session sends one request (cache of the last 20 queries). |

### AC-G3 `sendGif` and the event reader (PRIN-15)
| ID | Given / When / Then |
|---|---|
| AC-G3-1 | Given a pick under `mock` (`mock-1`), when the event is fetched via API, then its content matches the contract field by field: `msgtype` `m.text`, `body` = `Tacos dance http://localhost:5173/gif-fixtures/mock-1.gif`, `dev.matrixpoc.gif` with `provider` `mock`, `id` `mock-1`, `title` `Tacos dance`, `url` that gif, `w` 240, `h` 180, `previewUrl` the same gif, `previewW/H` 240/180, `stillUrl` `.../gif-fixtures/mock-1.png`; no `format`, no `url`/`info` at the top level. |
| AC-G3-2 | Given a pick under `klipy` (stubbed item), then `url`'s host is `static.klipy.com`, `body` ends with that `url`, `w/h` equal the stub's `hd.gif` dimensions, and `stillUrl` is the stub's `sm.jpg`. |
| AC-G3-3 | Given `sendGif(roomId, gif, { threadRoot })`, then the content additionally carries the Phase 3 thread relation (AC-T2-1 shape) and the row appears in the thread, not the channel (P1). |
| AC-G3-4 | Given an event (sent via API) whose `dev.matrixpoc.gif.url` host is `evil.example`, or is `http://static.klipy.com/...` (not https), or whose `w` is 0 or 4000, or whose field is a string, then `getGifContent` returns `null` and the row renders the plain `body` text with no `message-gif`; a valid field with a bad `stillUrl` still renders (`stillUrl` dropped). |
| AC-G3-5 | Given the dev build and the Android `WebView`, then an `<img>` with `src` `https://static.klipy.com/...` loads (no CSP / sanitizer / Capacitor block); review of `index.html`, `capacitor.config.ts` and `format.ts` plus one manual device check. |

### AC-G4 Picker UI (DEV-A-20)
| ID | Given / When / Then |
|---|---|
| AC-G4-1 | Given `<GifPicker variant="popover" />` mounted with no `initialQuery`, then within 1 s `gif-picker` shows `gif-heading` `Trending`, `gif-grid` with one `gif-item-{id}` per result (8 under `mock`) in provider order, `gif-attribution`, `gif-close`, and `gif-search` has focus with an empty value. |
| AC-G4-2 | Given `initialQuery="tacos"`, then `gif-search` reads `tacos`, `gif-heading` reads `Results for "tacos"` and the grid shows exactly `gif-item-mock-1`, `-mock-2`, `-mock-3` in that order. |
| AC-G4-3 | Given the provider returns results in order `[a, b, c]`, then `gif-item-*` `data-index` 0, 1, 2 follow that order and no client-side filtering or sorting is applied (Klipy's order rule). |
| AC-G4-4 | When I type `party` into `gif-search`, then `gif-loading` may show, and within 1 s of the last keystroke the grid shows `mock-3`, `mock-4`; clearing the input returns to `Trending`. |
| AC-G4-5 | When I type `__empty__`, then `gif-empty` reads `No GIFs for "__empty__"` and the grid is empty; `__error__` shows `gif-error` with `gif-error-retry`; clicking retry under a now-working provider shows results. |
| AC-G4-6 | When I click `gif-item-mock-3`, then `onPick` is called once with that `GifResult`; clicking `gif-close` or pressing Escape with focus inside the picker calls `onClose`. The picker renders no backdrop and does not listen for outside clicks (the mount does, AC-G6-5). |
| AC-G4-7 | Given `klipy`, then `gif-search`'s placeholder is exactly `Search KLIPY` and `gif-attribution` reads `Powered by KLIPY`; given `mock`, `Search GIFs` / `Mock GIFs (no key)`. |
| AC-G4-8 | Given a tile whose `previewMimetype` is `video/mp4` (stub), then it renders a muted, autoplaying, looping, `playsinline` `<video>`; webp/gif previews render an `<img>` with `alt` = title; tiles reserve their aspect ratio from `previewW/H` (no layout shift). |

### AC-G5 Keyboard navigation (DEV-A-21)
| ID | Given / When / Then |
|---|---|
| AC-G5-1 | Given focus in `gif-search` with results, when I press ArrowDown, then `gif-item-*` index 0 has `data-selected="true"` and `aria-activedescendant` points at it; ArrowRight/Left/Down/Up move the selection by 1 / 1 / columns / columns, clamped; the selected tile is scrolled into view. |
| AC-G5-2 | Given a selected tile, when I press Enter, then `onPick` fires with it; Escape calls `onClose`; typing a printable character returns focus to `gif-search` and appends it. |
| AC-G5-3 | Given `initialQuery` results, then index 0 is pre-selected so `/gif tacos`, Enter, Enter sends `mock-1` (demo step 3 with no arrows); ArrowRight twice then Enter sends `mock-3`. |
| AC-G5-4 | Given the picker open, then Tab cycles within the picker (search, grid, retry/close) and focus never lands in the composer behind it. |

### AC-G6 Composer triggers and mounting (DEV-B-23)
| ID | Given / When / Then |
|---|---|
| AC-G6-1 | Given `#general`, then `composer` contains `composer-gif` between `composer-attach` and `composer-input`; the composer height is unchanged (Phase 1/2 pixel rule) and AC-V6-1 holds on phone (44 px). |
| AC-G6-2 | When I click `composer-gif`, then `gif-picker` (`data-variant="popover"` on desktop) appears above the composer with its bottom edge within 8 px of the composer's top and its left edge aligned to the composer, with `gif-backdrop` behind it; no message is sent; clicking it again or `gif-close` closes it and focus returns to `composer-input`. |
| AC-G6-3 | When I type `/gif tacos` and press Enter, then no message is sent, `composer-input` is empty, and the picker opens with `gif-search` = `tacos`; `/GIPHY tacos` behaves the same; `/gif` alone opens on `Trending`. |
| AC-G6-4 | When I type `/gifs tacos`, `/giffy`, `/ gif tacos` or `/slap bob` and press Enter, then it is sent as a normal `m.text` with that body. |
| AC-G6-5 | Given the picker open, when I press Escape (focus anywhere) or click `gif-backdrop` / outside the picker, then the mount closes it, nothing is sent, `composer-input` is empty and focused; a reply banner (AC-B6) set before opening is still set after closing. |
| AC-G6-6 | Given the thread panel open, then `thread-composer-gif` exists and opens the same `gif-picker` (one instance; opening from the panel closes a channel-opened one); `/gif` in `thread-composer-input` works the same (P1). |
| AC-G6-7 | Given the picker open, when the room changes, then it closes. |

### AC-G7 Send flow (DEV-B-24)
| ID | Given / When / Then |
|---|---|
| AC-G7-1 | When I pick a tile, then the picker closes immediately, `gif-pending` appears in the composer, and a row for alice with `message-gif[data-gif-id]` = that id appears in `message-list` within 5 s; `gif-pending` is gone once the event has a `$` id; `composer-input` keeps focus. |
| AC-G7-2 | Given the send fails (QA: `page.route` answers the next `PUT .../send/m.room.message/*` with 500 once), then `toast` reads `Could not send GIF` and `gif-pending` is gone within 5 s; the picker is not reopened. |
| AC-G7-3 | Given `gif-pending` showing, then `composer-gif` is disabled and a second `/gif` Enter is ignored until it clears (one GIF in flight per composer). |
| AC-G7-4 | Given a pick from the thread composer, then the event carries the thread relation and the row appears in `thread-message-list` only (P1, with AC-G3-3). |

### AC-G8 GIF rendering (DEV-B-25)
| ID | Given / When / Then |
|---|---|
| AC-G8-1 | Given a GIF via API from bob (contract content, `mock-1`), then within 3 s the row shows `message-gif` with `data-provider="mock"`, `message-gif-img` whose `src` equals `url`, `width`/`height` 240 x 180, `alt` `Tacos dance`, and `message-gif-badge` reading `GIF`; the body text `Tacos dance http://...` is not rendered as text; `message-body` is not a link. |
| AC-G8-2 | Given a 498 x 498 `klipy` GIF, then the image is 300 x 300 (scaled into the 400 x 300 box); hover/toolbar actions (react, reply, thread, delete) work; `message-action-edit` is absent on GIF rows. |
| AC-G8-3 | Given a GIF row scrolled far out of view (>= 1 viewport, 20 text messages after it), then within 1 s `message-gif` has `data-state="offscreen"`, `message-gif-img` is not in the DOM and `message-gif-placeholder` has the same width/height; scrolling back restores `data-state="playing"` and the `<img>` with no layout shift (`message-list` scrollHeight unchanged +/- 2 px). |
| AC-G8-4 | Given `page.emulateMedia({ reducedMotion: 'reduce' })`, then a visible GIF row has `data-state="paused"` and `message-gif-play`; `message-gif-img` shows `stillUrl` (the png under `mock`, `sm.jpg` under `klipy`), or `message-gif-placeholder` when the event has none; clicking play switches to `playing` with `src` = `url`; the badge stays. |
| AC-G8-5 | Given the image fails to load (QA: stub `static.klipy.com` with 404 for that URL), then `data-state="fallback"` and `message-gif-fallback` shows the title and a link to `url` (`target="_blank"`, `rel="noopener noreferrer"`). |
| AC-G8-6 | Given a GIF row, then AC-B1 grouping, `message-timestamp`, reactions (`reaction-{key}`) and `message-reply-quote` on a reply to it (quote shows `[gif] Tacos dance`, the `previewText` rule, also used by the thread list and channel previews) behave as for a text row; AC-B9 delete shows `message-redacted`. |

### AC-G9 Phone (DEV-A-20 sheet variant, DEV-B-26)
| ID | Given / When / Then |
|---|---|
| AC-G9-1 | Given phone, when I tap `composer-gif`, then `gif-picker` has `data-variant="sheet"`, spans the viewport width, its bottom edge equals `app-shell`'s bottom edge (safe area, AC-V6-1 rule), height between 55 and 85 % of the viewport, 2-column `gif-grid`, `gif-backdrop` behind it; `gif-close` and tiles are >= 44 px. |
| AC-G9-2 | When I tap `gif-backdrop` or `gif-close`, then the sheet closes and nothing is sent; opening the sheet closes any open drawer, and Android back closes the sheet before the thread and drawers (`registerBackHandler`; **manual, device**). |
| AC-G9-3 | When I tap a tile, then the sheet closes and the GIF row appears as in AC-G7-1; `gif-search` has a 16 px font (no zoom, AC-V6-1). |
| AC-G9-4 | Given phone, when I type `/giphy cat` and tap send, then the sheet opens with `gif-search` = `cat` showing `mock-5`, `mock-6`. |

### AC-G10 Demo tooling and docs (PRIN-16)
| ID | Given / When / Then |
|---|---|
| AC-G10-1 | Given `npm run gif:sample -- --room '#general:localhost'` (default) then bob posts one contract GIF message (`mock-7`, own-origin URLs from `--origin`, default `http://localhost:5173`), prints JSON `{ roomId, eventId }` and exits 0; `--id mock-3` picks another fixture; `--root <id>` sends it into a thread. |
| AC-G10-2 | `.env.example` documents `VITE_GIF_API_KEY` (optional, Klipy Partner Panel URL, mock fallback, extractable from the APK) and `VITE_GIF_API_BASE`; docs/MOBILE.md has the APK rebuild note; docs/ARCHITECTURE.md has a "Phase 4 deltas" section listing every name or shape that differs from the Shared API table and the static-thumbnail note for user-attached GIFs. |

### AC-G11 Demo walkthrough and regression (QA-22, QA-23)
| ID | Given / When / Then |
|---|---|
| AC-G11-1 | `e2e/smoke.spec.ts` step 12 walks desktop demo steps 2-7 under `mock` (bob via `sendGifMessage` in place of the script) with a screenshot per sub-step in `e2e/results/demo/12-*`. |
| AC-G11-2 | `e2e/mobile-smoke.spec.ts` step 12 walks phone demo steps 2-5 under `mock` with screenshots in `e2e/demo-mobile/12-*`. |
| AC-G11-3 | Given any spec in either project, then no request reaches `api.klipy.com` or `static*.klipy.com` unstubbed (the catch-all route fails the test), so a key in `.env` never spends quota. |
| AC-G11-4 | Both projects are green (known fresh-seed skips only) at the end of Wave 11; recorded in docs/STATUS.md. |
