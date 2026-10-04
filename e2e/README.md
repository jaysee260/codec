# e2e

QA owns this folder (see `docs/TICKETS.md` QA-1 and `docs/PHASE2_TICKETS.md` QA-8..13). Specs are
`*.spec.ts`, helpers live in `fixtures/`.

## Projects

`playwright.config.ts` declares two projects. A spec belongs to exactly one of them.

| Project | Device | Specs | `outputDir` |
|---|---|---|---|
| `desktop` | `devices['Desktop Chrome']`, 1280x720 | the Phase 1 suite | `e2e/results/desktop` |
| `mobile` | `devices['Pixel 7']` — 412x839 CSS px, `isMobile`, `hasTouch`, `permissions: ['microphone']` | the Phase 2 phone suites | `e2e/results/mobile` |

| File | Project | Covers |
|---|---|---|
| `shell.spec.ts` | desktop | AC-SH-1 .. AC-SH-5 (login, session, logout) |
| `navigation.spec.ts` | desktop | AC-A1-1 .. AC-A9-1 (rail, channels, DMs, members, badges, create/invite) |
| `conversation.spec.ts` | desktop | AC-B1-1 .. AC-B10-3 (timeline, composer, pagination, rich bodies, reactions, replies, receipts, upload, edit/delete, mentions) |
| `smoke.spec.ts` | desktop | the `docs/PLAN.md` demo script, steps 1-10, serial, one screenshot per step into `results/demo/` |
| `voice.spec.ts` | mobile | AC-V1 .. AC-V6 recording/playback, with every sent event re-read through the API and the uploaded bytes checked by their container magic |
| `mobile-nav.spec.ts` | mobile | AC-M1 .. AC-M6 (phone shell, drawers, header, touch targets, bottom sheets, viewport CSS) + the layout half of AC-V6 |
| `mobile-smoke.spec.ts` | mobile | the `docs/PHASE2_PLAN.md` **phone** demo script, steps 1-10, serial, one screenshot per step into `e2e/demo-mobile/` |
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

```bash
npm run hs:up                 # Synapse on http://localhost:8008
npm run seed                  # writes seed/seed-output.json (room + event ids the fixtures read)
npm run test:e2e:fixtures     # regenerates test-image.png / test-file.txt / test-voice.wav

npm run test:e2e              # both projects
npm run test:e2e:desktop      # Phase 1 suite only          (= playwright test --project=desktop)
npm run test:e2e:mobile       # Phase 2 phone suites only    (= playwright test --project=mobile)
npm run test:e2e:smoke        # the desktop demo script only
npm run test:e2e:fresh        # seed:reset + both projects   <-- the intended full run
npm run test:android-build    # APK build + aapt checks (NOT a Playwright project; see below)

# one criterion — always name the project, the specs do not overlap
npx playwright test e2e/voice.spec.ts -g "AC-V2-1" --project=mobile --reporter=list
npx playwright test e2e/conversation.spec.ts -g "AC-B4-2" --project=desktop --reporter=list
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

**Do not run two suites at once.** Each invocation wipes its project's `outputDir` on start and the
config reuses whatever dev server is on 5173, so a concurrent run deletes the first run's traces
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

This section is about the **Phase 1 (`desktop`) suite**. The Phase 2 phone suites are
freshness-independent throughout and have no guarded criteria — see "Phase 2 additions" below.

`npm run test:e2e:fresh` = `npm run seed:reset && npm run test:e2e`. **A green run of every criterion
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

- `conversation.spec.ts`: AC-B1-1, AC-B3-1;
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
  the newest `m.read` by `ts`, because a user can hold both a threaded (`thread_id: "main"`, what
  matrix-js-sdk sends) and an unthreaded receipt at different positions.
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
