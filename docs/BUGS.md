# Bug log

QA owns this file (docs/TICKETS.md QA-6, docs/PHASE2_TICKETS.md QA-13). Every failing test gets a
row; devs close a row with the commit that fixes it (put the commit sha in **Status**).

**Severity** — `S1` blocks the demo script (docs/PLAN.md on desktop, docs/PHASE2_PLAN.md on the
phone) · `S2` wrong but the demo still works · `S3` cosmetic.

**Platform** (Phase 2 column) — `web-desktop` the `desktop` Playwright project / a real browser at
1280 px · `web-mobile-emulated` the `mobile` Playwright project (`devices['Pixel 7']`, fake mic; no
emulator exists on this machine) · `android-device` the APK on the stakeholder's phone ·
`ios-device` the Mac/iPhone pass. **Manual** = `yes` when the row came from a human walking the demo
rather than from a test (every `android-device` / `ios-device` row is manual by definition).

**Reproducing** — steps are written from a fresh seed:

```
npm run hs:up && npm run seed:reset && npm run dev          # homeserver + fixtures + client
npm run test:e2e                                            # both projects
npm run test:e2e:desktop                                    # Phase 1 suite only
npm run test:e2e:mobile                                     # Phase 2 phone suites only
npm run test:android-build                                  # APK build + manifest checks
npx playwright test e2e/conversation.spec.ts -g "AC-B3-2" --project=desktop
npx playwright test e2e/voice.spec.ts -g "AC-V2-1" --project=mobile
npx playwright show-trace e2e/results/<project>/<test-dir>/trace.zip
```

Artefacts live under `e2e/results/desktop/<test-dir>/` and `e2e/results/mobile/<test-dir>/` (failure
screenshot, trace, video — one `outputDir` per project so the runs do not wipe each other),
`e2e/results/demo/` (desktop demo screenshots) and `e2e/demo-mobile/` (phone demo screenshots, one
per step, written even when green). The APK check unpacks to `e2e/results/apk/`.

## Phase 1 (desktop)

| BUG | AC ref | Sev | Platform | Manual | Owner | Steps (from fresh seed) | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| BUG-1 | AC-B5-3, AC-B5-4, AC-B1-1, demo step 5 | S1 | web-desktop | no | Dev B | 1. Log in as alice. 2. Page `#general` back to the beginning. 3. Hover bob's "Lunch today? Thinking tacos." (`general.reacted`). 4. Click `message-action-react`, pick 🎉. 5. Click the new `reaction-🎉` pill to remove it. | The pill is clickable and the reaction is redacted. | Click times out: *"`<span data-testid="message-timestamp">` from `<div data-testid="message-$Yl6…">` subtree intercepts pointer events"*. Root cause: `MessageList.module.css .list` was `display:flex; flex-direction:column`, so every row was a flex item with the default `flex-shrink:1`; combined with `MessageRow.module.css .row { min-height:22px }` (an explicit min-height overrides the automatic minimum size) the flex algorithm shrank **every** row to 22 px while its content stayed 34 px+. Measured: `clientHeight 580 / scrollHeight 978`, all 24 rows `height 22px`, `flex-shrink 1`, content overflowing. Rows therefore painted over each other and the *following* row won hit-testing on pills, quotes and images. | `e2e/results/smoke-demo-script-QA-3-smo-8c4a7-oday-message-then-remove-it-chromium/` (trace.zip + test-failed-1.png) | **Fixed** by Dev B during Wave 2 — `.list` is no longer a flex container and `.row` sets `flex-shrink: 0`. Re-verified: AC-B5-1..B5-6 and demo step 5 pass. |
| BUG-2 | AC-B3-2 | S2 | web-desktop | no | Dev B | 1. Log in as alice (`#general` opens). 2. Note the top-most rendered row and its viewport `y`. 3. Scroll `message-list` to the top so backwards pagination fires. 4. When the older messages have rendered, measure that same row's viewport `y` again. | DEV-B-3: capture `scrollHeight` before `paginateBack` and restore `scrollTop += delta` after, so the anchor row stays at the same viewport position (criterion allows no jump). | The anchor row moved **~545-582 px** down the viewport — the list kept `scrollTop` while ~30 events were prepended, throwing the reader out of position on every page-in. `timeline-loading` did appear and the older messages did load, so the demo's "scroll to the top" still worked; only the anchoring was missing. | `e2e/results/conversation-DEV-B-3-backw-f00e8-er-messages-without-jumping-chromium/` (trace.zip + test-failed-1.png) | **Fixed** by Dev B during Wave 2. Re-verified: AC-B3-2 passes, anchor drift now ≤ 5 px. |
| BUG-3 | AC-A6-2, AC-A8-1, demo step 10 | S1 | web-desktop | no | Principal | 1. `npm run test:e2e` (or `npx playwright test e2e/navigation.spec.ts e2e/smoke.spec.ts`) — the failure needs a *loaded* homeserver, it does not reproduce running one test alone (`-g "AC-A6-2" --repeat-each=3` is 3/3 green). 2. Watch the create-channel / create-space criteria. | `create-channel-dialog` closes, the new room appears in `channel-list` with its `data-name`, selected, topic in the header. | The dialog closes (so `createChannel`/`createSpace` resolved server-side and the room exists) but the item **never appears in `channel-list`** within 15-20 s: *"element(s) not found"*. Intermittent and it moves between criteria — one run failed AC-A6-2 + step 10, the next passed AC-A6-2 and failed AC-A8-1 + step 10. Always a *newly created* room, never a seeded one, so the suspicion is the freshly-created room not reaching `useRoomStore.channelsBySpace` (`waitForRoom` / `recomputeRooms` missing the sync that carries it) rather than the sidebar render. Blocks demo step 10, hence S1. `expectChannelListed()` in `e2e/navigation.spec.ts` now records what the sidebar actually held, which separates "room never arrived" from "arrived without its name". | `e2e/results/navigation-DEV-A-6-creat-*-chromium/` and `e2e/results/smoke-*-step-10-*/` (trace.zip); look for the `diagnostic` annotation in the HTML report | **Fixed** (Principal). Two layers: (a) Synapse's separate `rc_room_creation` limiter (default burst 10, then 1/min per user) had not been relaxed, so after hours of test runs `createRoom` returned 429 and the dialog showed an error; (b) the store selected the new room from the first `/sync` batch (create + join only) before `m.space.parent` arrived in the next batch, so the selection flipped to Home. Fix: `retryOnRateLimit` honouring `retry_after_ms` (30 s budget) around `createChannel`/`createSpace`/`createDm`/`inviteUser`/`joinRoom` in `src/lib/matrix/actions.ts`; a selection invariant plus pending selection in `src/store/rooms.ts`; `rc_room_creation: 1000/1000` in `homeserver/homeserver.yaml`, `scripts/hs.mjs` and `homeserver/wsl/configure.sh` (applies on the next homeserver restart; until then alice's room creation is still ~1/min after a burst of 10). Re-verified: AC-A6 / AC-A8 / AC-A1 groups 9/9 pass. |

## Phase 2 (phone shell, voice notes, Capacitor)

Wave 5 QA pass against the `mobile` Playwright project (`devices['Pixel 7']`, 412x839, touch, fake
microphone) and `npm run test:android-build`, on a **dirty** homeserver (hours of traffic; every
Phase 2 test is written to tolerate it).

| BUG | AC ref | Sev | Platform | Manual | Owner | Steps | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| BUG-4 | AC-SH-2, docs/PHASE2_PLAN.md phone demo step 1 | S3 | web-desktop | no | Principal | 1. Run the whole `desktop` project (`npm run test:e2e:desktop`, ~14 min) against the current dirty homeserver. 2. Watch the last spec, `smoke.spec.ts` step 1. | Login to painted shell in under 10 s (AC-SH-2); the demo scripts want under 3 s. | **10 609 ms** at the tail of the run — just over the criterion. Re-running step 1 alone on an idle homeserver passes (7.4 s for the whole test, login well inside budget), and the **phone** smoke measures **1 832 ms** on the same homeserver, so this is initial-sync cost on a server that has just absorbed a 14-minute suite, not a layout or code regression. Recorded because login time *is* a demo criterion: if the stakeholder's device pass is run straight after a full suite, step 1 may feel slow. Mitigation for demo day: do not run the suites immediately before the demo, or `npm run seed:reset` first. | `e2e/results/desktop/smoke-demo-script-QA-3-smo-73c29-*/` (trace.zip) | **Open** — environment/perf, no code change proposed. |
| — | — | — | — | — | — | *No product defect found in the emulated phone pass.* **52** Phase 2 acceptance criteria green in **58 tests** — `voice.spec.ts` (18 tests / 23 criteria), `mobile-nav.spec.ts` (30 / 29), `mobile-smoke.spec.ts` (10 phone-demo steps) — plus **6** more (AC-C1-1..4, AC-C3-1/2) in the 20 checks of `npm run test:android-build`: **58 criteria in all**. The six failures on the first run were all QA-side and are listed under "Fixture-side defects" below. | | | `e2e/demo-mobile/` (10 phone demo screenshots) | — |

### Flake pass (QA P2)

`--repeat-each=3` of both phone suites on the dirty homeserver:

| Suite | Result |
|---|---|
| `mobile-nav.spec.ts` (AC-M5-2 excluded — it creates a room per run and `rc_room_creation` is still 1/min) | **87/87**, three runs, no flake. The two tight spec budgets held every time: AC-M2-1's 300 ms drawer open and AC-M1-3's 500 ms layout flip. |
| `voice.spec.ts` | **53/54** on the first pass, then **54/54** on a repeat and **4/4** on AC-V5-2 alone — 1 failure in 112 executions, never reproduced. |

The single failure was AC-V5-2 reporting that a voice note had reached `#dev` after
`recording-cancel`. The most likely window was QA-side: the test used to `page.unroute()` the injected
500 straight after cancelling, so a retry still in flight would have been served by the **real** media
repo and the note would have landed after the criterion said it was discarded. The `unroute` is gone —
the 500 now stays installed for the rest of the test, so the assertion judges the product rather than
the teardown. **If this reappears**, it is a genuine DEV-B-13 defect ("`recording-cancel` does not
abort an upload retry already in flight") and deserves an S2 row; capture
`e2e/results/mobile/voice-AC-V5-2-*/trace.zip` before the next run overwrites it.

### Contract note for the Principal (not a bug, needs one line in the registry)

`voice-waveform`'s `data-samples` is **the number of bars drawn**, not the number of waveform
samples the event carried. For a note with no waveform (`[]`, AC-V4-3) `VoiceMessage.tsx` draws
`FLAT_BARS = 40` placeholder bars and reports `data-samples="40"`. AC-V3-1 ("`data-samples` =
waveform length") and the registry row ("one bar per waveform sample") agree with each other only
when a waveform exists. `e2e/voice.spec.ts` therefore asserts `data-samples === waveform.length` for
AC-V3-1/AC-V4-1 and, for the empty case, asserts that the bars are flat (all the same height) and
that `data-samples` equals the bar count — which is what the criterion actually promises. Either
reading is fine; the registry should just say which.

### Phase 2 criteria that cannot be judged here (no emulator, no device) — stakeholder checklist

Every one of these is a **manual, device** row waiting to be filled in; none of them failed, they
were never run. The suites annotate them as `not run here`.

| Criterion | What the stakeholder has to see | Where |
|---|---|---|
| AC-C1-6 | Install the APK, open it: login form within 3 s, no white screen; log in as alice through the LAN proxy; `#general` renders. | phone demo prep |
| AC-M2-8 | Swipe from the left edge opens the drawer; swipe left closes it; Android **back** closes an open drawer instead of leaving the app. | demo step 2 |
| AC-M6-4 | With the keyboard open: `composer-input`, mic/send and the newest message visible; closed, the composer sits above the gesture bar. | demo step 5 |
| AC-M6-5 | Status-bar area dark (`#1e1f22`), no content under it, no pull-to-refresh or overscroll bounce. | demo step 1 |
| AC-V1-6 (P2) | Record for 120 s: it auto-stops and sends, timer caps at `2:00`. | — |
| AC-V5-3 | First mic tap shows the Android permission prompt; Allow records, Deny shows `recording-error`; the choice survives a restart. | demo step 6 |
| AC-C3-* (iOS) | Mac handoff: Xcode build, mic prompt, Ogg/Opus playback on iOS 18.4+. | docs/PHASE2_PLAN.md |

### Waived

**AC-V2-4** (`info.mimetype` is `audio/ogg` on Chromium). docs/ARCHITECTURE.md "Phase 2 deltas"
records the decision to send the native `MediaRecorder` container with no transcoding; Chromium and
the Android WebView therefore produce `audio/webm`. Verified instead: the mimetype is one of
`audio/ogg` / `audio/webm` / `audio/mp4` **and** the uploaded bytes really are that container
(AC-V2-3 magic check — observed `1A 45 DF A3`, WebM/EBML, every run).

### Device report template (fill one block per finding)

```
Device:            e.g. Pixel 7a
Android version:   e.g. 15 (API 35)
WebView version:   Settings > Apps > Android System WebView, or chrome://version inside the WebView
APK:               android/app/build/outputs/apk/debug/app-debug.apk, built <date>, VITE_HS_URL=<url>
Demo step:         docs/PHASE2_PLAN.md step N  (or "outside the script")
Criterion:         AC-M*/AC-V*/AC-C*  (or "none — new finding")
Steps:             1. ... 2. ... 3. ...
Expected:          <the "They should see" cell, verbatim>
Actual:            <what happened; note whether it is reproducible>
Screenshot:        <attach; phone screenshots go in docs/screenshots/device-*.png>
Severity:          S1 blocks the demo / S2 wrong but the demo works / S3 cosmetic
```

Paste the filled block into the **Actual** cell of a new row with `Platform: android-device` (or
`ios-device`) and `Manual: yes`.

## Not bugs — criteria that cannot be judged on a dirty homeserver

These are skipped with an actionable reason by `e2e/fixtures/fresh.ts`, not failed. They need
`npm run test:e2e:fresh` (seed reset + run). See the fixture header for why each one is
seed-sensitive.

| Criterion | Why it needs a fresh seed |
|---|---|
| AC-B1-1, AC-B3-1 | Assert which rows are inside the initial ~30-event sync window; every message anyone sends into `#general` pushes the seeded rows out of it. |
| AC-A2-3 | `#random`'s first message must be reachable in the opening window. |
| AC-B8-4 | Clipboard paste — the criterion itself marks Playwright optional; verify by hand. |
| demo steps 2, 3, 5, 6 | Step 2 asserts the seeded `3` badge on `#random`; steps 3/5/6 act on seeded rows that must be in the opening window. |

## Fixture-side defects found and fixed in this suite (no dev action)

Recorded so the same trap is not re-introduced.

### Phase 2 (QA-8 .. QA-12)

Every failure on the first `--project=mobile` run was one of these, not a product defect.

1. **`loginAs` hung on phone.** `e2e/fixtures/auth.ts` ended with `expect(space-rail).toBeVisible()`,
   but on phone the rail lives inside the *closed* `nav-drawer`, which is `visibility: hidden`. It
   now branches on `app-shell[data-layout]` and waits for `channel-header` + `message-list` instead;
   the desktop path is unchanged.
2. **`drawer-backdrop.tap()` was intercepted by the drawer.** The backdrop is `inset: 0` at
   `z-index: 20`; the open drawer covers 85 % of it at `z-index: 30`. `locator.tap()` aims at the
   element's *centre*, which is under the drawer, so it retried for 15 s and timed out. A real thumb
   lands on the exposed strip — `tapBackdrop()` in `e2e/fixtures/mobile.ts` measures the open drawer
   and taps beside it with `page.touchscreen.tap()`. Not a product bug: the backdrop is hittable
   everywhere it is visible.
3. **Geometry measured mid-animation.** The bottom sheet animates up from `translateY(100%)` over
   200 ms and the drawers slide over 250 ms, so AC-M5-2 measured the sheet 136 px and then 229 px
   below the viewport bottom on two runs of the *same* build. `settleAnimations(locator)` awaits the
   Web Animations `finished` promises before any geometry assertion (sleep-free: it costs exactly the
   remaining animation time). Any new phone geometry check must call it.
4. **Exact channel lists on a dirty homeserver.** AC-M2-1/AC-M2-4 asserted
   `['general','random','dev']` exactly, which broke as soon as AC-M5-2 had created its first
   `memes-*` room. They now assert the seeded names as an ordered *subsequence* and that foreign
   channels are absent, per the dirty-seed rule.
5. **"Nothing was sent" compared the wrong tail.** The helper asserted the room's last two events
   were `[marker, previousLast]`, but `lastMessage()` only sees `m.room.message` while `/messages`
   also returns the `m.room.redaction` that AC-V4-4 leaves behind. It now snapshots the set of
   alice's `m.audio` event ids and asserts nothing was added (which is what the criterion means).
6. **404 console lines carry no URL.** The redaction criterion (AC-V4-4) failed on
   `"Failed to load resource: ... 404"`, which is the SDK's expected
   `/org.matrix.msc4143/rtc/transports` probe. Text filtering cannot see which URL it was; the test
   now collects 404s through `page.on('response')` and only fails on non-msc4143 ones — the same
   trick `scripts/verify-phone-shell.mjs` uses.
7. **`devices['Desktop Chrome']` cannot be spread into a `test.describe`.** It carries
   `defaultBrowserType`, a launch-level option: *"Cannot use({ defaultBrowserType }) in a describe
   group"*. The desktop-regression blocks inside the mobile specs set the *context* options only
   (`viewport`, `isMobile: false`, `hasTouch: false`, `deviceScaleFactor`), which is what `isPhone`
   actually reads.
8. **`browser.newContext()` does not inherit a project's `use` block.** The serial phone smoke
   builds its context with `{ ...devices['Pixel 7'], permissions: ['microphone'], baseURL }`
   explicitly; without that it would have walked the phone demo at desktop size with no microphone
   and still gone green on most steps.

#### Phase 1 suite, re-run as Phase 2 regression (three dirty-seed defects, no product change)

The `desktop` regression run went **64 passed / 24 failed / 8 skipped** before these. **None of the 24
was a product regression** — every one was the Phase 1 suite assuming a seed state the homeserver has
since outgrown. Fixed in `e2e/**` (QA's files); nothing in `src/**` changed. After the fixes the Phase
1 suite is **88 passed / 0 failed / 8 skipped** of 96 (the 8 are the documented fresh-seed guards:
AC-B1-1, AC-B3-1, AC-A2-3, AC-B8-4 and demo steps 2, 3, 5, 6), with BUG-4 above as the one timing
outlier at the tail of a full run.

9. **`withFullHistory()` could no longer reach the first message of `#general`.** The room passed
   **435 events** during Phase 2; the client pages ~30 at a time and `paginateToTop`'s default budget
   was 12 rounds (~360 events), so 20 conversation criteria failed with *"could not page #general back
   to its first message"* — which reads like a pagination bug and is not one. The helper now asks for
   40 rounds and raises its own test timeout; it still exits on the first round that finds
   `timeline-start`, so a fresh seed costs the same as before. **Re-raise the budget when `#general`
   passes ~1200 events**, or reset the seed.
10. **AC-A2-1 asserted the Acme channel list exactly.** Every channel the create-channel criteria make
    (Phase 1 AC-A6-2 and Phase 2 AC-M5-2) stays in Acme HQ, so `['general','random','dev']` was only
    ever true on a pristine seed. It now asserts the seeded names as an ordered *subsequence* — the
    criterion is about `m.space.child` order, not about the absence of later rooms.
11. **AC-A3-2 assumed the Bob DM's first message was still in the opening window.** The DM is at 41
    events and the window is ~30. It now pages back to the message when it is not already rendered,
    the same treatment AC-B1-4 / AC-B4-2 already had.

### Phase 1

1. **`findMessage` only read one `/messages` page.** Once `#general` grew past 200 events the
   `beforeAll` lookup of message #2/#3/#34 failed and aborted the whole conversation suite.
   Fixed with `ApiUser.messagesDeep()`, which follows `end` tokens across pages.
2. **Reading a row id straight after `toBeVisible()`** captured the local-echo id (`message-~…`),
   which then detached when the remote echo re-keyed the row. AC-B9-3 failed spuriously ("edits my
   last message" landed on the previous message). Fixed with `settledEventId()` in `fixtures/ui.ts`.
3. **Backwards read receipts do not work.** Synapse silently keeps the newer receipt, so a consumed
   unread precondition cannot be restored by re-sending the older `m.read`. Verified directly
   against this homeserver; this is why `fixtures/state.ts` tops rooms up from a second user and
   derives expected unread counts instead of hard-coding the seeded numbers.
4. **`unread_notifications` on an *initial* `/sync` is stale on this Synapse build** (it kept
   reporting 3 after a receipt had zeroed the room; incremental syncs were correct). All unread
   assertions therefore go through `ApiUser.unreadFor()`, which derives the count from receipts plus
   the timeline, and never read unread from `/sync`.
