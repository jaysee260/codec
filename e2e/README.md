# e2e

QA owns this folder (see `docs/TICKETS.md` QA-1, `docs/PHASE2_TICKETS.md` QA-8..13 and
`docs/PHASE3_TICKETS.md` QA-14..18). Specs are `*.spec.ts`, helpers live in `fixtures/`.

## Which specs CI runs

Pushes to master run everything. A pull request runs the two smoke walk-throughs plus the specs for the areas it
changes (`scripts/select-e2e.mjs`; shared code such as `src/lib/matrix`, `src/store` or `e2e/fixtures` runs
everything). Label a PR `full-e2e` to force the whole suite. **A new spec must be added to an area there**:
`npm run test:unit` fails until it is.

## Projects

`playwright.config.ts` declares two projects. A spec belongs to exactly one of them.

| Project | Device | Specs | `outputDir` |
|---|---|---|---|
| `desktop` | `devices['Desktop Chrome']`, 1280x720 | the Phase 1 suite + Phase 3 threads | `e2e/results/desktop` |
| `mobile` | `devices['Pixel 7']` — 412x839 CSS px, `isMobile`, `hasTouch`, `permissions: ['microphone']` | the Phase 2 phone suites + Phase 3 phone threads | `e2e/results/mobile` |

| File | Project | Covers |
|---|---|---|
| `shell.spec.ts` | desktop | AC-SH-1 .. AC-SH-5 (login, session, logout) |
| `navigation.spec.ts` | desktop | AC-A1-1 .. AC-A9-1 (rail, channels, DMs, members, badges, create/invite) |
| `conversation-timeline.spec.ts` | desktop | AC-B1 (timeline rendering, grouping), AC-B3 (backwards pagination), AC-B7 (typing indicator, read receipts) |
| `conversation-compose.spec.ts` | desktop | AC-B2 (composer), AC-B6 (replies), AC-B8 (upload), AC-B9 (edit/delete), AC-B10 (mentions) |
| `conversation-messages.spec.ts` | desktop | AC-B4 (rich bodies, images, sanitising), AC-B5 (reactions) |
| `smoke.spec.ts` | desktop | the `docs/PLAN.md` demo script steps 1-10, plus the `docs/PHASE3_PLAN.md` thread walk-through as step 11; serial, one screenshot per sub-step into `results/demo/` |
| `voice.spec.ts` | mobile | AC-V1 .. AC-V6 recording/playback, with every sent event re-read through the API and the uploaded bytes checked by their container magic |
| `mobile-nav.spec.ts` | mobile | AC-M1 .. AC-M6 (phone shell, drawers, header, touch targets, bottom sheets, viewport CSS) + the layout half of AC-V6 |
| `mobile-smoke.spec.ts` | mobile | the `docs/PHASE2_PLAN.md` **phone** demo script steps 1-10, plus the `docs/PHASE3_PLAN.md` phone thread walk-through as step 11; serial, one screenshot per sub-step into `e2e/demo-mobile/` |
| `threads.spec.ts` | desktop | AC-T1 .. AC-T9: the thread wire contract, main-timeline hygiene, panel geometry, the summary row, Reply in thread, ThreadView, the Threads list, in-thread edits/reactions/delete/media |
| `mobile-threads.spec.ts` | mobile | AC-T3-4, AC-T4-6, AC-T5-2, AC-T7-1/2/4/7, AC-T8-1..3, and the AC-V6-1 composer rules applied to `thread-composer-*` |
| `e2ee-core-boot.spec.ts` | desktop | Phase 5 AC-E1 (crypto boot, reload, logout wipe), the members-panel layout regression, AC-E6 (encrypted by default) |
| `e2ee-core-timeline.spec.ts` | desktop | Phase 5 AC-E2 (decrypt, UTD, late decryption, relations), AC-E7-3, + regressions |
| `e2ee-media.spec.ts` | desktop | Phase 5 AC-E3: encrypted image / file / voice (decrypted shape, ciphertext on the media repo, hash check, lazy load) |
| `e2ee-security-chain.spec.ts` | desktop | Phase 5 AC-E4 / AC-E5 on throwaway accounts: the serial setup -> unlock -> SAS (match / mismatch / decline) -> backup chain, AC-E5-4 passphrase unlock |
| `e2ee-security-regressions.spec.ts` | desktop | Phase 5 AC-E4 / AC-E5 regressions (banner, dialog close testids, unlock errorKind, verification requests, SAS via the store) |
| `e2ee-recovery-second-key.spec.ts` | desktop | Recovery unlock hang (2026-10-18): backup secret under a second, non-default secret-storage key; unlock with the default key renders the K2 prompt while busy; Cancel -> `locked` (verified) -> `recovery-retry` (wrong key -> `locked`, K2 -> `done`); K2 at the prompt -> `done`; Hide (X) keeps the unlock and prompt alive |
| `android-build.mjs` | *(none — plain Node)* | AC-C1-1..4 and AC-C3-1/2: builds the APK and inspects it with `aapt` |

Each project has its **own** `outputDir`, so `npm run test:e2e:mobile` cannot wipe the desktop run's
traces. Both demo screenshot sets live *outside* those directories (`e2e/results/demo/` and
`e2e/demo-mobile/`) and therefore survive every run.

### Fake media (QA-8)

`launchOptions.args` are set globally in `playwright.config.ts` because they are harmless to the
desktop project:

| Flag | Why |
|---|---|
| `--use-fake-device-for-media-stream` | `getUserMedia({ audio: true })` returns a looping tone, so `MediaRecorder` produces real Opus bytes, `decodeAudioData` decodes them, and `recording-level` genuinely moves |
| `--use-fake-ui-for-media-stream` | auto-accepts the permission prompt |
| `--autoplay-policy=no-user-gesture-required` | `<audio>.play()` resolves in headless |

The `mobile` project additionally grants `permissions: ['microphone']` on the context (the flag
covers the prompt, the grant covers the Permissions API). The reference pipeline is
`docs/advisor/fake-mic-probe.mjs`. On this machine Chromium records `audio/webm;codecs=opus` — see
"AC-V2-4 is waived" in `docs/BUGS.md`.

## Running

One-time: a Synapse backend for the server pool, either a venv (Linux/macOS; Windows needs Docker or uses the
WSL1 fallback below) or Docker (`docker info` works; image `SYNAPSE_IMAGE`, default `ghcr.io/element-hq/synapse:latest`):

```bash
python3 -m venv homeserver/.venv && homeserver/.venv/bin/pip install 'matrix-synapse[url-preview]'
# elsewhere: SYNAPSE_PYTHON=/path/to/venv/bin/python   force a backend: HS_POOL_BACKEND=native|docker
```

Then `npm run test:e2e`. Every run starts fresh: `globalSetup` restores one seeded Synapse per worker
(`8008+i`, Vite on `5173+i`) from a cached snapshot (`scripts/hs-pool.mjs`; re-seeded only when the seed
inputs or the Synapse version change, ~minutes the first time) and stops them at the end. No `hs:up` / `seed` needed.

- `E2E_WORKERS=N` sizes the run (default `min(4, cores-1)`, max 8); use it, not `--workers`.
  `E2E_WORKERS=1` is the old layout (8008 / 5173) and reuses a homeserver already answering on 8008.
- `E2E_REUSE_SERVERS=1` starts and stops nothing: dev loops against servers you keep up
  (`npm run hs:pool:up -- --workers N` / `hs:pool:down`, or `hs:up` + `seed` with `E2E_WORKERS=1`).
- Windows with only the WSL1 homeserver (no venv, no Docker): the run drops to 1 worker against the server on
  8008 (start it with `npm run hs:up`) and says so in one line. That server is not reset: `npm run test:e2e:fresh`.
- Logs: `homeserver/data/pool/hs-<i>/synapse.log` (kept after the run), seeding in
  `homeserver/data/pool/snapshot-build.log`; `npm run hs:pool:status` shows what is running.

```bash
npm run test:e2e              # both projects, fresh servers   <-- the intended full run
npm run test:e2e:desktop      # Phase 1 suite only          (= playwright test --project=desktop)
npm run test:e2e:mobile       # Phase 2 phone suites only    (= playwright test --project=mobile)
npm run test:e2e:smoke        # the desktop demo script only
npm run test:e2e:threads      # Phase 3 thread specs, both projects (threads + mobile-threads)
npm run test:e2e:e2ee         # Phase 5 E2EE specs, desktop (helpers: fixtures/e2ee.ts, fixtures/e2ee-api.ts)
npm run test:e2e:fresh        # rebuild the seed snapshot, then both projects (WSL1: seed:reset instead)
npm run test:e2e:fixtures     # regenerates test-image.png / test-file.txt / test-voice.wav
npm run test:android-build    # APK build + aapt checks (NOT a Playwright project; see below)

# one criterion — always name the project, the specs do not overlap
npx playwright test e2e/voice.spec.ts -g "AC-V2-1" --project=mobile --reporter=list
npx playwright test e2e/conversation-messages.spec.ts -g "AC-B4-2" --project=desktop --reporter=list
npx playwright test e2e/threads.spec.ts -g "AC-T6-4" --project=desktop --reporter=list
npx playwright test e2e/mobile-threads.spec.ts -g "AC-T8-1" --project=mobile --reporter=list
```

Artefacts: `e2e/results/<project>/<test>/` (trace, failure screenshot, video),
`e2e/results/demo/` + `e2e/demo-mobile/` (demo screenshots, written even when green),
`e2e/results/apk/` (the unpacked APK), `playwright-report/`.

**The Android build check is deliberately not a Playwright project.** A browserless `build` project
would also run under a bare `npm run test:e2e`, and each run drives Gradle and rewrites `dist/`.
`npm run test:android-build` skips with a printed reason when the toolchain is incomplete — the skip
condition is `resolveToolchain().problems` from `scripts/toolchain.mjs`, **not** `JAVA_HOME` /
`ANDROID_HOME`, because on this machine both env vars are empty in a fresh shell and the build still
works (the scripts resolve `~/jdk21` and `~/android-sdk` themselves). Note its one side effect: the
AC-C1-4 check rebuilds `dist/` *without* `VITE_HS_URL`, so never run a bare `npx cap sync` straight
afterwards expecting the LAN URL — go through `npm run cap:build:android:lan`, which rebuilds first.

**Do not run two suites at once.** A second run's `globalSetup` stops the first run's server pool, each
invocation wipes its project's `outputDir` on start, and the config reuses whatever dev servers are on
5173+, so a concurrent run breaks the first one and deletes its traces
mid-flight — which shows up as a teardown failure like
`browserContext.close: ENOENT ... .playwright-artifacts-N/traces/...network` on a test that actually
passed. (The per-project `outputDir` means `--project=desktop` and `--project=mobile` no longer
clobber *each other's* artefacts, but two runs of the same project still do.) Copy a trace out if it
has to survive the next run, and note that `--reporter=list` *replaces* the config reporters, so a
`list`-only run leaves no HTML report either.

**Room creation is rate-limited.** Synapse's `rc_room_creation` is a burst of 10 then 1/min per user
until the homeserver is restarted with the relaxed config (`docs/BUGS.md` BUG-3). `AC-M5-2` in
`mobile-nav.spec.ts` creates one channel per run, as do several Phase 1 criteria — do not loop those
specs. For a flake pass use
`npx playwright test e2e/mobile-nav.spec.ts --project=mobile --repeat-each=3 --grep-invert "AC-M5-2"`.

## The full suite is meant to run on a fresh seed

`npm run test:e2e` now always gets one (restored from the snapshot), so the guard below only matters for
single-server runs against a live homeserver (`E2E_WORKERS=1` reusing 8008, `E2E_REUSE_SERVERS`, WSL1).

This section is about the **Phase 1 (`desktop`) suite**. The Phase 2 phone suites are
freshness-independent throughout and have no guarded criteria — see "Phase 2 additions" below.

`npm run test:e2e:fresh` rebuilds the seed snapshot (WSL1 fallback: `seed:reset`) and runs both projects; with the server pool every run already starts from a fresh copy. **A green run of every criterion
is only defined on a pristine seed**, because two of the seeded preconditions are consumed by use and
cannot be put back on a live homeserver:

- **The initial sync window.** The client opens a room with roughly the last 30 events. Several
  criteria are about *which* seeded messages that window holds (AC-B1-1 "#40 is visible at the
  bottom", AC-B3-1 "#1 is not in the DOM"). Every message anybody sends into `#general` — a test, a
  dev poking at the UI, another agent — pushes the seeded messages further out of it.
- **Unread counts.** The seed leaves `#random` at 3 and `#lobby` at 2 for alice (`docs/SEED_DATA.md`).
  The first client that opens either room sends an `m.read` receipt, and Synapse will not move a
  receipt backwards, so the seeded number is gone for good.

Everything else is written to survive a dirty homeserver: seeded rows are located by event id from
`seed/seed-output.json` and paged back to when they have dropped out of the window, rows this run
creates are located by their unique text, unread counts are compared against the count derived from
receipts + timeline (`ApiUser.unreadFor`) rather than against a hard-coded 3, and the replayable
preconditions (`fixtures/state.ts`) top up unread and withdraw a leftover invite before the criteria
that need them. No spec asserts an exact message count.

### How the guard behaves on a dirty database

`fixtures/fresh.ts` exports `requireFreshSeed(test)`. It probes the homeserver once per worker and
caches the verdict for the rest of the run (the run itself dirties both signals, so re-probing later
would skip tests that should have run). The seed counts as pristine when **both** hold:

1. the newest event in `#general` is still the seeded last message (`events["general.last"]`), read
   with `GET /_matrix/client/v3/rooms/{general}/messages?dir=b&limit=1` as alice; and
2. alice's unread in `#random` is still 3.

When either fails, the calling test is skipped with the reason
`requires a fresh seed: run npm run test:e2e:fresh`, plus a `needs-fresh-seed` annotation naming
what drifted (e.g. `#general has events after the seeded last message (newest is $..., expected
$...)`). So on a dirty database you get **skips, not red criteria** — a skip says "not judgeable
here", a failure says "the product is wrong", and the two must not be confused in a bug report.

Guarded (they cannot be judged without a pristine seed):

- `conversation-timeline.spec.ts`: AC-B1-1, AC-B3-1;
- `navigation.spec.ts`: AC-A2-3 (it names `#random`'s *first* seeded message, and the criterion wants
  it on screen within a second of clicking the channel, so paging back is not an option);
- `smoke.spec.ts`: demo steps 2, 3, 5 and 6 (the demo script is written against a fresh seed; steps 5
  and 6 act on seeded rows that only the step-3 walk-back brings into the DOM). Steps 1, 4, 7, 8, 9
  and 10 are freshness-independent and still run.

Made freshness-independent instead of guarded, by paging the room back to the seeded row (the
criterion is about how the row *renders*, not about where the window ends): AC-B1-4, AC-B1-8,
AC-B4-2, AC-B6-2/AC-B6-3, AC-B6-4.

## Conventions

- Selectors come from the `data-testid` registry in `docs/ACCEPTANCE.md`; no CSS/text selectors for
  structure. Text is asserted on, or used to find *unseeded* messages, which the contract allows.
- **No `waitForTimeout`.** Waits are locator auto-waits, `expect.poll`, or waiting for a testid.
- A message this run sent renders first as a local echo (`message-~abc`) and is re-keyed to
  `message-$abc` when the remote echo arrives, which unmounts the echo node. Never read a row's id
  straight after it appears — use `settledEventId(row)` from `fixtures/ui.ts` before hovering it or
  looking it up through the API, or the row detaches mid-action.
- Reading a read receipt through `/sync` needs cache-busting: Synapse caches *initial* `/sync`
  responses for about two minutes keyed by the filter, so polling with a constant filter replays a
  pre-receipt snapshot. `ApiUser.getReceipts` varies the filter per call; `readReceiptOf` also picks
  the newest `m.read` by `ts` **among main-timeline receipts only** — after the Phase 3 `threadSupport`
  flip a user holds one receipt per thread as well; see the Phase 3 section below.
- `workers: 1` and `fullyParallel: false`: the suite drives one shared homeserver and several tests
  assert on live cross-user updates.

### Phase 2 additions (`fixtures/mobile.ts`, phone specs)

- **Phase 2 criteria are freshness-independent by construction.** Nothing in `voice.spec.ts`,
  `mobile-nav.spec.ts` or `mobile-smoke.spec.ts` needs a pristine seed: seeded rooms are resolved by
  alias, seeded events by id, unread is *created* by bob inside the test rather than read from the
  seed, created rooms carry `uniqueName()`, and no test asserts a message count or an exact channel
  list (extra `memes-*` rooms from earlier runs are expected). The phone smoke's step 2 is the only
  place the literal seeded `3` appears, and it is asserted only when `checkFreshSeed()` says the seed
  is pristine; otherwise it records `seed-drift` and asserts `>= 1`.
- **Tap, do not click.** The `mobile` project has `hasTouch`, the app keys touch affordances off
  `@media (hover: none)`, and AC-V6-2 is *about* the difference. Use `locator.tap()` (or the helpers
  in `fixtures/mobile.ts`), never `click()`, in the phone specs.
- **`tapBackdrop(page)`, never `drawer-backdrop.tap()`.** The backdrop spans the viewport under the
  drawer, so a centre-aimed tap is intercepted and times out after 15 s. `tapBackdrop` measures the
  open drawer and taps the exposed strip beside it.
- **`settleAnimations(locator)` before any geometry assertion.** The drawers slide for 250 ms and the
  bottom sheets for 200 ms; measuring straight after `toBeVisible()` reports a position that changes
  run to run. It awaits the Web Animations `finished` promises, so it is sleep-free.
- **The one `waitForTimeout` exception** is `longPress(locator, ms)`, which must *hold* a CDP
  `Input.dispatchTouchEvent` for a wall-clock duration — there is nothing to auto-wait for between
  `touchStart` and `touchEnd`. It uses a Node-side `setTimeout`, not `page.waitForTimeout`.
- **"Nothing was sent" is asserted positively.** A negative Playwright assertion resolves instantly,
  so the voice spec has bob post a marker, waits for the marker *row* to render (a round trip longer
  than an encode+upload would take), and then compares the set of alice's `m.audio` event ids against
  the snapshot taken before. Never compare the room's last event id: `/messages` also returns
  redactions, `lastMessage()` does not.
- **404 console lines carry no URL.** Judge them through `page.on('response')` and allow the SDK's
  `/org.matrix.msc4143/rtc/transports` probe, which 404s once per `startClient` by design.
- **`browser.newContext()` does not inherit a project's `use` block.** A spec that builds its own
  context (the serial phone smoke) must pass `{ ...devices['Pixel 7'], permissions: ['microphone'],
  baseURL }` explicitly or it silently runs at desktop size with no microphone.
- **Desktop criteria inside a phone spec** go in a `test.describe` that sets the *context* options
  (`viewport`, `isMobile: false`, `hasTouch: false`, `deviceScaleFactor`). Spreading
  `devices['Desktop Chrome']` there fails — its `defaultBrowserType` is a launch-level option — and
  a phone context merely resized to 1280 px still reports a coarse pointer.
- **`ApiUser.sendVoice(roomId, opts)` / `ApiUser.getMedia(mxc)`** (`fixtures/matrix-api.ts`) are the
  independent voice path: `sendVoice` synthesises a 16 kHz PCM16 WAV (same algorithm as
  `scripts/send-voice-sample.mjs`), uploads it and posts the exact contract shape, with `url:'bogus'`
  for the 404 path, `voice:false` / `msc1767:false` for the plain-audio variants and `file`/`bytes`
  overrides; `getMedia` returns `{ status, bytes, contentType, magicHex, container }` where
  `container` comes from the magic bytes alone (`1A 45 DF A3` WebM, `OggS`, `ftyp`@4 MP4,
  `RIFF…WAVE`).

### Phase 3 additions (`fixtures/threads.ts`, thread specs)

- **Receipt helpers are main-timeline only.** `threadSupport: true` makes matrix-js-sdk send a
  receipt *per timeline*: `thread_id: "main"` for the room plus one per thread, all living in the same
  `m.receipt` event. `readReceiptOf` / `unreadFor` therefore filter to `thread_id === "main" ||
  undefined` (`isMainReceipt`) before taking the newest by `ts` — without that, every Phase 1
  receipt criterion reads back a *thread* position, which is newer. Use
  `threadReceiptOf(roomId, userId, rootId)` for an in-thread position and `threadReceipt()` to post
  one. `notifiesUser` (behind `unreadFor`) also drops `rel_type: "m.thread"` events, because
  `/messages` still returns thread replies in the room chunk while the app's badge counts main only.
- **`sendThreadReply(roomId, rootId, body, { latest })`** posts the exact contract content from
  `docs/PHASE3_ACCEPTANCE.md` (`rel_type: "m.thread"`, `event_id` = the root, `is_falling_back: true`,
  `m.in_reply_to` = the newest reply else the root). **Pass `latest` explicitly when sending a run of
  replies** — the previous call's return value — or each reply costs a `/relations` round trip, which
  is three times the work for the 40-reply pagination cases. `seedThread({ roomId, replies })` builds
  a whole root-plus-chain in one call and is what every test uses.
- **Assert the registry, never the skeleton.** The PRIN-10 `ThreadView` placeholder used
  `data-root-id`, `thread-message-{id}`, `thread-empty` and `thread-load-more`; the contract is
  `thread-panel[data-root]`, rows keyed `message-{eventId}` inside `thread-message-list`,
  `thread-replies-divider`, `thread-timeline-start` / `-loading`. `fixtures/threads.ts` supports only
  the registry names on purpose, so a divergence is reported instead of absorbed.
- **The prefix rule.** Inside `thread-panel` every `composer-*`, `message-list`, `timeline-*` and
  `typing-indicator` id is renamed (`thread-composer-*`, `thread-message-list`, `thread-timeline-*`,
  `thread-typing`), but **rows keep `message-{eventId}`** and everything inside a row
  (`message-actions`, `reaction-*`, `message-edited`, `voice-message`) keeps its Phase 1/2 name. The
  root is `thread-root`, not a second `message-{rootId}`.
- **`requireThreadUi(test, page, features)` is the "not built yet" guard**, the same idiom as
  `requireFreshSeed`: it probes the UI **once per worker in its own page**, annotates `not-built` and
  skips, so a test that runs and fails is a real defect. It probes *entry points*
  (`header-threads`, `message-action-thread`, a panel with `thread-composer-input`, a rendered
  `thread-summary-*`, phone `header-back`), never panel internals — the skeleton already had
  `thread-panel` in the tree.
- **The probe shares the test's origin storage.** `context().newPage()` is a *second page in the same
  context*, so the probe's own login would be restored by the test page's `goto('/')` and
  `login-form` would never appear (`loginAs`'s `dropStoredSession` is a no-op while the test page is
  on `about:blank`). The probe clears `localStorage` before closing and the specs call
  `resetSession(page)` before `loginAs`. **The two smoke specs deliberately do not use the probe** —
  clearing storage would log their long-lived shared page out mid-demo; they check for the entry
  point inline and `test.skip()`.
- **`stableRow(page, eventId)` instead of `row(...).scrollIntoViewIfNeeded()`.** `#general` takes
  live traffic from the devs and from the rest of the suite, so the list auto-scrolls while a test is
  aiming at a row and the raw call fails with "element is not stable" / "not attached".
  `longPressThread` goes through it and retries the gesture once if the sheet did not open.
- **An avatar stack carries no text.** `thread-summary-avatars` / `thread-list-item-avatars` hold an
  `<img>` or an initials badge; identity is in `title` / `aria-label` / `alt`. Use
  `avatarNames(stack)`, not `toContainText`.
- **`thread-composer-send` follows AC-V1-1**, like the room composer: the mic owns the slot while the
  input is empty and send appears with text. Assert it *attached*, and visible only after typing.
- **"The channel gained no row" is asserted as a set, with a sentinel.** A negative assertion
  resolves instantly, so AC-T1-2 snapshots `roomRowIds(page)`, has bob post a thread reply **and then
  a normal message**, waits for the normal message's row (which proves sync delivered both) and only
  then compares the sets. Never assert an absence without something to wait for.
- Deviations recorded in the spec headers: the pagination cases build **40** replies where the
  criteria say 35 (strictly harder), "within 3 s" criteria poll for 5 s, and AC-T2-6's 200 ms local
  echo is measured into an annotation with a 1 s assertion (Playwright's own press -> locator round
  trip is ~100 ms). AC-T3-5 (Android back order) is device-only and listed in `docs/BUGS.md`.
