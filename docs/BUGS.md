# Bug log

QA owns this file (docs/TICKETS.md QA-6, docs/PHASE2_TICKETS.md QA-13). Every failing test gets a
row; devs close a row with the commit that fixes it (put the commit sha in **Status**).

**Severity** — `S1` blocks the demo script (docs/PLAN.md on desktop, docs/PHASE2_PLAN.md on the
phone, docs/PHASE3_PLAN.md for threads) · `S2` wrong but the demo still works · `S3` cosmetic.
Phase 3 raises two specific things to `S1` on sight: **a thread reply leaking into the channel
timeline** (as a row or as a reply quote) and **any Phase 1/2 criterion regressing after
`threadSupport: true`** — both are the premise of the whole phase, so neither demo survives them.

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
npm run test:e2e:threads                                    # Phase 3 thread specs (both projects)
npm run test:e2e:gif                                        # Phase 4 GIF specs (both projects)
npm run test:e2e:link-preview                               # Phase 6 link preview specs (both projects)
npm run test:android-build                                  # APK build + manifest checks
npx playwright test e2e/conversation-timeline.spec.ts -g "AC-B3-2" --project=desktop
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
| BUG-4 | AC-SH-2, docs/PHASE2_PLAN.md phone demo step 1 | S3 | web-desktop | no | Principal | 1. Run the whole `desktop` project (`npm run test:e2e:desktop`, ~14 min) against the current dirty homeserver. 2. Watch the last spec, `smoke.spec.ts` step 1. | Login to painted shell in under 10 s (AC-SH-2); the demo scripts want under 3 s. | **10 609 ms** at the tail of the run — just over the criterion. Re-running step 1 alone on an idle homeserver passes (7.4 s for the whole test, login well inside budget), and the **phone** smoke measures **1 832 ms** on the same homeserver, so this is initial-sync cost on a server that has just absorbed a 14-minute suite, not a layout or code regression. Recorded because login time *is* a demo criterion: if the stakeholder's device pass is run straight after a full suite, step 1 may feel slow. Mitigation for demo day: do not run the suites immediately before the demo, or `npm run seed:reset` first. | `e2e/results/desktop/smoke-demo-script-QA-3-smo-73c29-*/` (trace.zip) | **Open** — environment/perf, no code change proposed. **Worse in Phase 3 and now consequential:** the final Wave 8 `desktop` run measured **16 083 ms** at the tail of a 31-minute suite, and because `smoke.spec.ts` is `mode: 'serial'`, step 1's failure left **all 11 later steps "did not run"** — including the new thread step 11. The cause still looks like initial-sync cost on a hammered homeserver rather than a thread regression: the `mobile` smoke's step 1 measured **1 832 ms** on the same homeserver when it ran first, and step 11 passes in 2.1 s when `smoke.spec.ts` is run on its own (`npm run test:e2e:smoke`). Two things follow for demo day: do not run the suites immediately before the demo (or `npm run seed:reset` first), and judge the demo steps from a standalone smoke run, not from the tail of a full-project run. |
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

**AC-V2-4** — *no longer waived* since the voice-format change (see "Voice format" below): Chromium
now sends `audio/ogg` and `e2e/voice.spec.ts` asserts it. Original Phase 2 text, for history:
(`info.mimetype` is `audio/ogg` on Chromium). docs/ARCHITECTURE.md "Phase 2 deltas"
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

## Phase 3 (threads)

Wave 8 QA pass (QA-14..18) against `e2e/threads.spec.ts` (desktop, 43 tests) and
`e2e/mobile-threads.spec.ts` (phone, 14 tests) on a **dirty** homeserver, plus the QA-17 regression
gate on the Phase 1/2 projects after the Principal's `threadSupport: true` flip. Every thread test
creates its own root and replies through the API, so nothing here needs a fresh seed.

```
npm run test:e2e:threads                                       # both thread specs, both projects
npx playwright test e2e/threads.spec.ts --project=desktop -g "AC-T6-4"
npx playwright test e2e/mobile-threads.spec.ts --project=mobile -g "AC-T3-4"
npm run thread:sample -- --root <eventId>                      # bob replies into a live thread
```

**Wave 8 reading note.** Dev A and Dev B were implementing while this pass ran, so a red criterion
could mean three different things. The specs separate them: each test declares the UI entry point it
needs (`requireThreadUi`, `e2e/fixtures/threads.ts`) and **skips with a `not-built` annotation** when
that entry point is absent. A test that *ran* and failed is therefore a product defect or a test
defect — never "not implemented yet". The not-built list for this pass is under "Not built yet".

| BUG | AC ref | Sev | Platform | Manual | Owner | Steps | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| BUG-5 | AC-T2-3 | S2 | web-desktop | no | Principal (PRIN-9) | 1. Log in as alice, open `#general`. 2. In the console (the dev hook the test uses): `__matrixPoc.actions.sendText(roomId, 'x', { replyTo: $root, threadRoot: $root })`. 3. Look for the message on the server. | The call **rejects** and no event is sent (`replyTo` with `threadRoot` is a contradiction; an in-thread quote reply, `is_falling_back: false`, is explicitly out of scope — docs/PHASE3_PLAN.md "Out of scope"). | The promise **resolves** and an event **is sent**, with exactly the shape the phase ruled out: `"m.relates_to": { "rel_type": "m.thread", "event_id": "$root", "is_falling_back": false, "m.in_reply_to": { "event_id": "$root" } }`. `sendRoomMessage` in `src/lib/matrix/actions.ts` passes `replyTo` straight into `threadRelation()`, whose first branch builds the `is_falling_back: false` form; there is no guard. Consequences beyond the criterion: the contract in docs/PHASE3_ACCEPTANCE.md says `is_falling_back` is *always* `true`, and our own readers treat `is_falling_back: false` as a real quote (`getReplyTargetId`), so such an event renders a reply quote inside the panel — which AC-T1-3 forbids. Suggested fix: reject when both are set, at the top of `sendText` / `sendRoomMessage`, and drop the `replyTo` branch of `threadRelation` until in-thread quote replies are in scope. | `e2e/results/desktop/threads-AC-T2-timeline-sou-b6c56-hreadRoot-and-sends-nothing-desktop/` (the `sent-anyway` annotation carried the full event) | **Fixed** by the Principal during Wave 8, exactly as suggested: `sendText` now throws `ThreadReplyConflictError` (`src/lib/matrix/actions.ts`) **before** anything is sent, and `sendRoomMessage` no longer takes a `replyTo` at all, so the `is_falling_back: false` branch is gone. Re-verified in the final `desktop` run: AC-T2-3 passes and no event reaches the server. |
| BUG-6 | AC-T6-4 (AC-B3-2 rule) | S2 | web-desktop | no | Dev B (DEV-B-20) | 1. Create a root with 40 API thread replies (`sendThreadReply` in a loop, or `npm run thread:sample -- --root <id> --replies 40`). 2. Open the thread from the message toolbar. 3. Note the top-most rendered reply row and its viewport `y`. 4. Scroll `thread-message-list` to the top so the thread pages back. 5. Measure that same row's `y` again. | The anchor row stays put (`thread-timeline-loading` shows, older replies prepend, drift <= 5 px — the same rule DEV-B-3 implements for the room timeline and AC-T6-4 restates for the panel). | The anchor row moved **504.6 px** down the viewport: the panel keeps `scrollTop` while a page of older replies is prepended, so the reader is thrown out of position on every page-in. This is BUG-2 again, in the second list — the room timeline's anchoring (capture `scrollHeight`, restore `scrollTop += delta`) has not been applied to `thread-message-list`. Everything else about thread pagination is correct: all 40 replies load, oldest first, no duplicate ids, `thread-timeline-start` appears (AC-T2-4 passes). | `e2e/results/desktop/threads-AC-T6-ThreadView-A-00f09--and-pages-in-without-drift-desktop/` (the `anchor-drift` annotation has the measurement) | **Test defect, not a product bug** (re-filed 2026-10-08): the drift assertion took its baseline before its own `scrollTop = 0`, so it measured the panel scrollTop (deterministic 504.59 px); real drift is 0.4 px. The orchestrator fixed `e2e/threads.spec.ts` to take the baseline inside the same `evaluate` (mirroring AC-B3-2); AC-T6-4 passes. Latent defect fixed by Dev B while investigating: `usePagination` captured a pin while the list was shorter than the viewport and walked the panel off the newest reply; it now pins only when live geometry says the list is away from the bottom. |
| BUG-7 | AC-T9-3 | S2 | web-desktop | no | Dev B (DEV-B-22) | 1. Open a thread, send two replies of your own from `thread-composer-input`. 2. Hover the second reply, click `message-action-delete`, confirm with `delete-confirm`. | The row stays and shows `message-redacted` (as a redacted message does in the room timeline, AC-B9), and the divider/summary count drops by 1. | The **row disappears from `thread-message-list` entirely** — the test's diagnostic reports `row-gone/no-placeholder` where the criterion wants `row-present/redacted`. **Half the criterion is fine and that half is verified separately** (the test asserts the two independently, and only the row assertion fails): the redaction goes through and `thread-replies-divider` does tick from `2 replies` to `1 reply`. So this is purely the panel's render path dropping redacted thread replies instead of rendering the Phase 1 `message-redacted` placeholder the room timeline shows (AC-B9). A P1 ticket, but a row vanishing under the reader's cursor mid-demo is the kind of thing a stakeholder notices, hence S2 rather than S3. | `e2e/results/desktop/threads-AC-T9-in-thread-ed-bd097--and-drops-the-count-by-one-desktop/` | **Fixed** (Dev B, DEV-B-22): read-only tombstone in `useRoomEvents` (the SDK parks the redacted reply in the room live timeline; the panel re-inserts it via `room.findEventById`). AC-T9-3 passes unmodified (row shows `message-redacted`, counts drop by 1), so ruling G-2 keeps its primary text and the fallback wording is not needed. Residual: a reply redacted before the client loaded has no row at all, because the server no longer reports it as part of the thread. |

### PM rulings (2026-10-08; full text in docs/PHASE3_ACCEPTANCE.md "Rulings")

| Ruling | Subject | Decision |
|---|---|---|
| G-1 | AC-A4-2 (Phase 1) says `#dev` has three members with carol absent; PRIN-12 seeds a carol-authored thread root in `#dev`, so carol joins it on the next reset | Not a defect. AC-A4-2 derives the expected members from the server (`/joined_members`), as QA already implemented; the criterion text in docs/ACCEPTANCE.md is updated. |
| G-2 | BUG-7 / AC-T9-3: Synapse strips `m.relates_to` on redaction and drops the reply from `/relations`, so a redacted thread reply cannot be shown as a tombstone without client-side memory | AC-T9-3 becomes "the reply disappears from the panel and the divider/summary counts drop by one" **unless Dev B reports a cheap tombstone** (checking now), in which case the row shows `message-redacted` and the counts still drop. **Outcome**: Dev B shipped a read-only tombstone (BUG-7 fixed); AC-T9-3 passes unmodified, the fallback wording is not needed. Residual: a reply redacted before the client loaded has no row at all. |

### QA-17 regression gate — the `threadSupport: true` flip did not regress Phase 1/2

Run after PRIN-8 landed and after QA-14's main-timeline-only receipt fixtures were in place (the gate
precondition in docs/PHASE3_PLAN.md "Sequence").

| Project | Result | Verdict |
|---|---|---|
| `desktop` (96 tests) | 79 pass / 9 fail / 8 skip, then **87 pass / 1 fail / 8 skip** after triage | No regression from the flip. 8 of the 9 failures were a **transient broken build**: every one is `app-shell` / `current-user` never rendering after login, in one contiguous block (AC-B5-6, AC-B6-1..5, AC-B7-1/2/3), and all 8 pass on re-run — the dev server on 5173 was serving a half-saved edit while Dev B worked. The 9th is AC-A4-2, see G-1. |
| `mobile` (58 tests) | 57 pass / 1 fail / 0 skip, then **58 pass** after a fixture fix | No regression from the flip. The single failure (AC-V2-5) was a QA-side seed-window defect, listed under "Fixture-side defects". |

Two gate findings that are **not** product defects but do need an owner:

| # | Finding | Owner |
|---|---|---|
| G-1 | **AC-A4-2 ("`#dev` has three members and carol is absent") is no longer true of this homeserver, and will not be true again.** Carol joined `#dev` on 2026-10-08 (Phase 3 thread tooling), and **PRIN-12 seeds the `#dev` thread with a carol-authored root**, so carol is a `#dev` member from the next `seed:reset` onwards: the criterion's seeded expectation now contradicts another Phase 3 ticket. QA has made the test derive membership from the server and record the drift with `noteSeedDrift` (the criterion's real content — the panel lists exactly who the server says is joined — still passes), but the **criterion text in docs/ACCEPTANCE.md needs a PM decision**: drop "carol is absent", or seed the `#dev` thread under a member who is already there. | PM / Principal |
| G-2 | `npm run verify:threads` pointed at a `scripts/verify-thread-shell.mjs` that was not in the tree, so the command failed immediately. **Resolved during Wave 8** — the Principal landed the script; re-checked at the end of this pass. | Principal (closed) |

### Final Wave 8 runs (AC-T11-3)

`npx playwright test --project=desktop` then `--project=mobile`, sequentially, on the dirty
homeserver, with both thread specs and both smoke step 11s in place.

| Project | Tests | Pass | Fail | Skip | Did not run | Time |
|---|---|---|---|---|---|---|
| `desktop` | 141 | **114** | 3 | 13 | 11 | 31.1 min |
| `mobile` | 74 | **65** | 2 | 7 | 0 | 3.4 min |

**Desktop failures**: BUG-6 (AC-T6-4) and BUG-7 (AC-T9-3), both open and listed above, plus
**BUG-4** (`smoke.spec.ts` step 1, login 16 083 ms) — and because that spec is `mode: 'serial'`,
step 1's failure is what produced all **11 "did not run"**, demo step 11 included. Run on its own,
`npm run test:e2e:smoke` is 7 passed / 5 skipped with step 11a green and step 11b skipped
(`header-threads` not built), and both screenshot sets are written: `e2e/results/demo/11-*` (5 shots)
and `e2e/demo-mobile/11-*` (4 shots).

**Mobile failures**: both **intermittent, both pass on re-run, neither is a product defect**, and
both are now hardened in the specs (see "Fixture-side defects" 7 and 8). The 13 desktop and 7 mobile
skips are the 8 known fresh-seed skips, 1 manual clipboard criterion, the `not-built` thread UI, and
the device-only AC-T3-5.

**Re-verified after the hardening**: `e2e/mobile-threads.spec.ts` 8 passed / 6 not-built, and
`e2e/voice.spec.ts` 18/18 passed.

### Observation: the thread suites make `#general` slower to page back (no defect, one recommendation)

After this pass `#general` holds **1 066 events, 335 of them (31.4 %) thread replies**. Thread
replies are real events in the room's `/messages` history but are *correctly* absent from the main
timeline, so backwards pagination has to walk ~1.5x more server events to surface the same number of
rendered rows. The visible effect is in the Phase 1 suite, not the product: `conversation.spec.ts`
tests that call `withFullHistory()` went from a few seconds to **36-43 s each**, which is most of why
the final `desktop` run took 31 minutes against the gate run's 10.

Nothing fails because of it and no criterion is violated — the app still reaches
`timeline-start` correctly. Two follow-ups worth taking:

1. **QA (next pass):** move the 40-reply pagination fixtures (`theBigThread()` in
   `e2e/threads.spec.ts`) from `#general` to `#dev`. The criteria do not name a room, and it would
   keep ~80 events per run out of the room every Phase 1 pagination criterion walks.
2. **Principal (worth a look, not a bug):** a room where a third of the history is thread replies is
   now the normal case for this homeserver. Worth confirming that `paginateBack` cannot return a page
   of *only* thread replies and be mistaken for "no more history" — the tests reach the start banner,
   so it behaves today, but the margin is narrower than it was.

### Not built yet (as of this QA pass — informational, not defects)

Probed once per run by `requireThreadUi`; these are the entry points that were absent, with the
criteria that consequently skipped rather than failed.

| Missing | Owner | Criteria skipped |
|---|---|---|
| `header-threads` / `header-threads-unread` — the button is not in `channel-header`. `src/features/navigation/components/ThreadList.tsx` **exists** and already uses the registry names (`thread-list[data-variant]`, `thread-list-item-{rootId}`, `-author` / `-snippet` / `-count` / `-time` / `-avatars`, `thread-list-empty`, `thread-list-close`), but nothing mounts it and `ThreadList.module.css` is missing — it is dead code today, so the app still builds; it will not once the header imports it. | Dev A (DEV-A-17) | desktop AC-T2-7, AC-T7-1..8; phone AC-T7-1 / 2 / 4 / 7; desktop demo step 11b; phone demo step 11b |
| `header-back` / `header-thread-room` on phone | Dev A (DEV-A-18) | phone AC-T8-1, AC-T8-2 |

Built and green at the time of the pass: `message-action-thread` (toolbar and sheet), `thread-panel`
with the registry composer, `thread-root`, `thread-replies-divider`, `thread-message-list`,
`thread-typing`, `thread-summary-{rootId}` with `-count` / `-time` / `-avatars`,
`thread-timeline-start`, `thread-timeline-loading`, `thread-close`, `app-shell[data-thread-open]`.

### Contract divergences for the Principal (not defects; the devs code against the ticket table)

| # | docs/PHASE3_TICKETS.md "Shared API" says | The tree has | Why it matters |
|---|---|---|---|
| D-1 | `src/store/thread.ts`, `useThreadStore` with `open: { roomId, rootId } \| null` plus `openThreadRootId` | `src/store/threads.ts`, `useThreadStore` with `openThreadRootId` / `openThreadRoomId` fields and a `useOpenThread()` selector returning `{ roomId, threadRootId }` | Internal only, and QA asserts the DOM contract (`app-shell[data-thread-open]`, `thread-panel[data-root]`) rather than the store, so nothing in the suite depends on it. **Resolved during Wave 8**: docs/ARCHITECTURE.md now has the "Phase 3 deltas (threads)" section AC-T10-4 asks for, which records these renames. Left here as the record of what QA checked. |
| D-2 | `src/lib/format.ts` exports `formatRelative(ts)` | `src/lib/format.ts` now **does** export it (landed during Wave 8), but `src/features/navigation/relativeTime.ts` still holds the temporary copy *and `ThreadList.tsx` still imports from it* — so there are currently two implementations of the same pinned strings. | The criteria assert the strings themselves (AC-T4-2 pins `just now`, AC-T7-2 the list's time), and Dev B's summary row and Dev A's list items must agree. The remaining step is the one Dev A's own file header asks for: point `ThreadList.tsx` at `@/lib/format.ts` and delete `relativeTime.ts`. **Closed** (Dev A, 2026-10-08): `relativeTime.ts` deleted, `ThreadList.tsx` imports `formatRelative` from `@/lib/format.ts`; one implementation of the pinned strings. |
| D-3 | — | `src/features/conversation/components/ThreadView.tsx` carried a PRIN-10 skeleton with non-registry ids (`data-root-id`, `thread-message-{id}`, `thread-empty`, `thread-load-more`) | QA asserts the **registry** names only, deliberately, so the suite reports such a divergence instead of hiding it. Dev B's ThreadView now uses the registry ids; recorded so the skeleton ids are not re-introduced. |

## Phase 5 (end-to-end encryption)

```
npm run test:e2e:e2ee                                              # e2ee-core-* + e2ee-media + e2ee-security-* (desktop)
npx playwright test e2e/smoke.spec.ts --project=desktop -g "step 13" # Phase 5 demo walk-through -> e2e/results/demo/13-*
npx playwright test e2e/e2ee-security-chain.spec.ts --project=desktop -g "AC-E5-2"
```
Prefix with `PLAYWRIGHT_BROWSERS_PATH=/tmp/claude-0/pwb` in the build container. Security chains and the demo run on
**throwaway accounts** (`freshUser()`): cross-signing cannot be undone, so alice's account is never set up by a test.

**S1 on sight (Phase 5):** plaintext reaches the wire in an encrypted room · a raw encrypted mxc is navigated to ·
keys survive logout · setup offers a new key on an account that already has secret storage.

| BUG | AC ref | Sev | Owner | Found | Expected | Actual | Status |
|---|---|---|---|---|---|---|---|
| BUG-11 | AC-E1-4 | S3 | Principal (`src/store/session.ts`) | `e2ee-core` AC-E1-4 | A token rejected after boot shows "Session expired" on the login form | Wipe is correct, but `onSessionLoggedOut` -> plain `logout()`: no message (only the boot-time path says it) | Fixed (session expired message on token rejection); regression `e2ee-core` AC-E1-4 |
| BUG-12 | AC-SH layout, AC-T6 | S1 | Principal (`src/app/Shell.tsx`) | thread panel `hidden` in AC-E2-5 | Members / thread panel beside `main` | `security-dialogs-host` was a grid child: panels pushed to a 2nd row, height 0 | Fixed 21179cb; regression `e2ee-core` "(21179cb a)" |
| BUG-13 | AC-E2-5 | - | PM | `e2ee-core` AC-E2-5 | Reactions `m.room.encrypted` on the wire | `m.reaction` in clear: matrix-js-sdk never encrypts reactions (Element parity) | **Resolved** (PM, 2026-10-18): AC-E2-5 reworded (edits, replies and thread replies `m.room.encrypted`; reactions in the clear, Element parity), limitation recorded in PHASE5_PLAN.md and PHASE5_DEMO.md; test asserts the clear relation only |
| BUG-14 | AC-E4-1 | S3 | Principal (`UserFooter`) or PM | `e2ee-security` AC-E4-1 | `current-user[data-verified="unknown"]` on an account with no cross-signing | `"false"` once status lands | Fixed (`unknown` without cross-signing); regression `e2ee-security` AC-E4-1 |
| BUG-15 | AC-E8-3 (Phase 1 suites) | S2 | Principal (`seed/`) | fixture load | `seed/seed-output.json` keeps the 11 seeded event ids | `"events": {}` since the additive `npm run seed` (2026-10-17 23:54): `conversation.spec` and smoke steps 3+ throw "has no event" | Fixed (seed re-records event ids); regression guard in `e2e/fixtures/seed.ts` loadSeed |
| BUG-16 | registry | S3 | Dev A or PM | helpers | `verify-close` / `recovery-close` / `setup-close` | One shared `dialog-close` in all three | Not a bug: the corner X has its own id since c59d1f8, footer buttons keep `dialog-close`; pinned by the BUG-16 regression test |
| BUG-17 | demo rows 8-9 | S3 | PM (docs/PHASE5_PLAN.md) | smoke step 13 | After the emoji match, window 3 offers Unlock and the user pastes the key | Window 1 holds the backup key, so the SAS hands it over and the restore runs by itself; the banner flashes `unlock` then disappears | **Fixed** (PM, 2026-10-18): demo rows 8-9 reworded (row 8: history restores by itself after the emoji match; row 9: the recovery-key path with window 1 closed), Recovery decision row, AC-E4-4, AC-E2-6, AC-E5-1, AC-E5-2 and PHASE5_DEMO.md aligned; step 13 accepts both |
| BUG-18 | AC-A1-2, AC-E8-3 (smoke step 1, Phase 1-4 suites) | S2 | Principal (`src/store/rooms.ts` `recomputeRooms`, `src/store/bridge.ts`) | full regression 2026-10-18 | A fresh login (no `nav.selection`) lands on Acme HQ / #general | Lands on Home / DM Bob in 3 of 4 tries (`navigation` AC-A1-2 `--repeat-each=4`). Likely: the first-load rule (`firstReady && spaces.length > 0`) runs on a debounced recompute fired mid initial sync (Phase 5 decryption / state events), before the spaces are known, so it falls back to `dms[0]`. Apply the first-load landing only once the initial sync is `Prepared` | Fixed 31f965d (no room recompute before the initial sync is prepared); regression `navigation` AC-A1-2, smoke step 1 |
| BUG-19 | AC-V6-6 | S3 | QA (`e2e/mobile-nav.spec.ts`) | mobile-nav, about 1 in 3 | The anchor stays put while older rows are prepended | "anchor drift 44 px" or "pagination did not add rows": the 44 px phone security banner (correct for an account without encryption) mounts ~1 s after the shell, after the test scrolled and measured | Fixed (test): `loginAs()` now waits for the security status and the banner (`settleSecurityBanner`). The AC-V6-6 drift is also measured inside `message-list`. Same 48 px shift on desktop broke `conversation` AC-B3-2 (3/4 red); both now pass 4/4 |
| BUG-20 | AC-E8-3 | S2 | QA (`e2e/auth-media.spec.ts`) | full regression 2 | Every test's browser contexts closed at its end | The SSO login-token test never closed its `browser.newContext()`, so a logged-in alice synced (with crypto) for the whole run; later logins took 16 s+ in "Setting up encryption" / "Syncing" and missed the 20 s shell timeout (5 desktop tests) | Fixed (test): context closed in `finally` |
| BUG-21 | AC-E8-3, AC-SH-2 | S2 | QA (`e2e/fixtures/auth.ts`) + coordinator (homeserver data) | full regression 3 | Test logins leave no devices behind | `loginAs` never logged out: alice has **1206 devices, 790 with device keys**. Since Phase 5 every login queries and every encrypted send shares keys with all of them. Logins slow down over a run (shell > 20 s, AC-SH-2 11.6 s, AC-E5-6 backup count stuck) | Test half fixed: `loginAs` logs out the sessions of earlier tests (`navigation` run: +2 devices for 29 tests). Server reset 2026-10-18 cleared them. Run 4 holds: alice 1 -> 11 devices over 290 tests (6 web, 4 API-helper logins) |
| BUG-22 | AC-G8-1, demo step 7 | S3 | QA (`gif.spec`, `mobile-gif.spec`, `smoke.spec`) | full regression 4 | GIF decoded / thumbnail box <= 400 px | Read once right after mount: `naturalWidth` 0 (decode not done) and `boundingBox()` null (bubble re-rendering). Flaky in long runs; the dev server watching `e2e/results` (Faster test runs thread) widens the window | Fixed (test): both polled. AC-G7-1 3/3, smoke demo chain and mobile-gif green in isolation |
| BUG-23 | AC-B1-1, AC-B3-1, AC-A2-3, smoke steps 2/3/5/6 | S2 | QA (`e2e/fixtures/fresh.ts`) | issue #2 run 1 (also with 1 worker) | The fresh-seed guard lets its 7 tests run on a pristine seed | Always skipped "requires a fresh seed" since 6cb6989: the seed posts a `late` thread reply into #general after `general.last`, and the probe took the newest event of any kind | Fixed (test): the probe ignores `m.thread` replies; regression `test-harness` BUG-23 |
| BUG-24 | same as BUG-23 | S3 | QA (`fresh.ts`) + `e2e/global-setup.ts` | issue #2 run 1, fix wave | A guarded test is judged on the server state its spec file started from | One verdict per worker: re-probed after a restart (spurious skips), and reused by later files on a server earlier files had dirtied (smoke step 3 failed after navigation) | Fixed (test): verdict per (pool instance, spec file), probed at the file's first guarded test; after a pool restore persisted as `e2e/tmp/fresh-w<i>-<file>.json` (cleared by global setup); regression `test-harness` BUG-24 (x2) Skip reasons name the first write after the seed and the spec file using the server then (`fixtures/run-log.ts`, PERF-3 ruling); regression `test-harness` PERF-3 |
| BUG-25 | PERF-1, PERF-6 | S2 | coordinator (`vite.config.ts`) | issue #2 run 1 (load avg 19 on 4 cores) | Idle Vite dev servers cost ~nothing during a run | Each Vite's watcher stat-ed Playwright trace files in `e2e/results` (~6400 statx/s, ~45% of a core per Vite, x N workers); logins timed out at 20 s | Fixed: `server.watch.ignored` (e2e/results, playwright-report, homeserver, ...); regression `test-harness` BUG-25 |
| BUG-26 | smoke step 2 (AC-A2-1) | S3 | QA (`e2e/smoke.spec.ts`) | issue #2, pristine seed after BUG-23 | Acme channel list = the seed's [general, random, dev, vault] | Spec expected [general, random, dev]: stale since Phase 5 added #vault, masked by the BUG-23 skip | Fixed (test): expectation lists #vault (Advisor ruling) |
| BUG-27 | AC-A5-2 | S2 | Principal (`scripts/hs-pool.mjs`) + PM (`docs/SEED_DATA.md`) | issue #2, pristine snapshot | Pristine seed: alice's only Acme unread is #random, so reading it clears the Acme dot | The snapshot bakes in `send-encrypted-sample.mjs`, leaving 4 unread in #vault (seed contract: created empty); the dot stays | **Fixed** (002be00): the snapshot build marks #vault read for alice (receipt + `m.fully_read`); spec unchanged (Advisor ruling); AC-A5-2 green in run 3 |
| BUG-28 | AC-B1-1 | S2 | Principal (message list scroll pinning, `src/`) | issue #2 run 2, pristine seed (red since the guard stopped skipping it) | #general opens scrolled to the bottom and stays there | The list pins to the bottom before the 48 px security banner mounts; when the banner shrinks the list (clientHeight 580 -> 532) nothing re-pins, so it rests 48 px short and the newest message is cut off by 31 px. A viewport resize does not re-pin either. Deterministic with 1 or 3 workers | Fixed afb6209 (`MessageList.tsx` ResizeObserver re-pins while stuck to the bottom); AC-B1-1 + regression `conversation-timeline` BUG-28 green in run 3 (3 workers) |
| BUG-29 | AC-B3-2 | S3 | QA (`e2e/conversation-timeline.spec.ts`) | issue #2 fix wave, fresh pool server (4/6 red with 1 worker) | The test sees `timeline-loading` while the page request is in flight | On a freshly restored server the request takes ~80 ms, so the indicator is mounted for ~85 ms and the polling `waitFor` missed it; pagination and the no-jump anchor were correct | Fixed (test): a MutationObserver installed with the scroll records the rendered indicator; 8/8 green. Same assertion |

The literal `${MARKER}` line in `homeserver/homeserver.yaml` (unparsable YAML since f6fce71) is fixed by PR #5, regression `homeserver-config.spec.ts`.

**Known limit (not a bug):** a *redacted* encrypted edit seen from history renders as "Message deleted": room v11
redaction empties the whole `m.room.encrypted` content, so no client can tell it was an edit (Element does the same).
Live, it is hidden (regression test). **Dev only:** a Vite HMR wave during boot can leave the page on
"Setting up encryption..." (seen once while devs were saving files); not reproducible in a build.

Regression tests for fixes found by others (JC's rule): Dev B's redacted relations and stuck "Decrypting..." reply
quote; the Principal's 21179cb (a) grid, (b) no rows for edits / reactions, (c) banner with no rooms, (d) `errorKind`,
(e) newest incoming request, (f) `unlock` hint for secret storage without cross-signing. All in `e2ee-core` / `e2ee-security`.

Not automated: AC-E2-8 (`decrypting` lasts milliseconds), AC-E4-2 wrong password (first upload needs no UIA, so no
password is ever asked), AC-E5-7 (needs 50+ sessions in one backup). All `test.fixme` with the reason.

**Full regression 2026-10-18 (61e6cef, `--output e2e/results/qa-regression-1018-0136`).** Desktop 121 passed /
53 failed / 35 skipped; mobile 37 / 34 / 10. All red but two tests is BUG-18: the test lands on DM Bob, or it cannot find a
`channel-item-*` of Acme HQ. QA fixes in the tests: `navigation` AC-A3-1 now expects the m.direct rooms alice is
*joined* to (e2ee suites leave their throwaway DMs), AC-A6-3 expects an encrypted channel (AC-E6-1 supersedes
"unencrypted"; PM: please reword AC-A6-3), and the `e2ee-core` AC-E6-1 teardown also leaves the #general that comes
with a new space. Five orphan encrypted "general" rooms from earlier runs are still in alice's Other Rooms. They need
cleanup by someone allowed to change shared homeserver data.

**Regression runs 2 and 3 (31f965d).** Run 2: desktop 175/7/27, mobile 78/3/0 (BUG-19, BUG-20, AC-V4-4 404
allowlist). Run 3, with those fixed (`e2e/results/qa-regression3-1018-0446`): desktop 179/7/23, mobile 79/2/0. 7 of the 9
red tests are slow logins or syncs (BUG-21). The other two, AC-V6-6 (1474 px jump) and AC-B3-2 (`timeline-loading`
not seen), pass in isolation; I'll re-judge them after the device cleanup.

**Regression run 4 (df1a7ca, fresh homeserver, `e2e/results/qa-regression4-1018-0949`).** Desktop 189/2/18 (40 min),
mobile 81/0/0 (10 min). The 2 red were BUG-22. AC-V6-6 and AC-B3-2 passed (the run-3 failures were BUG-21 load).

### Manual 704.chat checklist (AC-E8-4)
Real server: https://matrix.704.chat, SSO via Keycloak, Element on the side. Mark `ok` / `fail: <what>`.

| # | AC | Check | JC | Charlie | Juanjo |
|---|---|---|---|---|---|
| 1 | AC-E5-8 | Log in via Keycloak; banner says **Verify** (never **Set up**); unlock with the recovery key you have in Element | | | |
| 2 | AC-E5-8 | Same with the **passphrase** instead of the key (if you have one) | | | |
| 3 | AC-E5-8 | All 6 encrypted rooms read: old history decrypted, no "Unable to decrypt" left after the restore | | | |
| 4 | AC-E5-8 | Element still unlocks with the same key afterwards (key unchanged) | | | |
| 5 | AC-E4-8 | Verify codec from Element (Element starts): same 7 emoji, both say verified | | | |
| 6 | AC-E4-8 | Verify from codec (codec starts, Element accepts) | | | |
| 7 | AC-E4-8 | Element's session list shows the codec session with a green shield | | | |
| 8 | AC-E4-8 | Brand-new SSO account: **Set up** opens the Keycloak popup ("Finish signing in in the window that opened"), the key appears after the popup closes | | | |
| 9 | interop | Text from codec decrypts in Element, and Element's text decrypts in codec | | | |
| 10 | AC-E3-7 | Image from Element (with a thumbnail) renders in codec; voice note from Element plays in codec | | | |
| 11 | interop | Image, file and voice note sent from codec open / play in Element | | | |
| 12 | AC-E1-3 | Log out of codec, log in again: new session, banner back (DevTools > Application > IndexedDB: no old `matrix-poc-crypto:` store) | | | |

## Voice format (Ogg remux + software-decode fallback, docs/VOICE_FORMAT_PLAN.md)

QA pass against `e2e/ogg-remux.spec.ts` (Node, the remuxer on the real Chromium fixtures
`e2e/fixtures/chromium-{1s,3s}.webm`, judged by the independent reader `e2e/fixtures/ogg.ts`),
`e2e/voice-compat.spec.ts` (native vs fallback playback; the "old iPhone" simulation is
`e2e/fixtures/old-iphone.ts`) and `e2e/voice.spec.ts` (AC-V2-4 now asserted), all in the `mobile`
project, on the dirty homeserver. Notes go to `#dev`.

```
npx playwright test -c playwright.local.config.ts e2e/ogg-remux.spec.ts e2e/voice-compat.spec.ts e2e/voice.spec.ts --project=mobile
npx playwright test -c playwright.local.config.ts e2e/voice-compat.spec.ts --project=mobile -g "AC-F5"
```

| BUG | AC ref | Sev | Platform | Manual | Owner | Steps | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| BUG-32 | decision 1 (lossless remux), AC-F1 | S3 | web-mobile-emulated (Node) | no | Principal | `remuxWebmOpusToOgg(chromium-3s.webm sliced to 60 % of its bytes)` — a recording cut in the middle of a SimpleBlock. | The truncated trailing block is dropped (the remuxer's own header says so): 34 audio packets, the 34 complete SimpleBlocks. | 35 packets: the partial block was emitted as a full Opus packet (a corrupt last frame). `readElement()` clamped `dataEnd` to the buffer, so the `el.end > cluster.dataEnd` truncation check in the packet loop could never fire. | `e2e/ogg-remux.spec.ts` "remux of a WebM cut mid-cluster …" | **Fixed** (Principal, `src/lib/audio/ogg.ts`: elements record `truncated`, the packet loop breaks on it). Re-verified: the regression test passes. |
| BUG-31 | AC-A5-2 | S3 | web-desktop | no | QA | Full suite in CI (3 pool workers): an E2EE spec adds encrypted #vault to Acme on the same server before `navigation.spec.ts` runs; repro locally with `E2E_WORKERS=1` running `e2ee-core-boot`, `e2ee-core-timeline`, `navigation` on desktop. | After reading #random the Acme dot goes away only when no other Acme channel is unread. | The test summed only #general/#dev via the receipt-derived `unreadFor`, which cannot see bob's `m.room.encrypted` messages, so it expected the dot gone while #vault was still unread. Test bug, not an app bug; order-dependent on master too. | `e2e/navigation.spec.ts` AC-A5-2 | **Fixed**: the precondition now reads the channel list's own `channel-unread-*` badges (what the dot sums); asserts the dot stays when any remain. Re-verified with the repro order. |
| — | AC-V1-2 | — | web-mobile-emulated | no | — | Baseline run before the change: AC-V1-2 (live level meter) failed once. | — | Passed in every run of this pass (full voice run, and the suite alone). Not reproducible; environment flake of the fake mic in this container's Chromium, not a voice-format regression. | — | Not a bug. |
| — | phone demo step 1 | — | web-mobile-emulated | no | — | `mobile-smoke.spec.ts` run as the first spec right after the dev server cold-started (same run as the voice specs). | Lands in #general. | Header read "random" once (the pre-seeded `nav.selection` race the voice.spec `openRoom` helper already works around); the 12 later serial steps did not run. The suite alone right after: 13/13 green. | — | Not a voice-format defect; flake on a cold dev server. |

Regression tests added for Dev B's notes (no bug found, kept as guards): a native `play()` that never
settles switches to the fallback after the ~4 s stall timeout (`voice-compat.spec.ts` "stalled native
play() …"), and a WKWebView-style `canPlayType` that *lies* (`'maybe'`) recovers through the
`<audio>` format-error path ("old iPhone whose canPlayType lies").

## Phase 4 (GIF picker)

Wave 11 QA pass (QA-19 / QA-20) against `e2e/gif.spec.ts` (desktop, 16 tests) and
`e2e/mobile-gif.spec.ts` (phone, 6 tests) on a **dirty** homeserver, plus demo step 12 in both smoke
specs. Everything runs in **#dev** — never #general — and every test sends its own messages and
asserts on ids it created, so nothing here needs a fresh seed.

```
npm run test:e2e:gif                                           # both GIF specs, both projects
npx playwright test e2e/gif.spec.ts --project=desktop -g "AC-G3-1"
npx playwright test e2e/mobile-gif.spec.ts --project=mobile -g "AC-G9-1"
npx playwright test e2e/smoke.spec.ts --project=desktop        # demo step 12 needs steps 1-11 first
npm run gif:fixtures                                           # regenerate public/gif-fixtures/
npm run gif:sample -- --id mock-7                              # bob posts a GIF (demo row 7)
```

**Result: no S1 or S2 product defect.** Both projects are green with **no skips**
(desktop 16/16, phone 6/6, desktop smoke step 12 and phone smoke step 12 both pass). Every criterion
this pass can judge from a browser — the picker, both variants, the slash commands, keyboard
navigation, the send flow, the wire contract, the host allow list, the thread path, the `klipy` code
path against stubs including 404 and 429 — behaves as specified. The three rows below are
**contract/documentation divergences**, not broken behaviour; the fourth block is the quota guard.

**Quota guard (AC-G11-3).** Every GIF test installs `guardGifNetwork` (`e2e/fixtures/gif.ts`) before
any stub. An unstubbed request to `api.klipy.com` **fails the test** — a Klipy test key allows 100
requests an hour, so a leaking suite would spend the stakeholder's quota. Requests to
`static.klipy.com` are *served* from the local fixture bytes rather than failed, because the
`klipy` criteria must post real messages whose `url` is on the Klipy CDN (AC-G3-2) and every later
test that opens #dev then renders those rows; failing on that would make each klipy test poison every
test after it. Either way nothing leaves the machine. No run in this pass recorded a violation.

| BUG | AC ref | Sev | Platform | Manual | Owner | Steps | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| BUG-10 | AC-G4-2, AC-G5-3, AC-G8-1, docs/PHASE4_PLAN.md desktop demo row 3 | S2 | web-desktop + android-device | no | PM + Principal (PRIN-13) | 1. `grep "title: '" src/lib/gif/mock-fixtures.ts`. 2. Compare with the "Mock provider fixture contract" table in docs/PHASE4_ACCEPTANCE.md. 3. In the app under `mock`, type `/gif tacos` and press Enter. 4. Press ArrowRight twice, then Enter — the keystrokes the stakeholder's demo script prescribes. | Per the acceptance table and the demo script: `tacos` matches **three** fixtures (`mock-1` Tacos dance, `mock-2` Tacos Tuesday, `mock-3` Tacos party), so two ArrowRights move the selection to `mock-3` and Enter sends "Tacos party". AC-G4-2 names `mock-1`, `-mock-2`, `-mock-3` explicitly; AC-G5-3 says "ArrowRight twice then Enter sends `mock-3`". | `src/lib/gif/mock-fixtures.ts` titles `mock-2` **"Taco Tuesday"** (no "s") and `mock-3` **"Party time"**, so a case-insensitive substring match on `tacos` returns **one** fixture, `mock-1`. Both ArrowRights clamp at index 0 and Enter sends "Tacos dance". The feature is correct — the *search* is a faithful substring match and the picker's clamping is right (AC-G5-1) — but the document, the criteria and the stakeholder's scripted keystrokes describe a catalogue the code does not have. Either `mock-2`/`mock-3` are renamed to "Tacos Tuesday"/"Tacos party" (what the doc, AC-G4-2, AC-G5-3 and the demo script all assume) or those three criteria and demo row 3 are rewritten. Note the two files were realigned repeatedly during Wave 11 and this is the residue; QA's own suite is unaffected, because it **derives** every mock expectation from `mock-fixtures.ts` at run time (`e2e/fixtures/gif.ts` module header) and reports the mismatch as a `catalogue-drift` annotation on AC-G1-3 rather than as a red test. | the `catalogue-drift` annotation on `[desktop] AC-G1-3`; `e2e/results/demo/12-picker-prefilled.png` shows the one-result grid the demo actually gets | **Fixed and verified 2026-10-09.** Ruled by the orchestrator: the rename stands — `mock-2` becomes "Tacos Tuesday" and `mock-3` "Tacos party", so `tacos` matches `mock-1..3` and demo row 3 lands on `mock-3` as written. The Principal is landing it (`mock-fixtures.ts` + `npm run gif:fixtures`); the doc and all four criteria then need no edit. Landed by the Principal and re-verified by QA: `mock-2` = "Tacos Tuesday", `mock-3` = "Tacos party", so `tacos` and `taco` now match `mock-1..3`, `party` -> `mock-3, mock-4`, `cat` -> `mock-5, mock-6`, `dance` -> `mock-1` — exactly the acceptance table. AC-G4-2 and AC-G5-3 are satisfiable as written, and desktop demo step 12 now derives `tacos` for demo row 2, so two ArrowRights land on `mock-3` as the script narrates. The `catalogue-drift` annotation on AC-G1-3 is gone (verified: annotations empty). |
| BUG-9 | AC-G2-1, AC-G2-2 | S3 | web-desktop | no | Principal (PRIN-14) | 1. Stub `api.klipy.com` with two items whose ids are `9041071659142944` and `9041071659142945` (both 16-digit Klipy-shaped numbers above `Number.MAX_SAFE_INTEGER` = 9007199254740991). 2. Open the picker under `klipy`. 3. Inspect the two tiles. | Two tiles with distinct `gif-item-{id}` test ids and distinct `previewUrl`s. | **Both tiles carry `data-testid="gif-item-9041071659142944"` and both load `.../9041071659142944/sm.webp`** — their `<img alt>`, title and reserved dimensions are correct, so only the identity is wrong. Cause: Klipy ids arrive as JSON **numbers**, and `JSON.parse` rounds anything above 2^53 to the nearest double, so the two ids collapse onto one before `mapKlipyItem` stringifies them (`String(item.id)`). Consequences if a real Klipy id ever exceeds 2^53: duplicate React keys, a tile that previews the wrong GIF, and a `dev.matrixpoc.gif.id` that does not round-trip. The acceptance example id (`8041071659142944`) is *below* the limit, which is why nothing else caught it; ids beginning with 9 would not be. Fix if it is judged worth it: read ids as strings off the wire (a `JSON.parse` reviver, or ask Klipy whether ids are bounded). Found while writing the phone klipy test; QA's stub ids are now pinned below the limit with a comment. | `e2e/results/mobile/mobile-gif-GIF-sheet-—-kli-31e14-nd-a-pick-sends-the-CDN-url-mobile/` (the strict-mode violation lists both `<img>` elements with the same `src`) | **Fixed and verified 2026-10-09.** Ruled by the orchestrator: a Klipy `GifResult.id` becomes the item's **`slug`** instead of `String(item.id)`, which removes the limit entirely — a slug is already a string, so nothing passes through a double. Landed in `mapKlipyItem` (`item.slug` first, `String(item.id)` only when there is no slug) and re-verified by QA. QA's stub now pins `slug === String(spec.id)` (`klipyItem` / `klipyResultId` in `e2e/fixtures/gif.ts`), so every id assertion — tile test ids and the `dev.matrixpoc.gif.id` on the wire — pins the same string under either mapping and the suite needs no flag day. |

### Contract divergences for the Principal (not defects)

| # | Subject | Divergence | Suggested resolution |
|---|---|---|---|
| 1 | `customer_id` on every Klipy request | AC-G2-1 now requires each request to carry "a `customer_id` (stable across reloads in the same browser, `matrix-poc.gifCustomerId`)", and `provider.ts` exports `getGifCustomerId()` which generates and persists exactly that uuid — but `getGifProvider()` calls `createKlipyProvider({ apiKey, baseUrl })` **without** `customerId`, and `klipy.ts` only sets the parameter `if (options.customerId)`. So no `customer_id` is ever sent. docs/PHASE4_PLAN.md "Out of scope" explicitly lists "recent/favourite GIFs and Klipy's `customer_id`", so the **code follows the plan and the acceptance criterion is the odd one out**. | **Resolved and verified 2026-10-09.** Ruled by the orchestrator: `customer_id` **is** sent on every Klipy request, so AC-G2-1 stands and `getGifProvider()` gains `customerId: getGifCustomerId()` (falling back to `undefined`) — the Principal is landing it, and docs/PHASE4_PLAN.md "Out of scope" needs its `customer_id` clause struck. QA asserts the key path segment, `q`, `page`, `per_page` and `content_filter` and **not** `customer_id`, so the suite is green either way; the presence assertion is now in AC-G2-1 (the trending request carries a non-empty `customer_id`, and the following search carries the **same** value, so it is persisted rather than regenerated per call). The value itself is a random uuid and is deliberately not pinned. |
| 2 | `GifResult` / `GifPage` field names | docs/PHASE4_TICKETS.md's Shared API table promises `{ url, w, h, previewMime }` and `GifPage { items, hasNext }`; the shipped `types.ts` has `{ fullUrl, fullW, fullH, previewMimetype }` and `GifPage { results, nextPage, hasNext }`. The tickets already say names are "subject to the Principal's ARCHITECTURE deltas", and the **wire** shape (which is what the tickets protect) matches the acceptance contract exactly. | Informational only — the ticket table wants a refresh, or docs/ARCHITECTURE.md "Phase 4 deltas" wants writing (it does not exist yet, which is why this is listed at all: AC-G10-2 requires that section). No code change. |

### Phase 4 criteria this pass cannot judge — stakeholder checklist

| AC | Why | Who |
|---|---|---|
| AC-G3-5 (a `static.klipy.com` `<img>` loads in the Android WebView, no CSP / sanitizer / Capacitor block) | Needs the APK on a real device with internet. The browser half is covered: the `klipy` criteria render `<img src="https://static.klipy.com/...">` from the stub and the image decodes (`naturalWidth > 0`), so nothing in the dev build blocks the host. | stakeholder, `android-device` |
| AC-G9-2, Android-back half (back closes the GIF sheet before the drawers) | `@capacitor/app` back-button events are not dispatched in Chromium, so the `mobile` project cannot press it. The backdrop and `gif-close` halves are asserted. Same limitation as Phase 2's AC-M-back and Phase 3's AC-T3-5. | stakeholder, `android-device` |
| The real Klipy key (AC-G2-* against the live service) | No key exists yet; the whole `klipy` path is tested against `page.route` stubs written from the verified response shape. The live run is the stakeholder's (docs/PHASE4_PLAN.md "User-only steps"). If the live mapping is wrong it will be wrong in exactly one function, `mapKlipyItem`. | stakeholder, after pasting a key |
| AC-G8-3 (a GIF row far out of view unmounts its `<img>` into a sized `message-gif-placeholder`, remounts with no layout shift) | **Not covered by a dedicated test this pass** — a DEV-B-25 P1 half, not in the QA-19 brief. It is not unverified, though: `GifMessage` implements it (an IntersectionObserver with a 200 px margin and the four `data-state` values), `expectGifPlaying` in every pick assertion depends on a row *leaving* `offscreen` when scrolled in, and desktop demo step 12 row 4 asserts the placeholder whenever the row genuinely leaves the margin. What is missing is the layout-shift measurement (`message-list.scrollHeight` unchanged +/- 2 px) under a forced 20-message scroll. | QA, if it is promoted to P0 |
| AC-G8-4 (reduced motion shows `stillUrl` plus `message-gif-play`; clicking play animates) | **Not covered by a dedicated test this pass** — the other DEV-B-25 P1 half, not in the QA-19 brief. The ingredients are all verified elsewhere: AC-G1-3 asserts every `<id>.png` still frame is served, and the contract test asserts `stillUrl` reaches the wire. What is missing is a `page.emulateMedia({ reducedMotion: 'reduce' })` test of the `paused` -> `playing` transition. | QA, if it is promoted to P0 |
| Element interop (the GIF body shows as a link and the server unfurls it) | Needs a second client by hand. The wire half is asserted: `msgtype` is `m.text` and the url is the last whitespace-separated token of `body`, which is what makes Element linkify and unfurl it. | stakeholder, manual |

## Phase 7 (voice calls)

QA-34..38 against `e2e/calls-core.spec.ts` (Principal's core spec, taken over by QA), `e2e/call-dm.spec.ts`,
`e2e/call-room.spec.ts` (desktop) and `e2e/mobile-call.spec.ts` (phone); helpers in `e2e/fixtures/call.ts`. Local Synapse +
the per-worker LiveKit 1.13.10 + Node lk-jwt stack (`hs-pool`), Chromium's fake mic. Dirty seed allowed. The DM callee is
**dave** (`dm-alice-dave` is the only encrypted DM; `dm-alice-bob` is plain); `#vault` (alice, bob, dave) is the room;
the 7-member drop-in room and the `@signal_*` ghost rooms are created per run via API.

```
npm run test:e2e:calls                                          # calls-core + call-dm + call-room, desktop
npm run test:e2e:calls:mobile                                   # mobile-call, mobile
E2E_WORKERS=3 npx playwright test e2e/calls-core.spec.ts e2e/call-dm.spec.ts e2e/call-room.spec.ts e2e/mobile-call.spec.ts
npx playwright test e2e/call-dm.spec.ts -g "AC-R5-4" --project=desktop
```

**Severity rule (Phase 7).** `S1`: a call that connects without E2EE, a call started in an unencrypted room, a mic held
after leave, a ring that never stops. `S2`: wrong or missing chat lines, multi-device not stopping, chip / indicator
stale. `S3`: cosmetic.

**Result (Wave 2, `7f5bf37` + QA test fixes, 3 workers):** call specs 19 tests: **14 passed, 5 failed**, all five on
product defects below (no S1). The chains keep running past a known defect (`expect.soft`), so every other assertion in
the failing tests passed. The 60 s ring runs in real time (request #24 in docs/STATUS.md for a ring timeout override).
**Wave 2 full run** (`E2E_WORKERS=3 npx playwright test`, both projects, 21.5 min): **360 passed, 5 failed, 12 skipped**.
The 5 failures are exactly the call tests above (BUG-33..37); nothing outside Phase 7 regressed (Phase 1-6 suites,
e2ee, threads, mobile all green; AC-E6-3 green after its test-order fix). The 12 skips are the usual fresh-seed guards
(AC-B1-1, AC-B3-1, AC-A2-3, smoke steps 2/3/5/6), clipboard / manual / device-only criteria (AC-B8-4, AC-E2-8,
AC-E4-2, AC-E5-7, AC-T3-5).

| ID | Sev | Criterion | Repro | Owner | Status |
|---|---|---|---|---|---|
| BUG-33 | S2 | AC-R5-1 (ringtone after the first click) | A ring that arrives before any gesture on the page never starts the ringtone: the store calls `ringtone.play()` once when `incoming` becomes non-empty (`src/store/call.ts` ~l.316), `play()` returns early without a gesture, and nothing retries after the click that removes "Click anywhere to hear the ringtone". `ringtone.lastPlayedAt` stays `null` after the click. `npx playwright test e2e/call-dm.spec.ts -g "AC-R4-1, R5" --project=desktop` (step AC-R5-1, soft). Fix: on the first gesture while `incoming` is non-empty, call `ringtone.play()` (e.g. a one-shot listener in `ringtone.ts` that replays a pending start). | Principal | **Fixed** `41169c9` (ringtone retries on the first gesture). Regression: `call-dm.spec.ts` "AC-R4-1, R5…" step AC-R5-1 (hard expect) |
| BUG-34 | S2 | AC-R3-6, AC-R6-6 (ended line `participants`) | The `ended` `dev.matrixpoc.call` has no `participants` (`buildCallLineContent({ kind: 'ended' })` in `src/lib/rtc/lines.ts` and `sendEndLines` in `src/store/call.ts` never pass them); the ruling says `participants` = who was in the call. Seen in the 1:1 chain (`[]` instead of alice + dave) and the 3-person `#vault` call (`[]` instead of alice, bob, dave). `npx playwright test e2e/call-room.spec.ts -g "AC-R6-6" --project=desktop`. | Principal | **Fixed** `41169c9` (ended lines carry `participants`). Regression: `call-dm.spec.ts` "AC-R4-1, R5…" step AC-R6-5 / R3-6 and `call-room.spec.ts` AC-R6-6 |
| BUG-35 | S2 | AC-R5-4 (caller hangs up before an answer) | dave rings alice and hangs up while it is still ringing: alice's card closes in time, but **no** `missed` line is ever sent, so alice has no "Missed call from Dave" and no Call back. `sendEndLines` only sends `missed` for `endReason === 'no-answer'`; a `hangup` while ringing with nobody joined (and nobody declined) is also a missed call (AC-R5-4: "the same missed line appears"). `npx playwright test e2e/call-dm.spec.ts -g "AC-R5-4" --project=desktop`. | Principal | **Fixed** `41169c9` (a hang-up while ringing sends `missed`). Regression: `call-dm.spec.ts` "AC-R5-4 (caller hangs up)" |
| BUG-36 | S3 | AC-R7-1 (wording) | The started row reads "Dave Okafor started a call"; the registry text is "X started a voice call" (`describeCallEvent` in `src/lib/rtc/timeline.ts`; `lines.ts formatCallLine` already says "voice call"). `npx playwright test e2e/call-dm.spec.ts -g "AC-R7-1" --project=desktop` (soft). | Principal | **Fixed** `41169c9` ("started a voice call"). Regression: `call-dm.spec.ts` AC-R7-1 and the main chain step AC-R6-5 |
| BUG-37 | S3 | AC-R4-5 (one toast) | Mic denied shows the "Codec can't use your microphone…" toast **twice**. `CallErrorToast` (`src/features/call/CallHost.tsx`) calls `showToast` in an effect and then `clearError()`; React StrictMode (dev build) runs the effect twice with the same `error` before the clear lands. Fix: remember the last toasted error object in a ref, or take-and-clear in one store call. `npx playwright test e2e/call-dm.spec.ts -g "AC-R4-5" --project=desktop` (soft). | Principal | **Fixed** (uncommitted, `src/store/call.ts` `begin()` catch: sets `lastError` only when the session's snapshot carries no error of its own; the first store fix, `lastError ?? toError(e)`, lost a race with `CallErrorToast`'s clear). The `CallHost.tsx` once-gate from `41169c9` stays. Regression: `call-dm.spec.ts` AC-R4-5 (hard). Re-run E2E_WORKERS=1: `call-dm.spec.ts` 9/9, `calls-core.spec.ts` 4/4 |

**Fix wave (`41169c9`) re-run:** call specs (E2E_WORKERS=3) **21 passed, 1 failed** (AC-R4-5, BUG-37 still open);
the soft checks are hard expects again, and the missed-call tests use `__matrixPoc.call.setRingTimeoutMs` (8-10 s rings).
**Fix wave full run** (`E2E_WORKERS=3`, both projects, 22.5 min): **368 passed, 1 failed, 10 skipped**. The one failure
was AC-R4-5 (BUG-37), fixed afterwards in the store and green on re-run (see the BUG-37 row). The skips are the usual fresh-seed guards (AC-A2-3, smoke steps 2/3/5/6) and the clipboard /
manual / device-only criteria (AC-B8-4, AC-E2-8, AC-E4-2, AC-E5-7, AC-T3-5).
Smoke step 14 added to `smoke.spec.ts` (desktop demo rows 1-7, `e2e/results/demo/14-*`) and `mobile-smoke.spec.ts`
(AC-R9-1 phone call, `e2e/demo-mobile/14-*`): both green.

**Contract notes for the PM / Principal (not defects; ruled by the PM with the fix wave: "You …" on the sender's own
device, drop-in sends no notification, `call-close` is in the registry).**
- The decliner / caller sees their own line as "You declined" / "You started a call" (`describeCallEvent` `myUserId`);
  AC-R5-3 writes the name on both timelines. The specs accept "You" on the sender's own device. Needs one line in the AC.
- The `no-answer` / `ended` screen's Close is `call-close` (not in the registry, which only says "a Close"). The specs use it.
- A drop-in start sends **no** `rtc.notification` (ARCHITECTURE: `ring: false` is a quiet join; the "started" row is the
  opening membership); AC-R3-2 says `notification_type: "notification"`. The spec accepts either and annotates.
- `CallHost` turns `lastError` into a toast and clears it at once, so `__matrixPoc.call.state().lastError` is usually
  `null` right after a refused start; `calls-core.spec.ts` AC-C0 and `call-dm.spec.ts` AC-R4-5 now accept null.

**Test-side fixes made during the run (no product change).** `settleAnimations` waits for every animation's `finished`,
which never comes on the incoming card / call screen (infinite pulse): `mobile-call.spec.ts` uses a stable-box poll
instead (AC-R5-6 went from a 60 s hang to 6 s green). The main DM chain now opens the DM on dave's side after he
accepts from another room. `cleanupCalls()` clears every seeded user's `m.call` membership before and after each test.

**Test-order bug fixed: AC-E6-3** (`e2e/e2ee-core-boot.spec.ts`, red on PR #15's selected-spec CI run incl. retry; Principal
reproduced it on a fresh snapshot). The test expected a `/keys/query` or `/keys/claim` *after* focusing the #vault
composer, but alice's rust crypto already queries bob's and dave's device keys at login (all #vault members are in the
first sync); after the focus, `prepareToEncrypt`'s only request is `GET /rooms/<vault>/members`. It passed only when an
earlier spec on the same worker had left a claimable device. Not a product bug. The test now installs its listener
before login and asserts (a) a `/keys/query` naming bob and dave before any `/send/m.room.encrypted`, and (b) the
members request after the composer focus, with nothing sent. Green on its own (whole spec 11/11) and in the full run.

**Device-only (not automatable here):** AC-R5-6 / AC-R9-2 Android back (decline / minimise), AC-R9-4/5 foreground
service, lock screen and `POST_NOTIFICATIONS` (PRIN-31 report), real ringtone sound and vibration.

### Manual 704.chat checklist (AC-R10-5; JC, Charlie, Juanjo after Wave 20; homelab LiveKit)

Pass = all P0 rows green. Record `pass` / `fail (BUG-n)` / `n/a` per tester.

| # | P | Steps | Pass when | JC | Charlie | Juanjo |
|---|---|---|---|---|---|---|
| M1 | P0 | JC (web, LAN) calls Charlie from their DM; Charlie's phone (app open) rings | Ring within 3 s, JC's name on the card, ringtone + vibration | | | |
| M2 | P0 | Charlie accepts; talk for 5 minutes | Both hear each other clearly, no drop, no echo with the earpiece; timers agree within 2 s | | | |
| M3 | P0 | Either side leaves | Both screens close; "Call ended, 5 min" in the DM on both devices | | | |
| M4 | P0 | Juanjo, outside the home network on mobile data, calls JC and is called by JC | Same quality as M2; connects within 5 s; works again on Wi-Fi away from home | | | |
| M5 | P0 | All three in `#lobby` (encrypted, 3 members): JC starts, Charlie accepts, Juanjo joins by the chip; speak in turn; one mutes; one leaves | Speaker outline follows the talker; crossed mic on the muted person; the call continues for two; chip shows the count to the one who left | | | |
| M6 | P0 | Decline a call; let another ring out for 60 s | "X declined" line; red "Missed call from X" with Call back; "Missed call" preview + badge; Call back starts a call | | | |
| M7 | P0 | JC has Codec in Chrome and on the phone; Charlie calls; JC answers on the phone | Both ring; the browser stops ringing and its card closes | | | |
| M8 | P0 | On the phone, in a call: lock the screen 2 min, then another app 2 min | Audio both ways; "Codec call" notification; Hang up from the notification ends the call | | | |
| M9 | P0 | Deny the mic permission, then tap the phone icon | Clear message with how to allow; no call screen, no line, nobody rung | | | |
| M10 | P0 | Open the call screen | Lock icon. Server: LiveKit shows E2EE frames; `tcpdump` on the tunnel host shows no RTP | | | |
| M11 | P0 | Open `#general` or any unencrypted room | Phone icon disabled with "Calls need an encrypted room" | | | |
| M12 | P1 | Call someone whose phone's Codec is closed | No ring (expected); "Missed call" when they next open Codec | | | |
| M13 | P1 | Walk out of Wi-Fi range mid-call (handover to mobile data) | "Reconnecting..." then audio within 20 s, or a clean "Call ended" | | | |
| M14 | P1 | Firefox and Safari on a laptop: receive and make one call each | Audio both ways | | | |
| M15 | P1 | Join from a new, unverified device | Audio both ways within 5 s; note any "No call keys from X yet" and whether a re-join clears it | | | |

## Phase 6 (link preview cards)

QA-30..33 against `e2e/link-preview.spec.ts` (desktop) and `e2e/mobile-link-preview.spec.ts` (phone), helpers in
`e2e/fixtures/link-preview.ts`. Dirty seed allowed: #dev (plain) and #vault (encrypted) only, every test sends its own
messages with a unique `?t=` fixture URL (the client LRU, the SDK's promise cache and Synapse's url cache are all keyed by
URL). The core happy path is a **real** round trip: the test Synapse whitelists loopback for url previews and fetches
`public/preview-fixtures/` from the page's own Vite. Errors, slowness, non-mxc images, "no dimensions" and the
YouTube / Spotify embeds are `page.route` stubs of `/preview_url`.

```
npm run test:e2e:link-preview                                   # both specs, both projects
npx playwright test e2e/link-preview.spec.ts --project=desktop -g "AC-L3-1"
npx playwright test e2e/mobile-link-preview.spec.ts --project=mobile -g "AC-L4-5"
```

**Result (full run 3, both projects, 3 workers): 326 passed, 0 failed, 10 skipped** (the usual fresh-seed / manual skips;
none in the Phase 6 specs). `link-preview.spec.ts` 33/33 and `mobile-link-preview.spec.ts` 3/3. One product defect found
(BUG-30, S3, fixed); no S1 or S2.

**Severity rule (Phase 6).** `S1` on sight: a `/preview_url` request from an encrypted room without a click, any request
to a YouTube / Spotify host before the play click, or a raw non-homeserver image URL rendered in a card. `S2`: the list
jumps or loses the bottom when a card or its image arrives. `S3`: cosmetic, or a cache/retry defect with no visible
wrong state.

| ID | Sev | Criterion | Repro | Owner | Status |
|---|---|---|---|---|---|
| BUG-30 | S3 | AC-L6-5 (and the 5-min negative TTL of AC-L6-3) | Cards pass `ts` = the event's `origin_server_ts` to `getLinkPreview`, so matrix-js-sdk's own `client.urlPreviewCache` (key = minute bucket of `ts` + URL, never expired, rejected promises included) answers every later call for that message from memory. After `__matrixPoc.preview.clearLinkPreviewCache()` + a room switch (or after the miss TTL), **no** new `/preview_url` request is made, so a transient 500 / 429 / timeout is never retried for the rest of the session. `npx playwright test e2e/link-preview.spec.ts -g "AC-L6-3" --project=desktop`: "after clearLinkPreviewCache + remount the URL is fetched again", expected 2 requests, got 1. Fix: `src/lib/preview/fetch.ts` drops the SDK entry after each request settles (our LRU is the cache of record) or calls the endpoint itself. Regression: AC-L6-3 + AC-L6-5 (asserts both the hit and the cleared miss are refetched). | Principal | **Fixed** (uncommitted, `src/lib/preview/fetch.ts` drops the SDK's `urlPreviewCache` entry once a request settles); AC-L6-3 + AC-L6-5 green in run 3 |

Test-side notes (no product defect): the default landing room #general holds a seeded link (`general.link`,
`https://status.example.com`), which is previewed automatically and legitimately on login; the encrypted-room
"zero requests since the page loaded" tests therefore open straight into #vault (`loginAs(..., { selection })`). The media
service worker fetches `/_matrix/client/v1/media` itself and Playwright routes do not see service-worker requests, so
AC-L4-3 (hold the thumbnail, measure the reserved box) runs with `serviceWorkers: 'block'`, where the app falls back to
`/_matrix/media/v3` on the test server. Synapse measures `og:image` itself, so `long.html` / `nodims.html` come back
1200x630 (`large`); the "no dimensions -> thumbnail" card is a stub.

Two Phase 5 / Phase 1 tests changed with Phase 6 (full-suite run 1, both test-side):
- **AC-E6-4** (`e2ee-core-boot.spec.ts`) asserted "no `/preview_url` request at all" from login on. Since Phase 6 the
  landing room #general (plain) previews its links automatically and correctly (the seeded `general.link` plus the
  `https://example.com/link-*` that AC-B4 posts), so it went red on a legitimate request. It now asserts no request for
  the link it sends in #vault; the strict "zero since page load" form lives in AC-L3-1 (which opens straight into #vault).
- **AC-A5-2** (`navigation.spec.ts`, "reading #random clears the Acme dot") failed in full runs 1 and 2 (same slot, #205):
  the screenshot shows **#vault** with 1 unread, left by an earlier spec on that worker (the E2EE specs' bob-B posts in
  #vault). Adding two spec files reshuffled which files share a worker, which exposed the order dependency; it is not a
  product defect. The test now makes its premise self-sufficient (marks #general / #dev / #vault read for alice via
  `/read_markers` before bob posts, `markRoomRead` in `fixtures/state.ts`), and `link-preview.spec.ts` marks #dev read
  for alice after every test.

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

### Phase 3 criteria that cannot be judged here (no emulator, no device)

| Criterion | Why | Who checks it |
|---|---|---|
| AC-T3-5 | Android hardware back must close an open thread **before** closing drawers or leaving the app. `@capacitor/app` `backButton` events are not dispatched in Chromium, so the order can only be seen on a device. The handler order is in `src/app/Shell.tsx` (thread, then sheets/drawers, then `minimizeApp`) and reviewable, but not testable here. | Stakeholder, on the APK, same pass as AC-M6 / AC-V7 |
## Fixture-side defects found and fixed in this suite (no dev action)

Recorded so the same trap is not re-introduced.

### Phase 4 (QA-19 / QA-20)

Six QA-side defects found and fixed while bringing the two GIF specs green. 1-3 are the interesting
ones: each produced a red test that *looked* like a product bug.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | **Every "the GIF renders" assertion red** with `settledEventId` reading `data-testid` `"message-list"` forever. | The row locator was `page.locator('[data-testid^="message-"]').filter({ has: ... })`. That prefix also matches `message-list` itself, which *contains* every GIF tile, so the filter resolved to the list rather than to a row. | `gifRowById(page, id)` in `e2e/fixtures/gif.ts`: scoped inside `message-list` (or `thread-message-list`) and keyed on `getByTestId(/^message-[$~]/)`, so only real rows, local echoes included, can match. |
| 2 | **`message-gif-img` "element(s) not found"** right after a successful pick, while `message-gif` was present with the correct `data-gif-id`. | Not a product bug — `GifMessage` deliberately starts `offscreen` and mounts the `<img>` only while an IntersectionObserver reports the row as intersecting (+200 px), rendering `message-gif-placeholder` otherwise (the behaviour AC-G8-3 *requires*). Playwright's `toBeVisible()` does not mean "inside the viewport", so a just-sent row below the fold legitimately had no image. | `expectGifPlaying(row)` in `e2e/fixtures/gif.ts` scrolls the row into view, waits for `data-state="playing"`, then returns the `<img>`. Used by every pick assertion in both specs and both smoke steps. |
| 3 | **A `mock` test failed the quota guard** with `GET https://static.klipy.com/ii/8041071659142944/hd.gif`. | Self-inflicted and unavoidable: the `klipy` criteria must post real messages whose `url` is on the Klipy CDN (AC-G3-2), and #dev is dirty, so every later test that opens the room renders those rows and the browser fetches those images. The guard was right; treating it as a violation was not. | `guardGifNetwork` now **serves** `static.klipy.com` from the local fixture bytes and records it as `cdnFallbacks`; only unstubbed `api.klipy.com` (the actual quota) fails a test. Nothing leaves the machine either way, which is what AC-G11-3 protects. |
| 4 | **`AC-G6-3` (aliases) red** — `rowByText(page, '/gif')` found 4 rows where it expected 0. | A *substring* match on a dirty room: the AC-G6-4 test legitimately leaves `/gifs ...`, `/giffy` and `/ gif ...` rows behind, and all of them contain "/gif". The suite's own dirty-seed contract forbids exactly this. | The assertion became the dirty-seed-safe form already used elsewhere: snapshot `message-$*` row count before, assert it unchanged after three opens and three Escapes. |
| 5 | **The phone klipy test hit a strict-mode violation**, two tiles sharing one id. | QA's own stub ids (`9041071659142944` / `...945`) sat above `Number.MAX_SAFE_INTEGER`, so `JSON.parse` collapsed them. A test-data defect that exposed a real client limit — filed as BUG-9. | Phone stub ids pinned below 2^53 with a comment explaining why. |
| 6 | **Two phone tests skipped** as `not-built: message-gif`, though the renderer was built. | The `requireGifUi` probe posted its GIF event into **#dev** but, in touch mode, never navigated there — the phone opens #general by default and the probe only waited for `message-list`, so it looked for the row in the wrong room. | The probe now calls `tapRoom(probe, dev)` on touch and `openChannel` on desktop, so both layouts look in the room the event was posted to. |

Two further notes, neither a defect:

- **`AC-G8-1`'s "the body text is not rendered as text".** Asserting `message-body` absent is wrong —
  the criterion's own wording ("`message-body` is not a link") allows the element to exist. The test
  asserts what the criterion means instead: no `<a>` inside `message-body`, and the row's `innerText`
  does not contain the GIF url.
- **Build churn during the pass.** Three runs showed failures that passed on re-run in isolation
  (once `app-shell` never mounted at all). Dev A and Dev B were saving files into the dev server this
  suite shares, so a run can catch a half-saved module. Both specs were confirmed green on a run where
  `npx tsc --noEmit` reported zero `src/` errors; that is the gate to re-use before trusting a red.

### Phase 3 (QA-14 .. QA-18)

Eight QA-side defects found and fixed during the thread pass. The first is the one the regression
gate was designed to catch (the `threadSupport` flip breaking a Phase 2 fixture assumption); 2-6 are
defects in the new thread suite itself; 7-8 are timing flakes the final full runs exposed.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | **AC-V2-5 red in the `mobile` gate** — `message-$4SDk….voice-message` never rendered for bob. | The test picked "alice's newest `m.audio` in `#dev`" from the newest **60** `/messages` events, but bob's first render only holds the initial sync window (~30). `#dev` now absorbs the Phase 3 thread tooling (`npm run thread:sample`, the 40-reply pagination fixtures), so the chosen note was hundreds of events back and had no row at all — and `scrollIntoViewIfNeeded().catch()` swallowed the miss. The predicate also accepted a plain `m.audio`, which renders as `message-file` by design (AC-V4-3). | `e2e/voice.spec.ts`: look only inside a 25-event window, require `org.matrix.msc3245.voice`, and post a fresh note when neither holds. |
| 2 | **17 of 20 thread tests red with `login-form` never appearing**, the page showing an already-logged-in shell. | `requireThreadUi` probes the UI in `page.context().newPage()`, which **shares origin storage** with the test's own page. The probe's `loginAs` left `matrix-poc.session` behind, and `loginAs`'s own `dropStoredSession` is a no-op while the test page is still on `about:blank`, so `goto('/')` restored the probe's session instead of showing the form. | The probe clears `localStorage` before closing, and `resetSession(page)` (new, in `e2e/fixtures/threads.ts`) runs before every `loginAs` in the two thread specs. |
| 3 | **AC-T2-5 red** — "the latest sender is among the avatars", received `""`. | The assertion read **text** from `thread-summary-avatars`. An avatar is an `<img>` (or an initials badge) and carries no text; identity lives in `title` / `aria-label` / `alt`. Bob has a seeded avatar, so the stack was correct and the assertion was not. | `avatarNames(stack)` in `e2e/fixtures/threads.ts` reads identity from those attributes, falling back to text; AC-T2-5 and AC-T4-2/3 use it. |
| 4 | **AC-T6-1 red** — `thread-composer-send` "hidden". | The button follows the Phase 2 composer rule (AC-V1-1): the mic owns the slot while the input is empty and send appears with text. Asserting it *visible* on an empty composer contradicted a Phase 2 criterion. | AC-T6-1 asserts the element is attached, then visible after a character is typed. |
| 5 | **AC-T3-4 (phone) red** — `message-action-sheet` never opened. | The test opened and closed the member drawer first; the just-closed backdrop was still fading over the row, so the synthetic CDP touch landed on the backdrop and the 600 ms long-press never reached the row. | Dropped the drawer preamble (a long-press cannot reach a row an open drawer covers either, so it added no coverage); the drawer/sheet "one at a time" invariant is asserted where it is reachable, in AC-T7-7. |
| 6 | **AC-T5-2 (phone) red** — `locator.scrollIntoViewIfNeeded: element is not stable / not attached`. | `#general` takes live traffic from the devs and from the rest of the suite, so the list auto-scrolls while a test aims at a row. | `stableRow(page, eventId)` waits for visibility and tolerates a few scroll attempts; `longPressThread` retries the gesture once if the sheet did not open. Both thread specs and the `requireThreadUi` probe go through it. |
| 7 | **AC-V1-1 red once** in the final `mobile` run — `channel-header-name` read `general` where the test opened `#dev`. | `openRoom` pre-seeds `nav.selection` and trusted it. The room store validates a stored selection against the rooms it knows and falls back to the space's first channel when the target has not arrived in the first `/sync` batch — a pre-existing race that Phase 3 widens (`threadSupport: true` asks Synapse for per-thread unread counts, and `#general` now carries 335 thread replies). AC-V1-2 calls the same helper and passed in the same run; AC-V1-1 passes on re-run. | `openRoom` now *verifies* the header and re-selects the room through the drawer (`tapRoom`) when the pre-seed lost the race. |
| 8 | **AC-T4-6 (phone) red once** in the final `mobile` run — bob's root row never became visible. | A 20 s budget for a `/sync` round trip that occasionally takes longer on this homeserver under load. Passes on re-run. | `rootInView` in `e2e/mobile-threads.spec.ts` waits 30 s for the root row. |

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
