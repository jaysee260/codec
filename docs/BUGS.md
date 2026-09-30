# Bug log

QA owns this file (docs/TICKETS.md QA-6). Every failing test during Wave 3 gets a row; devs close a
row with the commit that fixes it (put the commit sha in **Status**).

**Severity** — `S1` blocks the demo script in docs/PLAN.md · `S2` wrong but the demo still works ·
`S3` cosmetic.

**Reproducing** — steps are written from a fresh seed:

```
npm run hs:up && npm run seed:reset && npm run dev     # homeserver + fixtures + client
npm run test:e2e                                        # whole suite
npx playwright test e2e/conversation.spec.ts -g "AC-B3-2"   # one criterion
npx playwright show-trace e2e/results/<test-dir>/trace.zip  # the trace named in the row
```

Artefacts live under `e2e/results/<test-dir>/` (failure screenshot, trace, video) and
`e2e/results/demo/` (one full-page screenshot per demo step, written even when green).

| BUG | AC ref | Sev | Owner | Steps (from fresh seed) | Expected | Actual | Screenshot/trace | Status |
|---|---|---|---|---|---|---|---|---|
| BUG-1 | AC-B5-3, AC-B5-4, AC-B1-1, demo step 5 | S1 | Dev B | 1. Log in as alice. 2. Page `#general` back to the beginning. 3. Hover bob's "Lunch today? Thinking tacos." (`general.reacted`). 4. Click `message-action-react`, pick 🎉. 5. Click the new `reaction-🎉` pill to remove it. | The pill is clickable and the reaction is redacted. | Click times out: *"`<span data-testid="message-timestamp">` from `<div data-testid="message-$Yl6…">` subtree intercepts pointer events"*. Root cause: `MessageList.module.css .list` was `display:flex; flex-direction:column`, so every row was a flex item with the default `flex-shrink:1`; combined with `MessageRow.module.css .row { min-height:22px }` (an explicit min-height overrides the automatic minimum size) the flex algorithm shrank **every** row to 22 px while its content stayed 34 px+. Measured: `clientHeight 580 / scrollHeight 978`, all 24 rows `height 22px`, `flex-shrink 1`, content overflowing. Rows therefore painted over each other and the *following* row won hit-testing on pills, quotes and images. | `e2e/results/smoke-demo-script-QA-3-smo-8c4a7-oday-message-then-remove-it-chromium/` (trace.zip + test-failed-1.png) | **Fixed** by Dev B during Wave 2 — `.list` is no longer a flex container and `.row` sets `flex-shrink: 0`. Re-verified: AC-B5-1..B5-6 and demo step 5 pass. |
| BUG-2 | AC-B3-2 | S2 | Dev B | 1. Log in as alice (`#general` opens). 2. Note the top-most rendered row and its viewport `y`. 3. Scroll `message-list` to the top so backwards pagination fires. 4. When the older messages have rendered, measure that same row's viewport `y` again. | DEV-B-3: capture `scrollHeight` before `paginateBack` and restore `scrollTop += delta` after, so the anchor row stays at the same viewport position (criterion allows no jump). | The anchor row moves **~545-582 px** down the viewport — the list keeps `scrollTop` while ~30 events are prepended, so the reader is thrown out of position on every page-in. `timeline-loading` does appear and the older messages do load, so the demo's "scroll to the top" still functions; only the anchoring is missing. | `e2e/results/conversation-DEV-B-3-backw-f00e8-er-messages-without-jumping-chromium/` (trace.zip + test-failed-1.png) | **Open** |
| BUG-3 | AC-A6-2 | S3 | Dev A | 1. Create 7-8 channels in Gaming so the channel list is longer than the sidebar (`npx playwright test e2e/navigation.spec.ts -g "AC-A6-2"` a few times without cleanup). 2. Create one more channel from `channel-add`. | The new channel appears in `channel-list`, is selected, and its topic shows in the header. | `byName(channel-list, name)` was not visible within 20 s in a full-suite run, while the identical test passes in isolation. Suspected: the sidebar clips a long channel list and the newly created item is not scrolled into view. Not reproduced since the accumulated test channels were removed (Gaming is back to `lobby` only), so it is recorded as a watch item rather than a confirmed defect. | `e2e/results/full-run.json` (run where it failed) | **Watch** — needs a repro with a long channel list; re-check during the Wave 3 dry run |

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
